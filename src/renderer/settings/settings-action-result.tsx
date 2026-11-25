import { Check, X } from "lucide-react";
import { formatSeconds } from "../assistant/activity-summary";

export function changeOrderTitle(revertOf: unknown) {
  return typeof revertOf === "string" && revertOf ? `回滚变更单 ${revertOf}` : "配置变更单";
}

export function ChangeDisposition({
  status,
  revertOf,
  answer,
  error,
}: {
  status: "expired" | "failed" | "rejected";
  revertOf?: unknown;
  answer?: unknown;
  error?: string;
}) {
  const prefix =
    status === "expired" ? "已失效" : status === "failed" ? "已批准，但执行失败" : "已拒绝";
  return (
    <div className="settings-action-result" title={status === "failed" ? error : undefined}>
      <X className={status === "failed" ? "failed" : undefined} size={14} aria-hidden />
      <span>
        {prefix}：{changeOrderTitle(revertOf)}
        {status === "rejected" && typeof answer === "string" && answer
          ? ` · 你的说明：${answer}`
          : ""}
      </span>
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
  const duration = result.duration_ms;
  const elapsed =
    trial && typeof duration === "number" && Number.isFinite(duration) && duration >= 0
      ? `耗时 ${formatSeconds(duration / 1000)}`
      : undefined;
  const text = [summary, trial && label, elapsed, error].filter(Boolean).join(" · ");
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
