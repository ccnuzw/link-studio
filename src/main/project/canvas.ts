import { Value } from "@sinclair/typebox/value";
import {
  CanvasEdge,
  CanvasGroup,
  CanvasId,
  type CanvasOperation,
  CanvasPosition,
  CanvasViewport,
  CreativeCanvasNode,
  type EditableCanvasNode,
  outputKindForNode,
  type ProjectCanvasView,
  validStoryboard,
} from "../../../packages/link-studio-core/src/canvas.ts";
import { validDirectorScene } from "../../../packages/link-studio-core/src/director.ts";
import type { JsonValue, ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { ProjectError } from "./errors.ts";

type StoredCanvas = ProjectState["canvas"];

function record(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function idOf(value: JsonValue) {
  const { id } = record(value);
  return typeof id === "string" ? id : undefined;
}

function editable(value: unknown): value is EditableCanvasNode {
  return Value.Check(CreativeCanvasNode, value) || Value.Check(CanvasGroup, value);
}

function graphIndex(values: JsonValue[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const id = idOf(value);
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function syntheticId(prefix: string, index: number, reserved: Set<string>) {
  let id = `${prefix}-${index}`;
  while (reserved.has(id)) id += "-";
  reserved.add(id);
  return id;
}

export function projectCanvas(canvas: StoredCanvas): ProjectCanvasView {
  const counts = graphIndex(canvas.nodes);
  const groups = new Set(
    canvas.nodes
      .filter((node) => Value.Check(CanvasGroup, node) && counts.get(node.id) === 1)
      .map((node) => idOf(node)),
  );
  const reservedNodes = new Set(counts.keys());
  const byRawId = new Map<string, ProjectCanvasView["nodes"][number]>();
  const nodes: ProjectCanvasView["nodes"] = canvas.nodes.map((node, index) => {
    const { id, position, parentId, type, data } = record(node);
    const parent = typeof parentId === "string" && groups.has(parentId) ? parentId : undefined;
    const unique = typeof id === "string" && counts.get(id) === 1;
    const entry: ProjectCanvasView["nodes"][number] =
      unique && editable(node) && parentId === parent
        ? node
        : {
            id:
              unique && Value.Check(CanvasId, id)
                ? id
                : syntheticId("compat-node", index, reservedNodes),
            position: Value.Check(CanvasPosition, position)
              ? position
              : { x: 120, y: 140 + index * 180 },
            type: "unknown",
            ...(parent ? { parentId: parent } : {}),
            data: {
              label:
                typeof record(data).label === "string"
                  ? String(record(data).label).slice(0, 255)
                  : `兼容节点 · ${typeof type === "string" ? type.slice(0, 64) : "未知类型"}`,
            },
          };
    if (unique) byRawId.set(id, entry);
    return entry;
  });
  const edgeCounts = graphIndex(canvas.edges);
  const reservedEdges = new Set(edgeCounts.keys());
  const edges: ProjectCanvasView["edges"] = canvas.edges.flatMap((edge, index) => {
    const { id, source, target } = record(edge);
    const from = typeof source === "string" ? byRawId.get(source) : undefined;
    const to = typeof target === "string" ? byRawId.get(target) : undefined;
    if (!from || !to) return [];
    if (
      Value.Check(CanvasEdge, edge) &&
      edgeCounts.get(edge.id) === 1 &&
      from.type === "creative" &&
      to.type === "creative"
    )
      return [edge];
    return [
      {
        id:
          typeof id === "string" && edgeCounts.get(id) === 1
            ? id
            : syntheticId("compat-edge", index, reservedEdges),
        source: from.id,
        target: to.id,
        readOnly: true,
      },
    ];
  });
  return {
    nodes,
    edges,
    viewport: Value.Check(CanvasViewport, canvas.viewport)
      ? canvas.viewport
      : { x: 0, y: 0, zoom: 1 },
  };
}

function invalid(): never {
  throw new ProjectError("CANVAS_OPERATION_INVALID", "操作包含重复标识、无效关联或只读画布记录");
}

function applyRecords(
  previous: JsonValue[],
  editableIds: Set<string>,
  changes: Map<string, JsonValue | null>,
) {
  const used = new Set<string>();
  const next = previous.flatMap((entry) => {
    const id = idOf(entry);
    if (id === undefined || !changes.has(id)) return [entry];
    if (!editableIds.has(id)) invalid();
    used.add(id);
    const change = changes.get(id);
    return change == null ? [] : [change];
  });
  for (const [id, change] of changes) {
    if (used.has(id)) continue;
    if (change === null) invalid();
    next.push(change);
  }
  return next;
}

function setChange(changes: Map<string, JsonValue | null>, id: string, value: JsonValue | null) {
  if (changes.has(id)) invalid();
  changes.set(id, value);
}

function validateCreativeOutputs(
  state: ProjectState,
  node: Extract<EditableCanvasNode, { type: "creative" }>,
) {
  const { character, kind, assetId } = node.data;
  if (
    node.data.director &&
    (kind !== "script" || node.data.storyboard || !validDirectorScene(node.data.director))
  )
    invalid();
  if (node.data.storyboard && (kind !== "script" || !validStoryboard(node.data.storyboard)))
    invalid();
  if (node.data.shotId && kind !== "image" && kind !== "video") invalid();
  if (character) {
    if (kind !== "image" || !character.name.trim() || !character.look.trim()) invalid();
    for (const [id, mediaType] of [
      ...character.extraAssetIds.map((id) => [id, "image"] as const),
      ...(character.voice ? [[character.voice.assetId, "audio"] as const] : []),
    ]) {
      const asset = state.assets[id];
      if (
        !asset ||
        asset.availability === "deleted" ||
        asset.mediaType !== mediaType ||
        id === assetId
      )
        throw new ProjectError("CANVAS_REFERENCE_MISSING", "角色素材不存在、类型不匹配或重复绑定");
    }
  }
  const outputs = node.data.outputs ?? [];
  const expectedKind = outputKindForNode(node.data.kind);
  const ids = new Set<string>();
  for (const output of outputs) {
    if (ids.has(output.id) || output.kind !== expectedKind) invalid();
    ids.add(output.id);
    if (output.kind === "text") {
      if (output.text === undefined || output.assetId !== undefined) invalid();
      continue;
    }
    if (!output.assetId || output.text !== undefined) invalid();
    const asset = state.assets[output.assetId];
    if (!asset || asset.availability === "deleted" || asset.mediaType !== output.kind) {
      throw new ProjectError("CANVAS_REFERENCE_MISSING", "历史产物引用的素材不存在或类型不匹配");
    }
  }
  if (node.data.activeOutputId !== undefined) {
    const active = outputs.find(({ id }) => id === node.data.activeOutputId);
    if (!active) invalid();
    if (
      active.kind === "text" &&
      (node.data.text !== active.text || node.data.assetId !== undefined)
    )
      invalid();
    if (active.kind !== "text" && node.data.assetId !== active.assetId) invalid();
  }
}

export function applyCanvas(state: ProjectState, operations: CanvasOperation[]): StoredCanvas {
  const previous = state.canvas;
  const view = projectCanvas(previous);
  const editableNodes = new Map(
    view.nodes.filter((node) => node.type !== "unknown").map((node) => [node.id, node]),
  );
  const nodeChanges = new Map<string, JsonValue | null>();
  const edgeChanges = new Map<string, JsonValue | null>();
  let viewport: CanvasViewport | undefined;
  for (const operation of operations) {
    switch (operation.type) {
      case "putNode": {
        const { node } = operation;
        const existing = editableNodes.get(node.id);
        if (
          existing &&
          (existing.type !== node.type ||
            (existing.type === "creative" &&
              node.type === "creative" &&
              existing.data.kind !== node.data.kind))
        )
          invalid();
        if (node.type === "creative" && node.data.assetId) {
          const asset = state.assets[node.data.assetId];
          if (!asset || asset.availability === "deleted" || asset.mediaType !== node.data.kind) {
            throw new ProjectError("CANVAS_REFERENCE_MISSING", "画布引用的素材不存在或类型不匹配");
          }
        }
        if (node.type === "creative") validateCreativeOutputs(state, node);
        setChange(nodeChanges, node.id, node);
        break;
      }
      case "removeNode":
        setChange(nodeChanges, operation.id, null);
        break;
      case "putEdge":
        setChange(edgeChanges, operation.edge.id, operation.edge);
        break;
      case "removeEdge":
        setChange(edgeChanges, operation.id, null);
        break;
      case "setViewport":
        if (viewport) invalid();
        viewport = operation.viewport;
        break;
    }
  }
  const editableEdges = new Set(view.edges.filter((edge) => !edge.readOnly).map((edge) => edge.id));
  const nodes = applyRecords(previous.nodes, new Set(editableNodes.keys()), nodeChanges);
  const edges = applyRecords(previous.edges, editableEdges, edgeChanges);
  if (
    nodes.length > Math.max(1000, previous.nodes.length) ||
    edges.length > Math.max(4000, previous.edges.length)
  )
    invalid();
  const removed = new Set([...nodeChanges].filter(([, value]) => value === null).map(([id]) => id));
  const nextNodes = new Map(editableNodes);
  for (const [id, value] of nodeChanges) {
    if (editable(value)) nextNodes.set(id, value);
    else nextNodes.delete(id);
  }
  for (const node of nodes) {
    const { parentId } = record(node);
    if (typeof parentId === "string" && removed.has(parentId)) invalid();
  }
  for (const node of nextNodes.values()) {
    if (node.type === "creative" && node.parentId && nextNodes.get(node.parentId)?.type !== "group")
      invalid();
  }
  const connections = new Map<string, number>();
  for (const edge of edges) {
    const { id, source, target } = record(edge);
    if (
      (typeof source === "string" && removed.has(source)) ||
      (typeof target === "string" && removed.has(target))
    )
      invalid();
    if (typeof id !== "string" || typeof source !== "string" || typeof target !== "string")
      continue;
    const key = JSON.stringify([source, target]);
    if (
      edgeChanges.has(id) &&
      (source === target ||
        nextNodes.get(source)?.type !== "creative" ||
        nextNodes.get(target)?.type !== "creative")
    )
      invalid();
    connections.set(key, (connections.get(key) ?? 0) + 1);
  }
  for (const change of edgeChanges.values()) {
    if (!Value.Check(CanvasEdge, change)) continue;
    const key = JSON.stringify([change.source, change.target]);
    if ((connections.get(key) ?? 0) > 1) invalid();
  }
  return {
    ...previous,
    nodes,
    edges,
    viewport: viewport ?? previous.viewport,
    revision: previous.revision + 1,
  };
}
