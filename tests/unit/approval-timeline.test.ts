import type { SettingsEvent } from "@link-studio/core";
import { expect, it } from "vitest";
import { approvalTimeline } from "../../src/renderer/assistant/approval-timeline";

it("同一轮逐个绑定审批，分批读取未定位的申请，重放时只保留最后的决定", () => {
  const event = (seq: number, type: string, approvalId: string): SettingsEvent => ({
    seq,
    type,
    approvalId,
    runId: "one",
    payload: {},
  });
  const request = event(2, "approval.created", "first");
  const events = [
    request,
    event(3, "approval.created", "first"),
    event(5, "approval.decided", "first"),
    event(7, "approval.decided", "first"),
  ];
  const pending = [{ id: "next", kind: "admin_test_run", status: "pending", payload: {} }];
  const page = approvalTimeline(events, pending);
  expect(page.anchors.get("first")).toBe(2);
  expect(page.decisions.get("first")?.seq).toBe(7);
  expect(page.unplaced).toEqual(pending);
  const complete = approvalTimeline([...events, event(10, "approval.created", "next")], pending);
  expect(complete.unplaced).toEqual([]);
  expect(complete.active.get("next")).toBe(pending[0]);
  const closed = approvalTimeline(
    [...events, { seq: 11, type: "run.status", runId: "one", payload: { status: "canceled" } }],
    [],
  );
  expect(closed.closedRuns.has("one")).toBe(true);
  expect(closed.active.size).toBe(0);
});
