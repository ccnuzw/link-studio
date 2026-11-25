import { createHash, randomInt, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Value } from "@sinclair/typebox/value";
import {
  type CanvasOperation,
  type CanvasShot,
  type CreativeData,
  type CreativeOutput,
  characterVoice,
  isPlainGeneratedMedia,
  maxStoryboardShots,
  restoreMediaVersion,
  validStoryboard,
} from "../../../packages/link-studio-core/src/canvas.ts";
import {
  defaultGenerationConcurrency,
  defaultGenerationQueueMultiplier,
  GenerationInput,
  type GenerationJob,
  type GenerationKind,
  type JobOutput,
  jobIsTerminal,
  missingJobBindingMessage,
  queueFullMessage,
} from "../../../packages/link-studio-core/src/generation.ts";
import {
  configuredGenerationInput,
  isPublicReferenceURL,
  mediaReferenceBytes,
  modelGenerationOptions,
} from "../../../packages/link-studio-core/src/media-generation.ts";
import {
  type ModelParameter,
  modelFanout,
  validCustomInput,
} from "../../../packages/link-studio-core/src/model-config.ts";
import type { JsonValue, ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { providerInput } from "../../../packages/link-studio-core/src/provider-input.ts";
import type { ReferenceMedia } from "../../../packages/provider-runtime/src/host.ts";
import { ProviderError, record } from "../../../packages/provider-runtime/src/runner.ts";
import { hasPendingReference, linkedMediaSources } from "../../shared/media-references";
import {
  type JobPrice,
  readTokenUsage,
  settleJobCredits,
  type TokenUsage,
} from "../generation-credits";
import { agentDeadlineMs, probeAgentStream } from "../settings/agent-model.ts";
import { openProviderResponse, providerTransport } from "../settings/network.ts";
import { providerPollDelay } from "../settings/provider-poll.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import type { AssetFiles } from "./asset-files.ts";
import type { AssetService, StagedAsset } from "./assets.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import { nodeGenerationInput, quotePreparedGeneration } from "./canvas-agent-generation";
import { checkApprovedRoleJobs, type RoleJob } from "./canvas-agent-references";
import { bumpSegmentVersion, dramaDocument } from "./drama.ts";
import { stageDramaBoard } from "./drama-boards.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

type StoredJob = GenerationJob &
  JobPrice & {
    previousBoardOutput?: string;
    version: 1;
    input: GenerationInput;
    requestHash: string;
    batchIds?: string[];
    batchRoot?: string;
    channelId?: string;
    nodeHash: string;
    mediaBindingHash?: string;
    pluginHash: string;
    providerTaskId?: string;
    providerState?: JsonValue;
    pollAfter?: number;
    pollAttempts?: number;
    submitRetries?: number;
    transferAttempts?: number;
    deadline?: number;
  };

const outputLimit = 256 * 1024 * 1024;
const deviceQueueLimit = defaultGenerationConcurrency * defaultGenerationQueueMultiplier;
const inlineImageLimit = 12 * 1024 * 1024;
const mimeExtensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
};

const mimeAliases: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "application/ogg": "audio/ogg",
};

function mediaMime(contentType?: string, fallback?: string) {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!type || type === "application/octet-stream" || type === "binary/octet-stream")
    return fallback ?? "";
  return mimeAliases[type] ?? type;
}

function recheckableBindings(state: ProjectState) {
  return jobs(state)
    .filter((job) => job.status === "outcome_unknown" && job.canRecheck && job.providerTaskId)
    .map((job) => job.id);
}

function jobs(state: ProjectState): StoredJob[] {
  return Object.values(state.jobs).filter(
    (value): value is JsonValue & StoredJob =>
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.version === 1 &&
      typeof value.id === "string" &&
      Value.Check(GenerationInput, value.input),
  );
}

export function activeMediaJobCount(state: ProjectState) {
  return jobs(state).filter((job) => !jobIsTerminal(job.status)).length;
}

function view(job: StoredJob): GenerationJob {
  const {
    id,
    nodeId,
    kind,
    providerLabel,
    model,
    status,
    progress,
    outputs,
    createdAt,
    updatedAt,
    error,
    bound,
    cancelRequested,
    canCancelRemote,
    canRecheck,
  } = job;
  return {
    id,
    nodeId,
    providerId: job.input.providerId,
    providerRevision: job.input.expectedProviderRevision,
    ...(job.modelKey !== undefined && { modelKey: job.modelKey }),
    ...(job.quotedCredits !== undefined && { quotedCredits: job.quotedCredits }),
    ...(job.settledCredits !== undefined && { settledCredits: job.settledCredits }),
    ...(job.batchRoot || job.batchIds ? { batchId: job.batchRoot ?? id } : {}),
    ...(job.unsubmittedCount && { unsubmittedCount: job.unsubmittedCount }),
    ...(job.input.purpose ? { purpose: job.input.purpose } : {}),
    ...(job.input.storyboardSplitMode && { storyboardSplitMode: job.input.storyboardSplitMode }),
    ...(job.storyboardShotIds && { storyboardShotIds: job.storyboardShotIds }),
    ...(job.input.afterImageJobId ? { afterImageJobId: job.input.afterImageJobId } : {}),
    ...(job.input.purpose === "character-voice" ? { voicePrompt: job.input.prompt } : {}),
    ...(outputs.some((output) => output.kind !== "text") && { outputPrompt: job.input.prompt }),
    ...(job.submittedAt && { submittedAt: job.submittedAt }),
    kind,
    providerLabel,
    model,
    status,
    progress,
    outputs,
    createdAt,
    updatedAt,
    error,
    bound,
    cancelRequested,
    canCancelRemote: canCancelRemote && !!job.providerTaskId,
    canRecheck,
    ...(status === "failed" && job.errorMessage && { errorMessage: job.errorMessage }),
  };
}

export function canvasRoleJobs(state: ProjectState): RoleJob[] {
  return jobs(state).map(({ nodeId, status, kind, createdAt, input }) => ({
    nodeId,
    status,
    kind,
    createdAt,
    purpose: input.purpose,
  }));
}

function put(state: ProjectState, job: StoredJob) {
  state.jobs[job.id] = JSON.parse(JSON.stringify(job));
}

function find(state: ProjectState, id: string) {
  const job = jobs(state).find((entry) => entry.id === id);
  if (!job) throw new ProjectError("JOB_NOT_FOUND", "生成任务不存在");
  return job;
}

function mediaBindingHash(data: CreativeData) {
  return isPlainGeneratedMedia(data)
    ? contentHash({
        kind: data.kind,
        assetId: data.assetId ?? null,
        activeOutputId: data.activeOutputId ?? null,
        ...(data.pendingMediaVersion && { pendingMediaVersion: data.pendingMediaVersion }),
      })
    : undefined;
}

function stageMediaVersion(
  data: CreativeData,
  batchId: string,
  now: string,
): CreativeData | undefined {
  if (!isPlainGeneratedMedia(data) || (!data.assetId && !data.pendingMediaVersion)) return;
  const outputs = data.outputs ?? [];
  const prior =
    data.activeOutputId ??
    data.pendingMediaVersion?.outputId ??
    outputs.find((output) => output.assetId === data.assetId)?.id;
  const outputId = prior ?? data.assetId;
  if (!outputId || data.kind === "script") return;
  const next = {
    ...data,
    pendingMediaVersion: { batchId, outputId },
    outputs: prior
      ? outputs
      : [
          ...outputs,
          { id: outputId, kind: data.kind, assetId: data.assetId, createdAt: now },
        ].slice(-50),
  };
  delete next.assetId;
  delete next.activeOutputId;
  return next;
}

function generationNodeHash(
  node: Extract<ReturnType<typeof projectCanvas>["nodes"][number], { type: "creative" }>,
) {
  return contentHash({
    kind: node.data.kind,
    label: node.data.label,
    text: node.data.text,
    ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    ...(node.data.character ? { character: node.data.character } : {}),
    ...(node.data.storyboard ? { storyboard: node.data.storyboard } : {}),
  });
}

