import { evenGridLines, GRID_MIN_GAP } from "@link-studio/core";
import { NodeToolbar, Position, useStore } from "@xyflow/react";
import { RotateCcw } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./grid-split-overlay.css";

export type GridSplitDraft = { xLines: number[]; yLines: number[] };
export function GridSplitOverlay({
  nodeId,
  rows,
  columns,
  busy,
  error,
  unavailable,
  close,
  submit,
  cancel,
  cancelling,
}: {
  nodeId: string;
  rows: number;
  columns: number;
  busy: boolean;
  error: string;
  unavailable: string;
  close: () => void;
  submit: (draft: GridSplitDraft) => void;
  cancel?: () => void;
  cancelling: boolean;
}) {
  const zoom = useStore((state) => state.transform[2]);
  const [xs, setXs] = useState(() => evenGridLines(columns));
  const [ys, setYs] = useState(() => evenGridLines(rows));
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ origin: number; start: number; length: number } | undefined>(undefined);
  const host = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"] .node-media`,
  );
  useEffect(() => {
    const escapeKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy) close();
    };
    document.addEventListener("keydown", escapeKey, true);
    return () => document.removeEventListener("keydown", escapeKey, true);
  }, [close, busy]);
  if (!host) return null;
  const lines = (axis: "x" | "y", values: number[]) =>
    [1, 2, 3, 4].slice(0, values.length).map((number) => {
      const index = number - 1;
      const value = values[index] ?? number / (values.length + 1);
      const vertical = axis === "x";
      const move = (proposed: number) => {
        if (busy) return;
        const updated = [...values];
        updated[index] = Math.min(
          (values[index + 1] ?? 1) - GRID_MIN_GAP,
          Math.max((values[index - 1] ?? 0) + GRID_MIN_GAP, proposed),
        );
        (vertical ? setXs : setYs)(updated);
      };
      return (
        <div
          key={`${axis}-${number}`}
          role="slider"
          tabIndex={0}
          aria-label={`第 ${index + 1} 条${vertical ? "竖" : "横"}线`}
          aria-orientation={vertical ? "horizontal" : "vertical"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(value * 100)}
          aria-valuetext={`${(value * 100).toFixed(1)}%`}
          data-axis={axis}
          style={vertical ? { left: `${value * 100}%` } : { top: `${value * 100}%` }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (busy || event.button !== 0) return;
            const bounds = stage.current?.getBoundingClientRect();
            if (!bounds) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              origin: vertical ? event.clientX : event.clientY,
              start: value,
              length: vertical ? bounds.width : bounds.height,
            };
          }}
          onPointerMove={(event) => {
            if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId))
              move(
                drag.current.start +
                  ((vertical ? event.clientX : event.clientY) - drag.current.origin) /
                    drag.current.length,
              );
          }}
          onLostPointerCapture={() => {
            drag.current = undefined;
          }}
          onKeyDown={(event) => {
            const dir =
              event.key === (vertical ? "ArrowLeft" : "ArrowUp")
                ? -1
                : event.key === (vertical ? "ArrowRight" : "ArrowDown")
                  ? 1
                  : 0;
            if (dir) {
              event.preventDefault();
              event.stopPropagation();
              move(value + dir * (event.shiftKey ? 0.05 : 0.01));
            }
          }}
        >
          <span />
        </div>
      );
    });
  const even = (values: number[]) =>
    values.every((value, index) => Math.abs(value - (index + 1) / (values.length + 1)) < 1e-9);
  return (
    <>
      {createPortal(
        <div
          ref={stage}
          className="split-stage nodrag nopan nowheel"
          style={{ "--split-inverse": 1 / zoom } as CSSProperties}
        >
          {lines("x", xs)}
          {lines("y", ys)}
          <button
            type="button"
            className="split-reset"
            disabled={busy || (even(xs) && even(ys))}
            onClick={() => {
              setXs(evenGridLines(columns));
              setYs(evenGridLines(rows));
            }}
          >
            <RotateCcw size={14} />
            重置均分
          </button>
          <span className="split-badge">
            {rows}×{columns} · {rows * columns} 格
          </span>
        </div>,
        host,
      )}
      <NodeToolbar isVisible nodeId={nodeId} position={Position.Bottom} offset={12}>
        <div className="split-bar nodrag nopan">
          <button type="button" disabled={cancel ? cancelling : busy} onClick={cancel ?? close}>
            {cancelling ? "取消中…" : "取消"}
          </button>
          <button
            type="button"
            disabled={busy || !!unavailable}
            onClick={() => submit({ xLines: xs, yLines: ys })}
          >
            确认切分 · {rows * columns} 格
          </button>
          {(error || unavailable) && <p role="alert">{error || unavailable}</p>}
        </div>
      </NodeToolbar>
    </>
  );
}
