import type { DramaDocument } from "@link-studio/core";
import {
  CircleAlert,
  CircleCheck,
  Clock3,
  FileText,
  ListTodo,
  LoaderCircle,
  RotateCw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import "./drama-studio-status.css";

type Job = NonNullable<DramaDocument["jobs"]>[number];

const stepLabels: Record<Job["step"], string> = {
  breakdown: "资产拆解",
  asset_prompts: "资产提示词",
  scripts: "分集剧本",
  storyboard: "分镜脚本",
  compose: "合成整集",
};

const statusLabels: Record<Job["status"], string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};

function statusIcon(status: Job["status"]) {
  if (status === "running") return <LoaderCircle className="drama-status-spin" size={16} />;
  if (status === "queued") return <Clock3 size={16} />;
  if (status === "succeeded") return <CircleCheck size={16} />;
  if (status === "failed") return <CircleAlert size={16} />;
  return <XCircle size={16} />;
}

export function DramaWorkspaceState({
  kind,
  title,
  description,
  action,
}: {
  kind: "loading" | "error";
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <section className="drama-workspace-state" data-kind={kind} aria-live="polite">
      <span className="drama-workspace-state-icon">
        {kind === "loading" ? (
          <LoaderCircle className="drama-status-spin" size={22} />
        ) : (
          <TriangleAlert size={22} />
        )}
      </span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action && (
        <button type="button" onClick={action.onClick}>
          <RotateCw size={14} />
          {action.label}
        </button>
      )}
    </section>
  );
}

export function DramaEmptyState({
  icon = <FileText size={24} />,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  compact?: boolean;
}) {
  return (
    <section className="drama-empty-state" data-compact={compact || undefined}>
      <span className="drama-empty-state-icon">{icon}</span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action && (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </section>
  );
}

export function DramaNotice({
  tone = "info",
  compact = false,
  children,
}: {
  tone?: "info" | "success" | "warning" | "error";
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="drama-notice"
      data-compact={compact || undefined}
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
    >
      {tone === "error" ? <CircleAlert size={15} /> : <ListTodo size={15} />}
      <span>{children}</span>
    </div>
  );
}

export function DramaTaskStatusStack({ jobs }: { jobs: readonly Job[] }) {
  return (
    <section className="drama-task-status-stack" aria-label="短剧任务" aria-live="polite">
      <header>
        <span className="drama-task-status-title">
          <ListTodo size={15} />
          任务进度
        </span>
        <small>{jobs.length} 项任务</small>
      </header>
      <div>
        {jobs.map((job) => (
          <article className="drama-task-status" data-status={job.status} key={job.id}>
            <span className="drama-task-status-icon">{statusIcon(job.status)}</span>
            <div className="drama-task-status-copy">
              <strong>{stepLabels[job.step]}</strong>
              <span>
                {statusLabels[job.status]}
                {job.error_message ? ` · ${job.error_message}` : ""}
              </span>
            </div>
            {job.status === "running" && typeof job.progress === "number" && <b>{job.progress}%</b>}
          </article>
        ))}
      </div>
    </section>
  );
}