export function parseStoryboardOutput(text: string): CanvasShot[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf("[");
  const end = source.lastIndexOf("]");
  if (start < 0 || end <= start) throw new ProviderError("JOB_OUTPUT_INVALID");
  let value: unknown;
  try {
    value = JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new ProviderError("JOB_OUTPUT_INVALID");
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > maxStoryboardShots) {
    throw new ProviderError("JOB_OUTPUT_INVALID");
  }
  const nearest = <T extends readonly string[]>(input: unknown, choices: T) => {
    const text = String(input ?? "").trim();
    return (
      choices.find((choice) => text === choice) ??
      [...choices]
        .sort((left, right) => right.length - left.length)
        .find((choice) => text.includes(choice)) ??
      ""
    );
  };
  const shotChoices = [
    "",
    "大远景",
    "远景",
    "全景",
    "中景",
    "中近景",
    "近景",
    "特写",
    "大特写",
  ] as const;
  const cameraChoices = [
    "",
    "固定",
    "推",
    "拉",
    "摇",
    "移",
    "跟",
    "升",
    "降",
    "环绕",
    "变焦",
    "甩镜",
    "手持",
    "航拍",
  ] as const;
  const shots = value
    .map((item, index) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const duration = Number(row.duration ?? 3);
      return {
        id: randomUUID(),
        scene: String(row.scene ?? row.visual ?? "").slice(0, 2000),
        shot: nearest(row.shot, shotChoices),
        camera: nearest(row.camera, cameraChoices),
        action: String(row.action ?? "").slice(0, 1000),
        dialogue: String(row.dialogue ?? "").slice(0, 1000),
        duration: Number.isFinite(duration)
          ? Math.max(1, Math.min(60, Number(duration.toFixed(1))))
          : 3,
        index,
      };
    })
    .map(({ index: _index, ...shot }) => shot);
  if (!validStoryboard(shots)) throw new ProviderError("JOB_OUTPUT_INVALID");
  return shots;
}

function appendOutputHistory(
  current: CreativeOutput[],
  additions: CreativeOutput[],
  activeOutputId?: string,
) {
  const known = new Set(current.map(({ id }) => id));
  const unique = additions.filter(({ id }, index) => {
    if (known.has(id) || additions.findIndex((item) => item.id === id) !== index) return false;
    known.add(id);
    return true;
  });
  const outputs = [...current, ...unique].slice(-50);
  const active = activeOutputId
    ? (outputs.find(({ id }) => id === activeOutputId) ?? outputs.at(-1))
    : undefined;
  return {
    outputs,
    ...(active ? { activeOutputId: active.id } : {}),
  };
}

function code(error: unknown) {
  return error instanceof ProviderError || error instanceof ProjectError
    ? error.code
    : "JOB_RUNTIME_FAILED";
}

export class GenerationService {
  private readonly reviewedRechecks = new WeakSet<ProjectStore>();
  private readonly active = new Map<
    ProjectStore,
    { controller: AbortController; done: Promise<void>; wake: boolean }
  >();

  constructor(
    private readonly registry: () => Promise<SettingsRegistry>,
    private readonly assets: AssetService,
    private readonly files: AssetFiles,
    private readonly pollFloor = 1000,
  ) {}

  list(store: ProjectStore) {
    const state = store.snapshot;
    return {
      jobs: jobs(state)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(view),
      revision: state.revision,
      canvasRevision: state.canvas.revision,
    };
  }

  async prepare(store: ProjectStore, input: GenerationInput, agentGeneration = false) {
    const registry = await this.registry();
    const state = store.snapshot;
    const result = this.validate(state, input, registry, agentGeneration);
    if (agentGeneration) {
      if (this.hasActiveJob(state, input))
        throw new ProjectError("JOB_INPUT_INVALID", "此节点已有生成任务");
      this.checkAgentGeneration(state, result);
    }
    if (!result.node) throw new ProjectError("JOB_INPUT_INVALID", "选择创作节点");
    return { ...result, node: result.node };
  }

  receipt(store: ProjectStore, ids: string[]) {
    const state = store.snapshot;
    const byId = new Map(jobs(state).map((job) => [job.id, job]));
    if (!ids.length || ids.some((id) => !byId.has(id))) return null;
    return {
      tasks: ids.flatMap((id) =>
        (byId.get(id)?.batchIds ?? [id]).map((member) => ({
          task_id: member,
          node_id: find(state, member).nodeId,
        })),
      ),
    };
  }

