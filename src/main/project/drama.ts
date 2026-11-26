import { createHash, randomBytes } from "node:crypto";
import { requirePresent } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import {
  type CanvasOperation,
  dramaAssetMeta,
  dramaBoardMeta,
} from "../../../packages/link-studio-core/src/canvas.ts";
import {
  AddDramaEpisode,
  AddDramaSegment,
  DeleteDramaEpisode,
  DeleteDramaSegment,
  type DramaAgentContext,
  type DramaAgentSnapshot,
  DramaDocument,
  DramaEdits,
  DramaRead,
  type DramaSource,
  defaultDramaStyle,
  dramaDeleteBlocked,
  dramaStyles,
  EditDramaField,
  episodeScriptPhase,
  ReorderDramaSegments,
  SaveDramaScript,
  SetDramaSegmentPrompt,
  SetDramaSegmentSeconds,
  UpdateDramaBoardSettings,
} from "../../../packages/link-studio-core/src/drama.ts";
import { boardTemplateError } from "../../../packages/link-studio-core/src/drama-board.ts";
import {
  dramaAssetSlots,
  type dramaImageFields,
  settleDramaImageParams,
} from "../../../packages/link-studio-core/src/drama-image-params.ts";
import {
  type DramaPromptEntry,
  type DramaSkillSnapshot,
  type PromptSnapshots,
  type PromptStep,
  promptSteps,
} from "../../../packages/link-studio-core/src/drama-prompts.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import type { ProviderView } from "../../../packages/link-studio-core/src/settings-api.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import type { DramaDraft } from "./drama-drafts.ts";
import { assetModel, type dramaImageModels, switchDramaAssetModels } from "./drama-image-models.ts";
import {
  checkDramaModelCapacity,
  importPastedDrama,
  preflightDramaSource,
} from "./drama-source.ts";
import { readDramaText, storeDramaText } from "./drama-source-blob.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

const key = "link-studio:drama";
function invalid(): never {
  throw new ProjectError("VALIDATION_FAILED", "短剧内容或参数无效");
}
function stale(): never {
  throw new ProjectError("AGENT_APPROVAL_STALE", "短剧已更改，请重新读取并确认");
}
function checkEpisodeLock(target: object, patch: object) {
  if ("locked" in target && target.locked === true && ("script_md" in patch || "synopsis" in patch))
    throw new ProjectError("DRAMA_EPISODE_LOCKED", "本集已拆解，剧本和梗概已锁定");
}
export function dramaDocument(state: ProjectState): DramaDocument | null {
  const value = state.extensions[key];
  if (value === undefined) return null;
  return Value.Check(DramaDocument, value) ? value : invalid();
}

type DramaSegment = NonNullable<DramaDocument["segments"]>[number];

function dramaAssetView(asset?: ProjectState["assets"][string] | null) {
  if (asset?.availability !== "ready") return null;
  return {
    id: asset.assetId,
    kind: asset.mediaType,
    mime_type: asset.mimeType,
    byte_size: asset.sizeBytes,
    width: asset.metadata.width ?? 0,
    height: asset.metadata.height ?? 0,
    duration_ms: asset.metadata.durationMs ?? 0,
    file_name: asset.displayName,
  };
}

export function segmentTakes(state: ProjectState, segment: DramaSegment) {
  return (segment.take_ids ?? []).flatMap((taskId) => {
    const job = state.jobs[taskId];
    if (
      !job ||
      typeof job !== "object" ||
      Array.isArray(job) ||
      job.kind !== "video" ||
      job.nodeId !== `seg:${segment.id}`
    )
      return [];
    const output = Array.isArray(job.outputs)
      ? job.outputs.find(
          (item) =>
            item && typeof item === "object" && !Array.isArray(item) && item.kind === "video",
        )
      : null;
    const asset =
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      typeof output.assetId === "string"
        ? state.assets[output.assetId]
        : null;
    const status = String(job.status);
    const statuses: Record<string, string> = {
      submitting: "pending",
      downloading: "finalizing",
      cancelled: "canceled",
      outcome_unknown: "failed",
    };
    return [
      {
        task_id: taskId,
        status: statuses[status] ?? status,
        error_message:
          (job.status === "failed" && typeof job.errorMessage === "string" && job.errorMessage) ||
          job.error ||
          "",
        created_at: job.createdAt,
        asset: dramaAssetView(asset),
      },
    ];
  });
}

export function bumpSegmentVersion(doc: DramaDocument, episodeNo: number) {
  const episode = doc.episodes.find((entry) => entry.episode_no === episodeNo);
  if (episode) episode.segment_version = (episode.segment_version ?? 0) + 1;
}

export async function setDramaSegmentSeconds(store: ProjectStore, input: unknown) {
  if (!Value.Check(SetDramaSegmentSeconds, input)) return invalid();
  return updateSegmentField(store, input);
}

export async function setDramaSegmentPrompt(store: ProjectStore, input: unknown) {
  if (!Value.Check(SetDramaSegmentPrompt, input)) return invalid();
  return updateSegmentField(store, input);
}

