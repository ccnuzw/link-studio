import type { CanvasOperation, ProjectCanvasView } from "@link-studio/core";
import { mapFragmentMedia } from "./selection-actions";

export function canvasSeed(canvas: ProjectCanvasView, sourceHandle?: string, library = false) {
  const nodes = canvas.nodes.filter((node) => node.type !== "unknown");
  if (nodes.length !== canvas.nodes.length || canvas.edges.some((edge) => edge.readOnly))
    throw new Error("画布含有当前版本不能完整另存的节点或连线；本地改动未丢弃。");
  const references = new Set<string>();
  mapFragmentMedia({ nodes, edges: canvas.edges }, (id) => {
    references.add(id);
    return id;
  });
  const operations: CanvasOperation[] = [
    ...nodes.map((node) => ({ type: "putNode" as const, node })),
    ...canvas.edges.map((edge) => ({ type: "putEdge" as const, edge })),
    { type: "setViewport", viewport: canvas.viewport },
  ];
  return {
    operations: JSON.parse(JSON.stringify(operations)) as CanvasOperation[],
    ...((sourceHandle || library) &&
      references.size && {
        media: { ...(sourceHandle && { projectHandle: sourceHandle }), assetIds: [...references] },
      }),
  };
}
