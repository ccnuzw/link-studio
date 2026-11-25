import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type {
  CanvasOperation,
  ProjectCanvasView,
} from "../../../packages/link-studio-core/src/canvas.ts";
import {
  CanvasAgentArrange,
  CanvasAgentCapture,
  CanvasAgentDelete,
  CanvasAgentEdit,
  CanvasAgentGenerate,
  CanvasAgentOps,
  CanvasAgentRead,
  canvasAgentMediaModels,
  maxAgentImages,
} from "../../../packages/link-studio-core/src/canvas-agent.ts";
import type { DirectorScene } from "../../../packages/link-studio-core/src/director.ts";
import type { DramaJobRequest } from "../../../packages/link-studio-core/src/drama.ts";
import type { GenerationInput } from "../../../packages/link-studio-core/src/generation.ts";
import {
  modelGenerationModes,
  modelGenerationOptions,
  modelParameterChoices,
} from "../../../packages/link-studio-core/src/media-generation.ts";
import { publicModelPricing } from "../../../packages/link-studio-core/src/model-price.ts";
import type { JsonValue, ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import { agentCanvasCatalog } from "./canvas-agent-catalog.ts";
import { compileDeletion, deletionPreview } from "./canvas-agent-delete.ts";
import { planFrames } from "./canvas-agent-frames.ts";
import { nodeGenerationInput, quotePreparedGeneration } from "./canvas-agent-generation";
import { compileArrange } from "./canvas-agent-layout.ts";
import { generationDetail } from "./canvas-agent-model";
import { compileAgentOps } from "./canvas-agent-ops.ts";
import type { CanvasMedia } from "./canvas-media.ts";
import { DramaTools, dramaDocument } from "./drama.ts";
import { estimateDramaJob } from "./drama-estimate.ts";
import { dramaJobReceipt, submitApprovedDramaJob } from "./drama-job.ts";
import { runDramaPlanning } from "./drama-planning.ts";
import { runDramaAssetJob } from "./drama-worker.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import { canvasRoleJobs, type GenerationService } from "./generation.ts";
import type { ProjectStore } from "./store.ts";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stableId(value: string) {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

type PatchRecord = { id: string; before: CanvasOperation; after: unknown; edge: boolean };
type EditReceipt = {
  runId: string;
  fingerprint: string;
  patches: PatchRecord[];
  nodeIds: string[];
  revision: number;
  undone?: boolean;
  created?: Record<string, string>;
  baseRevision?: number;
  warnings?: string[];
};

function digestEntry(value: unknown) {
  return contentHash(value ?? null);
}

function directorContext(
  scene: DirectorScene,
  detailed: boolean,
  clean: (value: string) => string,
) {
  const { cameras, characters, props, duration, activeCameraId } = scene;
  const active = cameras.find(({ id }) => id === activeCameraId);
  const directorSummary = {
    duration,
    activeCameraId,
    aspect: active?.aspect,
    cameraCount: cameras.length,
    characterCount: characters.length,
    propCount: props.length,
  };
  if (!detailed) return { directorSummary };
  const selectedCameras = active
    ? [active, ...cameras.filter(({ id }) => id !== active.id)]
    : cameras;
  const scrub = <Item extends { name: string }>(item: Item) => ({
    ...item,
    name: clean(item.name),
  });
  const withKeys = <Item extends { name: string; keys: unknown[] }>(item: Item) => ({
    ...scrub(item),
    keys: item.keys.slice(0, 8),
    keyCount: item.keys.length,
  });
  return {
    directorSummary,
    director: {
      duration,
      activeCameraId,
      cameras: selectedCameras.slice(0, 8).map(withKeys),
      characters: characters.slice(0, 12).map(withKeys),
      props: props.slice(0, 12).map(scrub),
    },
  };
}

export class CanvasAgentService {
  private readonly dramas = new WeakMap<ProjectStore, DramaTools>();
  private readonly dramaWorkers = new WeakMap<ProjectStore, Set<string>>();
  private readonly studioJobControllers = new WeakMap<ProjectStore, Map<string, AbortController>>();
  private readonly stores = new Map<string, ProjectStore>();
  private readonly readSets = new Map<string, { revision: number; ids: Set<string> }>();
  private readonly sessions = new WeakMap<ProjectStore, AbortController>();

  constructor(
    private readonly generation: GenerationService,
    private readonly registry: () => Promise<SettingsRegistry>,
    private readonly media?: CanvasMedia,
    private readonly skills?: {
      catalog(query?: string): Array<{ id: string; title: string; summary: string }>;
      page(
        id: string,
        offset: number,
        file?: string,
        pinned?: string,
      ): { id: string; text: string } | null;
    },
  ) {}

  key(store: ProjectStore) {
    return stableId(`${store.projectId}\n${store.directory}`);
  }

  async inspectMedia(
    store: ProjectStore,
    asset: ProjectState["assets"][string],
    timeMs: number,
    frameId: string,
    signal = new AbortController().signal,
  ) {
    if (!this.media) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "媒体处理能力不可用");
    return this.media.inspect(store, asset, timeMs, frameId, signal, true);
  }

  async trimMedia(
    store: ProjectStore,
    asset: ProjectState["assets"][string],
    operationId: string,
    startMs: number,
    endMs: number,
    removeAudio: boolean,
    signal: AbortSignal,
  ) {
    if (!this.media) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "媒体处理能力不可用");
    return this.media.trim(store, asset, operationId, startMs, endMs, removeAudio, signal);
  }

  async splitMedia(
    store: ProjectStore,
    asset: ProjectState["assets"][string],
    operationId: string,
    rows: number,
    columns: number,
    signal: AbortSignal,
    lines?: { x?: number[]; y?: number[] },
  ) {
    if (!this.media) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "媒体处理能力不可用");
    return this.media.split(store, asset, operationId, rows, columns, signal, lines);
  }

  async annotateMedia(
    store: ProjectStore,
    asset: ProjectState["assets"][string],
    operationId: string,
    pngData: string,
    signal: AbortSignal,
    purpose?: "outpaint",
  ) {
    if (!this.media) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "媒体处理能力不可用");
    return this.media.annotate(store, asset, operationId, pngData, signal, purpose);
  }

  attach(store: ProjectStore) {
    this.stores.set(this.key(store), store);
    this.sessions.set(store, new AbortController());
    this.startPlanning(store);
    for (const job of dramaDocument(store.snapshot)?.jobs ?? []) {
      if (["queued", "running"].includes(job.status)) this.startDramaAssetJob(store, job.id);
    }
  }

  startPlanning(store: ProjectStore) {
    const plan = dramaDocument(store.snapshot)?.planning;
    if (!plan || (plan.phase !== "running" && !plan.pending)) return;
    const signal = this.sessions.get(store)?.signal;
    const workers = this.dramaWorkers.get(store) ?? new Set<string>();
    if (!signal || workers.has("planning")) return;
    workers.add("planning");
    this.dramaWorkers.set(store, workers);
    void this.registry()
      .then((registry) => runDramaPlanning(store, registry, signal))
      .catch(() => {
        if (!signal.aborted) console.error("短剧规划状态保存失败");
      })
      .finally(() => workers.delete("planning"));
  }

  startDramaAssetJob(store: ProjectStore, id: string) {
    const session = this.sessions.get(store)?.signal;
    const workers = this.dramaWorkers.get(store) ?? new Set<string>();
    if (!session || workers.has(id)) return;
    const controller = new AbortController();
    const active = this.studioJobControllers.get(store) ?? new Map();
    active.set(id, controller);
    this.studioJobControllers.set(store, active);
    const signal = AbortSignal.any([session, controller.signal]);
    workers.add(id);
    this.dramaWorkers.set(store, workers);
    void this.registry()
      .then((registry) => runDramaAssetJob(store, registry, id, signal, this.media))
      .catch((error) => {
        if (!signal.aborted)
          console.error(
            "短剧任务状态保存失败",
            error instanceof ProjectError ? error.code : "DRAMA_WORKER_FAILED",
          );
      })
      .finally(() => {
        workers.delete(id);
        this.studioJobControllers.get(store)?.delete(id);
      });
  }

  async cancelStudioJob(store: ProjectStore, id: string, step?: "storyboard" | "breakdown") {
    await store.updateGeneration((state) => {
      const doc = dramaDocument(state),
        job = doc?.jobs?.find((entry) => entry.id === id),
        label = step === "breakdown" ? "拆解" : step === "storyboard" ? "分镜" : "短剧";
      if (!doc || !job || (step && job.step !== step))
        throw new ProjectError("DRAMA_STEP_NOT_READY", `${label}任务不存在`);
      if (job.status === "canceled") return { changed: false, result: null };
      if (job.status !== "running" && job.status !== "queued")
        throw new ProjectError("DRAMA_STEP_NOT_READY", `${label}任务已结束`);
      if (job.step === "scripts") {
        doc.status = doc.episodes.some((episode) => episode.script_md.trim())
          ? "ready"
          : "outlined";
        doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
        doc.revision++;
      }
      if (job.step === "storyboard") {
        const ep = doc.episodes.find((entry) => entry.episode_no === job.episodes[0]);
        if (ep) {
          ep.storyboard_status = doc.segments?.some(
            (segment) => segment.episode_no === ep.episode_no,
          )
            ? "ready"
            : "empty";
          ep.revision = (ep.revision ?? 1) + 1;
          doc.overview_revision ??= doc.revision;
          doc.revision++;
        }
      }
      job.status = "canceled";
      return { changed: true, result: null };
    });
    this.studioJobControllers.get(store)?.get(id)?.abort();
  }

  detach(store: ProjectStore) {
    const key = this.key(store);
    if (this.stores.get(key) === store) this.stores.delete(key);
    this.sessions.get(store)?.abort();
    this.sessions.delete(store);
    for (const run of this.readSets.keys())
      if (run.startsWith(`${key}:`)) this.readSets.delete(run);
  }

  private get(project: unknown) {
    const store = this.stores.get(String(project));
    if (!store) throw new ProjectError("AGENT_SCOPE_DENIED", "项目未打开");
    return store;
  }

  private assertOpen(store: ProjectStore) {
    if (this.stores.get(this.key(store)) !== store)
      throw new ProjectError("PROJECT_CLOSED", "项目已关闭");
  }

  private async attachments(store: ProjectStore, assetIds: string[]) {
    if (!this.media || assetIds.length > maxAgentImages)
      throw new ProjectError("AGENT_MEDIA_LIMIT", "附件数量超过限制");
    const signal = this.sessions.get(store)?.signal ?? new AbortController().signal;
    const result = [];
    for (const assetId of assetIds) {
      const asset = store.snapshot.assets[assetId];
      if (!asset || !["image", "video"].includes(asset.mediaType))
        throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "只支持图片或视频附件");
      result.push(
        await this.media.attachment(
          store,
          asset,
          signal,
          Math.floor((2 * 1024 * 1024) / assetIds.length),
        ),
      );
    }
    return result;
  }

  private requireRead(run: string, revision: number, ids: string[]) {
    const read = this.readSets.get(run);
    if (ids.length && (!read || read.revision !== revision || ids.some((id) => !read.ids.has(id))))
      throw new ProjectError("AGENT_READ_REQUIRED", "请先读取该节点的当前版本");
  }

  private checkedEdit(store: ProjectStore, run: string, args: unknown) {
    if (
      !Value.Check(CanvasAgentEdit, args) ||
      args.operations.length > 30 ||
      args.operations.some((op) => op.type === "setViewport")
    )
      throw new ProjectError("CANVAS_OPERATION_INVALID", "检查画布操作");
    const state = store.snapshot;
    if (state.canvas.revision !== args.expectedCanvasRevision)
      throw new ProjectError("CANVAS_REVISION_CONFLICT", "画布已更新");
    const canvas = projectCanvas(state.canvas);
    const nodes = new Set(canvas.nodes.map(({ id }) => id));
    const touched = new Set<string>();
    for (const op of args.operations) {
      if (op.type === "putNode") {
        if (nodes.has(op.node.id)) touched.add(op.node.id);
        if (op.node.type === "creative" && op.node.parentId && nodes.has(op.node.parentId))
          touched.add(op.node.parentId);
      } else if (op.type === "removeNode") touched.add(op.id);
      else if (op.type === "putEdge") {
        for (const id of [op.edge.source, op.edge.target]) if (nodes.has(id)) touched.add(id);
      } else if (op.type === "removeEdge") {
        const edge = canvas.edges.find(({ id }) => id === op.id);
        if (edge) for (const id of [edge.source, edge.target]) touched.add(id);
      }
    }
    this.requireRead(run, state.canvas.revision, [...touched]);
    applyCanvas(state, args.operations);
    return args;
  }

  async command(command: string, raw: unknown) {
    const args = object(raw);
    if (command === "admin-job-summaries") {
      const rows = Array.from(this.stores.values())
        .flatMap((store) =>
          this.generation
            .list(store)
            .jobs.filter((job) => !args.status || job.status === args.status)
            .map(({ id, kind, status, createdAt, updatedAt }) => ({
              id,
              kind,
              status,
              createdAt,
              updatedAt,
            })),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 50);
      return { resource: "queue", scope: "当前已打开项目的生成任务", limit: 50, rows };
    }
    if (command === "tasks") {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      const available = new Map(
        this.generation.list(this.get(args.project)).jobs.map((job) => [job.id, job] as const),
      );
      return ids.flatMap((id) => {
        const task = available.get(String(id));
        return task
          ? [
              {
                task_id: task.id,
                node_id: task.nodeId,
                kind: task.kind,
                status: task.status === "cancelled" ? "canceled" : task.status,
                progress: task.progress,
                error: task.error,
                outputs: task.outputs.map((output) =>
                  "assetId" in output
                    ? { media_type: output.kind, asset_id: output.assetId }
                    : { media_type: "text", text: output.text },
                ),
              },
            ]
          : [];
      });
    }
    const store = this.get(args.project);
    if (command.startsWith("drama-")) {
      if (command === "drama-estimate") {
        const snapshot = store.snapshot;
        const document = dramaDocument(snapshot);
        if (!document) throw new ProjectError("AGENT_SCOPE_DENIED", "未创建短剧");
        const { estimate } = await estimateDramaJob(
          document,
          args.input,
          await this.registry(),
          snapshot,
        );
        const { reason, ...request } = args.input as DramaJobRequest;
        const labels = {
          scripts: "分集剧本",
          breakdown: "资产拆解",
          asset_prompts: "资产提示词",
          storyboard: "分镜脚本",
          compose: "合成整集",
        };
        const activeJobs =
          document.jobs
            ?.filter((job) => ["queued", "running"].includes(job.status))
            .map(({ id, step, status, episodes }) => ({ id, step, status, episodes })) ?? [];
        return {
          title: `运行短剧任务：${labels[request.step]}`,
          reason: reason ?? "",
          args: request,
          estimate,
          ...(document.episode_order && { episodeOrder: document.episode_order }),
          before: JSON.stringify({ active_jobs: activeJobs }),
          after: JSON.stringify(request),
        };
      }
      if (
        args.kind === "drama_run_job" &&
        typeof args.id === "string" &&
        typeof args.runId === "string"
      ) {
        if (command === "drama-receipt")
          return dramaJobReceipt(store, args.runId, args.id, args.input);
        if (command === "drama-apply") {
          const job = await submitApprovedDramaJob(
            store,
            await this.registry(),
            args.runId,
            args.id,
            args.input as { args: DramaJobRequest; estimate: number },
            this.sessions.get(store)?.signal,
          );
          if (job.status === "queued") this.startDramaAssetJob(store, job.id);
          return { id: job.id, status: job.status, step: job.step, episodes: job.episodes };
        }
      }
      let tools = this.dramas.get(store);
      if (!tools) {
        tools = new DramaTools();
        this.dramas.set(store, tools);
      }
      if (["drama-skills", "drama-skill", "drama-question-models"].includes(command)) {
        await tools.command(store, "drama-prepare", {
          runId: String(args.runId),
          input: undefined,
        });
        command = command.slice(6);
      } else
        return tools.command(
          store,
          command,
          { ...args, runId: String(args.runId), input: args.input },
          this.sessions.get(store)?.signal,
        );
    }
    if (command === "attachments") {
      const ids = Array.isArray(args.assetIds) ? args.assetIds.map(String) : [];
      return this.attachments(store, ids);
    }
    if (command === "skills") {
      return this.skills?.catalog(String(args.query ?? "")) ?? [];
    }
    if (command === "skill") {
      const id = String(args.id ?? "");
      return (
        this.skills?.page(
          id,
          Number(args.offset ?? 0),
          typeof args.file === "string" ? args.file : undefined,
          typeof args.pinned === "string" ? args.pinned : undefined,
        ) ?? null
      );
    }
    const runId = String(args.runId);
    const run = `${this.key(store)}:${runId}`;
    const input = args.input;
    switch (command) {
      case "check-message": {
        const references = new Map<string, { kind: string; id: string; name: string }>();
        for (const match of String(input).matchAll(
          /@\[([^\]]*)\]\((node|model|skill|asset):([^)\s]+)\)/g,
        )) {
          const [, name, kind, id] = match;
          if (name === undefined || !kind || !id) continue;
          references.set(`${kind}:${id}`, { kind, id, name });
          if (references.size > 50)
            throw new ProjectError("AGENT_MESSAGE_REFERENCE_INVALID", "一条消息最多引用 50 个对象");
        }
        const kinds = new Set([...references.values()].map((ref) => ref.kind));
        const nodes = kinds.has("node")
          ? new Set((await store.readCanvas()).canvas.nodes.map((node) => node.id))
          : undefined;
        const models = kinds.has("model")
          ? new Set(
              canvasAgentMediaModels((await this.registry()).list()).map((row) => row.provider.id),
            )
          : undefined;
        const skills = kinds.has("skill")
          ? new Set(this.skills?.catalog().map((skill) => skill.id))
          : undefined;
        this.assertOpen(store);
        for (const { kind, id, name } of references.values()) {
          let reason: string | undefined;
          if (kind === "node" && !nodes?.has(id))
            reason = `引用的节点「${name}」不可用：画布上没有这个节点，可能已被删除`;
          if (kind === "model" && !models?.has(id))
            reason = `引用的模型「${name}」不可用：模型未发布或已下线`;
          if (kind === "skill" && !skills?.has(id))
            reason = `引用的技能「${name}」不可用：没有这个技能，或已被停用`;
          if (kind === "asset")
            reason = `暂不支持引用素材附件「${name}」，请先把图片放进画布，再引用对应的节点`;
          if (reason) throw new ProjectError("AGENT_MESSAGE_REFERENCE_INVALID", reason);
        }
        return null;
      }
      case "prepare": {
        if (!args.includeCatalog) return { project: store.projectId };
        const state = await store.readCanvas();
        const clean = (await this.registry()).redactor().redact;
        this.assertOpen(store);
        const selection = Array.isArray(args.selection)
          ? args.selection.filter((id): id is string => typeof id === "string")
          : [];
        return {
          project: store.projectId,
          catalog: agentCanvasCatalog(state.canvas, selection, clean),
        };
      }
      case "arrange":
      case "apply-ops": {
        if (typeof args.id !== "string" || !args.id)
          throw new ProjectError("CANVAS_OPERATION_INVALID", "检查批量操作");
        const operationId = stableId(`${run}:${args.id}`);
        const settings = command === "apply-ops" ? (await this.registry()).list() : undefined;
        const receipt = await store.updateGeneration((state) => {
          this.assertOpen(store);
          const fingerprint =
            command === "arrange" ? contentHash({ command, input }) : contentHash(input);
          const key = `canvas-agent:direct:${operationId}`;
          const previous = state.extensions[key] as unknown as EditReceipt | undefined;
          if (previous) {
            if (previous.fingerprint !== fingerprint)
              throw new ProjectError("OPERATION_ID_REUSED", "调用参数已变化");
            return { result: previous, changed: false };
          }
          const before = projectCanvas(state.canvas);
          const compiled =
            command === "arrange"
              ? Value.Check(CanvasAgentArrange, input) &&
                compileArrange(before, input, state.assets)
              : settings &&
                Value.Check(CanvasAgentOps, input) &&
                compileAgentOps(
                  before,
                  input,
                  (index) => stableId(`${operationId}:${index}`),
                  state.assets,
                  settings,
                );
          if (!compiled) throw new ProjectError("CANVAS_OPERATION_INVALID", "检查画布操作参数");
          const { operations, touched, created } = compiled;
          if (operations.length && !Value.Check(CanvasAgentEdit.properties.operations, operations))
            throw new ProjectError("CANVAS_OPERATION_INVALID", "布局超出画布范围");
          this.requireRead(run, state.canvas.revision, touched);
          const baseRevision = state.canvas.revision;
          if (operations.length) state.canvas = applyCanvas(state, operations);
          const patches = inversePatches(before, projectCanvas(state.canvas));
          const result: EditReceipt = {
            runId,
            fingerprint,
            created,
            ...("warnings" in compiled && compiled.warnings.length
              ? { warnings: compiled.warnings }
              : {}),
            baseRevision,
            revision: state.canvas.revision,
            patches,
            nodeIds: patches.filter((patch) => !patch.edge).map((patch) => patch.id),
          };
          state.extensions[key] = result as unknown as JsonValue;
          return { result, changed: true };
        }, this.sessions.get(store)?.signal);
        if (receipt.revision === store.getCanvas().canvasRevision) {
          const last = this.readSets.get(run);
          const ids = new Set(
            last && (last.revision === receipt.revision || last.revision === receipt.baseRevision)
              ? last.ids
              : [],
          );
          if (command !== "arrange") for (const id of receipt.nodeIds) ids.add(id);
          this.readSets.set(run, { revision: receipt.revision, ids });
        }
        return {
          revision: receipt.revision,
          created: receipt.created,
          nodeIds: receipt.nodeIds,
          ...(receipt.warnings ? { warnings: receipt.warnings } : {}),
        };
      }
      case "model-list": {
        const { kind } = object(input);
        if (kind !== "image" && kind !== "video" && kind !== "audio")
          throw new ProjectError("JOB_INPUT_INVALID", "检查模型类型");
        const registry = await this.registry();
        this.assertOpen(store);
        const { providers, plugins } = registry.list();
        const clean = registry.redactor().redact;
        return {
          models: providers.flatMap((provider) => {
            const plugin = plugins.find(({ hash }) => hash === provider.pluginHash);
            if (
              !provider.enabled ||
              provider.pending ||
              provider.channelEnabled === false ||
              provider.config?.kind === "agent" ||
              !plugin ||
              plugin.disabled ||
              plugin.kind !== kind ||
              (plugin.auth !== "none" && !provider.hasSecret)
            )
              return [];
            const options = modelGenerationOptions(
              kind,
              plugin.origin === "builtin" ? plugin.key : undefined,
              provider.model,
              provider.channel,
              provider.config,
            );
            const params = {
              ...modelParameterChoices(options),
              count: options.counts,
              ...options.customParameters,
            };
            return [
              {
                key: provider.id,
                revision: provider.revision,
                label: clean(provider.label),
                hint: clean(provider.config?.description ?? ""),
                ops: modelGenerationModes(kind, options).filter(
                  (mode) => !options.modes || options.modes.includes(mode),
                ),
                refs: {
                  image: !!options.references.image,
                  video: !!options.references.video,
                  audio: !!options.references.audio,
                },
                params,
                pricing: publicModelPricing(provider.config?.pricing),
              },
            ];
          }),
        };
      }
      case "question-models": {
        const registry = await this.registry();
        this.assertOpen(store);
        return canvasAgentMediaModels(registry.list()).map(({ provider, kind }) => ({
          id: provider.id,
          kind,
          name: provider.config?.name || provider.model,
          hint: provider.label,
        }));
      }
      case "read": {
        if (!Value.Check(CanvasAgentRead, input))
          throw new ProjectError("CANVAS_OPERATION_INVALID", "检查读取参数");
        const state = await store.readCanvas();
        this.assertOpen(store);
        const offset = input.offset ?? 0;
        let selected = state.canvas.nodes.slice(offset, offset + 30);
        if (input.nodeIds) {
          const byId = new Map(state.canvas.nodes.map((node) => [node.id, node]));
          selected = [...new Set(input.nodeIds)].map((id) => {
            const node = byId.get(id);
            if (!node) throw new ProjectError("CANVAS_OPERATION_INVALID", `节点 "${id}" 不存在`);
            return node;
          });
        }
        const previous = this.readSets.get(run);
        const ids = previous?.revision === state.canvasRevision ? previous.ids : new Set<string>();
        if (input.nodeIds)
          for (const node of selected) if (node.type !== "unknown") ids.add(node.id);
        if (this.readSets.size >= 500)
          this.readSets.delete(this.readSets.keys().next().value ?? "");
        this.readSets.set(run, { revision: state.canvasRevision, ids });
        const registry = await this.registry();
        const clean = registry.redactor().redact;
        const settings = registry.list();
        const { providers, plugins } = settings;
        const related = new Set(selected.map(({ id }) => id));
        const edges = state.canvas.edges.filter(
          ({ source, target }) => related.has(source) || related.has(target),
        );
        return {
          canvasRevision: state.canvasRevision,
          viewport: state.canvas.viewport,
          totalNodes: state.canvas.nodes.length,
          nodes: selected.map((node) => {
            if (node.type === "group" && input.nodeIds) {
              return {
                ...node,
                size: { x: node.width, y: node.height },
                data: { ...node.data, label: clean(node.data.label) },
              };
            }
            if (node.type !== "creative")
              return { ...node, data: { label: clean(node.data.label) } };
            const {
              director,
              assetId,
              outputs,
              activeOutputId: _activeOutputId,
              ...data
            } = node.data;
            const detail = input.nodeIds && generationDetail(data, settings);
            const text = clean(node.data.text);
            const characters = input.nodeIds ? Array.from(text) : undefined;
            return {
              ...node,
              ...(input.nodeIds && node.parentId && { parent: node.parentId }),
              ...(detail?.mode && { mode: detail.mode }),
              data: {
                ...data,
                outputCount: outputs?.length ?? 0,
                hasOutput: Boolean(assetId || outputs?.length),
                ...(detail?.model && { model: clean(detail.model) }),
                ...(detail &&
                  Object.keys(detail.params).length && {
                    params: Object.fromEntries(
                      Object.entries(detail.params).map(([key, value]) => [
                        key,
                        typeof value === "string" ? clean(value) : value,
                      ]),
                    ),
                  }),
                label: clean(node.data.label),
                text: characters
                  ? characters.length > 4000
                    ? `${characters.slice(0, 4000).join("")}…`
                    : text
                  : text.slice(0, 200),
                ...(director ? directorContext(director, !!input.nodeIds, clean) : {}),
                ...(node.data.storyboard
                  ? {
                      storyboard: node.data.storyboard
                        .slice(0, input.nodeIds ? node.data.storyboard.length : 0)
                        .map(({ imageAssetId, ...shot }, index) => ({
                          ...shot,
                          ...(imageAssetId && { hasImage: true }),
                          no: index + 1,
                          scene: clean(shot.scene),
                          action: clean(shot.action),
                          dialogue: clean(shot.dialogue),
                        })),
                      shotCount: node.data.storyboard.length,
                    }
                  : {}),
                ...(node.data.character
                  ? {
                      character: {
                        ...node.data.character,
                        name: clean(node.data.character.name),
                        look: clean(node.data.character.look),
                        description: clean(node.data.character.description),
                        ...(node.data.character.voicePrompt
                          ? { voicePrompt: clean(node.data.character.voicePrompt) }
                          : {}),
                      },
                    }
                  : {}),
              },
            };
          }),
          edges: input.nodeIds ? edges : edges.slice(0, 100),
          nextOffset:
            !input.nodeIds && offset + 30 < state.canvas.nodes.length ? offset + 30 : undefined,
          assets: Object.values(store.snapshot.assets)
            .filter((asset) => asset.availability === "ready")
            .slice(0, 40)
            .map(({ assetId, displayName, mediaType }) => ({
              assetId,
              displayName: clean(displayName),
              mediaType,
            })),
          providers: providers
            .filter(({ enabled }) => enabled)
            .map(({ id, revision, label, model, pluginHash }) => ({
              id,
              revision,
              label: clean(label),
              model: clean(model),
              kind: plugins.find(({ hash }) => hash === pluginHash)?.kind,
            })),
        };
      }
      case "edit-preview": {
        if (Value.Check(CanvasAgentDelete, input)) {
          const state = store.snapshot;
          const canvas = projectCanvas(state.canvas);
          applyCanvas(state, compileDeletion(canvas, input.nodeIds ?? [], input.edgeIds ?? []));
          return deletionPreview(canvas, state.canvas.revision, input);
        }
        const edit = this.checkedEdit(store, run, input);
        return {
          ...edit,
          items: edit.operations.map((operation) => ({
            label: operation.type,
            node_id:
              "node" in operation
                ? operation.node.id
                : "edge" in operation
                  ? operation.edge.id
                  : "id" in operation
                    ? operation.id
                    : "",
          })),
        };
      }
      case "edit-apply":
        return this.apply(store, runId, String(args.id), input, args.selected);
      case "generate-preview": {
        if (!Value.Check(CanvasAgentGenerate, input))
          throw new ProjectError("JOB_INPUT_INVALID", "检查任务参数");
        const { canvas, canvasRevision: revision } = store.getCanvas();
        this.requireRead(
          run,
          revision,
          input.items.map(({ nodeId }) => nodeId),
        );
        if (new Set(input.items.map(({ nodeId }) => nodeId)).size !== input.items.length)
          throw new ProjectError("JOB_INPUT_INVALID", "每个节点只能提交一个任务");
        const settings = (await this.registry()).list();
        const state = store.snapshot;
        const jobs = canvasRoleJobs(state);
        const items = [];
        for (const { nodeId } of input.items) {
          const request = nodeGenerationInput(
            canvas,
            revision,
            nodeId,
            state.assets,
            settings,
            jobs,
          );
          const {
            binding,
            node,
            kind,
            input: prepared,
          } = await this.generation.prepare(store, request, true);
          const config = binding.profile.config;
          const estimate = quotePreparedGeneration(config, kind, prepared, state.assets);
          items.push({
            request,
            kind,
            node_id: node.id,
            label: node.data.label,
            model_key: binding.profile.id,
            model_name: config?.name || binding.profile.label,
            count: 1,
            ...(estimate !== undefined && { price: estimate }),
            endpoint: binding.profile.endpoint,
            model: binding.profile.model,
          });
        }
        this.assertOpen(store);
        return {
          items,
          reason: Array.from(input.reason ?? "")
            .slice(0, 200)
            .join(""),
          wait: input.wait ?? true,
        };
      }
      case "generate-apply":
      case "generate-receipt": {
        const proposal = object(input);
        const items = Array.isArray(proposal.items) ? proposal.items : [];
        const selected = Array.isArray(args.selected) ? args.selected : [];
        const entries = selected.map((index) => ({
          id: stableId(`${this.key(store)}:${String(args.id)}:${String(index)}`),
          input: object(items[Number(index)]).request as GenerationInput,
        }));
        this.assertOpen(store);
        if (command === "generate-receipt") {
          return this.generation.receipt(
            store,
            entries.map(({ id }) => id),
          );
        }
        const jobs = await this.generation.submit(
          store,
          entries,
          this.sessions.get(store)?.signal,
          true,
        );
        return { tasks: jobs.map(({ id, nodeId }) => ({ task_id: id, node_id: nodeId })) };
      }
      case "undo":
        return this.undo(store, runId);
      case "inspect": {
        const media = args.media;
        const { nodeId, timeMs = 0, count = 6 } = object(input);
        if (
          typeof nodeId !== "string" ||
          typeof timeMs !== "number" ||
          !Number.isSafeInteger(timeMs) ||
          timeMs < 0 ||
          timeMs > 600_000 ||
          (media !== "image" && media !== "video")
        )
          throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "检查媒体读取参数");
        const { canvas, canvasRevision } = await store.readCanvas();
        this.requireRead(run, canvasRevision, [nodeId]);
        const node = canvas.nodes.find(({ id }) => id === nodeId);
        const asset =
          node?.type === "creative" && node.data.assetId
            ? store.snapshot.assets[node.data.assetId]
            : undefined;
        const signal = this.sessions.get(store)?.signal;
        if (!this.media || !signal || asset?.availability !== "ready" || asset.mediaType !== media)
          throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "当前节点没有可用的匹配素材");
        if (media === "video") {
          if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 6)
            throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "抽帧数量无效");
          if (typeof args.analyze === "function") {
            try {
              const video = await this.media.videoInput(store, asset, signal);
              signal.throwIfAborted();
              const analysis = await args.analyze(video, signal);
              this.assertOpen(store);
              if (typeof analysis !== "string" || !analysis.trim())
                throw new Error("EMPTY_ANALYSIS");
              return { analysis };
            } catch {
              signal.throwIfAborted();
              if (!args.allowFrames)
                throw new ProjectError(
                  "AGENT_MEDIA_UNAVAILABLE",
                  "视频分析失败，当前模型无法退回抽帧",
                );
            }
          }
          const result = await this.media.sampleVideo(store, asset, count, signal);
          this.assertOpen(store);
          return result;
        }
        const frameId = stableId(
          `${store.projectId}:frame:${asset.assetId}:${asset.sha256}:${timeMs}`,
        );
        const result = await this.media.inspect(store, asset, timeMs, frameId, signal);
        this.assertOpen(store);
        return result;
      }
      case "capture": {
        if (!Value.Check(CanvasAgentCapture, input) || typeof args.id !== "string" || !args.id)
          throw new ProjectError("CANVAS_OPERATION_INVALID", "检查截帧参数");
        const media = this.media;
        const signal = this.sessions.get(store)?.signal;
        if (!media || !signal) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "截帧不可用");
        const key = `canvas-agent:frames:${stableId(`${run}:${args.id}`)}`;
        const fingerprint = contentHash(input);
        return store.updateGeneration(async (state) => {
          this.assertOpen(store);
          const previous = state.extensions[key] as unknown as
            | (EditReceipt & {
                frames: { node_id: string; label: string; at: number; connected_to: string[] }[];
              })
            | undefined;
          if (previous) {
            if (previous.fingerprint !== fingerprint)
              throw new ProjectError("OPERATION_ID_REUSED", "调用参数已变化");
            return {
              changed: false,
              result: {
                ok: true,
                revision: previous.revision,
                frames: previous.frames,
                nodeIds: previous.nodeIds,
              },
            };
          }
          const before = projectCanvas(state.canvas);
          const planned = planFrames(before, state.assets, input, (part) =>
            stableId(`${key}:${part}`),
          );
          if (!Value.Check(CanvasAgentEdit.properties.operations, planned.operations))
            throw new ProjectError("CANVAS_OPERATION_INVALID", "截帧超出画布范围");
          for (const frame of planned.frames) {
            const timeMs = Math.min(
              Math.round(frame.at * 1000),
              Number(planned.asset.metadata.durationMs) - 1,
            );
            await media.inspect(
              store,
              planned.asset,
              timeMs,
              frame.assetId,
              signal,
              true,
              (asset) => {
                state.assets[asset.assetId] = asset;
              },
            );
          }
          this.assertOpen(store);
          state.canvas = applyCanvas(state, planned.operations);
          const patches = inversePatches(before, projectCanvas(state.canvas));
          const frames = planned.frames.map(({ assetId, ...frame }) => frame);
          const result = {
            ok: true,
            frames,
            revision: state.canvas.revision,
            nodeIds: frames.map((frame) => frame.node_id),
          };
          state.extensions[key] = {
            ...result,
            runId,
            fingerprint,
            patches,
          } as unknown as JsonValue;
          return { changed: true, result };
        }, signal);
      }
      default:
        throw new ProjectError("AGENT_SCOPE_DENIED", "工具不属于画布作用域");
    }
  }

  private apply(store: ProjectStore, runId: string, id: string, input: unknown, selected: unknown) {
    const { expectedCanvasRevision, operations, action, nodeIds, edgeIds, reason } = object(input);
    const edit = { expectedCanvasRevision, operations };
    const deletion = { nodeIds, edgeIds, reason };
    let targets: { nodeIds: string[]; edgeIds: string[] } | undefined;
    if (action === "delete" && Value.Check(CanvasAgentDelete, deletion)) {
      const nodes = deletion.nodeIds ?? [];
      const edges = deletion.edgeIds ?? [];
      const limit = nodes.length + Number(Boolean(edges.length));
      if (
        !Array.isArray(selected) ||
        !selected.length ||
        selected.some((index) => !Number.isInteger(index) || index < 0 || index >= limit) ||
        (edges.length && !selected.includes(nodes.length))
      )
        throw new ProjectError("CANVAS_OPERATION_INVALID", "检查删除审批");
      targets = { nodeIds: nodes.filter((_, index) => selected.includes(index)), edgeIds: edges };
    } else if (!Value.Check(CanvasAgentEdit, edit) || edit.operations.length > 30)
      throw new ProjectError("CANVAS_OPERATION_INVALID", "无效审批");
    return store.updateGeneration((state) => {
      this.assertOpen(store);
      const key = `canvas-agent:${id}`;
      const fingerprint = contentHash(targets ? { expectedCanvasRevision, targets } : edit);
      const previous = state.extensions[key] as unknown as EditReceipt | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.runId !== runId)
          throw new ProjectError("OPERATION_ID_REUSED", "审批回执不匹配");
        return { result: previous, changed: false };
      }
      if (state.canvas.revision !== edit.expectedCanvasRevision)
        throw new ProjectError("CANVAS_REVISION_CONFLICT", "画布已更新");
      const before = projectCanvas(state.canvas);
      state.canvas = applyCanvas(
        state,
        targets
          ? compileDeletion(before, targets.nodeIds, targets.edgeIds)
          : (edit.operations as CanvasOperation[]),
      );
      const after = projectCanvas(state.canvas);
      const patches = inversePatches(before, after);
      const result: EditReceipt = {
        runId,
        fingerprint,
        patches,
        nodeIds: patches.filter(({ edge }) => !edge).map(({ id }) => id),
        revision: state.canvas.revision,
      };
      state.extensions[key] = result as unknown as JsonValue;
      return { result, changed: true };
    }, this.sessions.get(store)?.signal);
  }

  private undo(store: ProjectStore, runId: string) {
    return store.updateGeneration((state) => {
      this.assertOpen(store);
      const skipped: { id: string; reason: string }[] = [];
      let reverted = 0;
      const receipts = Object.entries(state.extensions)
        .filter(
          ([key, raw]) =>
            key.startsWith("canvas-agent:") && object(raw).runId === runId && !object(raw).undone,
        )
        .sort(
          (left, right) => Number(object(right[1]).revision) - Number(object(left[1]).revision),
        );
      for (const [key, raw] of receipts) {
        const receipt = raw as unknown as EditReceipt;
        const visible = projectCanvas(state.canvas);
        let operations = receipt.patches.filter((patch) => {
          const entry = (patch.edge ? visible.edges : visible.nodes).find(
            ({ id }) => id === patch.id,
          );
          if (digestEntry(entry) !== digestEntry(patch.after)) {
            skipped.push({ id: patch.id, reason: "已被后来编辑" });
            return false;
          }
          return true;
        });
        try {
          if (operations.length)
            state.canvas = applyCanvas(
              state,
              operations.map(({ before }) => before),
            );
        } catch {
          const pending = operations;
          operations = [];
          for (const patch of pending) {
            try {
              state.canvas = applyCanvas(state, [patch.before]);
              operations.push(patch);
            } catch {
              skipped.push({ id: patch.id, reason: "存在后来添加的关联" });
            }
          }
        }
        reverted += operations.length;
        state.extensions[key] = { ...receipt, undone: true } as unknown as JsonValue;
      }
      return {
        changed: receipts.length > 0,
        result: { reverted, skipped, revision: state.canvas.revision },
      };
    }, this.sessions.get(store)?.signal);
  }
}

