import { randomBytes } from "node:crypto";
import type { CanvasOperation } from "../../../packages/link-studio-core/src/canvas.ts";
import { dramaAssetMeta } from "../../../packages/link-studio-core/src/canvas.ts";
import {
  type DramaJobRecord,
  dramaPromptBatchSize,
  dramaStyles,
} from "../../../packages/link-studio-core/src/drama.ts";
import { DramaOutputTruncatedError } from "../../../packages/provider-runtime/src/runner.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import type { CanvasMedia } from "./canvas-media.ts";
import { bumpSegmentVersion, dramaDocument } from "./drama.ts";
import { commitBreakdownBatch, type DramaAsset } from "./drama-assets.ts";
import { syncDramaBoards } from "./drama-boards.ts";
import { checkStoryboardTakes } from "./drama-estimate.ts";
import { progressBucket, recordDramaProgress } from "./drama-job.ts";
import { writeDramaScripts } from "./drama-scripts.ts";
import { dramaBatchBudget } from "./drama-source.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

async function processModelBatch<Item, Result>(
  items: Item[],
  signal: AbortSignal,
  generate: (items: Item[]) => Promise<Result>,
  commit: (items: Item[], result: Result) => Promise<void>,
  onModelError: (items: Item[], error: unknown) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  let result: Result;
  try {
    result = await generate(items);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ProjectError) throw error;
    if (error instanceof DramaOutputTruncatedError && items.length > 1) {
      const half = Math.floor(items.length / 2);
      await processModelBatch(items.slice(0, half), signal, generate, commit, onModelError);
      await processModelBatch(items.slice(half), signal, generate, commit, onModelError);
      return;
    }
    return onModelError(items, error);
  }
  signal.throwIfAborted();
  await commit(items, result);
}

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
      source_kind: document.planning ? "novel" : "script",
      source: document.planning?.summary ?? "",
      summary: document.planning?.summary ?? "",
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
      registry.dramaAssetStage(
        model,
        name,
        name === "breakdown" ? input : { ...input, known_cast: job.known_cast ?? [] },
        scope,
        signal,
        drafts[name],
      );
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
            has_voice: meta.type === "character" && !!node.data.character?.voice?.assetId,
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
        max_audios: job.request.max_audios ?? 0,
        max_seconds: job.request.max_seconds ?? 15,
      };
      const scope = {
        nodes: assets.map((asset) => asset.node_id),
        voiced: assets.filter((asset) => asset.has_voice).map((asset) => asset.node_id),
        max_seconds: input.max_seconds,
        max_audios: input.max_audios,
      };
      const draft = await stage(
        "storyboard",
        { ...variables, ...input, script_md: episode.script_md },
        scope,
      );
      await recordDramaProgress(store, id, 50, signal);
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
    async function promptBatch(): Promise<boolean> {
      const state = store.snapshot;
      const checkpoint = dramaDocument(state)!.jobs!.find((entry) => entry.id === id)!;
      const remaining =
        checkpoint.new_nodes?.filter(
          (node) =>
            !checkpoint.prompted_nodes?.includes(node) &&
            !checkpoint.deferred_nodes?.includes(node),
        ) ?? [];
      if (!remaining.length) return false;
      const assets = projectCanvas(state.canvas)
        .nodes.flatMap((node) => {
          if (node.type !== "creative" || !remaining.includes(node.id) || node.data.text?.trim())
            return [];
          const meta = dramaAssetMeta(node.data);
          return meta
            ? [
                {
                  node_id: node.id,
                  asset: { ...meta, voice_prompt: node.data.character?.voicePrompt ?? "" },
                },
              ]
            : [];
        })
        .slice(0, dramaPromptBatchSize);
      if (!assets.length) return false;
      await processModelBatch(
        assets,
        signal,
        async (group) => {
          const scope = { nodes: group.map((asset) => asset.node_id) };
          const draft = await stage("asset_prompts", { ...variables, assets: group }, scope);
          const result = (await stage(
            "asset_prompts_format",
            { assets: group, draft_md: draft },
            scope,
          )) as {
            prompts: { node_id: string; prompt: string }[];
          };
          const ids = new Set(
            result.prompts.filter((entry) => entry.prompt.trim()).map((entry) => entry.node_id),
          );
          if (
            result.prompts.length !== scope.nodes.length ||
            !scope.nodes.every((id) => ids.has(id))
          )
            throw Error("提示词未完整覆盖本批资产");
          return result;
        },
        async (group, result) => {
          const pending = group.map((asset) => asset.node_id);
          await store.updateGeneration((snapshot) => {
            const current = dramaDocument(snapshot)?.jobs?.find((entry) => entry.id === id);
            if (current?.status !== "running") throw Error("任务已结束");
            const nodes = projectCanvas(snapshot.canvas).nodes;
            const operations: CanvasOperation[] = result.prompts.flatMap(({ node_id, prompt }) => {
              const node = nodes.find((entry) => entry.id === node_id);
              if (!pending.includes(node_id)) throw Error("提示词引用了范围外的资产");
              if (node?.type !== "creative" || !dramaAssetMeta(node.data) || node.data.text?.trim())
                return [];
              return [
                {
                  type: "putNode" as const,
                  node: { ...node, data: { ...node.data, text: prompt } },
                },
              ];
            });
            if (operations.length) snapshot.canvas = applyCanvas(snapshot, operations);
            current.prompted_nodes = [...(current.prompted_nodes ?? []), ...pending];
            if (current.step === "breakdown" && current.new_nodes?.length) {
              const index = batches.findLastIndex((batch) =>
                batch.some((episode) => current.done_episodes?.includes(episode.episode_no)),
              );
              if (
                index >= 0 &&
                batches[index]!.every((ep) => current.done_episodes?.includes(ep.episode_no))
              ) {
                const start = progressBucket(((index + 2 / 3) * 90) / batches.length);
                const end = progressBucket(((index + 1) * 90) / batches.length);
                const fraction = current.prompted_nodes.length / current.new_nodes.length;
                current.progress = Math.max(
                  current.progress ?? 0,
                  start + Math.round((end - start) * fraction),
                );
              }
            }
            return { changed: true, result: null };
          }, signal);
        },
        async (group, error) => {
          const ids = new Set(group.map((asset) => asset.node_id));
          await store.updateGeneration((snapshot) => {
            const current = dramaDocument(snapshot)?.jobs?.find((entry) => entry.id === id);
            if (current?.status !== "running") throw Error("任务已结束");
            const missing = projectCanvas(snapshot.canvas).nodes.filter(
              (node) =>
                ids.has(node.id) &&
                node.type === "creative" &&
                dramaAssetMeta(node.data) &&
                !node.data.text?.trim(),
            );
            if (!missing.length) return { changed: false, result: null };
            current.deferred_nodes = [
              ...(current.deferred_nodes ?? []),
              ...missing.map((node) => node.id),
            ];
            current.prompt_error = registry
              .redact(error instanceof Error ? error.message : "提示词生成失败")
              .slice(0, 500);
            return { changed: true, result: null };
          }, signal);
        },
      );
      return true;
    }
    async function promptPending() {
      while (await promptBatch()) signal.throwIfAborted();
    }
    await promptPending();
    for (const [index, original] of batches.entries()) {
      const unfinished = original.filter(
        (episode) => !job.done_episodes?.includes(episode.episode_no),
      );
      if (!unfinished.length) continue;
      let completed = original.length - unfinished.length;
      const progress = (count: number) =>
        ((index + (completed + count) / original.length) * 90) / batches.length;
      await processModelBatch(
        unfinished,
        signal,
        async (batch) => {
          const scope = { episodes: batch.map((episode) => episode.episode_no) };
          const draft = await stage(
            "breakdown",
            {
              ...variables,
              assets: job.known_cast ?? [],
              episodes: batch.map(
                ({
                  episode_no,
                  title,
                  synopsis,
                  script_md,
                  hook,
                  cliffhanger,
                  unit_from,
                  unit_to,
                }) => ({
                  no: episode_no,
                  title,
                  synopsis,
                  hook: hook ?? "",
                  cliffhanger: cliffhanger ?? "",
                  unit_from: unit_from ?? 0,
                  unit_to: unit_to ?? 0,
                  script_md,
                }),
              ),
            },
            scope,
          );
          await recordDramaProgress(store, id, progress(batch.length / 3), signal);
          const result = (await stage(
            "breakdown_format",
            { draft_md: draft, episode_numbers: scope.episodes },
            scope,
          )) as { assets: DramaAsset[] };
          return result.assets;
        },
        async (batch, assets) => {
          await commitBreakdownBatch(
            store,
            id,
            batch.map((ep) => ep.episode_no),
            assets,
            signal,
          );
          await recordDramaProgress(store, id, progress((batch.length * 2) / 3), signal);
          await promptPending();
          completed += batch.length;
          await recordDramaProgress(store, id, progress(0), signal);
        },
        async (batch, error) => {
          if (error instanceof DramaOutputTruncatedError && batch.length === 1)
            throw Error(
              `第 ${batch[0]!.episode_no} 集单独拆解仍超过长度上限，请提高文本模型的最大输出后再继续`,
            );
          throw error;
        },
      );
    }
  }
  await store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    const current = doc?.jobs?.find((entry) => entry.id === id);
    if (!doc || current?.status !== "running") return { changed: false, result: null };
    if (current.deferred_nodes?.length) {
      const missing = new Set(
        projectCanvas(state.canvas).nodes.flatMap((node) =>
          node.type === "creative" && dramaAssetMeta(node.data) && !node.data.text?.trim()
            ? [node.id]
            : [],
        ),
      );
      current.deferred_nodes = current.deferred_nodes.filter((node) => missing.has(node));
      if (!failure && current.step === "asset_prompts" && current.deferred_nodes.length)
        failure = current.prompt_error || "部分资产仍待补词";
    }
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
