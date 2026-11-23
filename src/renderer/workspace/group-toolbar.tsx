import { Tooltip } from "@base-ui/react/tooltip";
import type { GroupHue } from "@link-studio/core";
import { NodeToolbar, Position, useStore } from "@xyflow/react";
import { LayoutGrid, Trash2, Ungroup } from "lucide-react";
import { motion } from "motion/react";
import { canvasModifier } from "./canvas-keys";
import { GroupColors } from "./group-colors";
import { SelectionButton } from "./selection-button";

export function GroupToolbar({
  id,
  colors,
  memberCount,
  arrange,
  ungroup,
  remove,
  setColor,
}: {
  id: string;
  colors: { color?: GroupHue; labelColor?: GroupHue };
  memberCount: number;
  arrange: () => void;
  ungroup: () => void;
  remove: () => void;
  setColor: (field: "color" | "labelColor", hue?: GroupHue) => void;
}) {
  const zoom = useStore((state) => state.transform[2]);
  const offset = (28 * Math.min(4, Math.max(1, 1 / zoom)) + 8) * zoom + 14;
  const shortcut = `⇧${canvasModifier}G`;
  return (
    <NodeToolbar
      nodeId={id}
      position={Position.Top}
      offset={offset}
      style={{ zIndex: 2000 }}
      isVisible
    >
      <Tooltip.Provider delay={0}>
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          <div
            role="toolbar"
            aria-label="分组操作"
            className="canvas-group-toolbar canvas-selection-tools grouped-node-tools nodrag nopan"
          >
            <GroupColors colors={colors} setColor={setColor} />
            <hr className="group-tools-divider" data-ui-divider aria-orientation="vertical" />
            <motion.button
              type="button"
              aria-label="整理布局"
              disabled={memberCount < 2}
              whileTap={memberCount < 2 ? undefined : { scale: 0.96 }}
              onClick={arrange}
            >
              <LayoutGrid />
              <span>整理布局</span>
            </motion.button>
            <hr className="group-tools-divider" data-ui-divider aria-orientation="vertical" />
            <SelectionButton
              label="解散这个组，节点原地保留"
              shortcut={shortcut}
              aria-label="解组"
              onClick={ungroup}
            >
              <Ungroup />
              <span>解组</span>
              <kbd>{shortcut}</kbd>
            </SelectionButton>
            <hr className="group-tools-divider" data-ui-divider aria-orientation="vertical" />
            <SelectionButton
              label="删除组和组内节点"
              shortcut="⌫"
              aria-label="删除组"
              className="selection-delete"
              onClick={remove}
            >
              <Trash2 />
            </SelectionButton>
          </div>
        </motion.div>
      </Tooltip.Provider>
    </NodeToolbar>
  );
}
