import type { SettingsEvent } from "@link-studio/core";

export type Steer = { id: string; text: string; event: SettingsEvent };
const reading = new Set([
  "running",
  "queued",
  "recovering",
  "waiting_input",
  "waiting_approval",
  "step_limit",
]);

export function projectSteers(events: SettingsEvent[]) {
  const pending = new Map<string, Steer>();
  const statuses = new Map<string, string>();
  const missed = new Map<number, number>();
  const transcript: SettingsEvent[] = [];
  let lastUser = 0;
  for (const event of events) {
    const data = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "message.user" && data.steer === true && typeof data.id === "string") {
      pending.set(data.id, { event, id: data.id, text: String(data.text ?? "") });
      continue;
    }
    if (event.type === "message.user" && !data.steer) lastUser = event.seq;
    if (event.type === "run.status") statuses.set(event.runId, String(data.status));
    transcript.push(event);
    if (event.type !== "steer.read" && event.type !== "steer.dropped") continue;
    for (const id of Array.isArray(data.ids) ? data.ids : []) {
      const steer = pending.get(id);
      if (!steer) continue;
      pending.delete(id);
      transcript.push(steer.event);
      if (event.type === "steer.dropped") missed.set(steer.event.seq, event.seq);
    }
  }
  const waiting: Steer[] = [];
  for (const steer of pending.values()) {
    const status = statuses.get(steer.event.runId);
    if (status && !reading.has(status)) {
      missed.set(steer.event.seq, steer.event.seq);
      transcript.push(steer.event);
    } else waiting.push(steer);
  }
  return { transcript, waiting, missed, lastUser };
}
