import type { SettingsEvent } from "@link-studio/core";
import { validateCard } from "../../../packages/agent-runtime/upstream/src/card";
import { activeStatuses, planFinished, planSteps } from "./run-plan";

type Tool = {
  id: string;
  name: string;
  verb: string;
  label: string;
  detail: string;
  failed: boolean;
  nodeIds: string[];
  ended: boolean;
};
export type ActivityGroupModel = {
  key: number;
  runId: string;
  tools: Map<string, Tool>;
  summary?: string;
  running: boolean;
  aborted: boolean;
  startedAt: number | null;
  endedAt: number | null;
};

const identity = (runId: string, id: unknown) => JSON.stringify([runId, id]);

export function toolHistory(events: SettingsEvent[], composerPlan: boolean) {
  const ends = new Map<string, SettingsEvent>();
  const statuses = new Map<string, string>();
  const summaries = new Map<string, string>();
  for (const event of events) {
    const data = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "run.status") statuses.set(event.runId, String(data.status));
    if (event.type === "tool.end")
      ends.set(identity(event.runId, data.id || `e${event.seq}`), event);
    if (event.type === "activity.summarized" && typeof data.text === "string")
      summaries.set(identity(event.runId, data.group_id), data.text);
  }

  const items: (SettingsEvent | ActivityGroupModel)[] = [];
  const seen = new Set<string>();
  const finishedPlans = new Set<string>();
  let group: ActivityGroupModel | undefined;
  let lastActivity: ActivityGroupModel | undefined;
  for (const event of events) {
    const data = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "tool.start" || event.type === "tool.end") {
      const id = String(data.id || `e${event.seq}`);
      const key = identity(event.runId, id);
      if (seen.has(key)) continue;
      seen.add(key);
      const end = ends.get(key);
      const result = { ...data, ...(end?.payload as Record<string, unknown>) };
      if (result.name === "show_card" && result.is_error !== true) continue;
      if (!group || group.runId !== event.runId) {
        group = {
          key: event.seq,
          runId: event.runId,
          summary: summaries.get(key),
          tools: new Map(),
          running: false,
          aborted: false,
          startedAt: event.createdAt ?? null,
          endedAt: null,
        };
        items.push(group);
      }
      lastActivity = group;
      const ids = result.node_ids ?? (result.result as { nodeIds?: unknown })?.nodeIds;
      group.tools.set(id, {
        id,
        name: String(result.name ?? ""),
        verb: String(result.verb ?? ""),
        label: String(result.label || result.verb || result.name || "执行操作"),
        detail: String(result.summary ?? ""),
        ended: !!end,
        failed: result.is_error === true,
        nodeIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
      });
      if (end?.createdAt != null)
        group.endedAt = Math.max(group.endedAt ?? end.createdAt, end.createdAt);
      if (!end) {
        const status = statuses.get(event.runId);
        if (status && !activeStatuses.has(status)) group.aborted = true;
        else group.running = true;
      }
      continue;
    }
    if (event.type === "message.done" && !data.text && !data.thinking) continue;
    if (event.type === "plan.updated" && composerPlan) {
      if (finishedPlans.has(event.runId) || !planFinished(planSteps(data))) continue;
      finishedPlans.add(event.runId);
    }
    if (event.type === "message.done" && data.text) lastActivity = undefined;
    if (
      [
        "message.done",
        "message.user",
        "approval.created",
        "context.compacted",
        "tasks.settled",
        "plan.updated",
      ].includes(event.type) ||
      (event.type === "card.shown" && validateCard(data.card).ok) ||
      (event.type === "run.status" && !activeStatuses.has(String(data.status)))
    )
      group = undefined;
    items.push(event);
  }
  if (
    lastActivity &&
    !lastActivity.aborted &&
    activeStatuses.has(statuses.get(lastActivity.runId) ?? "")
  )
    lastActivity.running = true;
  return items;
}
