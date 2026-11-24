import { Popover } from "@base-ui/react/popover";
import type { DramaDocument } from "@link-studio/core";
import { ChevronDown, CircleAlert, FileCheck2, Pause } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EpisodeProgress } from "./drama-episode-rail";
import { dramaJobFeedback } from "./drama-job-feedback";
import { episodeScope, failureRecovery } from "./drama-task-recovery";
import type { Stage } from "./drama-workspace-nav";

type Job = NonNullable<DramaDocument["jobs"]>[number];
type Plan = NonNullable<DramaDocument["planning"]>;
export type TaskControls = {
  blank?: ReadonlySet<string>;
  quotePrompts?: (job: Job) => Promise<{ estimate: number; submit: () => Promise<void> }>;
  cancel: (jobId: string) => Promise<void>;
  recover: (job: Job) => Promise<void>;
  plan: (action: "pause" | "resume" | "retry-builtin") => Promise<void>;
};

type Task = {
  actions?: { label: string; run: () => void; disabled?: boolean }[];
  id: string;
  name: string;
  scope?: string;
  detail?: string;
  diagnostic?: string;
  kept?: boolean;
  state: "running" | "paused" | "failed" | "queued" | "pendingPrompts";
  percent: number | null;
  open: () => void;
};
const steps = {
  scripts: ["分集剧本", "script"],
  breakdown: ["资产拆解", "assets"],
  asset_prompts: ["资产补词", "assets"],
  storyboard: ["分镜", "studio"],
  compose: ["成片合成", "final"],
} as const;
const states = {
  running: "进行中",
  queued: "排队中",
  paused: "已暂停",
  failed: "失败",
  pendingPrompts: "待补词",
};

function percent(done: number, total: number) {
  return Math.min(100, Math.round((100 * done) / total));
}

function planningPercent(plan: Plan) {
  if (!plan.summary) return null;
  const batch = plan.pending;
  const partial =
    batch?.step === "plan" && batch.progress === 50 ? (batch.to - batch.from + 1) / 2 : 0;
  return percent(plan.cursor + partial, plan.end);
}

function ProgressBar({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      className="dp-task-track"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value ?? undefined}
    >
      <i style={value === null ? undefined : { transform: `scaleX(${value / 100})` }} />
    </div>
  );
}

export function PlanningBar({ plan }: { plan: Plan }) {
  return (
    <ProgressBar value={planningPercent(plan)} label={plan.summary ? "分集规划" : "粗读全书"} />
  );
}

function jobTask(job: Job, go: (stage: Stage, episode?: number) => void): Task | undefined {
  if (
    job.status === "canceled" ||
    (job.status === "succeeded" && !(job.step === "breakdown" && job.deferred_nodes?.length))
  )
    return;
  const [name, stage] = steps[job.step];
  const { progress: value, detail } = dramaJobFeedback(job);
  return {
    id: job.id,
    name,
    state: job.status === "succeeded" ? "pendingPrompts" : job.status,
    scope: episodeScope(job.episodes),
    percent: value,
    detail,
    open: () => go(stage, job.episodes[0]),
  };
}

function aggregate(tasks: Task[]) {
  const active = tasks.filter((task) => task.state === "queued" || task.state === "running");
  if (
    !active.some((task) => task.state === "running") ||
    active.some((task) => task.state === "running" && task.percent === null)
  )
    return null;
  return Math.round(
    active.reduce((sum, task) => sum + (task.state === "queued" ? 0 : (task.percent ?? 0)), 0) /
      active.length,
  );
}

function Mark({ state, value }: { state: Task["state"]; value: number | null }) {
  if (state === "pendingPrompts") return <FileCheck2 size={16} aria-hidden />;
  if (state === "paused") return <Pause size={15} aria-hidden />;
  if (state === "failed") return <CircleAlert size={16} className="dp-task-error" aria-hidden />;
  return <EpisodeProgress size={16} queued={state === "queued"} progress={value ?? 0} />;
}

