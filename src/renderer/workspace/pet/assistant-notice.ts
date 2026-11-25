import type { BubbleInput } from "./bubble-queue";

export type PetRunEnd = { runId: string; status: string; error?: string };

const failureReasons = new Map([
  ["failed", ""],
  ["timeout", "运行超时"],
  ["step_limit", "达到步数上限"],
  ["budget_exhausted", "额度用完了"],
  ["interrupted", "被中断了"],
  ["expired", "等太久，已过期"],
]);

export function runEndBubble({ runId, status, error }: PetRunEnd): BubbleInput | null {
  const success = status === "succeeded";
  if (!success && !failureReasons.has(status)) return null;
  const reason = error || failureReasons.get(status);
  return {
    id: `assistant:done:${runId}`,
    source: "assistant",
    priority: success ? "result" : "error",
    mood: success ? "jumping" : "failed",
    text: success ? "好啦，回复写完了" : reason ? `卡住了：${reason}` : "卡住了，这一轮没跑完",
    ttl: success ? 4000 : 6000,
  };
}
