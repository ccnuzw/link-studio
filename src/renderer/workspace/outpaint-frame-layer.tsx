import { type ReactFlowState, useStore, ViewportPortal } from "@xyflow/react";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef } from "react";
import { toast } from "sonner";

import {
  type FrameHandle,
  frameHeight,
  frameWidth,
  moveFrame,
  type OriginSize,
  type OutpaintFrame,
  resizeFrame,
} from "./outpaint-geometry";

const KEY_STEP = 8;
const KEY_STEP_BIG = 32;

const LIMIT_TOAST_ID = "outpaint-limit";

const checkerStyle = (zoom: number): CSSProperties => {
  const a = "color-mix(in oklch, var(--canvas-ink) 5%, var(--canvas-paper))";
  const b = "color-mix(in oklch, var(--canvas-ink) 10%, var(--canvas-paper))";
  return {
    backgroundColor: a,
    backgroundImage: `conic-gradient(${b} 25%, transparent 0 50%, ${b} 0 75%, transparent 0)`,
    backgroundSize: `${24 / zoom}px ${24 / zoom}px`,
  };
};

const ARROW_DELTA: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const HANDLES: Array<{
  handle: FrameHandle;
  at: [number, number];
  cursor: string;
  label: string;
}> = [
  { handle: "t", at: [0.5, 0], cursor: "ns-resize", label: "上边" },
  { handle: "b", at: [0.5, 1], cursor: "ns-resize", label: "下边" },
  { handle: "l", at: [0, 0.5], cursor: "ew-resize", label: "左边" },
  { handle: "r", at: [1, 0.5], cursor: "ew-resize", label: "右边" },
  { handle: "tl", at: [0, 0], cursor: "nwse-resize", label: "左上角（等比）" },
  { handle: "tr", at: [1, 0], cursor: "nesw-resize", label: "右上角（等比）" },
  { handle: "bl", at: [0, 1], cursor: "nesw-resize", label: "左下角（等比）" },
  { handle: "br", at: [1, 1], cursor: "nwse-resize", label: "右下角（等比）" },
];

export function OutpaintFrameLayer({
  nodeId,
  origin,
  frame,
  onChange,
  sizeLabel,
  disabled,
}: {
  nodeId: string;
  origin: OriginSize;
  frame: OutpaintFrame;
  onChange: (frame: OutpaintFrame) => void;
  sizeLabel?: string;
  disabled?: boolean;
}) {
  const position = useStore((state) => state.nodeLookup.get(nodeId)?.internals.positionAbsolute);
  const zoom = useStore((state: ReactFlowState) => state.transform[2]);
  const drag = useRef<{
    handle: FrameHandle | "move";
    startX: number;
    startY: number;
    start: OutpaintFrame;
  } | null>(null);

  if (!position) return null;
  const { x: px, y: py } = position;
  const fw = frameWidth(frame);
  const fh = frameHeight(frame);

  const apply = (handle: FrameHandle | "move", start: OutpaintFrame, dx: number, dy: number) => {
    if (handle === "move") {
      onChange(moveFrame(origin, start, dx, dy));
      return;
    }
    const result = resizeFrame(handle, origin, start, dx, dy);
    onChange(result.frame);
    if (result.limited) toast("已到 3 倍上限", { id: LIMIT_TOAST_ID, duration: 1400 });
  };

  const begin = (handle: FrameHandle | "move") => (event: PointerEvent<HTMLElement>) => {
    if (disabled) return;

    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { handle, startX: event.clientX, startY: event.clientY, start: frame };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    apply(
      current.handle,
      current.start,
      (event.clientX - current.startX) / zoom,
      (event.clientY - current.startY) / zoom,
    );
  };
  const end = () => {
    drag.current = null;
  };
  const key = (handle: FrameHandle | "move") => (event: KeyboardEvent<HTMLElement>) => {
    const delta = ARROW_DELTA[event.key];
    if (!delta || disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    apply(handle, frame, delta[0] * step, delta[1] * step);
  };
  const pointerHandlers = (handle: FrameHandle | "move") => ({
    onPointerDown: begin(handle),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onKeyDown: key(handle),
  });

  const checker = checkerStyle(zoom);
  const counter: CSSProperties = { scale: 1 / zoom };
  const slack = fw - origin.w > 0.5 || fh - origin.h > 0.5;

  return (
    <ViewportPortal>
      <div
        className="outpaint-layer nodrag nopan nowheel"
        style={{
          transform: `translate(${px + frame.x0}px, ${py + frame.y0}px)`,
          width: fw,
          height: fh,
        }}
      >
        <div
          aria-hidden="true"
          style={{ ...checker, left: 0, top: 0, width: fw, height: -frame.y0 }}
        />
        <div
          aria-hidden="true"
          style={{
            ...checker,
            left: 0,
            top: origin.h - frame.y0,
            width: fw,
            height: frame.y1 - origin.h,
          }}
        />
        <div
          aria-hidden="true"
          style={{ ...checker, left: 0, top: -frame.y0, width: -frame.x0, height: origin.h }}
        />
        <div
          aria-hidden="true"
          style={{
            ...checker,
            left: origin.w - frame.x0,
            top: -frame.y0,
            width: frame.x1 - origin.w,
            height: origin.h,
          }}
        />

        <div
          role="application"
          tabIndex={disabled ? -1 : 0}
          aria-label="移动框（方向键微调，框始终包住原图）"
          style={{ cursor: slack && !disabled ? "grab" : "default" }}
          {...pointerHandlers("move")}
        />

        {sizeLabel && (
          <span
            className="outpaint-size-label"
            style={{
              ...counter,
              bottom: "100%",
              marginBottom: 8 / zoom,
              transformOrigin: "left bottom",
            }}
          >
            {sizeLabel} <span>输出</span>
          </span>
        )}

        {HANDLES.map(({ handle, at, cursor, label }) => (
          <div
            key={handle}
            data-handle={handle}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={label}
            aria-valuenow={Math.round(handle === "t" || handle === "b" ? fh : fw)}
            aria-valuetext={`${Math.round(fw)} × ${Math.round(fh)}`}
            aria-disabled={disabled}
            style={{
              left: at[0] * fw,
              top: at[1] * fh,
              translate: "-50% -50%",
              cursor: disabled ? "default" : cursor,
              ...counter,
            }}
            {...pointerHandlers(handle)}
          >
            <span />
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}
