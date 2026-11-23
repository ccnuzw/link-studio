import { Check, X } from "lucide-react";

export function GenerationDecisionRow({
  status,
  count,
  answer,
  credits,
  partialQuote,
}: {
  status: unknown;
  count: number;
  answer?: string;
  credits?: unknown;
  partialQuote?: boolean;
}) {
  const failed = status === "failed",
    rejected = status === "rejected",
    expired = status === "expired";
  const prefix = failed
    ? "已批准，但执行失败"
    : rejected
      ? "已拒绝"
      : expired
        ? "已失效"
        : status === "partially_approved"
          ? "已部分批准"
          : "已批准";
  const Icon = failed || rejected || expired ? X : Check;
  const text = `${prefix}：申请生成 ${count} 个节点${rejected && answer ? ` · 你的说明：${answer}` : ""}`;
  return (
    <div className="settings-action-result generation-decision-row">
      <Icon className={failed ? "failed" : undefined} size={14} aria-hidden />
      <span>{text}</span>
      {typeof credits === "number" && credits > 0 && (
        <span className="generation-credits">
          · ✦ {credits}
          {partialQuote && " + 未定价"}
        </span>
      )}
    </div>
  );
}
