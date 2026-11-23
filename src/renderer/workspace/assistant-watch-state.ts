import type { CanvasWatchBatch } from "@link-studio/core";

export function canvasTitleLabel(
  name: string,
  pending: boolean,
  watch: { queued: boolean; settled: number; total: number } | null,
) {
  const prefix = pending
    ? "⏸ 待批准 · "
    : watch && !watch.queued
      ? `⏳ ${watch.settled}/${watch.total} · `
      : "";
  return prefix + (name.trim() || "未命名画布");
}

export function summarizeWatches(batches: readonly CanvasWatchBatch[]) {
  const active = batches.filter(
    (batch) => batch.state === "waiting" || batch.state === "deliverable",
  );
  if (!active.length) return null;
  const total = active.reduce((count, batch) => count + batch.total, 0);
  const settled = active.reduce((count, batch) => count + batch.settled, 0);
  const tasks = active.flatMap((batch) =>
    batch.tasks.map((task) => ({
      id: task.task_id,
      node: task.node_id,
      label: task.label,
      status:
        task.status === "pending" ? "生成中" : task.task_status === "succeeded" ? "成功" : "失败",
    })),
  );
  const queued = active.some((batch) => batch.state === "deliverable");
  const failed = tasks.filter((task) => task.status === "失败").length;
  return {
    total,
    settled,
    tasks,
    failed,
    queued,
    text: queued
      ? "已全部结束 · 等当前运行结束后 Agent 继续"
      : `后台等待生成 · ${settled}/${total} 已结束`,
  };
}
