import { expect, it, vi } from "vitest";
import { type GatewayRecord, gatewayDiagnostic } from "../../src/main/settings/gateway-diagnostic";

const attempt = {
  call_id: "fixture",
  net_attempt: 1,
  channel: "test",
  upstream_model: "test",
  format: "responses",
  request_bytes: 200,
  purpose: "agent" as const,
};

it("只统计文本码点和用量，不把工具参数、正文或上游错误写入诊断", () => {
  const observe = vi.fn<(record: GatewayRecord) => void>();
  const diagnostic = gatewayDiagnostic(attempt, observe);
  diagnostic.status(200);
  diagnostic.frame({ type: "response.output_text.delta", delta: "文字🌷" });
  diagnostic.frame({ type: "response.function_call_arguments.delta", delta: "private-argument" });
  diagnostic.frame({
    type: "response.completed",
    response: {
      usage: { input_tokens: 12, output_tokens: 6, input_tokens_details: { cached_tokens: 4 } },
    },
  });
  const signal = new AbortController().signal;
  diagnostic.finish(signal, "end");
  diagnostic.finish(signal, "close");
  expect(observe).toHaveBeenCalledTimes(1);
  expect(observe.mock.calls[0]?.[0]).toMatchObject({
    response_chars: 3,
    finish_reason: "stop",
    result: "ok",
    input_tokens: 12,
    output_tokens: 6,
    cached_tokens: 4,
    usage_missing: false,
  });
  expect(JSON.stringify(observe.mock.calls)).not.toMatch(/文字|private-argument/);
  const failure = gatewayDiagnostic(attempt, observe);
  failure.status(200);
  failure.frame({ error: { message: "private-error" } });
  failure.finish(signal, "done");
  expect(observe.mock.calls[1]?.[0]).toMatchObject({
    result: "failed",
    error_type: "upstream",
    ttft_ms: null,
  });
  expect(JSON.stringify(observe.mock.calls)).not.toContain("private-error");
});
