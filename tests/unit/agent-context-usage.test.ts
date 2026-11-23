import {
  agentContextWindow,
  contextUsage,
  formatTokens,
  type SettingsEvent,
  sessionContextTokens,
} from "@link-studio/core";
import { describe, expect, it } from "vitest";

describe("assistant context usage", () => {
  it("formats token boundaries without 1000K or non-finite values", () => {
    expect([NaN, -1, 0, 999, 1499, 9950, 12499, 999499, 999500, 1250000].map(formatTokens)).toEqual(
      ["0", "0", "0", "999", "1.5K", "10K", "12K", "999K", "1M", "1.3M"],
    );
  });
  it("uses the raw ratio for warnings and caps the displayed progress", () => {
    expect(
      [1, 749, 750, 899, 900, 1300]
        .map((tokens) => contextUsage(tokens, 1000))
        .map(({ percent, tone }) => [percent, tone]),
    ).toEqual([
      [1, "normal"],
      [75, "normal"],
      [75, "warn"],
      [90, "warn"],
      [90, "danger"],
      [100, "danger"],
    ]);
    expect(contextUsage(1600, 0)).toEqual({
      used: 1600,
      known: false,
      ratio: 0,
      percent: 0,
      tone: "normal",
    });
    expect(contextUsage(Infinity, 2000).used).toBe(0);
    expect(agentContextWindow({})).toBe(32768);
    expect(agentContextWindow()).toBe(0);
  });
  it("restores the latest valid main input rather than summing outputs or resetting at a turn boundary", () => {
    let seq = 0;
    const event = (runId: string, type: string, payload: unknown = {}): SettingsEvent => ({
      seq: ++seq,
      runId,
      type,
      payload,
    });
    const first = [
      event("orphan", "run.usage", { context_tokens: 50 }),
      event("one", "run.status"),
      event("one", "model.usage", { input_tokens: 234, output_tokens: 2500 }),
      event("one", "run.usage", { context_tokens: 0 }),
      event("two", "run.status"),
    ];
    expect(sessionContextTokens(first.slice(0, 1))).toBe(0);
    expect(sessionContextTokens(first)).toBe(234);
    expect(
      sessionContextTokens([
        ...first,
        event("two", "run.usage", { context_tokens: 103 }),
        event("two", "activity.summarized"),
        event("two", "model.usage", { input_tokens: NaN }),
      ]),
    ).toBe(103);
    expect(sessionContextTokens([])).toBe(0);
  });
});