export async function deleteDramaSegment(store: ProjectStore, input: unknown) {
  if (!Value.Check(DeleteDramaSegment, input)) return invalid();
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    const target = doc?.segments?.find((segment) => segment.id === input.segmentId);
    if (
      !doc?.segments ||
      !target ||
      target.episode_no !== input.episodeNo ||
      (doc.episode_order ?? 0) !== input.episodeOrder
    )
      return stale();
    doc.segments = doc.segments.filter((segment) => segment.id !== target.id);
    bumpSegmentVersion(doc, input.episodeNo);
    for (const segment of doc.segments) {
      if (segment.episode_no !== input.episodeNo || segment.seq <= target.seq) continue;
      segment.seq--;
      segment.revision++;
      bumpSegmentVersion(doc, input.episodeNo);
    }
    doc.overview_revision ??= doc.revision;
    doc.revision++;
    return { changed: true, result: doc };
  });
}

export async function reorderDramaSegments(store: ProjectStore, input: unknown) {
  if (!Value.Check(ReorderDramaSegments, input)) return invalid();
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    if (!doc?.segments || (doc.episode_order ?? 0) !== input.episodeOrder) return stale();
    const ordered = doc.segments
      .filter((segment) => segment.episode_no === input.episodeNo)
      .sort((left, right) => left.seq - right.seq);
    if (
      ordered.length !== input.previous.length ||
      ordered.some((segment, index) => segment.id !== input.previous[index])
    )
      return stale();
    const byId = new Map(ordered.map((segment) => [segment.id, segment]));
    if (input.ids.length !== ordered.length || input.ids.some((id) => !byId.has(id)))
      return invalid();
    if (input.ids.every((id, index) => id === ordered[index]?.id))
      return { changed: false, result: doc };
    const next = input.ids.map((id, seq) => {
      const segment = requirePresent(byId.get(id), "byId.get(id)");
      if (segment.seq === seq) return segment;
      bumpSegmentVersion(doc, input.episodeNo);
      return { ...segment, seq, revision: segment.revision + 1 };
    });
    let index = 0;
    doc.segments = doc.segments.map((segment) =>
      segment.episode_no === input.episodeNo
        ? requirePresent(next[index++], "next[index++]")
        : segment,
    );
    doc.overview_revision ??= doc.revision;
    doc.revision++;
    return { changed: true, result: doc };
  });
}

function updateSegmentField(
  store: ProjectStore,
  input: typeof SetDramaSegmentPrompt.static | typeof SetDramaSegmentSeconds.static,
) {
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    const segment = doc?.segments?.find((entry) => entry.id === input.segmentId);
    if (
      !doc ||
      !segment ||
      segment.episode_no !== input.episodeNo ||
      (doc.episode_order ?? 0) !== input.episodeOrder ||
      segment.revision !== input.revision
    )
      return stale();
    if ("prompt" in input && input.format) {
      const adaptation = segment.adaptations?.[input.format];
      if (!adaptation) throw new ProjectError("VALIDATION_FAILED", "还没有这个格式的转写稿");
      adaptation.prompt = input.prompt;
      adaptation.edited = true;
      adaptation.updated_at = new Date().toISOString();
    } else if ("prompt" in input) {
      if (segment.prompt === input.prompt) return { changed: false, result: doc };
      segment.prompt = input.prompt;
    } else {
      if (segment.seconds === input.seconds) return { changed: false, result: doc };
      segment.seconds = input.seconds;
    }
    segment.revision++;
    doc.overview_revision ??= doc.revision;
    doc.revision++;
    return { changed: true, result: doc };
  });
}

export async function chooseDramaTake(
  store: ProjectStore,
  selection: { segmentId: string; taskId: string; revision: number },
) {
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    const segment = doc?.segments?.find((entry) => entry.id === selection.segmentId);
    if (!doc || !segment || segment.revision !== selection.revision) return stale();
    if (
      !segmentTakes(state, segment).some(
        (take) => take.task_id === selection.taskId && take.status === "succeeded",
      )
    )
      throw new ProjectError("VALIDATION_FAILED", "只能采用本片段已成功的视频");
    if (segment.chosen_task_id !== selection.taskId) bumpSegmentVersion(doc, segment.episode_no);
    segment.chosen_task_id = selection.taskId;
    segment.revision++;
    doc.overview_revision ??= doc.revision;
    doc.revision++;
    return { changed: true, result: doc };
  });
}
type SkillReader = (step: PromptStep, name: string) => DramaSkillSnapshot | undefined;

function snapshotPrompt(
  snapshots: PromptSnapshots,
  step: PromptStep,
  id: string,
  entries: DramaPromptEntry[],
  skill?: SkillReader,
) {
  if (id.startsWith("skill:")) {
    const snapshot = step !== "board" && skill?.(step, id.slice("skill:".length));
    if (!snapshot)
      throw new ProjectError("VALIDATION_FAILED", "所选技能不再适用于此环节，请重新选择");
    snapshots[step] = snapshot;
    return;
  }
  const selected = entries.find((entry) => entry.id === id && entry.step === step);
  if (!selected) throw new ProjectError("VALIDATION_FAILED", "所选提示词已删除，请重新选择");
  snapshots[step] = { ...selected };
}

