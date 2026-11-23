import { randomBytes } from "node:crypto";
import type { CanvasOperation } from "../../../packages/link-studio-core/src/canvas.ts";
import { dramaAssetMeta } from "../../../packages/link-studio-core/src/canvas.ts";
import { type DramaJobRecord, dramaStyles } from "../../../packages/link-studio-core/src/drama.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import type { CanvasMedia } from "./canvas-media.ts";
import { bumpSegmentVersion, dramaDocument } from "./drama.ts";
import { commitBreakdownBatch, type DramaAsset } from "./drama-assets.ts";
import { syncDramaBoards } from "./drama-boards.ts";
import { checkStoryboardTakes } from "./drama-estimate.ts";
import { recordDramaProgress } from "./drama-job.ts";
import { writeDramaScripts } from "./drama-scripts.ts";
import { dramaBatchBudget } from "./drama-source.ts";
import type { ProjectStore } from "./store.ts";

export async function runDramaAssetJob(
  store: ProjectStore,
  registry: SettingsRegistry,
  id: string,
  signal: AbortSignal,
  media?: CanvasMedia,
) {
  const job = await store.updateGeneration((state) => {
    const current = dramaDocument(state)?.jobs?.find((entry) => entry.id === id);
    if (!current || !["queued", "running"].includes(current.status))
      return { changed: false, result: null };
    const changed = current.status !== "running";
    current.status = "running";
    return { changed, result: current };
  }, signal);
  if (!job) return;
  let failure: string | undefined;
  try {
    if (job.step === "scripts") await writeDramaScripts(store, registry, job, signal);
    else await runAssets(job);
  } catch (error) {
    if (signal.aborted) return;
    failure =
      registry.redact(error instanceof Error ? error.message : "短剧任务执行失败").slice(0, 500) ||
      "短剧任务执行失败";
  }
  async function runAssets(job: DramaJobRecord) {
    if (job.step === "compose") {
      if (!media) throw Error("转码失败：合成服务未配置");
      await media.composeDrama(store, job, signal);
      return;
    }
    if (!job.model) throw Error("缺少任务模型版本");
    const model = job.model;
    const config = registry.agentBinding(model.id, model.revision).profile.config;
    const budget = dramaBatchBudget(config?.contextWindow);
    const document = dramaDocument(store.snapshot)!;
    const variables = {
      outline_md: document.outline_md,
      characters_md: document.characters_md,
      ratio: document.ratio,
      episode_seconds: document.episode_seconds,
      genre: document.genre ?? "",
      style:
        dramaStyles.styles.find((style) => style.key === document.style_key)?.prompt ??
        document.style_custom ??
        "",
    };
    const episodes = document.episodes.filter(
      (episode) => job.step === "breakdown" && job.episodes.includes(episode.episode_no),
    );
    const batches: (typeof episodes)[] = [];
    let chars = 0;
    for (const episode of episodes) {
      const size = Array.from(episode.script_md).length;
      if (!batches.length || batches.at(-1)!.length >= 12 || chars + size > budget) {
        batches.push([]);
        chars = 0;
      }
      batches.at(-1)!.push(episode);
      chars += size;
    }
    const frozen = job.prompt_snapshots ?? document.prompt_snapshots;
    const drafts: Record<string, string | undefined> = {
      breakdown: frozen?.assets?.body,
      asset_prompts: frozen?.asset_prompts?.body,
      storyboard: frozen?.video?.body,
    };
    const stage = (name: string, input: object, scope: object) =>
      registry.dramaAssetStage(model, name, input, scope, signal, drafts[name]);
    if (job.step === "storyboard") {
      const episode = document.episodes.find((entry) => entry.episode_no === job.episodes[0]);
      if (!episode?.locked || !episode.script_md.trim())
        throw Error("所选集须已拆解资产且剧本已就绪");
      const assets = projectCanvas(store.snapshot.canvas).nodes.flatMap((node) => {
        if (node.type !== "creative") return [];
        const meta = dramaAssetMeta(node.data);
        if (
          !meta?.episodes ||
          (meta.episodes.length && !meta.episodes.includes(episode.episode_no))
        )
          return [];
        return [
          {
            node_id: node.id,
            type: meta.type,
            name: meta.name,
            look: meta.look,
            prompt_summary: Array.from(node.data.text.trim()).slice(0, 500).join(""),
          },
        ];
      });
      const input = {
        episode_no: episode.episode_no,
        assets,
        max_seconds: job.request.max_seconds ?? 15,
      };
      const scope = { nodes: assets.map((asset) => asset.node_id), max_seconds: input.max_seconds };
      const draft = await stage(
        "storyboard",
        { ...variables, ...input, script_md: episode.script_md },
        scope,
      );
      const result = (await stage("storyboard_format", { ...input, draft_md: draft }, scope)) as {
        segments: { seconds: number; prompt: string }[];
      };
      await store.updateGeneration((state) => {
        const doc = dramaDocument(state);
        const task = doc?.jobs?.find((entry) => entry.id === id);
        const target = doc?.episodes.find((entry) => entry.episode_no === episode.episode_no);
        if (
          !doc ||
          !target?.locked ||
          target.script_md !== episode.script_md ||
          task?.status !== "running"
        )
          throw Error("分集或任务状态已更改");
        checkStoryboardTakes(doc, target.episode_no);
        const otherSegments = (doc.segments ?? []).filter(
          (segment) => segment.episode_no !== target.episode_no,
        );
        if (
          otherSegments.length + result.segments.length > 5000 ||
          result.segments.some((segment) => Array.from(segment.prompt).length > 24000)
        )
          throw Error("分镜超出项目片段容量");
        doc.segments = [
          ...otherSegments,
          ...result.segments.map((segment, seq) => ({
            ...segment,
            id: randomBytes(16).toString("hex"),
            episode_no: target.episode_no,
            seq,
            revision: 1,
          })),
        ];
        syncDramaBoards(state, target.episode_no, doc.segments);
        doc.overview_revision ??= doc.revision;
        doc.revision++;
        target.revision = (target.revision ?? 1) + 1;
        target.storyboard_status = "ready";
        bumpSegmentVersion(doc, target.episode_no);
        task.status = "succeeded";
        task.progress = 100;
        return { changed: true, result: null };
      }, signal);
      return;
    }
    async function promptPending() {
      const state = store.snapshot;
      const checkpoint = dramaDocument(state)!.jobs!.find((entry) => entry.id === id)!;
      const pending =
        checkpoint.new_nodes?.filter((node) => !checkpoint.prompted_nodes?.includes(node)) ?? [];
      if (!pending.length) return;
      const assets = projectCanvas(state.canvas).nodes.flatMap((node) => {
        if (node.type !== "creative" || !pending.includes(node.id)) return [];
        const meta = dramaAssetMeta(node.data);
        return meta
          ? [
              {
                node_id: node.id,
                asset: { ...meta, voice_prompt: node.data.character?.voicePrompt ?? "" },
              },
            ]
          : [];
      });
      if (assets.length !== pending.length) throw Error("任务资产节点已更改");
      const scope = { nodes: pending };
      const draft = await stage("asset_prompts", { ...variables, assets }, scope);
      const result = (await stage("asset_prompts_format", { assets, draft_md: draft }, scope)) as {
        prompts: { node_id: string; prompt: string }[];
      };
      await store.updateGeneration((snapshot) => {
        const current = dramaDocument(snapshot)?.jobs?.find((entry) => entry.id === id);
        if (current?.status !== "running") throw Error("任务已结束");
        const nodes = projectCanvas(snapshot.canvas).nodes;
        const operations: CanvasOperation[] = result.prompts.map(({ node_id, prompt }) => {
          const node = nodes.find((entry) => entry.id === node_id);
          if (
            node?.type !== "creative" ||
            !dramaAssetMeta(node.data) ||
            !current.new_nodes?.includes(node_id)
          )
            throw Error("任务资产节点已更改");
          return { type: "putNode", node: { ...node, data: { ...node.data, text: prompt } } };
        });
        snapshot.canvas = applyCanvas(snapshot, operations);
        current.prompted_nodes = [...(current.prompted_nodes ?? []), ...pending];
        return { changed: true, result: null };
      }, signal);
    }
    await promptPending();
    for (const [index, original] of batches.entries()) {
      const batch = original.filter((episode) => !job.done_episodes?.includes(episode.episode_no));
      if (!batch.length) continue;
      const scope = { episodes: batch.map((episode) => episode.episode_no) };
      const draft = await stage(
        "breakdown",
        {
          ...variables,
          episodes: batch.map(({ episode_no, title, synopsis, script_md }) => ({
            no: episode_no,
            title,
            synopsis,
            script_md,
          })),
        },
        scope,
      );
      const result = (await stage(
        "breakdown_format",
        { draft_md: draft, episode_numbers: scope.episodes },
        scope,
      )) as { assets: DramaAsset[] };
      await commitBreakdownBatch(store, id, scope.episodes, result.assets, signal);
      await promptPending();
      await recordDramaProgress(store, id, ((index + 1) * 90) / batches.length, signal);
    }
  }
  await store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    const current = doc?.jobs?.find((entry) => entry.id === id);
    if (!doc || current?.status !== "running") return { changed: false, result: null };
    current.status = failure ? "failed" : "succeeded";
    if (!failure) current.progress = 100;
    if (current.step === "scripts") {
      doc.status = failure ? "failed" : "ready";
      doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
      doc.revision++;
    }
    if (failure) current.error_message = failure;
    if (failure && current.step === "storyboard") {
      const episode = doc.episodes.find((entry) => entry.episode_no === current.episodes[0]);
      if (episode) {
        episode.storyboard_status = "failed";
        episode.revision = (episode.revision ?? 1) + 1;
        doc.overview_revision ??= doc.revision;
        doc.revision++;
      }
    }
    return { changed: true, result: null };
  }, signal);
}
