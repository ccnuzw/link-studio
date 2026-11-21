import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Value } from "@sinclair/typebox/value";
import {
  type CanvasShot,
  type CreativeOutput,
  validStoryboard,
} from "../../../packages/link-studio-core/src/canvas.ts";
import {
  GenerationInput,
  type GenerationJob,
  type GenerationKind,
  type JobOutput,
  jobIsTerminal,
} from "../../../packages/link-studio-core/src/generation.ts";
import {
  configuredGenerationInput,
  isPublicReferenceURL,
  mediaReferenceBytes,
  modelGenerationOptions,
} from "../../../packages/link-studio-core/src/media-generation.ts";
import type { JsonValue, ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { providerInput } from "../../../packages/link-studio-core/src/provider-input.ts";
import type { ReferenceMedia } from "../../../packages/provider-runtime/src/host.ts";
import { ProviderError, record } from "../../../packages/provider-runtime/src/runner.ts";
import { openProviderResponse, providerTransport } from "../settings/network.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import type { AssetFiles } from "./asset-files.ts";
import type { AssetService, StagedAsset } from "./assets.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

type StoredJob = GenerationJob & {
  version: 1;
  input: GenerationInput;
  requestHash: string;
  nodeHash: string;
  pluginHash: string;
  providerTaskId?: string;
  providerState?: JsonValue;
  pollAfter?: number;
  pollAttempts?: number;
  deadline?: number;
};

const outputLimit = 256 * 1024 * 1024;
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
    ...(job.input.purpose ? { purpose: job.input.purpose } : {}),
    ...(job.input.afterImageJobId ? { afterImageJobId: job.input.afterImageJobId } : {}),
    ...(job.input.purpose === "character-voice" ? { voicePrompt: job.input.prompt } : {}),
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
  };
}

function put(state: ProjectState, job: StoredJob) {
  state.jobs[job.id] = JSON.parse(JSON.stringify(job));
}

