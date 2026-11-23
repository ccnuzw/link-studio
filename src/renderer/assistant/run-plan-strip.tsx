import type { SettingsEvent } from "@link-studio/core";
import { Check, ChevronUp, X } from "lucide-react";
import { useMemo, useState } from "react";
import { latestPlan } from "./run-plan";
import "./run-plan.css";

export function RunPlanStrip({
  events,
  activeRun,
}: {
  events: SettingsEvent[];
  activeRun?: string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const plan = useMemo(() => latestPlan(events, activeRun), [events, activeRun]);
  if (!plan || (!plan.active && hidden.has(plan.runId))) return null;
  return (
    <Plan
      key={plan.runId}
      plan={plan}
      hide={() => setHidden((previous) => new Set(previous).add(plan.runId))}
    />
  );
}

function Plan({
  plan,
  hide,
}: {
  plan: NonNullable<ReturnType<typeof latestPlan>>;
  hide: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { steps, active } = plan;
  const done = steps.filter((step) => step.status === "done").length;
  const finished = done === steps.length;
  const current =
    steps.find((step) => step.status === "doing") ?? steps.find((step) => step.status === "todo");
  return (
    <section className="agent-run-plan" aria-label="本轮计划" data-finished={finished}>
      {open && (
        <ul>
          {steps.map((step, index) => (
            <li key={index} data-state={step.status}>
              <span aria-hidden>{step.status === "done" ? <Check size={14} /> : <i />}</span>
              <span>{step.title}</span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <button
          type="button"
          aria-label={open ? "收起计划" : "展开计划"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" strokeWidth="2" aria-hidden>
            <circle cx="9" cy="9" r="7" />
            <circle
              cx="9"
              cy="9"
              r="7"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={1 - done / steps.length}
              strokeLinecap="round"
            />
          </svg>
          {(finished || !active) && <b>{finished ? "完成" : "未完成"}</b>}
          <span>{finished ? "全部步骤已完成" : current?.title}</span>
          <small>
            {done}/{steps.length}
          </small>
          <ChevronUp size={14} />
        </button>
        {!active && (
          <button type="button" title="隐藏这个计划" aria-label="隐藏这个计划" onClick={hide}>
            <X size={14} />
          </button>
        )}
      </div>
    </section>
  );
}