function TaskRow({ task }: { task: Task }) {
  const running = task.state === "running";
  return (
    <div>
      <Popover.Close className="dp-task-row" onClick={task.open}>
        {task.kept ? (
          <FileCheck2 size={16} aria-hidden />
        ) : (
          <Mark state={task.state} value={task.percent} />
        )}
        <span className="dp-task-title">
          {task.name} <small>{task.scope}</small>
        </span>
        <small className={task.state === "failed" && !task.kept ? "dp-task-error" : undefined}>
          {task.kept
            ? "原版可用"
            : running && task.percent !== null
              ? `${task.percent}%`
              : states[task.state]}
        </small>
        {running && <ProgressBar value={task.percent} label={task.name} />}
        {task.detail && <small className="dp-task-detail">{task.detail}</small>}
      </Popover.Close>
      {(task.state === "failed" || (task.state === "pendingPrompts" && task.diagnostic)) && (
        <details className="dp-task-id">
          <summary>技术详情</summary>
          <small>
            {task.diagnostic}
            <br />
            任务 ID · {task.id}
          </small>
        </details>
      )}
      {task.actions?.length ? (
        <div className="dp-task-actions">
          {task.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskGroup({ tasks }: { tasks: Task[] }) {
  const [expanded, setExpanded] = useState(true);
  const first = tasks[0];
  if (!first) return null;
  if (tasks.length === 1) return <TaskRow task={first} />;
  const value = aggregate(tasks);
  return (
    <div>
      <button
        className="dp-task-row"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Mark
          state={
            tasks.some((task) => task.state === "running")
              ? "running"
              : tasks.some((task) => task.state === "failed")
                ? "failed"
                : tasks.some((task) => task.state === "queued")
                  ? "queued"
                  : first.state
          }
          value={value}
        />
        <span>
          {first.name} <small>{tasks.length} 项</small>
        </span>
        <small>
          {value !== null && `${value}% `}
          <ChevronDown size={14} aria-hidden />
        </small>
      </button>
      {expanded && (
        <div className="dp-task-children">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DramaTaskPill({
  doc,
  go,
  openPlanning,
  controls,
  projectId,
}: {
  doc: DramaDocument;
  go: (stage: Stage, episode?: number) => void;
  openPlanning: () => void;
  controls?: TaskControls;
  projectId?: string;
}) {
  const key = `drama-tasks:${projectId}:dismissed`;
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      const ids: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [quote, setQuote] = useState<{
    key: string;
    estimate: number;
    submit: () => Promise<void>;
  }>();
  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作失败，请重试");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function dismiss(id: string) {
    const next = [...dismissed.filter((entry) => doc.jobs?.some((job) => job.id === entry)), id];
    if (projectId) localStorage.setItem(key, JSON.stringify(next));
    setDismissed(next);
  }
  const tasks: Task[] = [];
  const plan = doc.planning;
  if (plan && plan.phase !== "done")
    tasks.push({
      id: "planning",
      name: plan.summary ? "分集规划" : "粗读全书",
      state: plan.phase,
      percent: planningPercent(plan),
      detail:
        plan.pause_reason ||
        (plan.summary ? `${plan.cursor}/${plan.end} 个原文单元` : "正在阅读原文"),
      open: openPlanning,
      actions: controls
        ? [
            {
              label: plan.phase === "paused" ? "继续" : "暂停",
              disabled: busy,
              run: () =>
                void perform(() => controls.plan(plan.phase === "paused" ? "resume" : "pause")),
            },
            ...(plan.phase === "paused" && plan.pause_code === "custom_prompt"
              ? [
                  {
                    label: "改用内置重试",
                    disabled: busy,
                    run: () => void perform(() => controls.plan("retry-builtin")),
                  },
                ]
              : []),
          ]
        : [],
    });
  const jobs = doc.jobs ?? [];
  const activeJobs = jobs.filter((job) => job.status === "running" || job.status === "queued");
  for (const [index, job] of jobs.entries()) {
    if (dismissed.includes(job.id)) continue;
    const task = jobTask(job, go);
    if (!task) continue;
    if (job.status === "failed" || task.state === "pendingPrompts") {
      const recovery = failureRecovery(doc, job, controls?.blank);
      if (recovery.resolved) continue;
      if (
        (job.step === "asset_prompts" || task.state === "pendingPrompts") &&
        jobs
          .slice(index + 1)
          .some(
            (other) =>
              other.step === "asset_prompts" &&
              other.status !== "canceled" &&
              (other.episode_order ?? 0) === (job.episode_order ?? 0) &&
              other.episodes.length === job.episodes.length &&
              job.episodes.every((no) => other.episodes.includes(no)),
          )
      )
        continue;
      if (task.state === "pendingPrompts" && !recovery.missing.length) continue;
      task.diagnostic = job.error_message ?? job.prompt_error;
      const reason =
        job.error_message === "AGENT_TEST_NETWORK_FAILED"
          ? "模型连接中断"
          : job.error_message === "AGENT_TEST_HTTP_FAILED"
            ? "模型服务返回错误"
            : "生成未完成";
      const remaining = recovery.remaining.map((ep) => ep.episode_no);
      const remainingScope = episodeScope(remaining);
      task.detail = recovery.kept
        ? `重新生成未完成，原有 ${recovery.kept} 段分镜已保留。`
        : [
            reason,
            recovery.missing.length && `${recovery.missing.length} 个资产待补词`,
            job.step === "breakdown" && remainingScope && `${remainingScope}待拆解`,
          ]
            .filter(Boolean)
            .join(" · ");
      task.kept = !!recovery.kept;
      if (task.state === "pendingPrompts")
        task.detail = `已拆解 ${job.done_episodes?.length ?? 0} 集，卡片可用 · ${recovery.missing.length} 个资产待补词`;
      if (controls) {
        const quoteKey = JSON.stringify([job.id, doc.episode_order, recovery.missing]);
        const prepare = controls.quotePrompts;
        const fill = prepare && recovery.missing.length > 0;
        task.actions = [
          {
            label: fill
              ? quote?.key === quoteKey
                ? `确认补写 · 约 ${quote.estimate} 积分`
                : `补写 ${recovery.missing.length} 个提示词`
              : recovery.kept
                ? "使用已有分镜"
                : job.step === "breakdown" && remaining.length
                  ? `继续拆解 ${remaining.length} 集`
                  : `查看${task.name}`,
            disabled:
              busy ||
              (!!fill &&
                activeJobs.some(
                  (other) => other.step === "asset_prompts" || other.step === "breakdown",
                )),
            run: () =>
              void perform(async () => {
                if (fill) {
                  if (quote?.key === quoteKey) {
                    setQuote(undefined);
                    await quote.submit();
                  } else setQuote({ key: quoteKey, ...(await prepare(job)) });
                  return;
                }
                await controls.recover(job);
                if (recovery.kept) dismiss(job.id);
                setOpen(false);
              }),
          },
          { label: "不再提醒", disabled: busy, run: () => dismiss(job.id) },
        ];
      }
    } else if (controls)
      task.actions = [
        {
          label: "取消任务",
          disabled: busy,
          run: () => void perform(() => controls.cancel(job.id)),
        },
      ];
    tasks.push(task);
  }
  const first = tasks[0];
  const hasTasks = tasks.length > 0;
  useEffect(() => {
    if (!hasTasks) setOpen(false);
  }, [hasTasks]);
  if (!first) return null;
  const value = aggregate(tasks);
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const group = groups.get(task.name);
    if (group) group.push(task);
    else groups.set(task.name, [task]);
  }
  const state = tasks.find((task) => task.state === "running")?.state ?? first.state;
  const label =
    tasks.length > 1
      ? `${tasks.length} 项任务`
      : `${first.name}${first.state === "running" ? "中" : states[first.state]}`;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuote(undefined);
      }}
    >
      <Popover.Trigger className="dp-task-trigger">
        <Mark state={state} value={value} />
        <span className="dp-task-title">{label}</span>
        {value !== null && <span className="dp-task-percent">{value}%</span>}
        {tasks.length > 1 &&
          state !== "failed" &&
          tasks.some((task) => task.state === "failed" && !task.kept) && (
            <CircleAlert size={13} aria-label="有失败任务" className="dp-task-error" />
          )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="dp-task-positioner"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <Popover.Popup className="dp-task-menu" aria-label="本项目任务">
            <div className="dp-task-heading">
              <b>任务</b>
              <small>{tasks.length}</small>
              {controls && activeJobs.length > 1 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const results = await Promise.allSettled(
                        activeJobs.map((job) => controls.cancel(job.id)),
                      );
                      const failed = results.find((result) => result.status === "rejected");
                      if (failed?.status === "rejected") throw failed.reason;
                    })
                  }
                >
                  取消全部任务
                </button>
              )}
            </div>
            {error && (
              <p className="dp-task-error" role="alert">
                {error}
              </p>
            )}
            {[...groups].map(([name, group]) => (
              <TaskGroup key={name} tasks={group} />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
