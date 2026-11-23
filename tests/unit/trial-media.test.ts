import { maximumModelPromptLength } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import { expect, it, vi } from "vitest";
import { settingsRequests } from "../../packages/link-studio-core/src/settings-api";
import { providerPollDelay } from "../../src/main/settings/provider-poll";
import {
  inlineTrialImage,
  TrialMediaStore,
  trialOutputMime,
} from "../../src/main/settings/trial-media";

it("试跑 IPC 可承载一个模型上限的双码元字符，也拒绝大于传输上限的输入", () => {
  const trial = {
    id: "model",
    expectedRevision: 1,
    dry: true,
    params: {},
    prompt: "🎵".repeat(maximumModelPromptLength),
  };
  expect(Value.Check(settingsRequests.modelTrial, trial)).toBe(true);
  expect(Value.Check(settingsRequests.modelTrial, { ...trial, prompt: trial.prompt + "A" })).toBe(
    false,
  );
});

it("从内联图片字节识别格式，并按模型种类限制二进制预览", async () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const preview = inlineTrialImage(gif.toString("base64").replace(/.{16}/g, "$&\r\n"));
  expect(preview.type).toBe("image/gif");
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(gif);
  expect(() => inlineTrialImage("bm90LWltYWdl")).toThrow("JOB_OUTPUT_INVALID");
  expect(trialOutputMime("audio", "audio/x-m4a")).toBe("audio/mp4");
  expect(trialOutputMime("video", "binary/octet-stream", "video/webm")).toBe("video/webm");
  expect(() => trialOutputMime("image", "image/svg+xml")).toThrow("JOB_OUTPUT_INVALID");
  expect(() => trialOutputMime("video", "audio/wav")).toThrow("JOB_OUTPUT_INVALID");
});

it("分段读取试跑产物，授权随窗口关闭或到期回收", async () => {
  vi.useFakeTimers();
  try {
    const previews = new TrialMediaStore();
    const sample = new Blob(["0123456789"], { type: "audio/wav" });
    const url = previews.grant(1, sample);
    expect(previews.serve(2, new Request(url)).status).toBe(404);
    const part = previews.serve(1, new Request(url, { headers: { range: "bytes=4-6" } }));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 4-6/10");
    expect(await part.text()).toBe("456");
    expect(previews.serve(1, new Request(url, { headers: { range: "bytes=10-" } })).status).toBe(
      416,
    );
    const second = previews.grant(2, sample);
    previews.close(1);
    expect(previews.serve(1, new Request(url)).status).toBe(404);
    expect(previews.serve(2, new Request(second)).status).toBe(200);
    vi.advanceTimersByTime(900000);
    expect(previews.serve(2, new Request(second)).status).toBe(404);
  } finally {
    vi.useRealTimers();
  }
});

it("异步协议的首次查询、指数退避、封顶和抖动", () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  try {
    const policy = { firstDelay: 3, interval: 2, maxInterval: 7, jitter: 0.25 };
    expect(providerPollDelay(policy, true, 0)).toBe(3000);
    expect([1, 2, 3, 4].map((attempt) => providerPollDelay(policy, false, attempt))).toEqual([
      2000, 4000, 7000, 7000,
    ]);
    random.mockReturnValue(0);
    expect(providerPollDelay(policy, false, 1)).toBe(1500);
  } finally {
    random.mockRestore();
  }
});
