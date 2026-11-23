import { Tooltip } from "@base-ui/react/tooltip";
import { NodeToolbar, Position, useStore, ViewportPortal } from "@xyflow/react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { type OpenFan, SelectionFan } from "./selection-fan";

export function SelectionOverlay({
  ids,
  visible,
  openFan,
  children,
}: {
  ids: string[];
  visible: boolean;
  openFan: OpenFan;
  children: ReactNode;
}) {
  const zoom = useStore((state) => state.transform[2]);
  const bounds = useStore((state) => {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const node of state.nodeLookup.values()) {
      if (!node.selected) continue;
      const { x, y } = node.internals.positionAbsolute;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + (node.measured.width ?? 0));
      bottom = Math.max(bottom, y + (node.measured.height ?? 0));
    }
    return Number.isFinite(left) ? [left, top, right, bottom].map(Math.round).join(",") : "";
  });
  const [left = 0, top = 0, right = 0, bottom = 0] = bounds.split(",").map(Number);
  return (
    <>
      {bounds && (
        <ViewportPortal>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            aria-hidden="true"
            className="canvas-selection-frame"
            style={{
              transform: `translate(${left - 24}px, ${top - 44}px)`,
              width: right - left + 48,
              height: bottom - top + 68,
            }}
          />
          {visible && (
            <SelectionFan
              ids={ids}
              anchor={{ x: right + 24, y: (top + bottom - 20) / 2 }}
              open={openFan}
            />
          )}
        </ViewportPortal>
      )}
      <NodeToolbar nodeId={ids} position={Position.Top} offset={44 * zoom + 14} isVisible={visible}>
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          <Tooltip.Provider delay={0}>{children}</Tooltip.Provider>
        </motion.div>
      </NodeToolbar>
    </>
  );
}
