import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { canvasModifier as modifier } from "./canvas-keys";
import "./canvas-shortcuts-dialog.css";

const shortcuts = [
  ["发送生成", `${modifier}↵`],
  ["聚焦选中节点的提示词", "↵"],
  ["撤销 / 重做", `${modifier}Z / ⇧${modifier}Z`],
  ["立即保存", `${modifier}S`],
  ["复制 / 粘贴 / 原地复制", `${modifier}C / ${modifier}V / ${modifier}D`],
  ["打组 / 解组", `${modifier}G / ⇧${modifier}G`],
  ["给选中的组改名", "↵ / F2 / 双击组名"],
  ["删除选中", "⌫"],
  ["选择 / 抓手 / 临时抓手", "V / H / 空格"],
  ["放大 / 缩小", `${modifier}+ / ${modifier}−`],
  ["适应画布 / 100%", "⇧1 / ⇧0"],
  ["取消选中", "Esc"],
  ["打开快捷键", "?"],
] as const;

export function CanvasShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal className="storyboard-layer">
        <Dialog.Backdrop className="storyboard-backdrop" />
        <Dialog.Popup className="canvas-shortcuts-dialog nokey">
          <Dialog.Title>快捷键</Dialog.Title>
          <dl>
            {shortcuts.map(([label, keys]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <kbd>{keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
          <Dialog.Close aria-label="Close" className="storyboard-close">
            <X size={16} />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
