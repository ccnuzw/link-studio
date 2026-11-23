import { ChevronDown, ChevronUp } from "lucide-react";
import { useId, useState } from "react";
import type { summarizeWatches } from "./assistant-watch-state";
import "./assistant-watch.css";

export function AssistantWatchStrip({
  summary,
  cancel,
  locate,
  busy = false,
}: {
  summary: NonNullable<ReturnType<typeof summarizeWatches>>;
  cancel: () => void;
  locate: (node: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = useId(),
    list = useId();
  const Chevron = open ? ChevronUp : ChevronDown;
  const circumference = 2 * Math.PI * 7;
  const ratio = summary.total > 0 ? Math.min(1, Math.max(0, summary.settled / summary.total)) : 0;
  return (
    <section className="assistant-watch" aria-label="后台等待生成">
      <div className="assistant-watch-heading">
        <button
          className="assistant-watch-toggle"
          type="button"
          aria-labelledby={label}
          aria-expanded={open}
          aria-controls={open ? list : undefined}
          onClick={() => setOpen(!open)}
        />
        <svg
          className="assistant-watch-ring"
          viewBox="0 0 18 18"
          aria-hidden="true"
          data-queued={summary.queued}
        >
          <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" />
          <circle
            cx="9"
            cy="9"
            r="7"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </svg>
        <span className="assistant-watch-label" id={label}>
          {summary.text}
          {summary.failed > 0 && <span data-status="失败"> · {summary.failed} 项失败</span>}
        </span>
        <i />
        {!summary.queued && (
          <button type="button" className="assistant-watch-cancel" disabled={busy} onClick={cancel}>
            不用等了
          </button>
        )}
        <Chevron size={14} aria-hidden="true" />
      </div>
      {open && (
        <ul id={list}>
          {summary.tasks.map((task) => (
            <li key={task.id}>
              <button type="button" onClick={() => locate(task.node)}>
                {task.label}
              </button>
              <span data-status={task.status}>{task.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
