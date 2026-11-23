import { randomBytes } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { DramaDocument, dramaStyles } from "../../../packages/link-studio-core/src/drama.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { dramaDocument } from "./drama.ts";
import { dramaKnownCast } from "./drama-cast.ts";
import { quoteDramaContinuation } from "./drama-estimate.ts";
import { nextNovelBatch, novelAnalysisSample, preflightDramaSource } from "./drama-source.ts";
import { readDramaText } from "./drama-source-blob.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

type Planning = NonNullable<DramaDocument["planning"]>;
type Task = NonNullable<Planning["pending"]>;
type Runtime = Pick<
  SettingsRegistry,
  "agentBinding" | "dramaAssetStage" | "dramaPromptText" | "recordDramaDuration"
>;
type Analysis = { summary: string; characters_md: string; outline_md: string };
type Episode = Pick<
  DramaDocument["episodes"][number],
  "title" | "synopsis" | "hook" | "cliffhanger" | "unit_from" | "unit_to"
>;

export async function controlDramaPlanning(
  store: ProjectStore,
  action: "pause" | "resume" | "retry-builtin",
) {
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    const plan = doc?.planning;
    if (!doc || !plan || plan.phase !== (action === "pause" ? "running" : "paused"))
      throw new ProjectError("VALIDATION_FAILED", "当前规划阶段不能执行此操作");
    if (action === "retry-builtin") {
      if (plan.pause_code !== "custom_prompt")
        throw new ProjectError("VALIDATION_FAILED", "仅在自定义规划输出不合格后可改用内置重试");
      if (doc.prompt_snapshots) delete doc.prompt_snapshots.plan;
      doc.board_settings_revision = (doc.board_settings_revision ?? 1) + 1;
    }
    plan.phase = action === "pause" ? "paused" : "running";
    plan.pause_code = action === "pause" ? "user" : "";
    plan.pause_reason = action === "pause" ? "用户暂停" : "";
    if (action !== "pause" && plan.cursor >= plan.end) plan.phase = "done";
    doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
    doc.revision++;
    return { changed: true, result: doc };
  });
}

async function pendingTask(store: ProjectStore, registry: Runtime, signal: AbortSignal) {
  return store.updateGeneration(async (state) => {
    const doc = dramaDocument(state);
    const plan = doc?.planning;
    if (!doc?.source || !plan || (plan.phase !== "running" && !plan.pending))
      return { changed: false, result: null };
    if (plan.pending)
      return {
        changed: false,
        result: { task: plan.pending, model: plan.pending.model ?? plan.model },
      };
    const config = registry.agentBinding(plan.model.id, plan.model.revision).profile.config;
    const limit = config?.contextWindow
      ? Math.max(1, Math.floor(config.contextWindow * 0.6))
      : 12000;
    const units = preflightDramaSource(
      await readDramaText(doc.source, store.directory),
      "novel",
    ).units;
    const variables = {
      source_kind: "novel",
      summary: plan.summary,
      characters_md: doc.characters_md,
      outline_md: doc.outline_md,
      genre: doc.genre ?? "",
      style:
        dramaStyles.styles.find((style) => style.key === doc.style_key)?.prompt ??
        doc.style_custom ??
        "",
      ratio: doc.ratio,
      episode_seconds: doc.episode_seconds,
    };
    let input: object;
    let to = units.length;
    if (plan.summary) {
      const last = doc.episodes.at(-1);
      const knownCast = dramaKnownCast(state, doc);
      const context = {
        ...variables,
        source: "",
        known_cast: knownCast,
        next_episode_no: (last?.episode_no ?? 0) + 1,
        previous_cliffhanger: last?.cliffhanger ?? "",
      };
      const prompt = await registry.dramaPromptText(
        "plan",
        context,
        signal,
        doc.prompt_snapshots?.plan?.body,
      );
      const batch = nextNovelBatch(units, plan.cursor, plan.end, limit - Array.from(prompt).length);
      input = { ...context, source: batch.source };
      to = batch.to;
    } else input = { ...variables, known_cast: [], source: novelAnalysisSample(units, limit) };
    const task: Task = {
      id: randomBytes(16).toString("hex"),
      step: plan.summary ? "plan" : "analyze",
      from: plan.cursor + 1,
      to,
      input: JSON.stringify(input),
      created_at: new Date().toISOString(),
      model: plan.model,
    };
    plan.pending = task;
    if (task.step === "plan" && doc.prompt_snapshots?.plan)
      task.body = doc.prompt_snapshots.plan.body;
    return { changed: true, result: { task, model: plan.model } };
  }, signal);
}

