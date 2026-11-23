import { Check, X } from "lucide-react";

export function RejectedChange({ answer }: { answer?: string }) {
  return (
    <div className="settings-action-result">
      <X size={14} aria-hidden />
      <span>已拒绝：配置变更单{answer ? ` · 你的说明：${answer}` : ""}</span>
    </div>
  );
}

export function SettingsActionResult({
  kind,
  status,
  result,
  label,
  error,
}: {
  kind: "admin_secret" | "admin_test_run";
  status: unknown;
  result: Record<string, unknown>;
  label?: string;
  error?: string;
}) {
  const failed = status === "failed";
  const expired = status === "expired";
  const rejected = status === "rejected";
  const trial = kind === "admin_test_run";
  const summary = trial
    ? result.tested
      ? "试跑成功"
      : rejected
        ? "未试跑"
        : expired
          ? "试跑请求已失效"
          : failed
            ? result.code === "PROVIDER_OUTCOME_UNKNOWN"
              ? "试跑结果未知"
              : "试跑失败"
            : "仍在运行"
    : rejected
      ? "已跳过"
      : result.configured
        ? "已保存密钥"
        : failed || result.configured === false
          ? "密钥未保存"
          : expired
            ? "密钥请求已失效"
            : "正在确认密钥";
  const text = [summary, trial && label, error].filter(Boolean).join(" · ");
  const Icon = failed || expired || rejected ? X : Check;
  return (
    <div className="settings-action-result">
      <Icon className={failed ? "failed" : undefined} size={14} aria-hidden />
      <span className={trial ? "trial" : undefined} title={trial ? text : undefined}>
        {text}
      </span>
    </div>
  );
}
