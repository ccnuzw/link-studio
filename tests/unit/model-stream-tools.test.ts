import { expect, it } from "vitest";
import { cleanModelStream } from "../../src/main/settings/stream";

const secret = "sk-test-credential";
const redactor = {
  secrets: [secret],
  redact: (text: string) => text.replaceAll(secret, "[已移除]"),
};
const frame = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}`;

it("保留完整工具名称，交错返回的工具名称与参数分别脱敏", () => {
  const clean = cleanModelStream(redactor, false, undefined, new Set(["canvas_apply_ops"]));
  const first = clean(
    frame({
      tool_calls: [
        { index: 0, function: { name: "canvas_apply_ops", arguments: "" } },
        { index: 1, function: { name: "sk-test-", arguments: "{" } },
      ],
    }),
  );
  expect(first).not.toContain("sk-test-");
  const second = clean(
    frame({
      tool_calls: [
        { index: 1, function: { name: "credential", arguments: "{}" } },
        { index: 0, function: { arguments: '{"prompt":"sk-test-' } },
      ],
    }),
  );
  const calls = JSON.parse(second.slice(6)).choices[0].delta.tool_calls;
  expect(calls[0].function.name).toBeUndefined();
  expect(calls[1].function).toEqual({ name: "canvas_apply_ops", arguments: '{"prompt":"' });
  expect(
    clean(frame({ tool_calls: [{ index: 0, function: { arguments: 'credential"}' } }] })),
  ).toContain("[凭证已移除]");
  expect(clean(frame({}, "tool_calls"))).toContain('"name":"[已移除]"');
});

it.each([frame({}, "tool_calls"), "data: [DONE]"])("无参数工具在结束帧发出完整名称", (end) => {
  const clean = cleanModelStream(redactor);
  clean(frame({ tool_calls: [{ index: 0, function: { name: "canvas_apply_" } }] }));
  clean(frame({ tool_calls: [{ index: 0, function: { name: "ops" } }] }));
  expect(clean(end)).toContain('"name":"canvas_apply_ops"');
});
