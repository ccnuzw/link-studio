import type { CanvasWatchBatch } from "@link-studio/core";
import { expect, it } from "vitest";
import {
  canvasTitleLabel,
  summarizeWatches,
} from "../../src/renderer/workspace/assistant-watch-state";

const batch = (
  state: CanvasWatchBatch["state"],
  id: string,
  results: (string | null)[],
): CanvasWatchBatch => ({
  state,
  batch_id: id,
  total: results.length,
  settled: results.filter(Boolean).length,
  tasks: results.map((result, index) => ({
    task_id: `${id}-${index}`,
    node_id: `node-${id}`,
    label: id,
    status: result ? "settled" : "pending",
    task_status: result ?? undefined,
  })),
});

it("已交付和已取消的批次不占用监听条，重新打开历史也不会复活", () => {
  expect(
    summarizeWatches([
      batch("delivered", "old", ["succeeded"]),
      batch("canceled", "ended", [null]),
    ]),
  ).toBeNull();
});

it("标题优先提示待批准或待提问，排队交付不再显示进度", () => {
  const watch = { queued: false, settled: 2, total: 3 };
  expect(canvasTitleLabel(" 场景一 ", true, watch)).toBe("⏸ 待批准 · 场景一");
  expect(canvasTitleLabel("场景一", false, watch)).toBe("⏳ 2/3 · 场景一");
  expect(canvasTitleLabel(" ", false, { ...watch, queued: true })).toBe("未命名画布");
});

it("按登记顺序合并活动批次，区分待生成、失败和已结束等待交付", () => {
  const waiting = batch("waiting", "A", [null, "expired"]);
  expect(summarizeWatches([waiting])?.text).toBe("后台等待生成 · 1/2 已结束");
  const summary = summarizeWatches([
    waiting,
    batch("canceled", "B", [null]),
    batch("deliverable", "C", ["succeeded", "missing", "canceled"]),
  ]);
  expect(summary).toMatchObject({
    total: 5,
    settled: 4,
    failed: 3,
    queued: true,
    text: "已全部结束 · 等当前运行结束后 Agent 继续",
  });
  expect(summary?.tasks.map((task) => [task.id, task.node, task.status])).toEqual([
    ["A-0", "node-A", "生成中"],
    ["A-1", "node-A", "失败"],
    ["C-0", "node-C", "成功"],
    ["C-1", "node-C", "失败"],
    ["C-2", "node-C", "失败"],
  ]);
});
