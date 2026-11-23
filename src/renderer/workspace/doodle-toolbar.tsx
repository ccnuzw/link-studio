import { Popover } from "@base-ui/react/popover";
import { Slider } from "@base-ui/react/slider";
import { Pencil, Redo2, Square, Type, Undo2, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { fixedMenuSide } from "./canvas-account-pill";
import { DOODLE_COLORS, DOODLE_WIDTH_MAX, DOODLE_WIDTH_MIN } from "./doodle";
import type { DoodleTool } from "./doodle-engine";
import "./doodle-toolbar.css";

type Props = {
  tool: DoodleTool;
  color: string;
  width: number;
  canUndo: boolean;
  canRedo: boolean;
  saveDisabled: boolean;
  busy?: boolean;
  onToolChange: (tool: DoodleTool) => void;
  onColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onClose: () => void;
  onInteract: () => void;
};
const tools = [
  ["pen", "画笔", Pencil],
  ["rect", "框选", Square],
  ["text", "文字", Type],
] as const;
const tap = { scale: 0.96 };
function Divider() {
  return <hr data-ui-divider aria-orientation="vertical" />;
}

export function DoodleToolbar(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div
      role="toolbar"
      aria-label="图片标注工具栏"
      className="canvas-control-pill doodle-pill nodrag nopan"
      onPointerDownCapture={props.onInteract}
    >
      <motion.button
        type="button"
        aria-label="关闭标注"
        title="关闭标注（不保存）"
        className="doodle-labeled"
        disabled={props.busy}
        whileTap={tap}
        onClick={props.onClose}
      >
        <X />
        <span>标注</span>
      </motion.button>
      <Divider />
      {tools.map(([id, label, Icon]) => (
        <motion.button
          key={id}
          type="button"
          className="doodle-labeled"
          aria-label={label}
          title={label}
          aria-pressed={props.tool === id}
          disabled={props.busy}
          whileTap={tap}
          onClick={() => props.onToolChange(id)}
        >
          <Icon />
          <span>{label}</span>
        </motion.button>
      ))}
      <Divider />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label="颜色"
          title="颜色"
          disabled={props.busy}
          className="doodle-color"
          render={<motion.button type="button" whileTap={tap} />}
        >
          <span style={{ backgroundColor: props.color }} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="doodle-palette-position"
            side="bottom"
            align="center"
            sideOffset={8}
            collisionAvoidance={fixedMenuSide}
          >
            <Popover.Popup className="doodle-palette" aria-label="标注颜色">
              {DOODLE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`颜色 ${color}`}
                  aria-pressed={color === props.color}
                  style={{ backgroundColor: color }}
                  onClick={() => {
                    props.onColorChange(color);
                    setOpen(false);
                  }}
                />
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <div className="doodle-width" title="粗细">
        <Slider.Root
          aria-label="粗细"
          min={DOODLE_WIDTH_MIN}
          max={DOODLE_WIDTH_MAX}
          value={[props.width]}
          step={1}
          disabled={props.busy}
          thumbAlignment="edge"
          onValueChange={([value]) => {
            if (value !== undefined) props.onWidthChange(value);
          }}
        >
          <Slider.Control className="doodle-control">
            <Slider.Track className="doodle-track">
              <Slider.Indicator className="doodle-indicator" />
            </Slider.Track>
            <Slider.Thumb className="doodle-thumb" aria-label="粗细" />
          </Slider.Control>
        </Slider.Root>
      </div>
      <Divider />
      <span title={props.canUndo ? "撤销" : "没有可撤销的操作"}>
        <motion.button
          type="button"
          aria-label="撤销"
          disabled={!props.canUndo || props.busy}
          whileTap={props.canUndo ? tap : undefined}
          onClick={props.onUndo}
        >
          <Undo2 />
        </motion.button>
      </span>
      <span title={props.canRedo ? "重做" : "没有可重做的操作"}>
        <motion.button
          type="button"
          aria-label="重做"
          disabled={!props.canRedo || props.busy}
          whileTap={props.canRedo ? tap : undefined}
          onClick={props.onRedo}
        >
          <Redo2 />
        </motion.button>
      </span>
      <Divider />
      <motion.button
        type="button"
        className="doodle-save"
        title="保存为新的图片节点"
        aria-label="保存"
        disabled={props.saveDisabled || props.busy}
        whileTap={props.saveDisabled ? undefined : tap}
        onClick={props.onSave}
      >
        保存
      </motion.button>
    </div>
  );
}