export async function createDrama(
  store: ProjectStore,
  source: DramaSource,
  images: ReadonlyArray<{ id: string; fields?: ReturnType<typeof dramaImageFields> }> = [],
  videos: ReadonlyArray<{ id: string }> = [],
  library: () => DramaPromptEntry[] = () => [],
  skill?: SkillReader,
  model?: { id: string; revision: number },
  draft?: () => Omit<DramaDraft, "text"> & { draftToken: string },
) {
  return store.updateGeneration(async (state) => {
    if (dramaDocument(state)) return stale();
    if (!source.title.trim() || !source.script.trim()) return invalid();
    const snapshots: PromptSnapshots = {};
    if (source.prompts) {
      const entries = library();
      for (const step of promptSteps) {
        if ((step === "plan" || step === "scripts") && source.sourceKind !== "novel") continue;
        const id = source.prompts[step];
        if (!id) continue;
        snapshotPrompt(snapshots, step, id, entries, skill);
      }
    }
    const picks = source.imageModels;
    const selected = Object.values(picks ?? {}).filter(Boolean);
    if (selected.some((id) => !images.some((model) => model.id === id)))
      throw new ProjectError("VALIDATION_FAILED", "所选图片模型不可用，请重新选择");
    if (source.videoModel && !videos.some((model) => model.id === source.videoModel))
      throw new ProjectError("VALIDATION_FAILED", "所选视频模型不可用，请重新选择");
    for (const slot of dramaAssetSlots) {
      const params = source.imageParams?.[slot];
      if (!picks?.[slot]) continue;
      const fields = images.find((model) => model.id === picks[slot])?.fields;
      if (
        (params?.aspectRatio && !fields?.ratios.includes(params.aspectRatio)) ||
        (params?.resolution && !fields?.resolutions.includes(params.resolution))
      )
        throw new ProjectError(
          "VALIDATION_FAILED",
          `${{ character: "人物", scene: "场景", prop: "物品" }[slot]}图片参数不可用，请重新选择`,
        );
    }
    const novel = source.sourceKind === "novel";
    const imported = novel
      ? { ...preflightDramaSource(source.script, "novel"), episodes: [] }
      : importPastedDrama(source.script, source.episodeSeconds);
    const end = source.rangeEnd || imported.source.total;
    if (novel && (!model || end < 1 || end > imported.source.total)) return invalid();
    const styleKey = source.styleKey ?? defaultDramaStyle;
    const styleCustom = styleKey === "custom" ? (source.styleCustom?.trim() ?? "") : "";
    if (styleKey === "custom" && (!styleCustom || Array.from(styleCustom).length > 500))
      throw new ProjectError("VALIDATION_FAILED", "自定义画风须为1至500字");
    if (styleKey !== "custom" && !dramaStyles.styles.some((style) => style.key === styleKey))
      throw new ProjectError("VALIDATION_FAILED", "画风不存在");
    const doc: DramaDocument = {
      title: source.title.trim(),
      revision: 1,
      overview_revision: 1,
      outline_md: "",
      characters_md: "",
      episode_seconds: source.episodeSeconds ?? 60,
      ratio: source.ratio ?? "9:16",
      genre: source.genre ?? "",
      style_key: styleKey,
      style_custom: styleCustom,
      ...(source.videoModel && { video_model: source.videoModel }),
      ...(source.imageParams && { image_params: source.imageParams }),
      ...(Object.keys(snapshots).length && { prompt_snapshots: snapshots }),
      ...((source.textModel || selected.length || snapshots.board) && {
        board_settings: {
          textModel: source.textModel ?? "",
          characterModel: picks?.character ?? "",
          propModel: picks?.prop ?? "",
          sceneModel: picks?.scene ?? "",
          boardModel: "",
          ...(snapshots.board && { template: snapshots.board.body }),
        },
      }),
      episodes: imported.episodes,
      ...(novel &&
        model && {
          planning: {
            model,
            phase: "running",
            cursor: 0,
            end,
            summary: "",
            pause_reason: "",
            pause_code: "",
          },
        }),
      source: {
        ...imported.source,
        ...(await storeDramaText(store.directory, imported.source.text)),
        ...draft?.(),
      },
    };
    if (!Value.Check(DramaDocument, doc)) return invalid();
    state.extensions[key] = doc;
    return { result: doc, changed: true };
  });
}
export async function addDramaEpisode(store: ProjectStore, input: unknown) {
  if (!Value.Check(AddDramaEpisode, input) || !input.title.trim()) return invalid();
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    if (!doc || doc.revision !== input.revision) return stale();
    if (doc.planning?.phase === "running")
      throw new ProjectError("VALIDATION_FAILED", "正在规划，完成或暂停后再新增");
    const episode_no = doc.episodes.reduce((next, ep) => Math.max(next, ep.episode_no + 1), 1);
    if (episode_no > 100000) throw new ProjectError("VALIDATION_FAILED", "集号不能超过100000");
    doc.episodes.push({
      episode_no,
      title: input.title.trim(),
      script_md: input.script_md.trim(),
      synopsis: "",
      revision: 1,
      script_status: input.script_md.trim() ? "ready" : "empty",
      updated_at: new Date().toISOString(),
    });
    doc.overview_revision ??= doc.revision;
    doc.revision++;
    state.extensions[key] = doc;
    return { result: doc, changed: true };
  });
}
export async function editDramaField(store: ProjectStore, input: unknown) {
  if (!Value.Check(EditDramaField, input)) return invalid();
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    if (!doc) return stale();
    if ("episode_no" in input) {
      const episode = doc.episodes.find((item) => item.episode_no === input.episode_no);
      if (
        !episode ||
        input.episodeOrder !== (doc.episode_order ?? 0) ||
        (episode[input.field] ?? "") !== input.previous
      )
        return stale();
      const writing = doc.jobs?.some((job) => episodeScriptPhase(job, episode.episode_no));
      if (episode.locked || writing)
        throw new ProjectError("DRAMA_STEP_NOT_READY", "本集已锁定或正在生成");
      episode[input.field] = input.value;
      episode.revision = (episode.revision ?? 1) + 1;
      episode.updated_at = new Date().toISOString();
    } else {
      if (doc[input.field] !== input.previous) return stale();
      if (input.field !== "title" && doc.planning && doc.planning.phase !== "done")
        throw new ProjectError("DRAMA_STEP_NOT_READY", "请先完成小说规划");
      doc[input.field] = input.value;
    }
    doc.overview_revision =
      (doc.overview_revision ?? doc.revision) + ("episode_no" in input ? 0 : 1);
    doc.revision++;
    state.extensions[key] = doc;
    return { changed: true, result: doc };
  });
}

