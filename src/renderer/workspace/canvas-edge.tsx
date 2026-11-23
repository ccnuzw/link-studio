import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { Scissors } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useRef, useState } from "react";

export const RunningEdgeTargets = createContext<ReadonlySet<string>>(new Set());

function nearestRatio(path: SVGPathElement, point: { x: number; y: number }) {
  const length = path.getTotalLength();
  let best = 0;
  let distance = Infinity;
  const check = (ratio: number) => {
    const sample = path.getPointAtLength(ratio * length);
    const next = (point.x - sample.x) ** 2 + (point.y - sample.y) ** 2;
    if (next < distance) {
      best = ratio;
      distance = next;
    }
  };
  for (let index = 0; index <= 64; index++) check(index / 64);
  const low = Math.max(0, best - 1 / 64);
  const high = Math.min(1, best + 1 / 64);
  for (let index = 0; index <= 16; index++) check(low + ((high - low) * index) / 16);
  return best;
}

function CutButton({ id, path, ratio }: { id: string; path: string; ratio: number }) {
  const zoom = useStore((state) => state.transform[2]);
  return (
    <EdgeLabelRenderer>
      <div
        className="canvas-edge-cut-anchor nodrag nopan"
        style={{
          offsetPath: `path("${path}")`,
          offsetDistance: `${ratio * 100}%`,
          offsetRotate: "0deg",
          transform: `scale(${Math.max(0.8, Math.min(1.2, zoom ** 0.35)) / zoom})`,
        }}
      >
        <motion.button
          type="button"
          whileTap={{ scale: 0.96 }}
          className="canvas-edge-cut"
          aria-label="断开连接"
          title="断开连接 · Delete"
          onClick={(event) => {
            event.stopPropagation();
            window.dispatchEvent(new CustomEvent("link-studio:disconnect-edge", { detail: id }));
          }}
        >
          <Scissors size={18} strokeWidth={1.75} />
        </motion.button>
      </div>
    </EdgeLabelRenderer>
  );
}

export type CanvasEdgeData = { readOnly?: true };
export type CanvasFlowEdge = Edge<CanvasEdgeData>;

export function CanvasEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  selected,
  data,
}: EdgeProps<CanvasFlowEdge>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const highlighted =
    useStore(
      (state) =>
        !!(state.nodeLookup.get(source)?.selected || state.nodeLookup.get(target)?.selected),
    ) || selected;
  const onlySelected = useStore(
    (state) => selected && state.edges.filter((edge) => edge.selected).length === 1,
  );
  const running = useContext(RunningEdgeTargets).has(target);
  const reduced = useReducedMotion();
  const { screenToFlowPosition } = useReactFlow();
  const probe = useRef<SVGPathElement>(null);
  const [ratio, setRatio] = useState(0.5);
  const gradient = `edge-sweep-${id}`;
  const color = running ? "var(--edge-running)" : "var(--edge-beam)";
  return (
    <>
      <path ref={probe} d={path} fill="none" stroke="none" pointerEvents="none" />
      <g
        onPointerDown={(event) => {
          if (probe.current)
            setRatio(
              nearestRatio(
                probe.current,
                screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              ),
            );
        }}
      >
        <BaseEdge id={id} path={path} className={highlighted ? "edge-highlighted" : undefined} />
      </g>
      {(highlighted || running) && !reduced && (
        <>
          <defs>
            <linearGradient
              id={gradient}
              gradientUnits="userSpaceOnUse"
              x1={sourceX}
              y1={sourceY}
              x2={targetX}
              y2={targetY}
            >
              <stop offset="0.3" stopColor={color} stopOpacity={0} />
              <stop offset="0.5" stopColor={color} stopOpacity={selected ? 1 : 0.85} />
              <stop offset="0.7" stopColor={color} stopOpacity={0} />
              <animateTransform
                attributeName="gradientTransform"
                type="translate"
                from={`${sourceX - targetX} ${sourceY - targetY}`}
                to={`${targetX - sourceX} ${targetY - sourceY}`}
                dur={running ? "1.1s" : "2.6s"}
                repeatCount="indefinite"
              />
            </linearGradient>
          </defs>
          <path
            d={path}
            fill="none"
            stroke={`url(#${gradient})`}
            strokeWidth={2.5}
            strokeLinecap="round"
            pointerEvents="none"
          />
        </>
      )}
      {onlySelected && !data?.readOnly && <CutButton id={id} path={path} ratio={ratio} />}
    </>
  );
}
