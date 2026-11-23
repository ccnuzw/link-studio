import { type CSSProperties, useRef, useState } from "react";

export const NUDGE_STEP = 16;

export function ResizeHandle({
  orientation,
  label,
  style,
  onStart,
  onMove,
  onEnd,
  onReset,
  onNudge,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  style: CSSProperties;
  onStart: () => number;
  onMove: (start: number, delta: number) => void;
  onEnd: () => void;
  onReset: () => void;
  onNudge: (direction: -1 | 1) => void;
}) {
  const vertical = orientation === "vertical";
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ origin: number; start: number } | null>(null);
  const position = (event: { clientX: number; clientY: number }) =>
    vertical ? event.clientX : event.clientY;

  return (
    <>
      <div
        role="separator"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-label={label}
        title={`${label}：拖动调节，双击还原`}
        tabIndex={0}
        style={style}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { origin: position(event), start: onStart() };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (drag.current) onMove(drag.current.start, position(event) - drag.current.origin);
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          drag.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          onEnd();
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
          onEnd();
        }}
        onDoubleClick={onReset}
        onKeyDown={(event) => {
          const back = vertical ? "ArrowLeft" : "ArrowUp";
          const forward = vertical ? "ArrowRight" : "ArrowDown";
          if (event.key !== back && event.key !== forward) return;
          event.preventDefault();
          event.stopPropagation();
          onNudge(event.key === back ? -1 : 1);
          onEnd();
        }}
        className={`director-divider ${orientation}`}
        data-dragging={dragging}
      >
        <span className="director-divider-line" />
      </div>

      {dragging && <div className={`director-divider-cover ${orientation}`} />}
    </>
  );
}