export async function saveDramaScript(store: ProjectStore, input: unknown) {
  if (!Value.Check(SaveDramaScript, input)) return invalid();
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state),
      episode = doc?.episodes.find((item) => item.episode_no === input.episode_no);
    if (
      !doc ||
      !episode ||
      (episode.revision ?? 1) !== input.revision ||
      (doc.episode_order ?? 0) !== (input.episodeOrder ?? 0)
    )
      return stale();
    checkEpisodeLock(episode, { script_md: input.script_md });
    if (doc.jobs?.some((job) => episodeScriptPhase(job, input.episode_no)))
      throw new ProjectError("VALIDATION_FAILED", "正在生成这一集的剧本");
    episode.revision = input.revision + 1;
    episode.script_md = input.script_md;
    episode.script_status = input.script_md.trim() ? "ready" : "empty";
    episode.updated_at = new Date().toISOString();
    doc.overview_revision ??= doc.revision;
    doc.revision++;
    state.extensions[key] = doc;
    return { result: doc, changed: true };
  });
}
export async function deleteDramaEpisode(store: ProjectStore, input: unknown) {
  if (!Value.Check(DeleteDramaEpisode, input)) return invalid();
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state),
      no = input.episode_no;
    if (
      !doc ||
      (doc.episode_order ?? 0) !== input.episodeOrder ||
      !doc.episodes.some((item) => item.episode_no === no)
    )
      return stale();
    const blocked = dramaDeleteBlocked(doc);
    if (blocked) throw new ProjectError("DRAMA_JOB_CONFLICT", blocked);
    const operations: CanvasOperation[] = [];
    for (const node of projectCanvas(state.canvas).nodes) {
      if (node.type !== "creative" || !node.data.drama?.episodes?.some((number) => number >= no))
        continue;
      const episodes = node.data.drama.episodes
        .filter((number) => number !== no)
        .map((number) => (number > no ? number - 1 : number));
      operations.push({
        type: "putNode",
        node: {
          ...node,
          data: {
            ...node.data,
            drama: { ...node.data.drama, episodes: episodes.length ? episodes : null },
          },
        },
      });
    }
    if (operations.length) state.canvas = applyCanvas(state, operations);
    doc.episodes = doc.episodes.filter((item) => item.episode_no !== no);
    for (const item of doc.episodes)
      if (item.episode_no > no) {
        item.episode_no--;
        item.revision = (item.revision ?? 1) + 1;
      }
    if (doc.segments) {
      doc.segments = doc.segments.filter((item) => item.episode_no !== no);
      for (const item of doc.segments) if (item.episode_no > no) item.episode_no--;
    }
    doc.episode_order = input.episodeOrder + 1;
    doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
    doc.revision++;
    return { result: doc, changed: true };
  });
}
export async function updateDramaBoardSettings(
  store: ProjectStore,
  input: unknown,
  models: ReturnType<typeof dramaImageModels>,
  agents: (Pick<ProviderView, "id" | "config"> & { revision?: number })[] = [],
  library: () => DramaPromptEntry[] = () => [],
  skill?: SkillReader,
) {
  if (!Value.Check(UpdateDramaBoardSettings, input)) return invalid();
  const problem =
    input.settings.template !== undefined && boardTemplateError(input.settings.template);
  if (problem) throw new ProjectError("VALIDATION_FAILED", problem);
  return store.updateGeneration(async (state) => {
    const doc = dramaDocument(state);
    if (!doc || (doc.board_settings_revision ?? 1) !== input.revision) return stale();
    const current = doc.board_settings;
    const settings = { ...input.settings };
    const snapshots = { ...doc.prompt_snapshots };
    const changedSteps = promptSteps.filter(
      (step) =>
        input.prompts?.[step] !== undefined &&
        input.prompts[step] !== (snapshots[step]?.id ?? null),
    );
    const entries = changedSteps.some((step) => input.prompts?.[step]) ? library() : [];
    for (const step of changedSteps) {
      if ((step === "plan" || step === "scripts") && !doc.planning && input.prompts?.[step])
        return invalid();
      const id = input.prompts?.[step];
      if (id) {
        snapshotPrompt(snapshots, step, id, entries, skill);
      } else delete snapshots[step];
    }
    if (input.prompts?.board !== undefined || snapshots.board) {
      if (snapshots.board) settings.template = snapshots.board.body;
      else delete settings.template;
    }
    const types = ["character", "scene", "prop"] as const;
    const changed =
      types.some((type) => assetModel(current, type) !== assetModel(input.settings, type)) ||
      (current?.boardModel ?? "") !== input.settings.boardModel;
    const textChanged = (current?.textModel ?? "") !== (input.settings.textModel ?? "");
    if (!changed && !textChanged && !changedSteps.length && current?.template === settings.template)
      return { changed: false, result: doc };
    if (textChanged) {
      const model = agents.find((model) => model.id === input.settings.textModel) ?? agents[0];
      if (!model) throw new ProjectError("DRAMA_NO_TEXT_MODEL", "暂无可用的 Agent 模型");
      checkDramaModelCapacity(
        doc,
        model.config?.contextWindow,
        doc.source && (await readDramaText(doc.source, store.directory)),
      );
      if (doc.planning) {
        if (!model.revision) return invalid();
        if (doc.planning.pending) doc.planning.pending.model ??= doc.planning.model;
        doc.planning.model = { id: model.id, revision: model.revision };
      }
    }
    if (changed) {
      const selected = [
        ...types.map((type) => assetModel(input.settings, type)),
        input.settings.boardModel,
      ];
      if (selected.some((id) => id && !models.some((model) => model.id === id)))
        throw new ProjectError("VALIDATION_FAILED", "所选图片模型不可用，请重新选择");
      switchDramaAssetModels(state, current, input.settings, models);
      for (const slot of types) {
        const picks = doc.image_params?.[slot];
        const id = assetModel(input.settings, slot);
        if (!picks || !doc.image_params || id === assetModel(current, slot)) continue;
        const fields = (id ? models.find((model) => model.id === id) : models[0])?.fields;
        const params = fields && settleDramaImageParams(fields, slot, picks);
        if (params && Object.keys(params).length) doc.image_params[slot] = params;
        else delete doc.image_params[slot];
      }
    }
    if (Object.keys(snapshots).length) doc.prompt_snapshots = snapshots;
    else delete doc.prompt_snapshots;
    doc.board_settings = settings;
    doc.board_settings_revision = input.revision + 1;
    doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
    doc.revision++;
    return { changed: true, result: doc };
  });
}
export function resolveDramaAssistantContext(
  state: ProjectState,
  context: DramaAgentContext,
): DramaAgentSnapshot {
  const doc = dramaDocument(state);
  const episode = doc?.episodes.find((entry) => entry.episode_no === context.episodeNo);
  const segment = doc?.segments?.find((entry) => entry.id === context.segmentId);
  const asset = context.assetId
    ? projectCanvas(state.canvas).nodes.find((node) => node.id === context.assetId)
    : undefined;
  const assetMeta =
    asset?.type === "creative" && !asset.data.director && dramaAssetMeta(asset.data);
  if (
    !doc ||
    (context.episodeNo !== undefined && !episode) ||
    ((context.episodeNo !== undefined || context.segmentId) &&
      context.episodeOrder !== (doc.episode_order ?? 0)) ||
    (context.segmentId && (!segment || (episode && segment.episode_no !== episode.episode_no))) ||
    (context.assetId &&
      (!assetMeta ||
        (episode &&
          assetMeta.episodes?.length &&
          !assetMeta.episodes.includes(episode.episode_no))))
  )
    throw new ProjectError("DRAMA_ASSISTANT_CONTEXT_STALE", "引用已变更，请重新选择后发送");
  return {
    ...context,
    ...(context.segmentId && segment && { segmentNumber: segment.seq + 1 }),
    ...(assetMeta && { assetName: assetMeta.name }),
  };
}

