import { describe, expect, it } from "vitest";
import { runEndBubble } from "../../src/renderer/workspace/pet/assistant-notice";
import { initialNoticeState, noticeState } from "../../src/renderer/workspace/pet/notice-state";
import { requireTestValue } from "../require-test-value";

describe("助手结束后的桌宠提醒", () => {
  it.each([
    ["failed", "卡住了，这一轮没跑完"],
    ["timeout", "卡住了：运行超时"],
    ["step_limit", "卡住了：达到步数上限"],
    ["budget_exhausted", "卡住了：额度用完了"],
    ["interrupted", "卡住了：被中断了"],
    ["expired", "卡住了：等太久，已过期"],
  ])("%s 使用运行原因，原因缺失时使用状态文案", (status, text) => {
    expect(runEndBubble({ runId: "run", status })).toMatchObject({
      id: "assistant:done:run",
      text,
      priority: "error",
      ttl: 6000,
      mood: "failed",
    });
    expect(runEndBubble({ runId: "run", status, error: "模型超时" })?.text).toBe(
      "卡住了：模型超时",
    );
  });

  it.each(["canceled", "running", "waiting_approval", "recovering"])("%s 保持安静", (status) => {
    expect(runEndBubble({ runId: "run", status })).toBeNull();
  });

  it("审批在前时，延迟到结果气泡显示时才庆祝", () => {
    const success = requireTestValue(runEndBubble({ runId: "run", status: "succeeded" }));
    const first = noticeState(initialNoticeState(), {
      type: "push",
      now: 100,
      bubble: {
        ...success,
        id: "approval",
        priority: "approval",
        mood: "waiting",
        ttl: null,
      },
    });
    const pending = noticeState(first, { type: "push", now: 200, bubble: success });
    expect(pending.queue.current?.id).toBe("approval");
    expect(pending.reaction).toBeNull();
    const promoted = noticeState(pending, { type: "dismiss", now: 1000, id: "approval" });
    expect(promoted.queue.current).toMatchObject({ text: "好啦，回复写完了", ttl: 4000 });
    expect(promoted.reaction?.kind).toBe("celebrate");
    expect(noticeState(promoted, { type: "endReaction", until: 200 })).toBe(promoted);
  });
});
