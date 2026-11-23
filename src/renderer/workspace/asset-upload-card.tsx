import { Tooltip } from "@base-ui/react/tooltip";
import { CircleAlert, Loader2, RotateCcw, X } from "lucide-react";
import { motion } from "motion/react";
import type { RefObject } from "react";
import type { PickerUploadTask } from "./picker-uploads";

export function AssetUploadCard({
  task,
  cancel,
  retry,
  container,
}: {
  task: PickerUploadTask;
  cancel: () => void;
  retry: () => void;
  container: RefObject<HTMLElement | null>;
}) {
  const failed = task.status === "failed";
  const label = failed ? "移除" : "取消上传";
  return (
    <div
      className="asset-upload-card"
      data-status={task.status}
      role="group"
      aria-label={task.file.name}
    >
      <Tooltip.Root>
        <Tooltip.Trigger
          delay={0}
          className="asset-upload-remove"
          aria-label={label}
          onClick={cancel}
        >
          <X size={14} />
        </Tooltip.Trigger>
        <Tooltip.Portal container={container}>
          <Tooltip.Positioner className="asset-upload-tip-position" side="top" sideOffset={4}>
            <Tooltip.Popup className="asset-upload-tip">
              {label}
              <Tooltip.Arrow className="asset-upload-tip-arrow" />
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
      {failed ? (
        <CircleAlert size={24} className="asset-upload-error" />
      ) : (
        <Loader2 size={24} className="asset-pick-spinner" />
      )}
      <span className="asset-upload-name">{task.file.name}</span>
      {failed ? (
        <>
          <span className="asset-upload-error" role="alert">
            {task.error}
          </span>
          <button type="button" className="asset-upload-retry" onClick={retry}>
            <RotateCcw size={14} />
            重试
          </button>
        </>
      ) : (
        <>
          <span
            role="progressbar"
            aria-label={task.file.name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={task.percent}
          >
            <motion.span
              initial={false}
              animate={{ scaleX: task.percent / 100 }}
              transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
            />
          </span>
          <span className="asset-upload-status">
            {task.status === "queued"
              ? "等待上传"
              : task.status === "registering"
                ? "处理中…"
                : `${task.percent}%`}
          </span>
        </>
      )}
    </div>
  );
}