function dramaAssistantAssets(state: ProjectState) {
  return projectCanvas(state.canvas).nodes.flatMap((node) => {
    if (node.type !== "creative" || node.data.director) return [];
    const meta = dramaAssetMeta(node.data);
    return meta ? [{ node, meta }] : [];
  });
}

export class DramaTools {
  private reads = new Map<string, Map<string, number | string>>();
  async command(
    store: ProjectStore,
    command: string,
    args: { runId: string; input: unknown; kind?: unknown; id?: unknown },
    signal?: AbortSignal,
  ) {
    const snapshot = store.snapshot;
    const doc = dramaDocument(snapshot);
    if (!doc) throw new ProjectError("AGENT_SCOPE_DENIED", "未创建短剧");
    if (command === "drama-prepare") return { title: doc.title };
    const { runId, input, kind } = args;
    const readKey = JSON.stringify([store.directory, runId]);
    const remember = (scope: string, revision: number | string) => {
      if (this.reads.size >= 512 && !this.reads.has(readKey))
        this.reads.delete(this.reads.keys().next().value ?? "");
      const scopes = this.reads.get(readKey) ?? new Map<string, number | string>();
      scopes.set(scope, revision);
      this.reads.set(readKey, scopes);
    };
    if (command === "drama-read") {
      if (!Value.Check(DramaRead, input)) return invalid();
      const ep = doc.episodes.find((entry) => entry.episode_no === input.episode_no);
      if ((input.episode_no !== undefined || ["episode", "segments"].includes(input.scope)) && !ep)
        return invalid();
      if (input.scope === "jobs") {
        return (doc.jobs ?? [])
          .filter(
            (job) =>
              (!input.job_id || job.id === input.job_id) &&
              (!ep ||
                ((job.episode_order ?? 0) === (doc.episode_order ?? 0) &&
                  job.episodes.includes(ep.episode_no))),
          )
          .slice(-30)
          .reverse()
          .map(
            ({
              id,
              step,
              status,
              episodes,
              progress,
              error_message,
              prompt_error,
              created_at,
            }) => ({
              id,
              step,
              status,
              episodes,
              progress,
              error_message,
              prompt_error,
              created_at,
            }),
          );
      }
      if (input.scope === "assets") {
        return dramaAssistantAssets(snapshot)
          .filter(
            ({ meta }) => !ep || !meta.episodes?.length || meta.episodes.includes(ep.episode_no),
          )
          .slice(0, 200)
          .map(({ node, meta }) => ({
            id: node.id,
            ...meta,
            has_prompt: !!node.data.text?.trim(),
          }));
      }
      if (input.scope === "asset") {
        const asset = dramaAssistantAssets(snapshot).find(({ node }) => node.id === input.asset_id);
        if (!asset) return invalid();
        const { node, meta } = asset;
        if (ep && meta.episodes?.length && !meta.episodes.includes(ep.episode_no)) return invalid();
        remember(`asset:${node.id}`, contentHash(node.data));
        return {
          id: node.id,
          ...meta,
          prompt: node.data.text ?? "",
          media: dramaAssetView(snapshot.assets[node.data.assetId ?? ""]),
        };
      }
      const segments = (doc.segments ?? [])
        .filter((segment) => segment.episode_no === ep?.episode_no)
        .sort((first, second) => first.seq - second.seq);
      if (input.scope === "overview") remember("overview", doc.overview_revision ?? doc.revision);
      else if (input.scope === "episode" && ep)
        remember(`episode:${doc.episode_order ?? 0}:${ep.episode_no}`, ep.revision ?? 1);
      else for (const segment of segments) remember(`segment:${segment.id}`, segment.revision);
      if (input.scope === "segments")
        return segments.map((segment) => {
          const takes = segmentTakes(snapshot, segment);
          const latest = takes.at(-1)?.status ?? "";
          let status =
            segment.chosen_task_id || takes.some((take) => take.status === "succeeded")
              ? "done"
              : "idle";
          if (["pending", "queued", "running", "finalizing"].includes(latest)) status = "running";
          if (latest === "failed") status = "error";
          const { take_ids, ...fields } = segment;
          return {
            ...fields,
            status,
            adaptations: segment.adaptations ?? {},
            takes,
            chosen_task_id: segment.chosen_task_id ?? "",
          };
        });
      const boardHashes = new Map<string, string>();
      for (const node of projectCanvas(snapshot.canvas).nodes) {
        if (node.type !== "creative" || !node.data.assetId) continue;
        const board = dramaBoardMeta(node.data);
        const asset = snapshot.assets[node.data.assetId];
        if (board && asset?.availability === "ready" && asset.mediaType === "image") {
          boardHashes.set(board.segmentId, board.sourceHash);
        }
      }
      const summary = (episode: DramaDocument["episodes"][number]) => {
        const items = (doc.segments ?? []).filter(
          (segment) => segment.episode_no === episode.episode_no,
        );
        return {
          no: episode.episode_no,
          title: episode.title,
          synopsis: episode.synopsis,
          revision: episode.revision ?? 1,
          locked: episode.locked ?? false,
          script_status: episode.script_status ?? (episode.script_md.trim() ? "ready" : "empty"),
          storyboard_status: episode.storyboard_status ?? "empty",
          final: dramaAssetView(snapshot.assets[episode.final_asset_id ?? ""]),
          final_stale:
            !!episode.final_asset_id && episode.segment_version !== episode.final_segment_version,
          unit_from: episode.unit_from ?? 0,
          unit_to: episode.unit_to ?? 0,
          hook: episode.hook ?? "",
          cliffhanger: episode.cliffhanger ?? "",
          segment_count: items.length,
          done_segment_count: items.filter((segment) => segment.chosen_task_id).length,
          done_board_count: items.filter(
            (segment) =>
              boardHashes.has(segment.id) &&
              boardHashes.get(segment.id) ===
                createHash("sha256").update(segment.prompt).digest("hex"),
          ).length,
          segment_seconds: items.reduce((seconds, segment) => seconds + segment.seconds, 0),
        };
      };
      return input.scope === "episode" && ep
        ? { ...summary(ep), script_md: ep.script_md }
        : {
            title: doc.title,
            text_model: doc.board_settings?.textModel ?? "",
            genre: doc.genre ?? "",
            style_key: doc.style_key ?? "",
            style_custom: doc.style_custom ?? "",
            video_model: doc.video_model ?? "",
            episode_seconds: doc.episode_seconds ?? 60,
            ratio: doc.ratio ?? "9:16",
            image_models: {
              character: assetModel(doc.board_settings, "character"),
              scene: assetModel(doc.board_settings, "scene"),
              prop: assetModel(doc.board_settings, "prop"),
              ...(doc.board_settings?.boardModel && { board: doc.board_settings.boardModel }),
            },
            revision: doc.overview_revision ?? doc.revision,
            outline_md: doc.outline_md,
            characters_md: doc.characters_md,
            active_jobs: [
              ...(doc.planning?.pending
                ? [
                    {
                      id: doc.planning.pending.id,
                      step: doc.planning.pending.step,
                      episodes: [],
                      status: "running",
                      created_at: doc.planning.pending.created_at,
                      lane: "pipeline",
                      batch_from:
                        doc.planning.pending.step === "plan" ? doc.planning.pending.from : 0,
                      batch_to: doc.planning.pending.step === "plan" ? doc.planning.pending.to : 0,
                      progress: doc.planning.pending.progress ?? 0,
                      credits: 0,
                      error_code: 0,
                      error_message: "",
                      started_at: doc.planning.pending.created_at,
                      finished_at: null,
                      result: null,
                    },
                  ]
                : []),
              ...(doc.jobs ?? [])
                .filter((job) => job.status === "queued" || job.status === "running")
                .map(({ id, step, episodes, status, created_at, progress = 0 }) => ({
                  id,
                  step,
                  episodes,
                  status,
                  created_at,
                  lane: "user",
                  batch_from: 0,
                  batch_to: 0,
                  progress,
                  credits: 0,
                  error_code: 0,
                  error_message: "",
                  started_at: null,
                  finished_at: null,
                  result: null,
                })),
            ],
            ...(doc.source && {
              source_kind: doc.planning ? "novel" : "script",
              source_chars: doc.source.chars,
              units_total: doc.source.total,
              unit_kind: doc.source.kind,
              phase: doc.planning?.phase ?? "done",
              status:
                doc.status ??
                (doc.planning ? (doc.planning.cursor ? "outlined" : "analyzing") : "ready"),
              plan_cursor: doc.planning?.cursor ?? doc.source.total,
              range_end: doc.planning?.end ?? doc.source.total,
              pause_code: doc.planning?.pause_code ?? "",
              pause_reason: doc.planning?.pause_reason ?? "",
            }),
            episodes: doc.episodes.map(summary),
          };
    }
    if (command === "drama-preview") {
      if (kind === "drama_update_asset_prompt") {
        if (!Value.Check(DramaEdits[kind], input)) return invalid();
        const asset = dramaAssistantAssets(snapshot).find(({ node }) => node.id === input.asset_id);
        if (!asset) return stale();
        const nodeVersion = contentHash(asset.node.data);
        if (this.reads.get(readKey)?.get(`asset:${input.asset_id}`) !== nodeVersion) return stale();
        return {
          title: `修改资产「${asset.meta.name}」的提示词`,
          assetId: asset.node.id,
          nodeVersion,
          reason: input.reason ?? "",
          before: { prompt: asset.node.data.text ?? "" },
          after: { prompt: input.prompt },
        };
      }
      const outline = kind === "drama_update_outline";
      const segment = kind === "drama_update_segment";
      if (!outline && !segment && kind !== "drama_update_episode") return invalid();
      if (!Value.Check(DramaEdits[kind], input)) return invalid();
      const currentSegment =
        "segment_id" in input
          ? doc.segments?.find((item) => item.id === input.segment_id)
          : undefined;
      const episode = "episode_no" in input ? input.episode_no : currentSegment?.episode_no;
      const original = outline
        ? doc
        : segment
          ? currentSegment
          : doc.episodes.find((entry) => entry.episode_no === episode);
      const read = this.reads.get(readKey);
      const scope = outline
        ? "overview"
        : segment
          ? `segment:${currentSegment?.id}`
          : `episode:${doc.episode_order ?? 0}:${episode}`;
      const targetRevision = outline
        ? (doc.overview_revision ?? doc.revision)
        : (original?.revision ?? 1);
      if (!original || read?.get(scope) !== targetRevision) return stale();
      const after = Object.fromEntries(
        Object.entries(input).filter(
          ([field]) => !["reason", "episode_no", "segment_id"].includes(field),
        ),
      );
      if (!Object.keys(after).length) return invalid();
      if (kind === "drama_update_episode") checkEpisodeLock(original, after);
      return {
        title: outline
          ? "修改短剧大纲与人物"
          : `修改第 ${episode} 集${currentSegment ? `片段 ${currentSegment.seq + 1}` : ""}`,
        ...(currentSegment && { segment_id: currentSegment.id }),
        revision: doc.revision,
        ...(doc.episode_order && { episodeOrder: doc.episode_order }),
        ...(outline ? { overviewRevision: targetRevision } : { targetRevision }),
        episode: episode ?? 0,
        reason: input.reason ?? "",
        before: Object.fromEntries(
          Object.keys(after).map((field) => [field, Reflect.get(original, field)]),
        ),
        after,
      };
    }
    if (
      (command !== "drama-apply" && command !== "drama-receipt") ||
      typeof args.id !== "string" ||
      !args.id ||
      !input ||
      typeof input !== "object"
    )
      return invalid();
    const payload = input as {
      revision: number;
      targetRevision?: number;
      overviewRevision?: number;
      episodeOrder?: number;
      episode: number;
      segment_id?: string;
      assetId?: string;
      nodeVersion?: string;
      after: Record<string, unknown>;
    };
    const fingerprint = contentHash({ runId, kind, payload });
    const receipt = `drama:approval:${args.id}`;
    if (command === "drama-receipt")
      return store.snapshot.extensions[receipt] === fingerprint ? { applied: true } : null;
    return store.updateGeneration((state) => {
      const current = dramaDocument(state);
      if (!current) return stale();
      if (state.extensions[receipt] === fingerprint)
        return { result: { applied: true }, changed: false };
      if (kind === "drama_update_asset_prompt") {
        const asset = dramaAssistantAssets(state).find(({ node }) => node.id === payload.assetId);
        if (
          state.extensions[receipt] !== undefined ||
          !asset ||
          contentHash(asset.node.data) !== payload.nodeVersion
        )
          return stale();
        const edit = { ...payload.after, asset_id: payload.assetId };
        if (!Value.Check(DramaEdits[kind], edit)) return invalid();
        const node = { ...asset.node, data: { ...asset.node.data, text: edit.prompt } };
        state.canvas = applyCanvas(state, [{ type: "putNode", node }]);
        state.extensions[receipt] = fingerprint;
        return { result: { applied: true }, changed: true };
      }
      if ((payload.episodeOrder ?? 0) !== (current.episode_order ?? 0)) return stale();
      if (
        state.extensions[receipt] !== undefined ||
        (payload.overviewRevision === undefined &&
          payload.targetRevision === undefined &&
          current.revision !== payload.revision)
      )
        return stale();
      const outline = kind === "drama_update_outline";
      const segment = kind === "drama_update_segment";
      if (!outline && !segment && kind !== "drama_update_episode") return invalid();
      const schema = DramaEdits[kind];
      const patch = payload.after;
      if (
        !patch ||
        !Object.keys(patch).length ||
        Object.keys(patch).some(
          (field) =>
            !(
              outline
                ? ["outline_md", "characters_md"]
                : segment
                  ? ["prompt", "seconds"]
                  : ["title", "synopsis", "script_md"]
            ).includes(field),
        ) ||
        !Value.Check(
          schema,
          outline
            ? patch
            : segment
              ? { ...patch, segment_id: payload.segment_id }
              : { ...patch, episode_no: payload.episode },
        )
      )
        return invalid();
      const currentSegment = segment
        ? current.segments?.find(
            (item) => item.id === payload.segment_id && item.episode_no === payload.episode,
          )
        : undefined;
      const target = segment
        ? currentSegment
        : outline
          ? current
          : current.episodes.find((ep) => ep.episode_no === payload.episode);
      if (
        !target ||
        (payload.targetRevision !== undefined && (target.revision ?? 1) !== payload.targetRevision)
      )
        return stale();
      const overviewRevision = current.overview_revision ?? current.revision;
      if (
        payload.overviewRevision !== undefined &&
        (!outline || overviewRevision !== payload.overviewRevision)
      )
        return stale();
      if (kind === "drama_update_episode") {
        checkEpisodeLock(target, patch);
        if (
          typeof patch.script_md === "string" &&
          current.jobs?.some((job) => episodeScriptPhase(job, payload.episode))
        )
          throw new ProjectError(
            "AGENT_APPROVAL_STALE",
            "正在生成这一集的剧本，请稍后重新申请审批",
          );
      }
      Object.assign(target, patch);
      if ("script_md" in target && typeof patch.script_md === "string") {
        target.script_status = patch.script_md.trim() ? "ready" : "empty";
        target.updated_at = new Date().toISOString();
      }
      if (!outline) target.revision = (target.revision ?? 1) + 1;
      current.overview_revision = overviewRevision + Number(outline);
      current.revision++;
      state.extensions[key] = current;
      state.extensions[receipt] = fingerprint;
      return { result: { applied: true }, changed: true };
    }, signal);
  }
}

export async function addDramaSegment(store: ProjectStore, input: unknown) {
  if (!Value.Check(AddDramaSegment, input)) return invalid();
  return store.updateGeneration((state) => {
    const doc = dramaDocument(state);
    if (!doc || doc.revision !== input.revision) return stale();
    if (
      !doc.episodes.some((ep) => ep.episode_no === input.episode_no) ||
      (doc.segments?.length ?? 0) >= 5000
    )
      return invalid();
    const segments = doc.segments ?? [];
    segments.push({
      id: randomBytes(16).toString("hex"),
      episode_no: input.episode_no,
      seq: segments.filter((item) => item.episode_no === input.episode_no).length,
      seconds: input.seconds,
      prompt: input.prompt?.trim() ?? "",
      revision: 1,
    });
    doc.segments = segments;
    bumpSegmentVersion(doc, input.episode_no);
    doc.overview_revision ??= doc.revision;
    doc.revision++;
    state.extensions[key] = doc;
    return { result: doc, changed: true };
  });
}
