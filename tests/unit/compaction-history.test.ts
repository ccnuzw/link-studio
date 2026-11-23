import type { SettingsEvent } from "@link-studio/core";
import { expect, it } from "vitest";
import { compactionHistory } from "../../src/renderer/assistant/compaction-history";

it("将分隔行与同一轮中首次后续用量配对，切页、失败和临时事件都不移动历史位置", () => {
  const event = (seq: number, runId: string, type: string, payload: unknown): SettingsEvent => ({
    seq,
    runId,
    type,
    payload,
  });
  const history = [
    event(1, "a", "run.usage", { context_tokens: 2400 }),
    event(0, "a", "context.compacting", {}),
    event(2, "a", "context.compacted", { before: 2400 }),
    event(3, "a", "context.compacted", { before: 1500 }),
    event(4, "b", "context.compacted", { failed: true }),
    event(5, "b", "run.usage", { context_tokens: 300 }),
    event(6, "a", "run.usage", { spent_credits: 4 }),
    event(7, "a", "model.usage", { input_tokens: 500 }),
  ];
  const pending = compactionHistory(history);
  expect([...pending.keys()]).toEqual([2, 3, 4]);
  expect(pending.get(2)?.after).toBeNull();
  const resolved = compactionHistory([
    ...history,
    event(8, "a", "run.usage", { context_tokens: 600 }),
    event(9, "a", "run.usage", { context_tokens: 770 }),
    event(10, "c", "context.compacted", {}),
    event(11, "c", "run.usage", { context_tokens: 0 }),
  ]);
  expect([...resolved.values()]).toEqual([
    { before: 2400, after: 600, failed: false },
    { before: 1500, after: 600, failed: false },
    { before: 0, after: null, failed: true },
    { before: 0, after: 0, failed: false },
  ]);
  expect(pending.get(3)?.after).toBeNull();
});