export function extendDramaPlanning(
  store: ProjectStore,
  registry: SettingsRegistry,
  rangeEnd: number,
  previousEnd: number,
) {
  return store.updateGeneration(async (state) => {
    const doc = dramaDocument(state);
    if (!doc?.planning || doc.planning.end !== previousEnd)
      throw new ProjectError("DRAMA_STEP_NOT_READY", "规划范围已改变");
    const { end, model } = await quoteDramaContinuation(doc, rangeEnd, registry, store.directory);
    Object.assign(doc.planning, { end, model, phase: "running", pause_code: "", pause_reason: "" });
    doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
    doc.revision++;
    return { changed: true, result: doc };
  });
}

export async function runDramaPlanning(
  store: ProjectStore,
  registry: Runtime,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    let taskId: string | undefined;
    try {
      const work = await pendingTask(store, registry, signal);
      if (!work) return;
      const { task, model } = work;
      const started = performance.now();
      taskId = task.id;
      const input = JSON.parse(task.input);
      const scope = task.step === "plan" ? { unit_from: task.from, unit_to: task.to } : {};
      const output = await registry.dramaAssetStage(
        model,
        task.step,
        input,
        scope,
        signal,
        task.body,
      );
      if (task.step === "plan")
        await store.updateGeneration((state) => {
          const pending = dramaDocument(state)?.planning?.pending;
          if (pending?.id !== task.id)
            throw new ProjectError("DRAMA_STEP_NOT_READY", "规划批次已变更");
          if (pending.progress === 50) return { changed: false, result: null };
          pending.progress = 50;
          return { changed: true, result: null };
        }, signal);
      const episodes =
        task.step === "plan"
          ? (
              (await registry.dramaAssetStage(
                model,
                "plan_format",
                {
                  draft_md: output,
                  batch_from: task.from,
                  batch_to: task.to,
                  known_cast: input.known_cast ?? [],
                },
                scope,
                signal,
              )) as { episodes: Episode[] }
            ).episodes
          : undefined;
      const committed = await store.updateGeneration((state) => {
        const doc = dramaDocument(state);
        const plan = doc?.planning;
        if (!doc || !plan || plan.pending?.id !== task.id || plan.cursor + 1 !== task.from)
          return { changed: false, result: null };
        if (episodes) {
          const next = Math.max(0, ...doc.episodes.map((episode) => episode.episode_no)) + 1;
          doc.episodes.push(
            ...episodes.map((episode, index) => ({
              ...episode,
              episode_no: next + index,
              revision: 1,
              script_md: "",
              updated_at: new Date().toISOString(),
            })),
          );
          plan.recent_batches = [...(plan.recent_batches ?? []), task.from].slice(-3);
          doc.status = "outlined";
          plan.cursor = task.to;
          if (plan.phase === "running" && plan.cursor >= plan.end) plan.phase = "done";
        } else {
          const analysis = output as Analysis;
          plan.summary = analysis.summary;
          if (doc.characters_md === input.characters_md) doc.characters_md = analysis.characters_md;
          if (doc.outline_md === input.outline_md) doc.outline_md = analysis.outline_md;
        }
        delete plan.pending;
        doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
        doc.revision++;
        if (!Value.Check(DramaDocument, doc))
          throw new ProjectError("VALIDATION_FAILED", "模型输出超出项目容量");
        return { changed: true, result: true };
      }, signal);
      if (committed) {
        try {
          registry.recordDramaDuration(task.id, model, task.step, performance.now() - started);
        } catch {
          console.warn("未能记录短剧耗时样本");
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      await store.updateGeneration((state) => {
        const doc = dramaDocument(state);
        const plan = doc?.planning;
        if (!doc || !plan || plan.phase === "done" || plan.pending?.id !== taskId)
          return { changed: false, result: null };
        plan.phase = "paused";
        if (
          error instanceof ProviderError &&
          error.code === "模型输出无法解析" &&
          plan.pending?.step === "plan" &&
          plan.pending.body
        ) {
          plan.pause_code = "custom_prompt";
          plan.pause_reason = "自定义提示词或技能导致输出不合格（plan）";
        } else if (
          (error instanceof ProjectError || error instanceof ProviderError) &&
          error.code === "DRAMA_CONTEXT"
        ) {
          plan.pause_code = "context";
          plan.pause_reason =
            error instanceof ProjectError ? error.message : "完整提示词超过模型上下文预算";
        } else {
          plan.pause_code = "failed";
          plan.pause_reason = "模型任务失败，请检查模型后重试";
        }
        delete plan.pending;
        doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
        doc.revision++;
        return { changed: true, result: null };
      }, signal);
      return;
    }
  }
}
