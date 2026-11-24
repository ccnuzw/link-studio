import { Dialog } from "@base-ui/react/dialog";
import type { GenerationJob } from "@link-studio/core";
import { History, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type HistoryNode, historyJobRows, historyJobScope } from "./canvas-history-jobs";
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
      <div className="canvas-task-wait">
        <LoaderCircle size={16} />
        正在加载任务
      </div>
    ) : (
      <div className="canvas-task-empty">
        <History size={32} />
        这张画布还没有生成过内容。
      </div>
    );
  const labels = new Map(nodes.map((node) => [node.id, node.data.label]));
  return (
    <ul>
      {list.map((job) => (
        <li key={job.id}>
          <button type="button" disabled={!labels.has(job.nodeId)} onClick={() => pick(job.nodeId)}>
            <span>
              <strong>
                {labels.get(job.nodeId) ?? "已删除的节点"}
                <small>{kinds[job.kind]}</small>
              </strong>
              <small>
                {dateFormat.format(new Date(job.createdAt))} · {job.modelKey ?? job.model}
              </small>
            </span>
            <span>
              <strong data-status={job.status}>{taskStatus(job)}</strong>
              <small>{job.settledCredits ?? job.quotedCredits ?? "—"} 积分</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function CanvasTaskHistory({
  open,
  setOpen,
  ...props
}: HistoryProps & { open: boolean; setOpen: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal className="storyboard-layer">
        <Dialog.Backdrop className="canvas-task-backdrop" />
        <Dialog.Popup className="canvas-task-history nokey">
          <header>
            <Dialog.Title>任务历史</Dialog.Title>
            <Dialog.Description>这张画布上的生成记录，点一条定位到节点</Dialog.Description>
          </header>
          <TaskList
            {...props}
            pick={(id) => {
              if (!props.pick(id)) return false;
              setOpen(false);
              return true;
            }}
          />
          <Dialog.Close className="storyboard-close" aria-label="Close">
            <X size={16} />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
