export type CanvasNoticeKind = "approval" | "settled";

export function canvasNoticeKind(type: string, payload: unknown): CanvasNoticeKind | undefined {
  const data = payload as {
    kind?: unknown;
    status?: unknown;
    steer?: unknown;
    receipt_only?: unknown;
  } | null;
  if (type === "approval.created" && data?.kind === "generate" && data.status === "pending")
    return "approval";
  if (type === "tasks.settled" && data?.steer === false && data.receipt_only !== true)
    return "settled";
}

export function canvasNoticeTitle(kind: CanvasNoticeKind, name: string) {
  return `${name.trim() || "未命名画布"}：${kind === "approval" ? "Agent 需要你批准一批生成" : "生成已完成，Agent 正在验收"}`;
}