  private validate(
    state: ProjectState,
    input: GenerationInput,
    registry: SettingsRegistry,
    agentGeneration = false,
  ) {
    if (!Value.Check(GenerationInput, input) || !input.prompt.trim())
      throw new ProjectError("JOB_INPUT_INVALID", "检查生成参数");
    if (state.canvas.revision !== input.expectedCanvasRevision)
      throw new ProjectError("CANVAS_REVISION_CONFLICT", "画布已经变化");
    const isSegment = input.purpose === "drama-segment";
    const doc = isSegment ? dramaDocument(state) : null;
    const segment = doc?.segments?.find((entry) => `seg:${entry.id}` === input.nodeId);
    const graph = isSegment ? undefined : projectCanvas(state.canvas);
    const canvasNode = graph?.nodes.find(({ id }) => id === input.nodeId);
    const node = canvasNode?.type === "creative" ? canvasNode : undefined;
    if (isSegment) {
      if (
        !segment ||
        !doc?.episodes.find((episode) => episode.episode_no === segment.episode_no)?.locked
      )
        throw new ProjectError("DRAMA_STEP_NOT_READY", "媒体任务只允许已锁定的集");
      if (
        doc.jobs?.some(
          (job) =>
            ["queued", "running"].includes(job.status) &&
            ["storyboard", "compose"].includes(job.step) &&
            job.episodes.includes(segment.episode_no),
        )
      )
        throw new ProjectError("DRAMA_JOB_CONFLICT", "已有进行中的短剧任务");
    } else if (
      node?.type !== "creative" ||
      node.data.uploaded ||
      (input.purpose === "storyboard-split"
        ? node.data.kind !== "script" || !node.data.storyboard
        : node.data.storyboard || node.data.director)
    )
      throw new ProjectError("JOB_INPUT_INVALID", "选择创作节点");
    if (input.purpose === "character-voice" && !node?.data.character)
      throw new ProjectError("JOB_INPUT_INVALID", "音色生成需要角色卡");
    if (input.purpose === "storyboard-split" && !input.storyboardSplitMode)
      throw new ProjectError("JOB_INPUT_INVALID", "拆分镜需要指定覆盖或追加模式");
    const kind: GenerationKind =
      input.purpose === "character-voice"
        ? "audio"
        : !node
          ? "video"
          : node.data.kind === "script"
            ? "text"
            : node.data.kind;
    let binding: ReturnType<SettingsRegistry["agentBinding"]>;
    try {
      binding =
        input.purpose === "storyboard-split" ||
        (kind === "text" && registry.provider(input.providerId).config?.kind === "agent")
          ? registry.agentBinding(input.providerId, input.expectedProviderRevision)
          : registry.binding(input.providerId, input.expectedProviderRevision);
    } catch {
      throw new ProjectError("JOB_MODEL_UNAVAILABLE", "检查模型配置和凭证");
    }
    if (
      (binding.plugin?.kind ?? "text") !== kind ||
      (binding.origin === "gateway" && input.referenceAssetIds.length !== 0) ||
      (input.purpose === "storyboard-split" && !binding.profile.agentEnabled) ||
      (input.duration !== undefined && kind !== "video") ||
      (input.size !== undefined && kind !== "image" && kind !== "video")
    )
      throw new ProjectError("JOB_INPUT_INVALID", "模型能力与节点不匹配");
    const options = modelGenerationOptions(
      kind,
      binding.origin === "builtin" ? binding.plugin.key : undefined,
      binding.profile.model,
      binding.profile.channel,
      binding.profile.config,
    );
    if (!validCustomInput(binding.profile.config, input.customParams))
      throw new ProjectError("JOB_INPUT_INVALID", "检查自定义参数");
    input = configuredGenerationInput(binding.profile.config, input);
    if (!Value.Check(GenerationInput, input))
      throw new ProjectError("JOB_INPUT_INVALID", "检查模型默认参数");
    const action = input.videoAction;
    const durationInvalid =
      (action === undefined &&
        input.duration !== undefined &&
        input.duration !== -1 &&
        (options.durations.length > 0 || binding.profile.config?.params?.duration) &&
        !options.durations.includes(input.duration)) ||
      (input.duration === -1 && !options.autoDuration) ||
      (input.duration !== undefined &&
        input.duration !== -1 &&
        options.durationRange !== undefined &&
        (input.duration < options.durationRange.min || input.duration > options.durationRange.max));
    if (input.afterImageJobId) {
      const parent = jobs(state).find(({ id }) => id === input.afterImageJobId);
      if (
        input.purpose !== "character-voice" ||
        !parent ||
        parent.nodeId !== node?.id ||
        parent.kind !== "image" ||
        parent.input.purpose ||
        input.referenceAssetIds.length ||
        (options.references.image && (options.referenceNeedsURL("image") || input.speaker))
      )
        throw new ProjectError("JOB_INPUT_INVALID", "音色模型需要支持直接读取本次生成的角色主图");
    }
    if (kind === "video" && options.modes && !input.op) {
      const mode = input.referenceAssetIds.length
        ? options.modes.find((entry) => entry === "i2v" || entry === "omni")
        : "t2v";
      if (mode) input = { ...input, op: mode };
    }
    const op = input.op;
    const mode =
      kind === "image"
        ? input.referenceAssetIds.length || options.requiresImage
          ? "i2i"
          : "t2i"
        : op;
    const pending =
      !input.purpose &&
      graph &&
      !input.referenceAssetIds.length &&
      hasPendingReference(
        linkedMediaSources(
          graph,
          input.nodeId,
          new Set(
            jobs(state)
              .filter((job) => !jobIsTerminal(job.status) && !job.purpose)
              .map((job) => job.nodeId),
          ),
        ),
        mode,
        options.references,
      );
    const emptyAgentMode =
      agentGeneration &&
      !input.purpose &&
      !input.referenceAssetIds.length &&
      ((mode === "omni" && options.omni) ||
        (mode === "i2v" && options.frameLimit > 0) ||
        (mode === "i2i" && !!options.references.image));
    if (
      Array.from(input.prompt.trim()).length > options.promptLimit ||
      (options.modes && (!mode || !options.modes.includes(mode))) ||
      (op !== undefined && kind !== "video") ||
      (op === "t2v" && input.referenceAssetIds.length > 0) ||
      (op === "omni" &&
        (!options.omni || (!input.referenceAssetIds.length && !pending && !emptyAgentMode))) ||
      (input.seed !== undefined && !options.seed) ||
      (input.negativePrompt !== undefined && !options.negativePrompt) ||
      (input.makeInstrumental !== undefined && !options.instrumental) ||
      (input.audioFormat !== undefined &&
        !options.audioFormats.some((format) => format === input.audioFormat)) ||
      (input.speaker !== undefined && (!options.speaker || input.referenceAssetIds.length > 0)) ||
      (!options.speaker &&
        [input.sampleRate, input.speechRate, input.loudnessRate, input.pitchRate].some(
          (value) => value !== undefined,
        )) ||
      (action !== undefined &&
        (!options.videoAction ||
          op !== "omni" ||
          input.aspectRatio !== undefined ||
          input.resolution !== undefined ||
          input.generateAudio !== undefined)) ||
      (action === "edit" && input.duration !== undefined) ||
      (action === "extend" &&
        input.duration !== undefined &&
        (input.duration < 2 || input.duration > 10)) ||
      (input.count !== undefined && !options.counts.includes(input.count)) ||
      (input.quality !== undefined &&
        !options.qualities.some((quality) => quality === input.quality)) ||
      (input.aspectRatio !== undefined && !options.ratios.includes(input.aspectRatio)) ||
      (input.resolution !== undefined && input.size !== undefined) ||
      (input.resolution !== undefined && !options.resolutions.includes(input.resolution)) ||
      (binding.plugin?.key === "vidu" &&
        binding.profile.model === "vidu2.0" &&
        input.duration === 8 &&
        input.resolution?.toLowerCase() !== "720p") ||
      (binding.plugin?.key === "alibaba-video" &&
        input.resolution?.toLowerCase() === "480p" &&
        /^(?:wan2\.[256]-t2v|wanx?2\.1-t2v)/i.test(binding.profile.model) &&
        (input.aspectRatio === "4:3" || input.aspectRatio === "3:4")) ||
      (input.generateAudio !== undefined && !options.audio) ||
      (input.aspectRatio !== undefined && input.size !== undefined) ||
      (input.size !== undefined &&
        (!options.manualSize || input.size === "auto") &&
        ![...options.sizes, ...options.largeSizes].includes(input.size)) ||
      durationInvalid ||
      input.referenceAssetIds.length > options.referenceLimit
    )
      throw new ProjectError(
        "JOB_INPUT_INVALID",
        durationInvalid
          ? `生成参数超出当前模型支持范围：时长 ${input.duration} 秒`
          : "生成参数超出当前模型支持范围",
      );
    for (const [id, url] of Object.entries(input.referenceURLs ?? {})) {
      if (!input.referenceAssetIds.includes(id) || !isPublicReferenceURL(url))
        throw new ProjectError("JOB_INPUT_INVALID", "参考素材链接须为可公开访问的 HTTPS 地址");
    }
    const counts = { image: 0, audio: 0, video: 0 };
    for (const id of input.referenceAssetIds) {
      const asset = state.assets[id];
      if (
        asset?.availability !== "ready" ||
        asset.sizeBytes > (options.referenceBytes[asset.mediaType] ?? mediaReferenceBytes) ||
        ++counts[asset.mediaType] > (options.references[asset.mediaType] ?? 0) ||
        (op === "i2v" && (asset.mediaType !== "image" || counts.image > options.frameLimit))
      )
        throw new ProjectError("JOB_INPUT_INVALID", "参考素材不可用或超过大小限制");
      if (
        !input.referenceURLs?.[id] &&
        !(
          binding.origin === "builtin" &&
          binding.plugin.key === "doubao-video" &&
          asset.mediaType === "image" &&
          registry.hasLinkedFilingReference(binding.profile.channelId, asset, state.projectId)
        ) &&
        (asset.sizeBytes > mediaReferenceBytes ||
          (options.referenceNeedsURL(asset.mediaType) && binding.origin === "builtin"))
      )
        throw new ProjectError("JOB_INPUT_INVALID", "此适配器需要参考素材的公网 HTTPS 链接");
    }
    if (
      ((op === "i2v" || options.requiresImage) && !counts.image && !pending && !emptyAgentMode) ||
      (options.requiresReference &&
        !input.referenceAssetIds.length &&
        !pending &&
        !emptyAgentMode) ||
      (options.requiresAudio && !counts.audio) ||
      (action !== undefined && (counts.video !== 1 || counts.image > 0 || counts.audio > 0)) ||
      (options.videoAction &&
        counts.video > 0 &&
        (counts.image > 0 ||
          counts.audio > 0 ||
          input.aspectRatio !== undefined ||
          input.resolution !== undefined ||
          input.generateAudio !== undefined ||
          (action !== "extend" && input.duration !== undefined))) ||
      (binding.plugin?.key === "xai" &&
        (op === "omni" || counts.image > 1 || counts.audio > 0) &&
        input.resolution?.toLowerCase() === "1080p")
    )
      throw new ProjectError("JOB_INPUT_INVALID", "参考素材或参数与生成方式不匹配");
    return { node, segment, kind, binding, input };
  }

