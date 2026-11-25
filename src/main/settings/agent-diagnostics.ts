import { requirePresent } from "@link-studio/core";
import type { SettingsValues } from "../../../packages/link-studio-core/src/settings-api.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";

export const diagnosticWindowMs = 168 * 3600_000;

export function errorQuery(args: Record<string, unknown>) {
  const { hours = 24, limit = 5, model_key, channel_key, task_id } = args;
  if (
    Object.keys(args).some(
      (key) => !["hours", "limit", "model_key", "channel_key", "task_id"].includes(key),
    ) ||
    typeof hours !== "number" ||
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 168 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10 ||
    (model_key !== undefined && typeof model_key !== "string") ||
    (channel_key !== undefined && typeof channel_key !== "string") ||
    (task_id !== undefined && (typeof task_id !== "string" || !/^[\w.:-]{1,128}$/.test(task_id)))
  )
    throw new ProviderError("AGENT_ARGUMENT_INVALID");
  return {
    since: Date.now() - hours * 3600_000,
    limit,
    model: model_key || null,
    channel: channel_key || null,
    task: task_id ?? null,
  };
}

export function diagnosticSteps(
  trace: SettingsValues["modelTrial"]["trace"],
  redact: (text: string) => string,
) {
  return trace.slice(0, 20).map((step) => {
    let url: string | undefined;
    if (step.endpoint && URL.canParse(step.endpoint)) {
      const parsed = new URL(step.endpoint);
      if (["https:", "http:"].includes(parsed.protocol))
        url = redact(parsed.origin + parsed.pathname);
    }
    const excerpt = step.responseBody && Array.from(redact(step.responseBody.text));
    return {
      stage: step.phase,
      kind: step.kind,
      duration_ms: step.durationMs ?? 0,
      ...(step.hook && { hook: step.hook, ok: !step.error }),
      ...(step.method && { method: step.method }),
      ...(url && { url }),
      ...(step.status !== undefined && { http_status: step.status }),
      ...(excerpt && {
        response_excerpt: excerpt.slice(0, 1000).join(""),
        response_truncated:
          requirePresent(step.responseBody, "step.responseBody").truncated || excerpt.length > 1000,
      }),
      ...(step.error && { error: Array.from(redact(step.error)).slice(0, 300).join("") }),
    };
  });
}
