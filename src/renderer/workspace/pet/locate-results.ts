import type { Node, ReactFlowInstance } from "@xyflow/react";

export function locatePetResults<CanvasNode extends Node>(
  flow: Pick<ReactFlowInstance<CanvasNode>, "getNode" | "fitView"> | null,
  ids: readonly string[],
) {
  if (!flow) return;
  const nodes = ids.filter((id) => flow.getNode(id)).map((id) => ({ id }));
  if (nodes.length) return flow.fitView({ nodes, duration: 400, padding: 0.3, maxZoom: 1 });
}
