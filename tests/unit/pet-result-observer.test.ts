import type { GenerationJob } from "@link-studio/core";
import { expect, it } from "vitest";
import { CanvasResultObserver } from "../../src/renderer/workspace/pet/result-observer";

const openedAt = Date.UTC(2026, 10, 23);
const job = (id: string, status: GenerationJob["status"], elapsed: number) => ({
  id,
  status,
  updatedAt: new Date(openedAt + elapsed).toISOString(),
});

it("首次轮询捕获画布打开后结束的快速任务，再次轮询和重开项目保持安静", () => {
  const observer = new CanvasResultObserver(openedAt);
  const history = job("history", "succeeded", -1);
  const fast = job("fast", "succeeded", 0);
  const failure = job("failure", "failed", 1);
  expect(observer.collect([history, fast, failure, fast])).toEqual([fast, failure]);
  expect(observer.collect([])).toEqual([]);
  expect(observer.collect([failure, fast])).toEqual([]);
  expect(new CanvasResultObserver(openedAt + 2).collect([fast, history, failure])).toEqual([]);
});

it("保留画布内见过的活动任务，缺失时间只有见过活动态才提醒", () => {
  const observer = new CanvasResultObserver(openedAt);
  expect(observer.collect([job("seen", "queued", -5)])).toEqual([]);
  observer.collect([]);
  const seen = { ...job("seen", "failed", -1), updatedAt: "" };
  expect(observer.collect([seen, { ...seen, id: "unseen" }])).toEqual([seen]);
});

it("取消和结果未知不冒成功气泡，重新查询成功可以提醒一次", () => {
  const observer = new CanvasResultObserver(openedAt);
  expect(
    observer.collect([job("cancel", "cancelled", 5), job("check", "outcome_unknown", 6)]),
  ).toEqual([]);
  const resolved = job("check", "succeeded", 10);
  expect(observer.collect([resolved])).toEqual([resolved]);
  expect(observer.collect([resolved])).toEqual([]);
});
