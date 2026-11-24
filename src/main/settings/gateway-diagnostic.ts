import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";

export type GatewayPurpose =
  | "agent"
  | "connection_test"
  | "model_trial"
  | "generation"
  | "video_inspect";
type Attempt = {
  call_id: string;
  net_attempt: number;
  purpose: GatewayPurpose;
  channel: string;
  upstream_model: string;
  format: string;
  request_bytes: number;
};
export type GatewayRecord = Attempt & {
  drama?: {
    step: string;
    model_revision: number;
    prompt_hash: string;
    prompt_chars: number;
    template: "builtin" | "snapshot";
    template_hash?: string;
  };
  event: "llm.call";
  started_at: number;
  latency_ms: number;
  ttft_ms: number | null;
  upstream_status: number | null;
  result: "ok" | "timeout" | "canceled" | "failed";
  error_type: "timeout" | "canceled" | "upstream" | "network" | null;
  response_chars: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  usage_missing: boolean;
  finish_reason: string | null;
};

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function gatewayDiagnostic(attempt: Attempt, observe: (record: GatewayRecord) => void) {
  const started = performance.now();
  const elapsed = () => Math.floor(performance.now() - started);
  const record: GatewayRecord = {
    ...attempt,
    event: "llm.call",
    started_at: Date.now(),
    latency_ms: 0,
    ttft_ms: null,
    upstream_status: null,
    result: "ok",
    error_type: null,
    response_chars: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    usage_missing: true,
    finish_reason: null,
  };
  let finished = false;
  let upstreamFailed = false;
  return {
    status(value: number | undefined) {
      record.upstream_status = value ?? null;
    },
    frame(data: unknown) {
      const chunk = object(data);
      const choice = object(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
      const delta = object(choice.delta);
      const response = object(chunk.response);
      const text = chunk.type === "response.output_text.delta" ? chunk.delta : delta.content;
      if (
        text ||
        delta.reasoning_content ||
        delta.reasoning ||
        delta.tool_calls ||
        chunk.usage ||
        typeof chunk.delta === "string"
      )
        record.ttft_ms ??= elapsed();
      if (typeof text === "string") for (const _char of text) record.response_chars++;
      if (chunk.error || chunk.type === "error" || chunk.type === "response.failed")
        upstreamFailed = true;
      if (chunk.type === "response.completed") record.finish_reason = "stop";
      if (chunk.type === "response.incomplete")
        record.finish_reason =
          object(response.incomplete_details).reason === "max_output_tokens" ? "length" : "other";
      if (typeof choice.finish_reason === "string" && choice.finish_reason)
        record.finish_reason = [
          "stop",
          "length",
          "tool_calls",
          "content_filter",
          "function_call",
        ].includes(choice.finish_reason)
          ? choice.finish_reason
          : "other";
      const supplied = chunk.usage ?? response.usage;
      if (supplied && typeof supplied === "object") {
        const usage = object(supplied);
        record.usage_missing = false;
        record.input_tokens = count(usage.prompt_tokens ?? usage.input_tokens);
        record.output_tokens = count(usage.completion_tokens ?? usage.output_tokens);
        record.cached_tokens = count(
          object(usage.prompt_tokens_details ?? usage.input_tokens_details).cached_tokens,
        );
      }
    },
    finish(signal: AbortSignal, outcome: "end" | "done" | "error" | "close", error?: unknown) {
      if (finished) return;
      finished = true;
      if (
        signal.aborted ||
        (error instanceof ProviderError && error.code === "AGENT_TEST_TIMEOUT")
      ) {
        const timeout =
          signal.reason?.name === "TimeoutError" ||
          signal.reason?.code === "AGENT_TEST_TIMEOUT" ||
          !signal.aborted;
        record.result = record.error_type = timeout ? "timeout" : "canceled";
      } else if (
        upstreamFailed ||
        outcome === "error" ||
        (outcome === "end" && !record.finish_reason)
      ) {
        record.result = "failed";
        record.error_type = record.upstream_status !== null ? "upstream" : "network";
      } else if (outcome === "close") record.result = record.error_type = "canceled";
      record.latency_ms = elapsed();
      try {
        observe(record);
      } catch {
        return;
      }
    },
  };
}