function find(state: ProjectState, id: string) {
  const job = jobs(state).find((entry) => entry.id === id);
  if (!job) throw new ProjectError("JOB_NOT_FOUND", "生成任务不存在");
  return job;
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
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
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

function pollDelay(poll: unknown, submitting: boolean, attempts: number) {
  const settings = (poll ?? {}) as Partial<
    Record<"firstDelay" | "interval" | "maxInterval" | "jitter", number>
  >;
  if (submitting) return (settings.firstDelay || 10) * 1000;
  const interval = settings.interval || 5;
  const maximum = Math.max(interval, settings.maxInterval || 15);
  const wait = Math.min(maximum, interval * 2 ** Math.min(52, Math.max(0, attempts - 1)));
  return wait * (1 + (settings.jitter || 0.2) * (2 * Math.random() - 1)) * 1000;
}

export class GenerationService {
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

  async prepare(store: ProjectStore, input: GenerationInput) {
    const registry = await this.registry();
    return this.validate(store.snapshot, input, registry);
  }

  private validate(state: ProjectState, input: GenerationInput, registry: SettingsRegistry) {
    if (!Value.Check(GenerationInput, input) || !input.prompt.trim())
      throw new ProjectError("JOB_INPUT_INVALID", "检查生成参数");
    if (state.canvas.revision !== input.expectedCanvasRevision)
      throw new ProjectError("CANVAS_REVISION_CONFLICT", "画布已经变化");
    const node = projectCanvas(state.canvas).nodes.find(({ id }) => id === input.nodeId);
    if (
      node?.type !== "creative" ||
      (input.purpose === "storyboard-split"
        ? node.data.kind !== "script" || !node.data.storyboard
        : node.data.storyboard || node.data.director)
    )
      throw new ProjectError("JOB_INPUT_INVALID", "选择创作节点");
    if (input.purpose === "character-voice" && !node.data.character)
      throw new ProjectError("JOB_INPUT_INVALID", "音色生成需要角色卡");
    if (input.purpose === "storyboard-split" && !input.storyboardSplitMode)
      throw new ProjectError("JOB_INPUT_INVALID", "拆分镜需要指定覆盖或追加模式");
    const kind: GenerationKind =
      input.purpose === "character-voice"
        ? "audio"
        : node.data.kind === "script"
          ? "text"
          : node.data.kind;
    let binding: ReturnType<SettingsRegistry["binding"]>;
    try {
      binding = registry.binding(input.providerId, input.expectedProviderRevision);
    } catch {
      throw new ProjectError("JOB_MODEL_UNAVAILABLE", "检查模型配置和凭证");
    }
    if (
      binding.plugin.kind !== kind ||
      binding.profile.config?.kind === "agent" ||
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
        parent.nodeId !== node.id ||
        parent.kind !== "image" ||
        parent.input.purpose ||
        input.referenceAssetIds.length ||
        !options.references.image ||
        options.referenceNeedsURL("image") ||
        input.speaker
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
    const mode = kind === "image" ? (input.referenceAssetIds.length ? "i2i" : "t2i") : op;
    if (
      Array.from(input.prompt.trim()).length > options.promptLimit ||
      (options.modes && (!mode || !options.modes.includes(mode))) ||
      (op !== undefined && kind !== "video") ||
      (op === "t2v" && input.referenceAssetIds.length > 0) ||
      (op === "omni" && (!options.omni || !input.referenceAssetIds.length)) ||
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
      (binding.plugin.key === "vidu" &&
        binding.profile.model === "vidu2.0" &&
        input.duration === 8 &&
        input.resolution !== "720p") ||
      (binding.plugin.key === "alibaba-video" &&
        input.resolution === "480p" &&
        /^(?:wan2\.[256]-t2v|wanx?2\.1-t2v)/i.test(binding.profile.model) &&
        (input.aspectRatio === "4:3" || input.aspectRatio === "3:4")) ||
      (input.generateAudio !== undefined && !options.audio) ||
      (input.aspectRatio !== undefined && input.size !== undefined) ||
      (input.size !== undefined &&
        !options.manualSize &&
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
        options.referenceNeedsURL(asset.mediaType) &&
        !input.referenceURLs?.[id] &&
        binding.origin === "builtin"
      )
        throw new ProjectError("JOB_INPUT_INVALID", "此适配器需要参考素材的公网 HTTPS 链接");
    }
    if (
      ((op === "i2v" || options.requiresImage) && !counts.image) ||
      (options.requiresReference && !input.referenceAssetIds.length) ||
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
      (binding.plugin.key === "xai" &&
        (op === "omni" || counts.image > 1 || counts.audio > 0) &&
        input.resolution === "1080p")
    )
      throw new ProjectError("JOB_INPUT_INVALID", "参考素材或参数与生成方式不匹配");
    return { node, kind, binding, input };
  }

  async submit(
    store: ProjectStore,
    entries: { id: string; input: GenerationInput }[],
    signal?: AbortSignal,
  ) {
    const registry = await this.registry();
    const result = await store.updateGeneration((state) => {
      let changed = false;
      const result = entries.map(({ id, input }) => {
        const requestHash = contentHash(input);
        const previous = jobs(state).find((job) => job.id === id);
        if (previous) {
          if (previous.requestHash !== requestHash)
            throw new ProjectError("OPERATION_ID_REUSED", "生成请求与原提交不一致");
          return view(previous);
        }
        if (this.hasActiveJob(state, input))
          throw new ProjectError("JOB_INPUT_INVALID", "此节点已有生成任务");
        const { node, kind, binding, input: configured } = this.validate(state, input, registry);
        const now = new Date().toISOString();
        const job: StoredJob = {
          version: 1,
          id,
          input: { ...configured, prompt: registry.redact(configured.prompt) },
          providerId: configured.providerId,
          providerRevision: configured.expectedProviderRevision,
          requestHash,
          nodeId: input.nodeId,
          nodeHash: generationNodeHash(node),
          pluginHash: binding.plugin.hash,
          providerLabel: binding.profile.label,
          model: binding.profile.config?.name ?? binding.profile.model,
          kind,
          status: "queued",
          progress: 0,
          outputs: [],
          createdAt: now,
          updatedAt: now,
          canCancelRemote: binding.plugin.hooks.includes("buildCancelRequest"),
          canRecheck: false,
        };
        put(state, job);
        changed = true;
        return view(job);
      });
      return { result, changed };
    }, signal);
    if (!signal?.aborted) this.start(store);
    return result;
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
      return { result: view(job), changed: true };
    });
    this.start(store);
    return result;
  }

  async recheck(store: ProjectStore, id: string) {
    const result = await this.patch(store, id, (job, state) => {
      if (job.status !== "outcome_unknown" || !job.canRecheck || !job.providerTaskId)
        throw new ProjectError("JOB_CANNOT_RECHECK", "缺少可查询的供应商任务");
      if (this.hasActiveJob(state, job.input))
        throw new ProjectError("JOB_CANNOT_RECHECK", "此节点已有同类生成任务");
      return { status: "running", error: undefined, pollAfter: 0, deadline: undefined };
    });
    this.start(store);
    return view(result);
  }

  private hasActiveJob(state: ProjectState, input: GenerationInput) {
    return jobs(state).some(
      (job) =>
        job.nodeId === input.nodeId &&
        job.input.purpose === input.purpose &&
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
      return { result: next, changed: true };
    }, signal);
  }

  private async run(store: ProjectStore, signal: AbortSignal) {
    const slots = new Map<string, () => void>();
    try {
      while (!signal.aborted) {
        const allJobs = jobs(store.snapshot);
        const pending = allJobs.filter((job) => !jobIsTerminal(job.status));
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
      }
    } finally {
      for (const release of slots.values()) release();
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

  private async references(store: ProjectStore, job: StoredJob, signal: AbortSignal) {
    const media: Record<string, ReferenceMedia> = {};
    const input = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
    for (const id of job.input.referenceAssetIds) {
      signal.throwIfAborted();
      const asset = store.snapshot.assets[id];
      if (asset?.availability !== "ready" || asset.sizeBytes > mediaReferenceBytes)
        throw new ProviderError("JOB_INPUT_INVALID");
      const { handle } = await this.files.inspect(store, asset, true);
      try {
        const list = input[`${asset.mediaType}s`];
        const key = `input:${asset.mediaType}s.${list.length}`;
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
          url: job.input.referenceURLs?.[id],
        };
      } finally {
        await handle.close();
      }
    }
    return { media, input };
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
      const { profile, plugin, secret, secretKey, origin } = registry.binding(
        job.input.providerId,
        job.input.expectedProviderRevision,
      );
      if (plugin.hash !== job.pluginHash) throw new ProviderError("JOB_MODEL_UNAVAILABLE");
      const submitting = job.status === "queued";
      const deadline =
        job.deadline ??
        (profile.config?.timeoutSeconds && Date.now() + profile.config.timeoutSeconds * 1000);
      if (deadline && deadline <= Date.now()) throw new ProviderError("JOB_TIMEOUT");
      if (profile.channelId && !slots.has(job.id)) {
        const release = registry.acquireGeneration(profile.channelId);
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
      if (deadline) deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const requestSignal = deadlineSignal ? AbortSignal.any([signal, deadlineSignal]) : signal;
      const directory = await mkdtemp(join(tmpdir(), "link-studio-job-"));
      temp = directory;
      const imageReference =
        submitting && job.input.afterImageJobId
          ? this.characterImageReference(store.snapshot, job)
          : undefined;
      if (imageReference) {
        const options = modelGenerationOptions(
          "audio",
          origin === "builtin" ? plugin.key : undefined,
          profile.model,
          profile.channel,
          profile.config,
        );
        const asset = store.snapshot.assets[imageReference];
        if (!asset || asset.sizeBytes > (options.referenceBytes.image ?? mediaReferenceBytes))
          throw new ProjectError(
            "JOB_IMAGE_DEPENDENCY_FAILED",
            "形象素材超过音色模型的参考图大小限制",
          );
      }
      const references = submitting
        ? await this.references(
            store,
            imageReference
              ? {
                  ...job,
                  input: { ...job.input, referenceAssetIds: [imageReference] },
                }
              : job,
            requestSignal,
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
          signal,
        );
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
      const host = registry.createHost(registry.wrapChannelTransport(profile.channelId, transport));
      const context = {
        kind: job.kind,
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
      };
      if (submitting) {
        const claimed = await store.updateGeneration((state) => {
          const current = find(state, job.id);
          if (current.status !== "queued") return { result: false, changed: false };
          if (imageReference) this.characterImageReference(state, current);
          const { referenceURLs: _referenceURLs, ...input } = current.input;
          put(state, {
            ...current,
            input,
            status: "submitting",
            ...(deadline && { deadline }),
            updatedAt: new Date().toISOString(),
          });
          return { result: true, changed: true };
        }, signal);
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
      const response = await host.invoke(
        binding,
        submitting ? "submit" : "query",
        context,
        requestSignal,
      );
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
            status: "running",
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
              Math.max(this.pollFloor, pollDelay(plugin.meta.poll, submitting, attempts)),
          }),
          signal,
        );
        return;
      }
      if (result.status === "failed" || result.status === "cancelled") {
        const cancelled = result.status === "cancelled";
        await this.patch(
          store,
          job.id,
          () => ({
            status: cancelled ? "cancelled" : "failed",
            error: cancelled ? undefined : "JOB_PROVIDER_FAILED",
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
      await this.patch(store, job.id, () => ({ status: "downloading", progress: 99 }), signal);
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
      await store.updateGeneration(async (state) => {
        const current = find(state, job.id);
        if (jobIsTerminal(current.status)) return { changed: false, result: undefined };
        for (const entry of staged) {
          await this.assets.publishBlob(store, entry, signal);
          state.assets[entry.asset.assetId] = entry.asset;
        }
        const node = projectCanvas(state.canvas).nodes.find(({ id }) => id === job.nodeId);
        const first = outputs[0];
        const unchanged = node?.type === "creative" && generationNodeHash(node) === job.nodeHash;
        const isVoice = job.input.purpose === "character-voice";
        const isStoryboardSplit = job.input.purpose === "storyboard-split";
        let bound = !isVoice && unchanged && !!first;
        if (isStoryboardSplit) {
          if (!unchanged || first?.kind !== "text" || node?.type !== "creative")
            throw new ProviderError("JOB_OUTPUT_INVALID");
          const incoming = parseStoryboardOutput(first.text);
          const existing = node.data.storyboard ?? [];
          const storyboard =
            job.input.storyboardSplitMode === "append" ? [...existing, ...incoming] : incoming;
          if (storyboard.length > 100 || !validStoryboard(storyboard))
            throw new ProviderError("JOB_OUTPUT_INVALID");
          state.canvas = applyCanvas(state, [
            { type: "putNode", node: { ...node, data: { ...node.data, storyboard } } },
          ]);
          bound = true;
        } else if (!isVoice && node?.type === "creative") {
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
                  ...node.data,
                  ...appendOutputHistory(
                    node.data.outputs ?? [],
                    history,
                    node.data.activeOutputId,
                  ),
                  ...(unchanged && first
                    ? {
                        activeOutputId: history[0]?.id,
                        ...(first.kind === "text"
                          ? { text: first.text, assetId: undefined }
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
          progress: 100,
          outputs,
          bound,
          error: undefined,
          cancelRequested: false,
          updatedAt: new Date().toISOString(),
        });
        return { changed: true, result: undefined };
      }, signal);
    } catch (error) {
      if (signal.aborted) return;
      const errorCode = deadlineSignal?.aborted ? "JOB_TIMEOUT" : code(error);
      const unknown =
        !receivedResult &&
        (Boolean(job.providerTaskId) || code(error) === "PROVIDER_OUTCOME_UNKNOWN");
      await this.patch(
        store,
        job.id,
        (current) =>
          jobIsTerminal(current.status)
            ? {}
            : {
                status: unknown ? "outcome_unknown" : "failed",
                error: unknown ? "JOB_OUTCOME_UNKNOWN" : errorCode,
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
