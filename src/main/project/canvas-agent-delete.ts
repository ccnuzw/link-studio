import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  CanvasOperation,
  ProjectCanvasView,
} from "../../../packages/link-studio-core/src/canvas.ts";
import { CanvasOperations } from "../../../packages/link-studio-core/src/canvas.ts";
import type { CanvasAgentDelete } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import { ProjectError } from "./errors.ts";

export function compileDeletion(canvas: ProjectCanvasView, nodeIds: string[], edgeIds: string[]) {
  const gone = new Set(nodeIds);
  const dropped = new Set(edgeIds);
  const nodes = new Map(canvas.nodes.map((node) => [node.id, node]));
  const edges = new Set(canvas.edges.map((edge) => edge.id));
  if (
    (!gone.size && !dropped.size) ||
    nodeIds.some((id) => !nodes.has(id) || nodes.get(id)?.type === "unknown") ||
    edgeIds.some((id) => !edges.has(id))
  )
    throw new ProjectError("CANVAS_OPERATION_INVALID", "请选择存在且可编辑的节点或连线");
  const operations: CanvasOperation[] = [];
  for (const edge of canvas.edges) {
    if (dropped.has(edge.id) || gone.has(edge.source) || gone.has(edge.target)) {
      if (edge.readOnly) throw new ProjectError("CANVAS_OPERATION_INVALID", "关联线只读");
      operations.push({ type: "removeEdge", id: edge.id });
    }
  }
  for (const node of canvas.nodes) {
    if (gone.has(node.id)) operations.push({ type: "removeNode", id: node.id });
    else if (node.type === "creative" && node.parentId && gone.has(node.parentId)) {
      const { parentId, ...member } = node;
      const parent = nodes.get(parentId);
      if (parent?.type !== "group")
        throw new ProjectError("CANVAS_OPERATION_INVALID", "组框不存在");
      operations.push({
        type: "putNode",
        node: {
          ...member,
          position: {
            x: parent.position.x + node.position.x,
            y: parent.position.y + node.position.y,
          },
        },
      });
    }
  }
  if (!Value.Check(CanvasOperations, operations))
    throw new ProjectError("CANVAS_OPERATION_INVALID", "删除后的成员坐标超出画布范围");
  return operations;
}

export function deletionPreview(
  canvas: ProjectCanvasView,
  revision: number,
  request: Static<typeof CanvasAgentDelete>,
) {
  const { nodeIds = [], edgeIds = [] } = request;
  const nodes = new Map(canvas.nodes.map((node) => [node.id, node]));
  const items = nodeIds.map((id) => {
    const node = nodes.get(id);
    return {
      node_id: id,
      label: node?.data.label || id,
      hasOutput:
        node?.type === "creative" && Boolean(node.data.assetId || node.data.outputs?.length),
    };
  });
  return {
    action: "delete",
    expectedCanvasRevision: revision,
    reason: Array.from(request.reason).slice(0, 200).join(""),
    nodeIds,
    edgeIds,
    items: edgeIds.length ? [...items, { label: `${edgeIds.length} 条连线`, edges: true }] : items,
  };
}
