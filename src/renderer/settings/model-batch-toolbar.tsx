import { Tooltip } from "@base-ui/react/tooltip";
import { ArrowDownToLine, ArrowUpFromLine, Blocks, PencilLine, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import type { BatchAction } from "./model-batch";

const actions = [
  ["批量上线", ArrowUpFromLine],
  ["批量下线", ArrowDownToLine],
  ["批量修改", PencilLine],
  ["批量设置能力与协议", Blocks],
  ["批量删除", Trash2],
] as const;

function Tool({
  label,
  help = label,
  disabled,
  click,
  children,
}: {
  label: string;
  help?: string;
  disabled?: boolean;
  click: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<button type="button" disabled={disabled} />}
        aria-label={label}
        disabled={disabled}
        onClick={click}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={4} className="batch-tool-tip-position">
          <Tooltip.Popup className="batch-tool-tip">
            {help}
            <Tooltip.Arrow className="batch-tool-tip-arrow" />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function ModelBatchToolbar({
  count,
  disabled,
  clear,
  select,
}: {
  count: number;
  disabled: boolean;
  clear: () => void;
  select: (action: BatchAction) => void;
}) {
  const [announcement, setAnnouncement] = useState("");
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!count) {
      setAnnouncement("");
      return;
    }
    setAnnouncement(`已选 ${count} 个模型，批量操作条可用`);
    const timer = setTimeout(() => setAnnouncement(""), 3000);
    return () => clearTimeout(timer);
  }, [count]);
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (!buttons.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      clear();
      return;
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowRight"
            ? (index + 1) % buttons.length
            : event.key === "ArrowLeft"
              ? index <= 0
                ? buttons.length - 1
                : index - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  }
  return (
    <Tooltip.Provider delay={0}>
      <span className="batch-announcement" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <AnimatePresence>
        {count > 0 && (
          <motion.div
            className="model-batch-toolbar"
            role="toolbar"
            tabIndex={-1}
            aria-label={`已选 ${count} 个模型的批量操作`}
            onKeyDownCapture={move}
            initial={{ opacity: 0, y: reduced ? 0 : 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduced ? 0 : 16, transition: { duration: 0.126 } }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          >
            <Tool label="清除选择" help="清除选择（Esc）" click={clear}>
              <X size={16} />
            </Tool>
            <i aria-hidden="true" />
            <span className="batch-count">
              <b role="status" aria-label={`已选 ${count} 个`}>
                {count}
              </b>
              <span>个模型</span> 已选
            </span>
            <i aria-hidden="true" />
            {actions.map(([label, Icon]) => (
              <Tool key={label} label={label} disabled={disabled} click={() => select(label)}>
                <Icon size={16} />
              </Tool>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </Tooltip.Provider>
  );
}
