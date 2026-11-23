import type { DramaJobRecord } from "../../../packages/link-studio-core/src/drama.ts";
import { dramaStyles } from "../../../packages/link-studio-core/src/drama.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { dramaDocument } from "./drama.ts";
import { progressBucket } from "./drama-job.ts";
import { numberedSource, preflightDramaSource } from "./drama-source.ts";
import { readDramaText } from "./drama-source-blob.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

export async function writeDramaScripts(
  store: ProjectStore,
  registry: SettingsRegistry,
  job: DramaJobRecord,
  signal: AbortSignal,
) {
  const model = job.model;
  if (!model) throw Error("缺少任务模型版本");
  const context = registry.agentBinding(model.id, model.revision).profile.config?.contextWindow;
  const limit = context ? Math.max(1, Math.floor(context * 0.6)) : 12000;
  const doc = dramaDocument(store.snapshot)!;
  const units = doc.source
    ? preflightDramaSource(await readDramaText(doc.source, store.directory), "novel").units
    : [];
  const summary = doc.planning?.summary ?? "";
  for (const number of job.episodes) {
    signal.throwIfAborted();
    if (job.done_episodes?.includes(number)) continue;
    const episode = doc.episodes.find((item) => item.episode_no === number);
    if (!episode || episode.locked) throw Error("分集不存在或已锁定");
    const expected = episode.revision ?? 1;
    const previous = doc.episodes.find((item) => item.episode_no === number - 1);
    const ending = previous
      ? previous.script_md.trim()
        ? previous.script_md
        : `上一集剧本尚未写，以下为其梗概与结尾悬念：\n${previous.synopsis}\n${previous.cliffhanger ?? ""}`
      : "";
    const from = episode.unit_from ?? 0,
      to = episode.unit_to ?? 0;
    if (from && (to < from || to > units.length)) throw Error("分集原文范围无效");
    const source = from
      ? units
          .slice(from - 1, to)
          .map((unit, index) => numberedSource(unit, from + index))
          .join("")
      : summary;
    if (Array.from(source).length > limit)
      throw new ProjectError("DRAMA_CONTEXT", "本集原文超过模型上下文");
    const input = {
      source,
      source_kind: doc.planning ? "novel" : "",
      summary,
      characters_md: doc.characters_md,
      outline_md: doc.outline_md,
      genre: doc.genre ?? "",
      style:
        dramaStyles.styles.find((style) => style.key === doc.style_key)?.prompt ??
        doc.style_custom ??
        "",
      ratio: doc.ratio ?? "9:16",
      episode_seconds: doc.episode_seconds ?? 60,
      known_cast: job.known_cast ?? [],
      previous_ending: Array.from(ending).slice(-800).join("").trim(),
      hook: episode.hook ?? "",
      cliffhanger: episode.cliffhanger ?? "",
      episode: {
        no: number,
        title: episode.title,
        synopsis: episode.synopsis,
        unit_from: from,
        unit_to: to,
        hook: episode.hook ?? "",
        cliffhanger: episode.cliffhanger ?? "",
        script_status: episode.script_status ?? (episode.script_md.trim() ? "ready" : "empty"),
        storyboard_status: episode.storyboard_status ?? "empty",
        revision: expected,
        updated_at: episode.updated_at ?? job.created_at,
        segment_count: 0,
        segment_seconds: 0,
        done_segment_count: 0,
        done_board_count: 0,
        locked: false,
        final: null,
        final_stale: false,
      },
    };
    let script: string;
    try {
      const output = await registry.dramaAssetStage(
        model,
        "scripts",
        input,
        {},
        signal,
        job.prompt_snapshots?.scripts?.body,
      );
      if (typeof output !== "string" || !output.trim()) throw Error("剧本正文为空");
      script = output;
    } catch (error) {
      if (!signal.aborted) await save();
      throw error;
    }
    await save(script);
    episode.script_md = script;
    async function save(text?: string) {
      await store.updateGeneration((state) => {
        const current = dramaDocument(state);
        const active = current?.jobs?.find((item) => item.id === job.id);
        const target = current?.episodes.find((item) => item.episode_no === number);
        if (
          !current ||
          active?.status !== "running" ||
          !target ||
          target.locked ||
          (target.revision ?? 1) !== expected
        )
          throw new ProjectError("DRAMA_STEP_NOT_READY", "任务或分集已更改，未覆盖正文");
        target.script_status = text === undefined ? "failed" : "ready";
        target.updated_at = new Date().toISOString();
        target.revision = expected + 1;
        if (text !== undefined) {
          target.script_md = text;
          active.done_episodes ??= [];
          active.done_episodes.push(number);
          active.progress = progressBucket(
            (active.done_episodes.length * 90) / active.episodes.length,
          );
        }
        current.overview_revision ??= current.revision;
        current.revision++;
        return { changed: true, result: null };
      }, signal);
    }
  }
}
