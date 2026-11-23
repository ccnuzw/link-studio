import { getBezierPath, Position, useReactFlow, useStore } from "@xyflow/react";
import { Plus } from "lucide-react";
import { motion } from "motion/react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

type Point = { x: number; y: number };
export type Fan = { ids: string[]; exits: (Point & { id: string })[]; to: Point };
export type OpenFan = (fan: Fan, trigger: HTMLButtonElement) => void;

export function FanLines({
  exits,
  to,
  reverse = false,
}: Pick<Fan, "exits" | "to"> & { reverse?: boolean }) {
  return createPortal(
    <svg className="canvas-fan-lines" aria-hidden="true">
      {exits.map((exit) => {
        const [path] = getBezierPath({
          sourcePosition: reverse ? Position.Left : Position.Right,
          targetPosition: reverse ? Position.Right : Position.Left,
          sourceX: exit.x,
          sourceY: exit.y,
          targetX: to.x,
          targetY: to.y,
        });
        return <path key={exit.id} d={path} fill="none" stroke="currentColor" strokeWidth={1} />;
      })}
    </svg>,
    document.body,
  );
}

export function SelectionFan({
  ids,
  anchor,
  open,
}: {
  ids: string[];
  anchor: Point;
  open: OpenFan;
}) {
  const zoom = useStore((state) => state.transform[2]);
  const { getInternalNode, flowToScreenPosition } = useReactFlow();
  const [drag, setDrag] = useState<Fan>();
  const session = useRef<{ origin: Point; exits: Fan["exits"]; moved: boolean }>(undefined);
  const exits = () =>
    ids.flatMap((id) => {
      const node = getInternalNode(id);
      if (!node?.measured.width || !node.measured.height) return [];
      const origin = node.internals.positionAbsolute;
      return [
        {
          id,
          ...flowToScreenPosition({
            x: origin.x + node.measured.width,
            y: origin.y + node.measured.height / 2,
          }),
        },
      ];
    });
  const nearButton = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.right + 8, y: rect.top + rect.height / 2 };
  };
  const cancel = () => {
    session.current = undefined;
    setDrag(undefined);
  };
  const delta =
    drag && session.current
      ? { x: drag.to.x - session.current.origin.x, y: drag.to.y - session.current.origin.y }
      : { x: 0, y: 0 };
  return (
    <>
      <div
        className="canvas-fan-anchor"
        style={{ transform: `translate(${anchor.x}px,${anchor.y}px) scale(${1 / zoom})` }}
      >
        <motion.button
          className="canvas-fan-handle nodrag nopan"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{
            duration: 0.18,
            ease: [0.2, 0, 0, 1],
            x: { duration: 0 },
            y: { duration: 0 },
          }}
          style={{ x: delta.x, y: delta.y }}
          type="button"
          aria-label="引用选中的节点生成"
          title="拖出去或点击，引用选中的节点生成"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            session.current = {
              origin: { x: event.clientX, y: event.clientY },
              exits: exits(),
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const active = session.current;
            if (!active) return;
            active.moved ||=
              Math.hypot(event.clientX - active.origin.x, event.clientY - active.origin.y) > 6;
            if (active.moved)
              setDrag({ ids, exits: active.exits, to: { x: event.clientX, y: event.clientY } });
          }}
          onPointerUp={(event) => {
            const active = session.current;
            if (!active) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            open(
              {
                ids,
                exits: active.exits,
                to: active.moved
                  ? { x: event.clientX, y: event.clientY }
                  : nearButton(event.currentTarget),
              },
              event.currentTarget,
            );
            cancel();
          }}
          onPointerCancel={cancel}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0)
              open(
                { ids, exits: exits(), to: nearButton(event.currentTarget) },
                event.currentTarget,
              );
          }}
        >
          <Plus size={14} />
        </motion.button>
      </div>
      {drag && <FanLines {...drag} />}
    </>
  );
}