function inversePatches(before: ProjectCanvasView, after: ProjectCanvasView): PatchRecord[] {
  const patches: PatchRecord[] = [];
  const previousNodes = new Map(before.nodes.map((entry) => [entry.id, entry]));
  const nextNodes = new Map(after.nodes.map((entry) => [entry.id, entry]));
  const previousEdges = new Map(before.edges.map((entry) => [entry.id, entry]));
  const nextEdges = new Map(after.edges.map((entry) => [entry.id, entry]));
  for (const id of new Set([...previousEdges.keys(), ...nextEdges.keys()])) {
    const previous = previousEdges.get(id);
    const next = nextEdges.get(id);
    if (digestEntry(previous) !== digestEntry(next) && !previous?.readOnly && !next?.readOnly)
      patches.push({
        id,
        before: previous ? { type: "putEdge", edge: previous } : { type: "removeEdge", id },
        after: next ?? null,
        edge: true,
      });
  }
  for (const id of new Set([...previousNodes.keys(), ...nextNodes.keys()])) {
    const previous = previousNodes.get(id);
    const next = nextNodes.get(id);
    if (
      digestEntry(previous) !== digestEntry(next) &&
      previous?.type !== "unknown" &&
      next?.type !== "unknown"
    )
      patches.push({
        id,
        before: previous ? { type: "putNode", node: previous } : { type: "removeNode", id },
        after: next ?? null,
        edge: false,
      });
  }
  return patches;
}
