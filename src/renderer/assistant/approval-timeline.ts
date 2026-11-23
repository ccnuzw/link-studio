import type { SettingsApproval, SettingsEvent } from "@link-studio/core";

export function approvalTimeline(events: SettingsEvent[], pending: SettingsApproval[]) {
  const anchors = new Map<string, number>();
  const decisions = new Map<string, SettingsEvent>();
  const closedRuns = new Set<string>();
  const active = new Map(pending.map((approval) => [approval.id, approval]));
  for (const event of events) {
    if (event.type === "run.status") {
      const status = (event.payload as { status?: string } | null)?.status;
      if (status === "canceled" || status === "expired") closedRuns.add(event.runId);
    }
    const id = event.approvalId;
    if (!id) continue;
    if (event.type === "approval.created" && !anchors.has(id)) anchors.set(id, event.seq);
    if (event.type === "approval.decided") decisions.set(id, event);
  }
  return {
    anchors,
    decisions,
    active,
    closedRuns,
    unplaced: pending.filter(({ id }) => !anchors.has(id) && !decisions.has(id)),
  };
}
