import { Dialog } from "@base-ui/react/dialog";
import type { GenerationJob } from "@link-studio/core";
import {
  ChevronRight,
  FileText,
  History,
  Image,
  LoaderCircle,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type HistoryNode, historyJobRows, historyJobScope } from "./canvas-history-jobs";
import "./canvas-generation-tasks.css";
import "./canvas-task-history.css";

const statuses = {
  queued: "排队中",
  submitting: "等待中",
  running: "生成中",
  downloading: "即将完成",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  outcome_unknown: "结果未知",
};
const kinds = { image: "图片", video: "视频", audio: "音频", text: "文本" };
const kindIcons = { image: Image, video: Video, audio: Volume2, text: FileText };
function taskStatus(job: GenerationJob) {
  if (job.status === "failed" && (job.error === "JOB_QUEUE_TIMEOUT" || job.error === "JOB_TIMEOUT"))
    return "已超时";
  return statuses[job.status];
}
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
type HistoryProps = {
  nodes: readonly HistoryNode[];
  jobs: GenerationJob[];
  inventoryReady: boolean;
  projectHandle: string;
  pick: (id: string) => boolean;
};

function TaskList({ nodes, jobs, inventoryReady, projectHandle, pick }: HistoryProps) {
  const [scope] = useState(() => historyJobScope(nodes, jobs, inventoryReady));
  const [snapshot, setSnapshot] = useState<GenerationJob[] | null>(null);
  useEffect(() => {
    if (!scope.fetch) return;
    let mounted = true;
    void window.desktop.projects
      .listJobs({ projectHandle })
      .then((reply) => {
        if (mounted) setSnapshot(reply.ok ? reply.value.jobs.filter(scope.acceptsSnapshot) : []);
      })
      .catch(() => {
        if (mounted) setSnapshot([]);
      });
    return () => {
      mounted = false;
    };
  }, [projectHandle, scope]);
  const list = historyJobRows([...scope.initial, ...(snapshot ?? [])], jobs, scope.includes);
  if (!list.length)
    return snapshot === null && scope.fetch ? (
      <div className="canvas-task-wait" role="status">
        <LoaderCircle aria-hidden="true" size={16} />
        正在加载任务
      </div>
    ) : (
      <div className="canvas-task-empty" role="status">
        <History aria-hidden="true" size={28} />
        这张画布还没有生成过内容。
      </div>
    );
  const labels = new Map(nodes.map((node) => [node.id, node.data.label]));
  return (
    <ul aria-label="生成记录">
      {list.map((job) => {
        const Icon = kindIcons[job.kind];
        const label = labels.get(job.nodeId);
        const model = job.modelKey ?? job.model;
        return (
          <li key={job.id}>
            <button type="button" disabled={label === undefined} onClick={() => pick(job.nodeId)}>
              <span className="canvas-task-kind" aria-label={kinds[job.kind]} role="img">
                <Icon aria-hidden="true" size={16} />
              </span>
              <span className="canvas-task-record">
                <strong title={label}>{label ?? "已删除的节点"}</strong>
                <small title={model}>
                  {dateFormat.format(new Date(job.createdAt))} · {model}
                </small>
              </span>
              <span className="canvas-task-result">
                <strong className="canvas-task-status" data-status={job.status}>
                  {taskStatus(job)}
                </strong>
                <small>{job.settledCredits ?? job.quotedCredits ?? "—"} 积分</small>
              </span>
              {label !== undefined && (
                <ChevronRight className="canvas-task-locate" aria-hidden="true" size={14} />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function CanvasTaskHistory({
  open,
  setOpen,
  management,
  ...props
}: HistoryProps & {
  open: boolean;
  setOpen: (open: boolean) => void;
  management?: {
    view: "history" | "manage";
    setView: (view: "history" | "manage") => void;
    content: ReactNode;
  };
}) {
  const managing = management?.view === "manage";
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal className="canvas-task-layer">
        <Dialog.Backdrop className="canvas-task-backdrop" />
        <Dialog.Popup className="canvas-task-history nokey">
          <header>
            <History aria-hidden="true" size={20} />
            <div>
              <Dialog.Title>{management ? "生成任务" : "任务历史"}</Dialog.Title>
              <Dialog.Description>
                {managing ? "查看进度、结果与待处理任务" : "查看本画布的生成记录，点击可定位节点"}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="canvas-task-close"
              aria-label={management ? "关闭任务" : "关闭任务历史"}
            >
              <X aria-hidden="true" size={16} />
            </Dialog.Close>
          </header>
          {management && (
            <fieldset
              className="job-center-filters canvas-task-views"
              data-ui-group
              aria-label="任务视图"
            >
              <button
                type="button"
                aria-pressed={!managing}
                onClick={() => management.setView("history")}
              >
                画布历史
              </button>
              <button
                type="button"
                aria-pressed={managing}
                onClick={() => management.setView("manage")}
              >
                任务管理
              </button>
            </fieldset>
          )}
          {managing ? (
            management?.content
          ) : (
            <TaskList
              {...props}
              pick={(id) => {
                if (!props.pick(id)) return false;
                setOpen(false);
                return true;
              }}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
