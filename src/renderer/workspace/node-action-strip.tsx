import { Tooltip } from "@base-ui/react/tooltip";
import { NodeToolbar, Position, useStore } from "@xyflow/react";
import {
  AudioLines,
  Copy,
  Download,
  Expand,
  FolderPlus,
  type LucideIcon,
  Maximize2,
  PenLine,
  Scissors,
  Sparkle,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { type FrameChoice, FrameMenu } from "./frame-menu";
import { GridSplitMenu } from "./grid-split-menu";
import "./node-action-strip.css";

export type StripKind = "script" | "storyboard" | "image" | "video" | "audio";
export function NodeActionAnchor({
  id,
  moving,
  children,
}: {
  id: string;
  moving: boolean;
  children: ReactNode;
}) {
  const zoom = useStore((state) => state.transform[2]);
  return (
    <NodeToolbar
      isVisible
      nodeId={id}
      position={Position.Top}
      align="center"
      offset={28 * zoom + 16}
    >
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: moving ? 0.35 : 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        style={{ pointerEvents: moving ? "none" : "auto" }}
      >
        {children}
      </motion.div>
    </NodeToolbar>
  );
}
export type StripAction =
  | "copy"
  | "zoom"
  | "download"
  | "library"
  | "edit"
  | "outpaint"
  | "trim"
  | "split"
  | "storyboard";
type Props = {
  kind: StripKind;
  label: string;
  ready: boolean;
  running: boolean;
  history: boolean;
  room: number;
  action: (id: StripAction) => void;
  frame: (choice: FrameChoice) => void;
  grid: (rows: number, columns: number) => void;
};
export function NodeActionStrip({
  kind,
  label,
  ready,
  running,
  history,
  room,
  action,
  frame,
  grid,
}: Props) {
  if (kind !== "storyboard" && !ready && !history) return null;
  const disabled = kind !== "storyboard" && (!ready || running);
  const tool = (id: StripAction, name: string, Icon: LucideIcon, paid = false, noRoom = false) => (
    <motion.button
      type="button"
      className="strip-text"
      title={name}
      aria-label={name}
      disabled={disabled || noRoom}
      whileTap={{ scale: 0.96 }}
      onClick={() => action(id)}
    >
      <Icon />
      <span>{name}</span>
      {paid && <Sparkle role="img" aria-label="消耗积分" className="strip-credit" />}
    </motion.button>
  );
  const tail = (id: StripAction, name: string, Icon: LucideIcon) => (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <motion.button
            type="button"
            aria-label={name}
            disabled={disabled}
            whileTap={disabled ? undefined : { scale: 0.96 }}
            onClick={() => action(id)}
          />
        }
      >
        <Icon />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={8} className="strip-tip-pos">
          <Tooltip.Popup className="strip-tip">
            {name}
            <Tooltip.Arrow />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
  return (
    <Tooltip.Provider delay={0}>
      <div
        className="node-action-strip nodrag nopan"
        role="toolbar"
        aria-label={`${label} 的功能区`}
      >
        {kind === "image" && (
          <>
            {tool("edit", "图片编辑", PenLine, false, room < 1)}
            {tool("outpaint", "扩图", Expand, true, room < 1)}
            <GridSplitMenu disabled={disabled || room < 2} choose={grid} />
          </>
        )}
        {kind === "video" && (
          <>
            <FrameMenu disabled={disabled || room < 1} choose={frame} />
            {tool("trim", "视频修剪", Scissors, false, room < 1)}
          </>
        )}
        {kind === "audio" && (
          <>
            {tool("trim", "音频修剪", Scissors)}
            {tool("split", "人声分离", AudioLines, true)}
          </>
        )}
        {kind === "storyboard" && tool("storyboard", "编辑分镜", Maximize2)}
        {kind !== "script" && kind !== "storyboard" && (
          <span className="strip-separator" role="separator" aria-orientation="vertical" />
        )}
        {kind === "script" && tail("copy", "复制文本", Copy)}
        {(kind === "script" || kind === "image" || kind === "video") &&
          tail("zoom", "放大预览", Maximize2)}
        {kind !== "script" && kind !== "storyboard" && (
          <>
            {tail("download", "下载", Download)}
            {ready && !running && tail("library", "加入资产库", FolderPlus)}
          </>
        )}
      </div>
    </Tooltip.Provider>
  );
}