  async submit(
    store: ProjectStore,
    entries: { id: string; input: GenerationInput }[],
    signal?: AbortSignal,
    agentGeneration = false,
  ) {
    const registry = await this.registry();
    const result = await store.updateGeneration((state) => {
      let changed = false;
      let available = Math.max(
        0,
        deviceQueueLimit -
          registry.activeGenerationCountOutside(store.projectId) -
          jobs(state).filter((job) => !jobIsTerminal(job.status)).length,
      );
      const bindings: {
        job: string;
        profile: ReturnType<SettingsRegistry["binding"]>["profile"];
      }[] = [];
      const stagedVersions: CanvasOperation[] = [];
      const result = entries.flatMap(({ id, input }) => {
        const requestHash = contentHash(input);
        const previous = jobs(state).find((job) => job.id === id);
        if (previous) {
          if (previous.requestHash !== requestHash || previous.batchRoot)
            throw new ProjectError("OPERATION_ID_REUSED", "生成请求与原提交不一致");
          if (!previous.unsubmittedCount || !available)
            return (previous.batchIds ?? [id]).map((member) => view(find(state, member)));
        }
        if (!previous && this.hasActiveJob(state, input))
          throw new ProjectError("JOB_INPUT_INVALID", "此节点已有生成任务");
        if (agentGeneration && !previous && input.expectedCanvasRevision < state.canvas.revision) {
          const current = nodeGenerationInput(
            projectCanvas(state.canvas),
            state.canvas.revision,
            input.nodeId,
            state.assets,
            registry.list(),
            canvasRoleJobs(state),
          );
          if (
            contentHash({ ...current, expectedCanvasRevision: input.expectedCanvasRevision }) !==
            requestHash
          )
            throw new ProjectError(
              "CANVAS_REVISION_CONFLICT",
              "待发送内容或模型绑定已变化，请重新申请生成",
            );
          input = current;
        }
        const previousBoardOutput =
          input.purpose === "drama-board" && !previous
            ? stageDramaBoard(state, input)
            : previous?.previousBoardOutput;
        const validated = this.validate(
          state,
          previous || input.purpose === "drama-board"
            ? { ...input, expectedCanvasRevision: state.canvas.revision }
            : input,
          registry,
          agentGeneration,
        );
        if (agentGeneration && !previous) this.checkAgentGeneration(state, validated);
        const { node, segment, kind, binding, input: configured } = validated;
        const quotedCredits = quotePreparedGeneration(
          binding.profile.config,
          kind,
          configured,
          state.assets,
        );
        const pricing = binding.profile.config?.pricing;
        const { key, count } = modelFanout(binding.profile.config, {
          ...configured,
          ...configured.customParams,
        });
        if (key) {
          if (configured.customParams && Object.hasOwn(configured.customParams, key))
            delete configured.customParams[key];
          else delete configured[key as ModelParameter];
        }
        const existingIds = previous?.batchIds ?? [];
        const accepted = Math.min(count - existingIds.length, available);
        if (!accepted) throw new ProjectError("JOB_QUEUE_FULL", queueFullMessage);
        available -= accepted;
        const newIds = Array.from({ length: accepted }, (_, index) =>
          existingIds.length || index ? randomUUID() : id,
        );
        const memberIds = [...existingIds, ...newIds];
        const missing = count - memberIds.length;
        const now = new Date().toISOString();
        let stagedVersion =
          node && !previous && !input.purpose ? stageMediaVersion(node.data, id, now) : undefined;
        if (
          node &&
          !previous &&
          !input.purpose &&
          kind === "text" &&
          !node.data.storyboard &&
          !node.data.director
        ) {
          stagedVersion = { ...node.data, text: "", textStatus: "idle" };
          delete stagedVersion.textError;
          delete stagedVersion.textFailureTask;
          delete stagedVersion.activeOutputId;
        }
        if (node && stagedVersion)
          stagedVersions.push({ type: "putNode", node: { ...node, data: stagedVersion } });
        const job: StoredJob = {
          version: 1,
          ...(previousBoardOutput && { previousBoardOutput }),
          id,
          input: { ...configured, prompt: registry.redact(configured.prompt) },
          providerId: configured.providerId,
          providerRevision: configured.expectedProviderRevision,
          requestHash,
          nodeId: input.nodeId,
          nodeHash:
            previous?.nodeHash ??
            (node
              ? generationNodeHash(
                  stagedVersion && kind === "text" ? { ...node, data: stagedVersion } : node,
                )
              : contentHash(input.nodeId)),
          mediaBindingHash: previous
            ? previous.mediaBindingHash
            : node && !input.purpose
              ? mediaBindingHash(stagedVersion ?? node.data)
              : undefined,
          pluginHash: binding.profile.pluginHash,
          channelId: binding.profile.channelId,
          providerLabel: binding.profile.label,
          modelKey: binding.profile.modelKey ?? configured.providerId,
          quotedCredits,
          ...(quotedCredits !== undefined &&
            pricing?.unit === "token" && {
              tokenRates: { input: pricing.input, output: pricing.output ?? 0 },
            }),
          model: binding.profile.config?.name ?? binding.profile.model,
          kind,
          status: "queued",
          progress: 0,
          outputs: [],
          createdAt: now,
          updatedAt: now,
          canCancelRemote: binding.plugin?.hooks.includes("buildCancelRequest") ?? false,
          canRecheck: false,
        };
        changed = true;
        if (segment) segment.take_ids = [...(segment.take_ids ?? []), ...newIds];
        if (previous)
          put(state, { ...previous, batchIds: memberIds, unsubmittedCount: missing || undefined });
        for (const memberId of newIds) {
          const member = { ...job, id: memberId };
          if (count > 1) {
            if (memberId === id) {
              member.batchIds = memberIds;
              if (missing) member.unsubmittedCount = missing;
            } else member.batchRoot = id;
            if (configured.seed === undefined && configured.customParams?.seed === undefined)
              member.input = { ...job.input, seed: randomInt(1, 2147483648) };
          }
          put(state, member);
          bindings.push({ job: memberId, profile: binding.profile });
        }
        return memberIds.map((member) => view(find(state, member)));
      });
      if (changed) {
        if (stagedVersions.length) state.canvas = applyCanvas(state, stagedVersions);
        for (const binding of bindings)
          registry.rememberJobBinding(store.projectId, binding.job, binding.profile);
        registry.reconcileJobPins(
          store.projectId,
          jobs(state).filter((job) => !jobIsTerminal(job.status)),
          recheckableBindings(state),
        );
      }
      return { result, changed };
    }, signal);
    if (!signal?.aborted) this.start(store);
    return result;
  }

  async retryCharacterImage(
    store: ProjectStore,
    id: string,
    operationId: string,
    expectedCanvasRevision: number,
  ) {
    const state = store.snapshot;
    const failed = find(state, id);
    const node = projectCanvas(state.canvas).nodes.find((item) => item.id === failed.nodeId);
    if (
      failed.status !== "failed" ||
      failed.kind !== "image" ||
      node?.type !== "creative" ||
      !node.data.character
    )
      throw new ProjectError("JOB_INPUT_INVALID", "只能重试角色卡上失败的形象任务");
    const [job] = await this.submit(store, [
      {
        id: operationId,
        input: {
          ...failed.input,
          prompt: node.data.text.trim() || failed.input.prompt,
          expectedCanvasRevision,
        },
      },
    ]);
    return job;
  }

  async cancel(store: ProjectStore, id: string) {
    const result = await store.updateGeneration((state) => {
      const job = find(state, id);
      if (jobIsTerminal(job.status) || job.cancelRequested)
        return { result: view(job), changed: false };
      if (job.status === "queued") job.status = "cancelled";
      else if (job.status === "running" && job.canCancelRemote && job.providerTaskId)
        job.cancelRequested = true;
      else throw new ProjectError("JOB_CANNOT_CANCEL", "此阶段或供应商不支持取消");
      job.updatedAt = new Date().toISOString();
      put(state, job);
      if (job.status === "cancelled") this.restoreCancelledVersion(state, job);
      return { result: view(job), changed: true };
    });
    this.start(store);
    return result;
  }

  async recheck(store: ProjectStore, id: string) {
    const result = await this.patch(store, id, (job, state) => {
      if (job.status === "outcome_unknown" && job.error === "JOB_ORIGINAL_BINDING_MISSING")
        throw new ProjectError("JOB_CANNOT_RECHECK", missingJobBindingMessage);
      if (job.status !== "outcome_unknown" || !job.canRecheck || !job.providerTaskId)
        throw new ProjectError("JOB_CANNOT_RECHECK", "缺少可查询的供应商任务");
      if (this.hasActiveJob(state, job.input))
        throw new ProjectError("JOB_CANNOT_RECHECK", "此节点已有同类生成任务");
      return { status: "running", error: undefined, pollAfter: 0, deadline: undefined };
    });
    this.start(store);
    return view(result);
  }

  private checkAgentGeneration(
    state: ProjectState,
    { node, binding, input }: ReturnType<GenerationService["validate"]>,
  ) {
    if (!node || node.data.uploaded || node.data.assetId || node.data.outputs?.length)
      throw new ProjectError("JOB_INPUT_INVALID", "已有产物，请新建节点再申请");
    if (
      (input.count ?? 1) !== 1 ||
      modelFanout(binding.profile.config, { ...input, ...input.customParams }).count !== 1
    )
      throw new ProjectError("JOB_INPUT_INVALID", "Agent 每个节点只能生成一个结果");
    if (node.data.kind === "video" || input.referenceAssetIds.length)
      checkApprovedRoleJobs(
        projectCanvas(state.canvas),
        node.id,
        node.data.kind === "video",
        input.referenceAssetIds,
        canvasRoleJobs(state),
      );
  }

