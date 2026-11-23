import { CircleStop, Play, TriangleAlert } from "lucide-react";
import { statusEvent } from "../../../packages/agent-runtime/upstream/src/engine/status";

export function showsContinue(status: unknown) {
  return ["interrupted", "budget_exhausted", "step_limit", "timeout"].includes(String(status));
}

export function RunStatusCard({
  data,
  resume,
  addBudget,
}: {
  data: Record<string, unknown>;
  resume?: () => void;
  addBudget?: () => void;
}) {
  const status = String(data.status);
  const fallback = statusEvent(status);
  if (typeof fallback.title !== "string") return null;
  const failed = status === "timeout" || status === "failed";
  const Icon = failed ? TriangleAlert : CircleStop;
  const title = String(data.title || fallback.title);
  return (
    <section className="agent-run-status-card" aria-label={title} data-failed={failed}>
      <div className="agent-run-status-body">
        <Icon size={16} aria-hidden />
        <div>
          <strong>{title}</strong>
          <p>{String(data.error || data.hint || fallback.hint || "")}</p>
        </div>
      </div>
      {(resume || addBudget) && (
        <div className="agent-resume-actions">
          {addBudget && (
            <button type="button" onClick={addBudget}>
              追加 20 积分并继续
            </button>
          )}
          {resume && (
            <button type="button" onClick={resume}>
              <Play size={16} aria-hidden />
              继续
            </button>
          )}
        </div>
      )}
    </section>
  );
}
