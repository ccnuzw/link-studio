import type { CanvasOperation, ProjectCanvasView } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";

type RecordWithId = { id: string };

export function canvasDiff(base: ProjectCanvasView, draft: ProjectCanvasView): CanvasOperation[] {
  const operations: CanvasOperation[] = [];
  function diff<Item extends RecordWithId>(
    before: Item[],
    after: Item[],
    put: (item: Item) => CanvasOperation,
    remove: (id: string) => CanvasOperation,
  ) {
    const previous = new Map(before.map((item) => [item.id, item]));
    for (const item of after) {
      if (!Value.Equal(previous.get(item.id), item)) operations.push(put(item));
      previous.delete(item.id);
    }
    for (const id of previous.keys()) operations.push(remove(id));
  }
  diff(
    base.nodes.filter((node) => node.type !== "unknown"),
    draft.nodes.filter((node) => node.type !== "unknown"),
    (node) => ({ type: "putNode", node }),
    (id) => ({ type: "removeNode", id }),
  );
  diff(
    base.edges.filter((edge) => !edge.readOnly),
    draft.edges.filter((edge) => !edge.readOnly),
    (edge) => ({ type: "putEdge", edge }),
    (id) => ({ type: "removeEdge", id }),
  );
  if (!Value.Equal(base.viewport, draft.viewport))
    operations.push({ type: "setViewport", viewport: draft.viewport });
  return operations;
}

export function rebaseCanvas(
  base: ProjectCanvasView,
  draft: ProjectCanvasView,
  saved: ProjectCanvasView,
) {
  const operations = canvasDiff(base, draft);
  const remoteChanges = new Map(
    canvasDiff(base, saved).map((operation) => [operationKey(operation), operation]),
  );
  const nodes = new Map(saved.nodes.map((node) => [node.id, node]));
  const edges = new Map(saved.edges.map((edge) => [edge.id, edge]));
  let viewport = saved.viewport;
  for (const operation of operations) {
    const remote = remoteChanges.get(operationKey(operation));
    if (remote) {
      if (!Value.Equal(operation, remote)) return null;
      continue;
    }
    switch (operation.type) {
      case "putNode":
        if (nodes.get(operation.node.id)?.type === "unknown") return null;
        nodes.set(operation.node.id, operation.node);
        break;
      case "removeNode":
        if (nodes.get(operation.id)?.type === "unknown") return null;
        nodes.delete(operation.id);
        break;
      case "putEdge":
        if (edges.get(operation.edge.id)?.readOnly) return null;
        edges.set(operation.edge.id, operation.edge);
        break;
      case "removeEdge":
        if (edges.get(operation.id)?.readOnly) return null;
        edges.delete(operation.id);
        break;
      case "setViewport":
        viewport = operation.viewport;
        break;
    }
  }
  for (const node of nodes.values()) {
    if ("parentId" in node && node.parentId && nodes.get(node.parentId)?.type !== "group")
      return null;
  }
  for (const edge of edges.values())
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) return null;
  return { nodes: [...nodes.values()], edges: [...edges.values()], viewport };
}

function operationKey(operation: CanvasOperation) {
  switch (operation.type) {
    case "putNode":
      return `node:${operation.node.id}`;
    case "removeNode":
      return `node:${operation.id}`;
    case "putEdge":
      return `edge:${operation.edge.id}`;
    case "removeEdge":
      return `edge:${operation.id}`;
    case "setViewport":
      return "viewport";
  }
}