  private hasActiveJob(state: ProjectState, input: GenerationInput) {
    return jobs(state).some(
      (job) =>
        job.nodeId === input.nodeId &&
        (job.input.purpose === input.purpose ||
          job.input.purpose === "drama-board" ||
          input.purpose === "drama-board") &&
        !jobIsTerminal(job.status),
    );
  }

  start(store: ProjectStore) {
    const current = this.active.get(store);
    if (current) {
      current.wake = true;
      return;
    }
    const controller = new AbortController();
    const session = { controller, wake: false, done: Promise.resolve() };
    this.active.set(store, session);
    session.done = this.run(store, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(store);
        if (session.wake && !controller.signal.aborted) this.start(store);
      });
  }

  async stop(store: ProjectStore) {
    const active = this.active.get(store);
    active?.controller.abort();
    await active?.done;
  }

  private patch(
    store: ProjectStore,
    id: string,
    update: (job: StoredJob, state: ProjectState) => Partial<StoredJob>,
    signal?: AbortSignal,
  ) {
    return store.updateGeneration((state) => {
      const current = find(state, id);
      const next = { ...current, ...update(current, state), updatedAt: new Date().toISOString() };
      put(state, next);
      if (
        next.status === "failed" &&
        current.status !== "failed" &&
        next.kind === "text" &&
        !next.input.purpose &&
        !this.hasActiveJob(state, next.input)
      ) {
        const node = projectCanvas(state.canvas).nodes.find((entry) => entry.id === next.nodeId);
        if (
          node?.type === "creative" &&
          node.data.kind === "script" &&
          !node.data.storyboard &&
          !node.data.director &&
          generationNodeHash(node) === next.nodeHash
        ) {
          const data = {
            ...node.data,
            text: "",
            textStatus: "error" as const,
            textError: next.errorMessage || next.error || "生成失败",
          };
          delete data.activeOutputId;
          if (next.providerTaskId && next.providerTaskId.length <= 32768)
            data.textFailureTask = { id: next.id, reference: next.providerTaskId };
          else delete data.textFailureTask;
          state.canvas = applyCanvas(state, [{ type: "putNode", node: { ...node, data } }]);
        }
      }
      if (next.status === "cancelled" && current.status !== "cancelled")
        this.restoreCancelledVersion(state, next);
      return { result: next, changed: true };
    }, signal);
  }

  private restoreCancelledVersion(state: ProjectState, job: StoredJob) {
    if (!job.input.purpose && job.mediaBindingHash) {
      const node = projectCanvas(state.canvas).nodes.find((entry) => entry.id === job.nodeId);
      if (
        node?.type !== "creative" ||
        !node.data.pendingMediaVersion ||
        node.data.pendingMediaVersion.batchId !== (job.batchRoot ?? job.id) ||
        mediaBindingHash(node.data) !== job.mediaBindingHash ||
        this.hasActiveJob(state, job.input)
      )
        return;
      state.canvas = applyCanvas(state, [
        { type: "putNode", node: { ...node, data: restoreMediaVersion(node.data) } },
      ]);
      return;
    }
    if (
      job.input.purpose !== "drama-board" ||
      !job.previousBoardOutput ||
      this.hasActiveJob(state, job.input)
    )
      return;
    const node = projectCanvas(state.canvas).nodes.find((entry) => entry.id === job.nodeId);
    if (node?.type !== "creative" || node.data.assetId || generationNodeHash(node) !== job.nodeHash)
      return;
    const previous = node.data.outputs?.find((output) => output.id === job.previousBoardOutput);
    if (previous?.assetId && state.assets[previous.assetId]?.availability === "ready") {
      state.canvas = applyCanvas(state, [
        {
          type: "putNode",
          node: {
            ...node,
            data: { ...node.data, assetId: previous.assetId, activeOutputId: previous.id },
          },
        },
      ]);
    }
  }

  private async run(store: ProjectStore, signal: AbortSignal) {
    const slots = new Map<string, () => void>();
    const registry = await this.registry();
    let lastPins: string | undefined;
    try {
      for (const job of jobs(store.snapshot)) {
        registry.recordModelUse(store.projectId, job.id, job.providerId, Date.parse(job.createdAt));
        if (job.status === "failed")
          registry.recordRequestError(
            job.id,
            job.providerId,
            job.channelId ?? "",
            Date.parse(job.createdAt),
            job.error && /^[A-Z][A-Z0-9_]{0,127}$/.test(job.error)
              ? job.error
              : "JOB_PROVIDER_FAILED",
          );
      }
      while (!signal.aborted) {
        let pending = jobs(store.snapshot).filter((job) => !jobIsTerminal(job.status));
        const signature = JSON.stringify(pending.map((job) => [job.id, job.pluginHash]));
        if (signature !== lastPins) {
          pending = await store.updateGeneration((state) => {
            const stored = jobs(state);
            let changed = false;
            if (!this.reviewedRechecks.has(store))
              for (const job of stored) {
                if (
                  job.status !== "outcome_unknown" ||
                  !job.canRecheck ||
                  !job.providerTaskId ||
                  registry.hasOriginalJobBinding(store.projectId, job)
                )
                  continue;
                put(state, {
                  ...job,
                  error: "JOB_ORIGINAL_BINDING_MISSING",
                  canRecheck: false,
                  updatedAt: new Date().toISOString(),
                });
                changed = true;
              }
            const committed = stored.filter((job) => !jobIsTerminal(job.status));
            registry.reconcileJobPins(store.projectId, committed, recheckableBindings(state));
            lastPins = JSON.stringify(committed.map((job) => [job.id, job.pluginHash]));
            return { result: committed, changed };
          }, signal);
          this.reviewedRechecks.add(store);
        }
        const pendingIds = new Set(pending.map(({ id }) => id));
        for (const [id, release] of slots) {
          if (pendingIds.has(id)) continue;
          release();
          slots.delete(id);
        }
        if (!pending.length) return;
        const now = Date.now();
        const available = pending.find(
          (job) =>
            !(
              job.status === "queued" &&
              job.input.afterImageJobId &&
              pendingIds.has(job.input.afterImageJobId)
            ) &&
            (job.cancelRequested ||
              (job.deadline ?? Infinity) <= now ||
              (job.pollAfter ?? 0) <= now),
        );
        if (!available) {
          await delay(this.pollFloor, undefined, { signal });
          continue;
        }
        await this.step(store, available, slots, signal);
        const completed = find(store.snapshot, available.id);
        registry.recordModelUse(
          store.projectId,
          completed.id,
          completed.providerId,
          Date.parse(completed.createdAt),
        );
        if (completed.status === "failed")
          registry.recordRequestError(
            completed.id,
            completed.providerId,
            completed.channelId ?? "",
            Date.parse(completed.createdAt),
            completed.error ?? "JOB_PROVIDER_FAILED",
          );
      }
    } finally {
      const upstream = new Set(
        jobs(store.snapshot)
          .filter((job) => job.providerTaskId && !jobIsTerminal(job.status))
          .map((job) => job.id),
      );
      for (const [id, release] of slots) if (!upstream.has(id)) release();
      registry.clearGenerationWaiters(store.projectId);
    }
  }

  private characterImageReference(state: ProjectState, job: StoredJob) {
    const parent = jobs(state).find(({ id }) => id === job.input.afterImageJobId);
    const node = projectCanvas(state.canvas).nodes.find(({ id }) => id === job.nodeId);
    const first = parent?.outputs[0];
    if (
      parent?.status === "succeeded" &&
      parent.bound &&
      first?.kind === "image" &&
      node?.type === "creative" &&
      node.data.character &&
      node.data.assetId === first.assetId &&
      state.assets[first.assetId]?.availability === "ready"
    )
      return first.assetId;
    throw new ProjectError("JOB_IMAGE_DEPENDENCY_FAILED", "本次形象未成为角色主图，音色任务未提交");
  }

  private async references(
    store: ProjectStore,
    job: StoredJob,
    signal: AbortSignal,
    filedReference: (
      url: string | undefined,
      asset: ProjectState["assets"][string],
    ) => Promise<{ url?: string; filedAssetId?: string }> | undefined,
  ) {
    const media: Record<string, ReferenceMedia> = {};
    const input = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
    for (const id of job.input.referenceAssetIds) {
      signal.throwIfAborted();
      const asset = store.snapshot.assets[id];
      if (asset?.availability !== "ready") throw new ProviderError("JOB_INPUT_INVALID");
      const { handle } = await this.files.inspect(store, asset, true);
      try {
        const list = input[`${asset.mediaType}s`];
        const key = `input:${asset.mediaType}s.${list.length}`;
        const suppliedURL = job.input.referenceURLs?.[id];
        const reference =
          asset.mediaType === "image" ? await filedReference(suppliedURL, asset) : undefined;
        const url = reference?.url ?? suppliedURL;
        const filedAssetId = reference?.filedAssetId;
        if (asset.sizeBytes > mediaReferenceBytes) {
          if (!filedAssetId && (!url || !isPublicReferenceURL(url)))
            throw new ProviderError("JOB_INPUT_INVALID");
          list.push(key);
          media[key] = {
            url,
            urlOnly: true,
            bytes: new Uint8Array(),
            mime: asset.mimeType,
            filename: `reference${mimeExtensions[asset.mimeType] ?? ".bin"}`,
            filedAssetId,
          };
          continue;
        }
        const bytes = Buffer.alloc(asset.sizeBytes);
        const result = await handle.read(bytes, 0, bytes.length, 0);
        if (
          result.bytesRead !== bytes.length ||
          createHash("sha256").update(bytes).digest("hex") !== asset.sha256
        )
          throw new ProviderError("JOB_INPUT_INVALID");
        list.push(key);
        media[key] = {
          bytes,
          mime: asset.mimeType,
          filename: `reference${mimeExtensions[asset.mimeType] ?? ".bin"}`,
          url,
          filedAssetId,
        };
      } finally {
        await handle.close();
      }
    }
    return { media, input };
  }

  private claimSubmission(
    store: ProjectStore,
    job: StoredJob,
    deadline: number | undefined,
    checkImageReference: boolean,
    signal: AbortSignal,
  ) {
    return store.updateGeneration((state) => {
      const current = find(state, job.id);
      if (current.status !== "queued") return { result: false, changed: false };
      if (checkImageReference) this.characterImageReference(state, current);
      const { referenceURLs: _referenceURLs, ...input } = current.input;
      put(state, {
        ...current,
        input,
        status: "submitting",
        submittedAt: new Date().toISOString(),
        ...(deadline && { deadline }),
        updatedAt: new Date().toISOString(),
      });
      return { result: true, changed: true };
    }, signal);
  }

  private publishOutputs(
    store: ProjectStore,
    job: StoredJob,
    outputs: JobOutput[],
    staged: StagedAsset[],
    signal: AbortSignal,
    usages: readonly (TokenUsage | undefined)[],
  ) {
    return store.updateGeneration(async (state) => {
      const current = find(state, job.id);
      if (jobIsTerminal(current.status)) return { changed: false, result: undefined };
      for (const entry of staged) {
        await this.assets.publishBlob(store, entry, signal);
        state.assets[entry.asset.assetId] = entry.asset;
      }
      const node = projectCanvas(state.canvas).nodes.find(({ id }) => id === job.nodeId);
      const first = outputs[0];
      const unchanged =
        node?.type === "creative" &&
        (current.mediaBindingHash !== undefined
          ? mediaBindingHash(node.data) === current.mediaBindingHash
          : generationNodeHash(node) === current.nodeHash);
      const isVoice = job.input.purpose === "character-voice";
      const isStoryboardSplit = job.input.purpose === "storyboard-split";
      let bound = !isVoice && unchanged && !!first;
      let storyboardShotIds: string[] | undefined;
      if (job.input.purpose === "drama-segment") {
        const doc = dramaDocument(state);
        const segment = doc?.segments?.find(
          (entry) => `seg:${entry.id}` === job.nodeId && entry.take_ids?.includes(job.id),
        );
        bound = !!segment && first?.kind === "video";
        if (doc && segment && bound && !segment.chosen_task_id) {
          segment.chosen_task_id = job.id;
          bumpSegmentVersion(doc, segment.episode_no);
          segment.revision++;
          doc.overview_revision ??= doc.revision;
          doc.revision++;
        }
      } else if (isStoryboardSplit) {
        if (!unchanged || first?.kind !== "text" || node?.type !== "creative")
          throw new ProviderError("JOB_OUTPUT_INVALID");
        const incoming = parseStoryboardOutput(first.text);
        storyboardShotIds = incoming.map((shot) => shot.id);
        const existing = node.data.storyboard ?? [];
        const storyboard =
          job.input.storyboardSplitMode === "append" ? [...existing, ...incoming] : incoming;
        if (storyboard.length > maxStoryboardShots || !validStoryboard(storyboard))
          throw new ProviderError("JOB_OUTPUT_INVALID");
        state.canvas = applyCanvas(state, [
          { type: "putNode", node: { ...node, data: { ...node.data, storyboard } } },
        ]);
        bound = true;
      } else if (
        isVoice &&
        first?.kind === "audio" &&
        node?.type === "creative" &&
        node.data.character
      ) {
        const voiceJobs = jobs(state).filter(
          (candidate) =>
            candidate.nodeId === node.id && candidate.input.purpose === "character-voice",
        );
        const latest = voiceJobs
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .at(-1);
        if (latest?.id === job.id) {
          const character = {
            ...node.data.character,
            voice: characterVoice(
              first.assetId,
              "generated",
              state.assets[first.assetId]?.displayName,
            ),
          };
          state.canvas = applyCanvas(state, [
            { type: "putNode", node: { ...node, data: { ...node.data, character } } },
          ]);
          bound = true;
        }
      } else if (!isVoice && node?.type === "creative") {
        const data = { ...node.data };
        if (unchanged && first) delete data.pendingMediaVersion;
        if (unchanged && first?.kind === "text") {
          delete data.assetId;
          delete data.textError;
          delete data.textFailureTask;
        }
        const history = outputs.map((output, index) => ({
          id: `${job.id}:${index}`,
          kind: output.kind,
          ...(output.kind === "text" ? { text: output.text } : { assetId: output.assetId }),
          model: job.model,
          createdAt: new Date().toISOString(),
        }));
        state.canvas = applyCanvas(state, [
          {
            type: "putNode",
            node: {
              ...node,
              data: {
                ...data,
                ...appendOutputHistory(node.data.outputs ?? [], history, node.data.activeOutputId),
                ...(unchanged && first
                  ? {
                      activeOutputId: history[0]?.id,
                      ...(first.kind === "text"
                        ? { text: first.text, textStatus: "done" }
                        : { assetId: first.assetId }),
                    }
                  : {}),
              },
            },
          },
        ]);
      }
      put(state, {
        ...current,
        status: "succeeded",
        settledCredits: settleJobCredits(current, usages),
        progress: 100,
        outputs,
        ...(storyboardShotIds && { storyboardShotIds }),
        bound,
        error: undefined,
        cancelRequested: false,
        updatedAt: new Date().toISOString(),
      });
      return { changed: true, result: undefined };
    }, signal);
  }

  private async step(
    store: ProjectStore,
    job: StoredJob,
    slots: Map<string, () => void>,
    signal: AbortSignal,
  ) {
    if ((job.status === "submitting" || job.status === "downloading") && !job.providerTaskId) {
      await this.patch(
        store,
        job.id,
        () => ({ status: "outcome_unknown", error: "JOB_OUTCOME_UNKNOWN" }),
        signal,
      );
      return;
    }
    let temp: string | undefined;
    const staged: StagedAsset[] = [];
    const downloaded: { path: string; mime: string }[] = [];
    let receivedResult = false;
    let deadlineSignal: AbortSignal | undefined;
    try {
      const registry = await this.registry();
      const submitting = job.status === "queued";
      const phase = submitting
        ? "submit"
        : job.providerTaskId && job.channelId && !job.cancelRequested
          ? "receipt-query"
          : "submitted";
      const target = { project: store.projectId, id: job.id };
      const resolved = (() => {
        try {
          const binding =
            job.pluginHash === "" && job.kind === "text"
              ? registry.agentJobBinding(
                  job.input.providerId,
                  job.input.expectedProviderRevision,
                  target,
                )
              : registry.queryBinding(
                  job.input.providerId,
                  job.input.expectedProviderRevision,
                  job.pluginHash,
                  target,
                  phase,
                );
          if (job.providerTaskId && job.channelId && binding.profile.channelId !== job.channelId)
            throw new ProviderError("JOB_ORIGINAL_BINDING_MISSING");
          return binding;
        } catch (error) {
          if (
            job.providerTaskId &&
            error instanceof ProviderError &&
            !registry.hasOriginalJobBinding(store.projectId, job)
          )
            throw new ProviderError("JOB_ORIGINAL_BINDING_MISSING");
          throw error;
        }
      })();
      const { profile } = resolved;
      if (profile.pluginHash !== job.pluginHash) throw new ProviderError("JOB_MODEL_UNAVAILABLE");
      const timeoutMs =
        resolved.origin === "gateway"
          ? agentDeadlineMs(profile)
          : (profile.config?.timeoutSeconds ?? 1800) * 1000;
      if (submitting && profile.channelId && Date.now() >= Date.parse(job.createdAt) + timeoutMs)
        throw new ProviderError("JOB_QUEUE_TIMEOUT");
      const deadline =
        job.deadline ??
        (profile.channelId || profile.config?.timeoutSeconds ? Date.now() + timeoutMs : undefined);
      if (deadline && deadline <= Date.now()) throw new ProviderError("JOB_TIMEOUT");
      if (!slots.has(job.id)) {
        const created = Date.parse(job.createdAt);
        const release = registry.acquireGeneration(
          profile.channelId,
          store.projectId,
          job.id,
          deadline ?? Date.now() + timeoutMs,
          submitting ? { created, until: created + timeoutMs } : undefined,
        );
        if (!release) {
          await this.patch(
            store,
            job.id,
            () => ({ pollAfter: Date.now() + this.pollFloor }),
            signal,
          );
          return;
        }
        slots.set(job.id, release);
      }
      if (deadline)
        deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())));
      const requestSignal = deadlineSignal ? AbortSignal.any([signal, deadlineSignal]) : signal;
      if (resolved.origin === "gateway") {
        if (!submitting || job.kind !== "text") throw new ProviderError("JOB_INPUT_INVALID");
        if (!(await this.claimSubmission(store, job, deadline, false, signal))) return;
        const result = await probeAgentStream(resolved, registry.redactor(), timeoutMs, {
          prompt: job.input.prompt,
          signal: requestSignal,
          generation: true,
        });
        receivedResult = true;
        if (!result.text) throw new ProviderError("JOB_OUTPUT_INVALID");
        await this.publishOutputs(
          store,
          job,
          [{ kind: "text", text: registry.redact(result.text).slice(0, 32768) }],
          [],
          signal,
          [result.usage],
        );
        return;
      }
      const { plugin, secret, secretKey, origin, transportConfig } = resolved;
      const directory = await mkdtemp(join(tmpdir(), "link-studio-job-"));
      temp = directory;
      const imageReference =
        submitting && job.input.afterImageJobId
          ? this.characterImageReference(store.snapshot, job)
          : undefined;
      let inlineReference: string | undefined;
      if (imageReference) {
        const options = modelGenerationOptions(
          "audio",
          origin === "builtin" ? plugin.key : undefined,
          profile.model,
          profile.channel,
          profile.config,
        );
        const asset = store.snapshot.assets[imageReference];
        if (options.references.image) inlineReference = imageReference;
        if (
          inlineReference &&
          (!asset ||
            asset.sizeBytes >
              Math.min(options.referenceBytes.image ?? mediaReferenceBytes, mediaReferenceBytes))
        )
          throw new ProjectError(
            "JOB_IMAGE_DEPENDENCY_FAILED",
            "形象素材超过音色模型的参考图大小限制",
          );
      }
      const references = submitting
        ? await this.references(
            store,
            inlineReference
              ? {
                  ...job,
                  input: { ...job.input, referenceAssetIds: [inlineReference] },
                }
              : job,
            requestSignal,
            (url, asset) =>
              origin === "builtin" && plugin.key === "doubao-video"
                ? registry.projectFilingReference(
                    profile.channelId,
                    asset,
                    store.projectId,
                    url,
                    requestSignal,
                  )
                : undefined,
          )
        : undefined;
      const capture = async (mime: string, payload: NodeJS.ReadableStream | Buffer) => {
        if (!mimeExtensions[mime] || !mime.startsWith(`${job.kind}/`) || downloaded.length >= 10)
          throw new ProviderError("JOB_OUTPUT_INVALID");
        const path = join(directory, String(downloaded.length));
        if (Buffer.isBuffer(payload)) {
          if (payload.length > outputLimit) throw new ProviderError("JOB_OUTPUT_INVALID");
          await writeFile(path, payload, { flag: "wx", mode: 0o600, signal });
        } else {
          let bytes = 0;
          try {
            await pipeline(
              payload,
              new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  bytes += chunk.length;
                  callback(
                    bytes > outputLimit ? new ProviderError("JOB_OUTPUT_INVALID") : null,
                    chunk,
                  );
                },
              }),
              createWriteStream(path, { flags: "wx", mode: 0o600 }),
              { signal },
            );
          } finally {
            if ("destroy" in payload && typeof payload.destroy === "function") payload.destroy();
          }
        }
        downloaded.push({ path, mime });
        return downloaded.length - 1;
      };
      const fetchOutput = async (url: string, fallbackMime?: string) => {
        const response = await openProviderResponse(
          profile.endpoint,
          profile.allowLocal,
          { url, method: "GET", headers: {}, timeoutMs: 120000, responseType: "binary" },
          requestSignal,
        );
        if (
          job.providerTaskId &&
          [401, 403, 404, 410, 429, 500, 502, 503, 504].includes(response.statusCode ?? 0)
        ) {
          response.destroy();
          throw new ProviderError("JOB_OUTPUT_REFRESH_REQUIRED");
        }
        if (
          response.statusCode !== 200 ||
          Number(response.headers["content-length"]) > outputLimit
        ) {
          response.destroy();
          throw new ProviderError("JOB_OUTPUT_INVALID");
        }
        try {
          return await capture(mediaMime(response.headers["content-type"], fallbackMime), response);
        } finally {
          response.destroy();
        }
      };
      const transport = providerTransport(
        profile.endpoint,
        profile.allowLocal,
        async (body) => {
          if (
            job.kind !== "image" ||
            !body ||
            typeof body !== "object" ||
            !("data" in body) ||
            !Array.isArray(body.data)
          )
            return body;
          for (const item of body.data) {
            if (!item || typeof item !== "object") continue;
            delete item.asset_index;
            if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) continue;
            if (typeof item.b64_json !== "string" || !item.b64_json) continue;
            const encoded = item.b64_json.replace(/[\r\n]/g, "");
            if (
              encoded.length > Math.ceil(inlineImageLimit / 3) * 4 ||
              encoded.length % 4 !== 0 ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
            )
              throw new ProviderError("JOB_OUTPUT_INVALID");
            const bytes = Buffer.from(encoded, "base64");
            if (!bytes.length || bytes.length > inlineImageLimit)
              throw new ProviderError("JOB_OUTPUT_INVALID");
            const mime = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
              ? "image/png"
              : bytes[0] === 255 && bytes[1] === 216
                ? "image/jpeg"
                : bytes.toString("ascii", 0, 4) === "RIFF" &&
                    bytes.toString("ascii", 8, 12) === "WEBP"
                  ? "image/webp"
                  : "";
            item.asset_index = await capture(mime, bytes);
            delete item.b64_json;
          }
          return body;
        },
        async (request, transportSignal) => {
          const response = await openProviderResponse(
            profile.endpoint,
            profile.allowLocal,
            request,
            transportSignal,
          );
          try {
            if (response.statusCode !== 200)
              return { status: response.statusCode ?? 502, body: {}, text: "", headers: {} };
            const index = await capture(
              mediaMime(
                response.headers["content-type"],
                job.kind === "video" ? "video/mp4" : undefined,
              ),
              response,
            );
            return { status: 200, body: {}, text: "", headers: {}, asset: { id: String(index) } };
          } finally {
            response.destroy();
          }
        },
      );
      const host = registry.createHost(
        registry.wrapChannelTransport(profile.channelId, transport, transportConfig),
      );
      const context = {
        kind: job.kind,
        ...(submitting &&
          plugin.hooks.includes("buildPrepareRequests") && {
            prepared: registry.readPrepared(store.projectId, job.id),
          }),
        channel: { baseUrl: profile.endpoint, settings: profile.channel },
        model: { upstreamModel: profile.model },
        input: providerInput(job.kind, plugin.key, job.input, profile.config, references?.input),
        ...(job.providerTaskId
          ? { task: { providerTaskId: job.providerTaskId, state: job.providerState } }
          : {}),
      };
      const binding = {
        source: plugin.source,
        approvedHash: plugin.hash,
        baseUrl: profile.endpoint,
        builtin: origin === "builtin",
        secret,
        secretKey,
        media: references?.media,
        savePrepared: (prepared: unknown) =>
          registry.savePrepared(store.projectId, job.id, prepared),
      };
      if (submitting) {
        const claimed = await this.claimSubmission(
          store,
          job,
          deadline,
          Boolean(imageReference),
          signal,
        );
        if (!claimed) return;
      } else if (job.cancelRequested) {
        await this.patch(
          store,
          job.id,
          () => ({ cancelRequested: false, canCancelRemote: false }),
          signal,
        );
        try {
          await host.invoke(binding, "cancel", context, requestSignal);
        } catch {
          signal.throwIfAborted();
          await this.patch(store, job.id, () => ({ error: "JOB_CANCEL_UNCONFIRMED" }), signal);
        }
      }
      const response = await host
        .invoke(binding, submitting ? "submit" : "query", context, requestSignal)
        .catch(async (error) => {
          if (signal.aborted || deadlineSignal?.aborted || code(error) !== "PROVIDER_RETRYABLE")
            throw error;
          if (submitting) {
            const retries = (job.submitRetries ?? 0) + 1;
            if (retries > 5) throw error;
            const delayMs =
              Math.min(60_000, 2000 * 2 ** (retries - 1)) * (0.8 + 0.4 * Math.random());
            await this.patch(
              store,
              job.id,
              (current) => ({
                status: "queued",
                input: { ...current.input, referenceURLs: job.input.referenceURLs },
                submitRetries: retries,
                pollAfter: Date.now() + delayMs,
              }),
              signal,
            );
          } else {
            const attempts = (job.pollAttempts ?? 0) + 1;
            await this.patch(
              store,
              job.id,
              () => ({
                pollAttempts: attempts,
                pollAfter:
                  Date.now() +
                  Math.max(this.pollFloor, providerPollDelay(plugin.meta.poll, false, attempts)),
              }),
              signal,
            );
          }
          return undefined;
        });
      if (!response) return;
      const result = record(response.immediate ?? response);
      if (
        (response.immediate === undefined && typeof response.providerTaskId === "string") ||
        result.status === "running" ||
        result.status === "queued"
      ) {
        const attempts = submitting ? 0 : (job.pollAttempts ?? 0) + 1;
        await this.patch(
          store,
          job.id,
          (current) => ({
            status: job.status === "downloading" ? "downloading" : "running",
            ...(deadline && { deadline }),
            providerTaskId:
              typeof response.providerTaskId === "string"
                ? response.providerTaskId
                : job.providerTaskId,
            providerState: (result.state === undefined
              ? job.providerState
              : result.state) as JsonValue,
            canRecheck: true,
            progress:
              typeof result.progress === "number"
                ? Math.max(current.progress, Math.min(99, result.progress))
                : current.progress,
            pollAttempts: attempts,
            pollAfter:
              Date.now() +
              Math.max(this.pollFloor, providerPollDelay(plugin.meta.poll, submitting, attempts)),
          }),
          signal,
        );
        return;
      }
      if (result.status === "failed" || result.status === "cancelled") {
        const cancelled = result.status === "cancelled";
        const errorMessage = cancelled
          ? undefined
          : registry.failureMessage(
              plugin.auth.type,
              record(result.error).message,
              [
                ...Object.values(context.input),
                ...Object.values(profile.channel),
                ...Object.values(job.input.referenceURLs ?? {}),
              ],
              profile.channelId,
              transportConfig,
            );
        await this.patch(
          store,
          job.id,
          () => ({
            status: cancelled ? "cancelled" : "failed",
            error: cancelled ? undefined : "JOB_PROVIDER_FAILED",
            errorMessage,
            canRecheck: false,
            canCancelRemote: false,
            cancelRequested: false,
          }),
          signal,
        );
        return;
      }
      receivedResult = result.status === "succeeded";
      if (
        result.status !== "succeeded" ||
        !Array.isArray(result.outputs) ||
        !result.outputs.length ||
        result.outputs.length > 8
      )
        throw new ProviderError("JOB_OUTPUT_INVALID");
      const queryBeforeTransfer =
        job.providerTaskId &&
        job.status !== "downloading" &&
        result.outputs.some((output) => record(output).type === "url");
      await this.patch(
        store,
        job.id,
        () => ({
          status: "downloading",
          progress: 99,
          ...(queryBeforeTransfer && { pollAfter: 0 }),
          ...(job.providerTaskId &&
            result.state !== undefined && { providerState: result.state as JsonValue }),
        }),
        signal,
      );
      registry.markFinalizing(store.projectId, job.id);
      if (queryBeforeTransfer) return;
      const outputs: JobOutput[] = [];
      for (const output of result.outputs.map(record)) {
        if (job.kind === "text" && typeof output.text === "string") {
          outputs.push({ kind: "text", text: registry.redact(output.text).slice(0, 32768) });
          continue;
        }
        if (job.kind === "text") throw new ProviderError("JOB_OUTPUT_INVALID");
        const index =
          output.type === "url" && typeof output.url === "string"
            ? await fetchOutput(
                output.url,
                typeof output.mime === "string" ? output.mime : undefined,
              )
            : Number(output.asset_index ?? 0);
        const item = downloaded[index];
        if (!item) throw new ProviderError("JOB_OUTPUT_INVALID");
        const file = await open(item.path, "r");
        try {
          const assetId = randomUUID();
          const asset = await this.assets
            .stage(
              store,
              file,
              `生成-${job.id.slice(0, 8)}-${outputs.length + 1}${mimeExtensions[item.mime]}`,
              assetId,
              { signal },
            )
            .catch((error: unknown) => {
              if (
                error instanceof ProjectError &&
                ["ASSET_READ_FAILED", "ASSET_TYPE_UNSUPPORTED", "ASSET_SIZE_LIMIT"].includes(
                  error.code,
                )
              )
                throw new ProviderError("JOB_OUTPUT_INVALID");
              throw error;
            });
          asset.asset.origin = "generated";
          asset.asset.metadata.jobId = job.id;
          staged.push(asset);
          outputs.push({ kind: job.kind, assetId });
        } finally {
          await file.close();
        }
      }
      await this.publishOutputs(
        store,
        job,
        outputs,
        staged,
        signal,
        result.outputs.map((output) => readTokenUsage(record(output).usage)),
      );
    } catch (error) {
      if (signal.aborted) return;
      const errorCode = deadlineSignal?.aborted ? "JOB_TIMEOUT" : code(error);
      if (errorCode === "JOB_OUTPUT_REFRESH_REQUIRED") {
        const attempts = (job.transferAttempts ?? 0) + 1;
        await this.patch(
          store,
          job.id,
          (current) => {
            if (jobIsTerminal(current.status)) return {};
            if (attempts >= 10) return { status: "failed", error: "JOB_OUTPUT_INVALID" };
            return {
              status: "downloading",
              transferAttempts: attempts,
              pollAfter: Date.now() + Math.min(600_000, this.pollFloor * 10 * 2 ** (attempts - 1)),
            };
          },
          signal,
        );
        return;
      }
      const unknown =
        !receivedResult &&
        !["PROVIDER_TERMINAL", "PROVIDER_MODERATION", "PROVIDER_PROVIDER_BALANCE"].includes(
          errorCode,
        ) &&
        (Boolean(job.providerTaskId) || code(error) === "PROVIDER_OUTCOME_UNKNOWN");
      await this.patch(
        store,
        job.id,
        (current) =>
          jobIsTerminal(current.status)
            ? {}
            : {
                status: unknown ? "outcome_unknown" : "failed",
                error:
                  unknown && errorCode !== "JOB_ORIGINAL_BINDING_MISSING"
                    ? "JOB_OUTCOME_UNKNOWN"
                    : errorCode,
                canRecheck:
                  unknown && current.canRecheck && errorCode !== "JOB_ORIGINAL_BINDING_MISSING",
                cancelRequested: false,
              },
        signal,
      );
    } finally {
      await Promise.allSettled(staged.map((asset) => this.assets.discard(asset)));
      if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
