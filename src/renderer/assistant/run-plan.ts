import type { SettingsEvent } from "@link-studio/core";

export const activeStatuses = new Set([
  "queued",
  "running",
  "recovering",
  "waiting_input",
  "waiting_approval",
]);

type Step = { title: string; status: "todo" | "doing" | "done" };

export function planSteps(payload: unknown): Step[] {
  const steps = (payload as { steps?: unknown } | null)?.steps;
  if (
    !Array.isArray(steps) ||
    !steps.every(
      (step) =>
        step && typeof step.title === "string" && ["todo", "doing", "done"].includes(step.status),
    )
  )
    return [];
  return steps;
}

export function planFinished(steps: Step[]) {
  return steps.length > 0 && steps.every((step) => step.status === "done");
}

export function latestPlan(events: SettingsEvent[], activeRun?: string) {
  const latest = events.findLast((event) => event.type === "run.status");
  const runId = activeRun ?? latest?.runId;
  if (!runId) return null;
  const steps = planSteps(
    events.findLast((event) => event.runId === runId && event.type === "plan.updated")?.payload,
  );
  const active =
    !!activeRun || activeStatuses.has((latest?.payload as { status?: string })?.status ?? "");
  if (!steps.length || (!active && planFinished(steps))) return null;
  return { runId, steps, active };
}
