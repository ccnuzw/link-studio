import {
  type ModelConfig,
  type ModelKind,
  priceDimensions,
  pricingIssues,
  validModelCapabilities,
} from "@link-studio/core";
import { expect, it } from "vitest";
import { applyKindTemplate, rebindTemplate } from "../../src/renderer/settings/model-kind-template";

const base: ModelConfig = { kind: "text", name: "样例", description: "", sort: 100 };
const samples: [ModelKind, string, string][] = [
  ["image", "openai-image", "dall-e-3"],
  ["image", "alibaba-image", "wan2.6-image"],
  ["image", "doubao-image", "seedream-4-0"],
  ["video", "doubao-video", "doubao-seedance-2-0"],
  ["video", "sora", "sora-2"],
  ["video", "xai", "grok-imagine-video"],
  ["audio", "doubao-audio", "speech"],
  ["video", "incho", "sample"],
  ["video", "alibaba-video", "wan2.2-kf2v-flash"],
];
it.each(samples)("%s 模板符合 %s / %s 的宿主能力及报价约束", (kind, adapter, model) => {
  const config = applyKindTemplate(base, kind, false, { adapter, model });
  expect(validModelCapabilities(config, adapter, model)).toBe(true);
  expect(pricingIssues(config, priceDimensions(config, adapter, model))).toEqual([]);
});
it("支持的音频和清晰度规格维持原版价格、排序和默认时长", () => {
  const config = applyKindTemplate(base, "video", false, {
    adapter: "doubao-video",
    model: "doubao-seedance-2-0",
  });
  expect(config.pricing).toEqual({
    unit: "second",
    input: 2,
    tiers: [
      { on: true, when: { generate_audio: true }, unit: 3 },
      { on: true, when: { resolution: "1080P" }, unit: 4 },
      { on: true, when: { resolution: "1080P", generate_audio: true }, unit: 5 },
      { on: true, when: { resolution: "4K" }, unit: 8 },
    ],
  });
  expect(config.params?.count).toMatchObject({
    fanout: true,
    values: ["1", "2", "4"],
    default: "1",
  });
  expect(config.params?.duration?.range).toMatchObject({ min: 5, max: 10, step: 1 });
  expect(config.refs).toEqual({
    image: { max: 4, mb: 10 },
    audio: { max: 1, mb: 15 },
    video: { max: 1, mb: 100 },
  });
});
it("更换协议不删除自定义参数、手填价格或已编辑的时限", () => {
  const previous = { adapter: "openai-image", model: "dall-e-3" },
    next = { adapter: "doubao-image", model: "seedream-4-0" };
  const config = applyKindTemplate(base, "image", false, previous);
  config.timeoutSeconds = 45;
  config.pricing = { unit: "request", input: 19 };
  config.customParams = { lock: { type: "boolean", label: "锁定", default: true } };
  const rebound = rebindTemplate(config, previous, next);
  expect(rebound).toMatchObject({
    pricing: config.pricing,
    timeoutSeconds: 45,
    customParams: config.customParams,
    params: { resolution: { values: ["1K", "2K", "4K"] } },
  });
  const changed = applyKindTemplate(rebound, "agent", true);
  expect(changed).toMatchObject({
    agentDeadlineSeconds: 45,
    pricing: config.pricing,
    vision: true,
  });
  expect(changed.customParams).toBeUndefined();
});
