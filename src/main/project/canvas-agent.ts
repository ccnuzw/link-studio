import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type {
  CanvasOperation,
  ProjectCanvasView,
} from "../../../packages/link-studio-core/src/canvas.ts";
import {
  CanvasAgentEdit,
  CanvasAgentGenerate,
  CanvasAgentRead,
  canvasAgentMediaModels,
} from "../../../packages/link-studio-core/src/canvas-agent.ts";
import type { DirectorScene } from "../../../packages/link-studio-core/src/director.ts";
import type { GenerationInput } from "../../../packages/link-studio-core/src/generation.ts";
import type { JsonValue, ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import type { CanvasMedia } from "./canvas-media.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import type { GenerationService } from "./generation.ts";
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
  private readonly stores = new Map<string, ProjectStore>();
  private readonly readSets = new Map<string, { revision: number; ids: Set<string> }>();
  private readonly sessions = new WeakMap<ProjectStore, AbortController>();

  constructor(
    private readonly generation: GenerationService,
    private readonly registry: () => Promise<SettingsRegistry>,
    private readonly media?: CanvasMedia,
    private readonly skills?: {
      catalog(query?: string): Array<{ id: string; title: string; summary: string }>;
      content(name: string, version: number): string | null;
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
    return this.media.inspect(store, asset, timeMs, frameId, signal);
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
    if (!this.media || assetIds.length > 4)
      throw new ProjectError("AGENT_MEDIA_LIMIT", "附件数量超过限制");
    const signal = this.sessions.get(store)?.signal ?? new AbortController().signal;
    const result = [];
    for (const assetId of assetIds) {
      const asset = store.snapshot.assets[assetId];
      if (!asset || !["image", "video"].includes(asset.mediaType))
        throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "只支持图片或视频附件");
      result.push(await this.media.attachment(store, asset, signal));
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
    if (command === "attachments") {
      const ids = Array.isArray(args.assetIds) ? args.assetIds.map(String) : [];
      return this.attachments(store, ids);
    }
    if (command === "skills") {
      const query = String(args.query ?? "").toLowerCase();
      const list = this.skills?.catalog(String(args.query ?? "")) ?? [];
      return list.filter(
        (skill) =>
          !query || `${skill.id} ${skill.title} ${skill.summary}`.toLowerCase().includes(query),
      );
    }
    if (command === "skill") {
      const id = String(args.id ?? "");
      const [name, version] = id.split("@");
      const skill = this.skills?.content(name ?? "", Number(version));
      return skill ? { id, text: skill } : null;
    }
    const runId = String(args.runId);
    const run = `${this.key(store)}:${runId}`;
    const input = args.input;
    switch (command) {
      case "prepare":
        return { project: store.projectId };
      case "question-models": {
        const registry = await this.registry();
        this.assertOpen(store);
        return canvasAgentMediaModels(registry.list()).map(({ provider, kind }) => ({
          id: provider.id,
          kind,
        }));
      }
      case "read": {
        if (!Value.Check(CanvasAgentRead, input))
          throw new ProjectError("CANVAS_OPERATION_INVALID", "检查读取参数");
        const state = await store.readCanvas();
        this.assertOpen(store);
        const offset = input.offset ?? 0;
        const selected = input.nodeIds
          ? state.canvas.nodes.filter(({ id }) => input.nodeIds?.includes(id))
          : state.canvas.nodes.slice(offset, offset + 30);
        const previous = this.readSets.get(run);
        const ids = previous?.revision === state.canvasRevision ? previous.ids : new Set<string>();
        if (input.nodeIds)
          for (const node of selected) if (node.type !== "unknown") ids.add(node.id);
        if (this.readSets.size >= 500)
          this.readSets.delete(this.readSets.keys().next().value ?? "");
        this.readSets.set(run, { revision: state.canvasRevision, ids });
        const registry = await this.registry();
        const clean = registry.redactor().redact;
        const { providers, plugins } = registry.list();
        const related = new Set(selected.map(({ id }) => id));
        return {
          canvasRevision: state.canvasRevision,
          viewport: state.canvas.viewport,
          missingNodeIds: input.nodeIds?.filter((id) => !related.has(id)) ?? [],
          nodes: selected.map((node) => {
            if (node.type !== "creative")
              return { ...node, data: { label: clean(node.data.label) } };
            const { director, ...data } = node.data;
            return {
              ...node,
              data: {
                ...data,
                label: clean(node.data.label),
                text: clean(node.data.text).slice(0, input.nodeIds ? 5000 : 200),
                ...(director ? directorContext(director, !!input.nodeIds, clean) : {}),
                ...(node.data.storyboard
                  ? {
                      storyboard: node.data.storyboard
                        .slice(0, input.nodeIds ? 30 : 0)
                        .map((shot) => ({
                          ...shot,
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
                      },
                    }
                  : {}),
              },
            };
          }),
          edges: state.canvas.edges
            .filter(({ source, target }) => related.has(source) || related.has(target))
            .slice(0, 100),
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
        return this.apply(store, runId, String(args.id), input);
      case "generate-preview": {
        if (!Value.Check(CanvasAgentGenerate, input))
          throw new ProjectError("JOB_INPUT_INVALID", "检查任务参数");
        const revision = store.getCanvas().canvasRevision;
        this.requireRead(
          run,
          revision,
          input.items.map(({ nodeId }) => nodeId),
        );
        if (new Set(input.items.map(({ nodeId }) => nodeId)).size !== input.items.length)
          throw new ProjectError("JOB_INPUT_INVALID", "每个节点只能提交一个任务");
        const items = await Promise.all(
          input.items.map(async (request) => {
            const { binding, node, kind } = await this.generation.prepare(store, request);
            return {
              request,
              kind,
              node_id: node.id,
              label: node.data.label,
              endpoint: binding.profile.endpoint,
              model: binding.profile.model,
            };
          }),
        );
        this.assertOpen(store);
        return { items, wait: true };
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
          const tasks = new Map(
            this.generation.list(store).jobs.map((job) => [job.id, job.nodeId]),
          );
          return entries.length && entries.every(({ id }) => tasks.has(id))
            ? { tasks: entries.map(({ id }) => ({ task_id: id, node_id: tasks.get(id) })) }
            : null;
        }
        const jobs = await this.generation.submit(store, entries, this.sessions.get(store)?.signal);
        return { tasks: jobs.map(({ id, nodeId }) => ({ task_id: id, node_id: nodeId })) };
      }
      case "undo":
        return this.undo(store, runId);
      case "inspect": {
        const media = args.media;
        const { nodeId, timeMs = 0 } = object(input);
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
        const frameId = stableId(
          `${store.projectId}:frame:${asset.assetId}:${asset.sha256}:${timeMs}`,
        );
        const result = await this.media.inspect(store, asset, timeMs, frameId, signal);
        this.assertOpen(store);
        return result;
      }
      default:
        throw new ProjectError("AGENT_SCOPE_DENIED", "工具不属于画布作用域");
    }
  }

  private apply(store: ProjectStore, runId: string, id: string, input: unknown) {
    const { expectedCanvasRevision, operations } = object(input);
    const edit = { expectedCanvasRevision, operations };
    if (!Value.Check(CanvasAgentEdit, edit) || edit.operations.length > 30)
      throw new ProjectError("CANVAS_OPERATION_INVALID", "无效审批");
    return store.updateGeneration((state) => {
      this.assertOpen(store);
      const key = `canvas-agent:${id}`;
      const fingerprint = contentHash(edit);
      const previous = state.extensions[key] as unknown as EditReceipt | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.runId !== runId)
          throw new ProjectError("OPERATION_ID_REUSED", "审批回执不匹配");
        return { result: previous, changed: false };
      }
      if (state.canvas.revision !== edit.expectedCanvasRevision)
        throw new ProjectError("CANVAS_REVISION_CONFLICT", "画布已更新");
      const before = projectCanvas(state.canvas);
      state.canvas = applyCanvas(state, edit.operations);
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
