import type { SettingsEvent } from "@link-studio/core";

export type Compaction = { before: number; after: number | null; failed: boolean };

export function compactionHistory(events: SettingsEvent[]) {
  const dividers = new Map<number, Compaction>();
  const waiting = new Map<string, Compaction[]>();
  for (const { type, seq, runId, payload } of events) {
    if (type !== "context.compacted" && type !== "run.usage") continue;
    const data = (payload ?? {}) as Record<string, unknown>;
    if (type === "context.compacted") {
      const item: Compaction = {
        before: typeof data.before === "number" ? data.before : 0,
        after: null,
        failed: data.failed === true,
      };
      dividers.set(seq, item);
      if (!item.failed) {
        const pending = waiting.get(runId);
        if (pending) pending.push(item);
        else waiting.set(runId, [item]);
      }
    } else if (typeof data.context_tokens === "number") {
      for (const item of waiting.get(runId) ?? []) item.after = data.context_tokens;
      waiting.delete(runId);
    }
  }
  return dividers;
}
