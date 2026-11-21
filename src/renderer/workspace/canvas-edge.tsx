import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { Scissors } from "lucide-react";

export type CanvasEdgeData = { readOnly?: true };
export type CanvasFlowEdge = Edge<CanvasEdgeData>;

export function CanvasEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  selected,
  data,
}: EdgeProps<CanvasFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={24}
        style={{
          strokeWidth: selected ? 2.5 : 1.5,
          stroke: selected ? "var(--canvas-primary)" : undefined,
        }}
      />
      {selected && !data?.readOnly && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="canvas-edge-cut nodrag nopan"
            aria-label="断开连接"
            title="断开连接 · Delete"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(event) => {
              event.stopPropagation();
              window.dispatchEvent(new CustomEvent("link-studio:disconnect-edge", { detail: id }));
            }}
          >
            <Scissors size={13} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
