const milliseconds: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function readDuration(text: string, agent: boolean) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(trimmed))
    return { error: "时长格式不对，示例：90s、30m、1h" };
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g))
    total += Number(amount) * (milliseconds[unit ?? ""] ?? 0);
  if (agent && (total < 10000 || total > 600000)) return { error: "必须在 10s – 10m 之间" };
  if (!Number.isFinite(total) || total < 1 || total > 86400000)
    return { error: "任务超时须在 1 毫秒至 24 小时之间" };
  return { seconds: total / 1000 };
}
