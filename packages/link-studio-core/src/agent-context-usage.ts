import type { ProviderView, SettingsEvent } from "./settings-api.ts";

export function agentContextWindow(profile?: Pick<ProviderView, "config">) {
  return profile ? (profile.config?.contextWindow ?? 32768) : 0;
}

export function formatTokens(tokens: number) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = tokens < 10000 ? Math.round(tokens / 100) / 10 : Math.round(tokens / 1000);
  return thousands < 1000 ? `${thousands}K` : `${Math.round(tokens / 100000) / 10}M`;
}

export function contextUsage(tokens: number, limit: number) {
  const used = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  const known = limit > 0;
  const ratio = known ? Math.min(1, used / limit) : 0;
  const percent = known && used ? Math.max(1, Math.round(ratio * 100)) : 0;
  return {
    used,
    known,
    ratio,
    percent,
    tone: ratio >= 0.9 ? "danger" : ratio >= 0.75 ? "warn" : "normal",
  };
}

export function sessionContextTokens(events: readonly SettingsEvent[]) {
  const runs = new Set<string>();
  let used = 0;
  for (const { runId, type, payload } of events) {
    if (type === "run.status") runs.add(runId);
    if (!runs.has(runId) || !payload || typeof payload !== "object") continue;
    const count =
      type === "run.usage" && "context_tokens" in payload
        ? payload.context_tokens
        : type === "model.usage" && "input_tokens" in payload
          ? payload.input_tokens
          : undefined;
    if (typeof count === "number" && Number.isFinite(count) && count > 0) used = count;
  }
  return used;
}
