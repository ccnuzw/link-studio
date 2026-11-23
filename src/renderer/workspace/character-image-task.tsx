import { type GenerationJob, jobFailureReason } from "@link-studio/core";
import { Loader2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copySettingsText } from "../settings/copy-settings-text";

export function imageTaskTitle(job?: GenerationJob) {
  switch (job?.status) {
    case "queued":
      return "排队中";
    case "submitting":
    case "running":
      return "生成中";
    case "downloading":
      return "即将完成";
    case "failed":
      return "生成失败";
    default:
      return undefined;
  }
}

export function imageProgress(job: GenerationJob) {
  return job.status === "running" && Number.isFinite(job.progress)
    ? Math.min(100, Math.max(0, Math.round(job.progress)))
    : undefined;
}

function Elapsed({ start }: { start: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return <>正在同步任务状态…</>;
  return (
    <>
      已耗时{" "}
      {seconds < 60
        ? `${seconds}秒`
        : `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`}
    </>
  );
}

export function MediaGenerationTask({
  job,
  action,
  disabled,
  retryHint,
}: {
  job: GenerationJob;
  action: () => Promise<void>;
  disabled: boolean;
  retryHint?: string;
}) {
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const perform = async () => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };
  if (job.status === "failed")
    return (
      <div className="character-image-task failed" role="alert">
        <TriangleAlert />
        <p>{jobFailureReason(job) || "生成失败"}</p>
        <button
          className="task-id nodrag nowheel"
          type="button"
          title="点击复制任务 ID"
          aria-label={`任务 ID ${job.id}，点击复制`}
          data-task-ref={`任务 ID：${job.id}`}
          onClick={async () => {
            try {
              await copySettingsText(job.id);
              setCopied(true);
              clearTimeout(copyTimer.current);
              copyTimer.current = setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          <span>{copied ? "已复制任务 ID" : <>任务 ID：{job.id}</>}</span>
        </button>
        <span className="task-retry" title={retryHint}>
          <button
            className="task-action nodrag"
            type="button"
            disabled={disabled || pending}
            onClick={perform}
          >
            <RotateCcw />
            重试
          </button>
        </span>
      </div>
    );
  const progress = imageProgress(job);
  const canCancel = job.status === "queued" || (job.status === "running" && job.canCancelRemote);
  return (
    <div className="character-image-task" role="status" aria-live="polite">
      <div className="character-task-line">
        <Loader2 className="shot-split-spinner" />
        {imageTaskTitle(job)}
        {progress !== undefined && <span>{progress}%</span>}
      </div>
      <p>
        {job.status === "queued" ? (
          "前面的任务处理完后会自动开始"
        ) : job.status === "downloading" ? (
          `正在保存${job.kind === "audio" ? "音频" : job.kind === "video" ? "视频" : "图片"}`
        ) : (
          <Elapsed start={job.submittedAt ?? job.createdAt} />
        )}
      </p>
      {progress !== undefined && (
        <div className="character-task-track">
          <i style={{ width: `${progress}%` }} />
        </div>
      )}
      {canCancel && (
        <button
          className="task-action task-cancel nodrag"
          type="button"
          onClick={perform}
          disabled={pending || job.cancelRequested}
        >
          {pending || job.cancelRequested ? <Loader2 className="shot-split-spinner" /> : <X />}取消
        </button>
      )}
    </div>
  );
}
