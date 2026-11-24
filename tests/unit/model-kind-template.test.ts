import {
  configuredGenerationInput,
  type ModelConfig,
  type ModelKind,
  mediaGenerationOptions,
  modelGenerationOptions,
  priceDimensions,
  pricingIssues,
  validModelCapabilities,
} from "@link-studio/core";
import { expect, it } from "vitest";
import { modelCapabilities } from "../../packages/link-studio-core/src/model-document";
import {
  applyKindTemplate,
  rebindTemplate,
  restoreKindTemplate,
} from "../../src/renderer/settings/model-kind-template";

const base: ModelConfig = { kind: "text", name: "样例", description: "", sort: 100 };
const imageRatios = ["Auto", "1:1", "16:9", "9:16", "4:3", "3:4"];
it.each(["gpt-image-1", "gpt-image-2", "chatgpt-image-latest"])(
  "%s 图片模板精确匹配原版三项生成参数",
  (model) => {
    const config = applyKindTemplate(base, "image", false, { adapter: "openai-image", model });
    expect(config.params?.aspectRatio).toMatchObject({ values: imageRatios, default: "1:1" });
    expect(config.params?.resolution).toMatchObject({
      values: ["1K", "2K", "4K"],
      default: "1K",
      label: "清晰度",
      spec: true,
    });
    expect(config.params?.count).toMatchObject({ values: ["1", "2", "4"], default: "1" });
    expect(Object.keys(config.params ?? {}).sort()).toEqual(["aspectRatio", "count", "resolution"]);
    expect(validModelCapabilities(config, "openai-image", model)).toBe(true);
    expect(modelGenerationOptions("image", "openai-image", model, {}, config).resolutions).toEqual([
      "1K",
      "2K",
      "4K",
    ]);
    expect(modelGenerationOptions("image", "openai-image", model, {}, config).ratios).toEqual(
      imageRatios,
    );
  },
);
it("图片协议默认能力恢复后提供完整原生参数", () => {
  const restored = restoreKindTemplate(
    { ...base, kind: "image" },
    { adapter: "openai-image", model: "gpt-image-1" },
  );
  const options = modelGenerationOptions("image", "openai-image", "gpt-image-1", {}, restored);
  expect(options.ratios).toEqual(imageRatios);
  expect(restored.params?.resolution).toMatchObject({
    values: ["1K", "2K", "4K"],
    default: "1K",
  });
  expect(restored.params?.size).toBeUndefined();
  expect(restored.params?.quality).toBeUndefined();
  expect(options.counts).toEqual([1, 2, 4]);
});
it("OpenAI 图片与 OpenAI 兼容对话生图遵循原项目通用图片能力模板", () => {
  const image = applyKindTemplate(base, "image", false, {
    adapter: "openai-image",
    model: "dall-e-3",
  });
  const chatImage = applyKindTemplate(base, "image", false, {
    adapter: "openai-chat-image",
    model: "dall-e-3",
  });
  const imageOptions = modelGenerationOptions("image", "openai-image", "dall-e-3", {}, image);
  const chatImageOptions = modelGenerationOptions(
    "image",
    "openai-chat-image",
    "dall-e-3",
    {},
    chatImage,
  );

  expect(image).toMatchObject({
    modes: ["t2i", "i2i"],
    refs: { image: { max: 4, mb: 10 } },
    params: chatImage.params,
  });
  expect(chatImage).toMatchObject({ modes: image.modes, refs: image.refs });
  expect(imageOptions).toMatchObject({
    ratios: chatImageOptions.ratios,
    resolutions: chatImageOptions.resolutions,
    counts: chatImageOptions.counts,
    modes: chatImageOptions.modes,
    references: chatImageOptions.references,
    referenceLimit: chatImageOptions.referenceLimit,
    hiddenParameters: chatImageOptions.hiddenParameters,
    defaultParameters: chatImageOptions.defaultParameters,
  });
  expect(imageOptions.ratios).toEqual(imageRatios);
  expect(validModelCapabilities(image, "openai-image", "dall-e-3")).toBe(true);
});
it.each([
  ["image", "openai-image", "gpt-image-1"],
  ["video", "sora", "sora-2"],
] as const)("%s 模型选项实时提供已配置的画布参数顺序", (kind, adapter, model) => {
  const config = applyKindTemplate(base, kind, false, { adapter, model });
  const order = (Object.keys(config.params ?? {}) as (keyof NonNullable<ModelConfig["params"]>)[])
    .reverse()
    .map(String);
  config.parameterOrder = order;

  expect(modelGenerationOptions(kind, adapter, model, {}, config).parameterOrder).toEqual(order);
  expect(Object.keys(modelCapabilities(config).params ?? {})).toEqual(
    order.map(
      (key) => ({ aspectRatio: "aspect_ratio", generateAudio: "generate_audio" })[key] ?? key,
    ),
  );
});
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
it.each([
  ["hailuo", "MiniMax-H3", ["768P", "2K"]],
  ["vidu", "viduq2", ["720P", "1080P", "360P", "540P"]],
  ["sora", "sora-2", ["720P"]],
  ["sora", "sora-2-pro", ["720P", "1080P"]],
  ["kling", "sample", []],
] as const)("%s / %s 模板包含协议支持的全部清晰度", (adapter, model, complete) => {
  const config = applyKindTemplate(base, "video", false, { adapter, model });
  expect(config.params?.resolution?.values ?? []).toEqual(complete);
  expect(configuredGenerationInput(config, {}).resolution).toBe(complete[0]);
  expect(validModelCapabilities(config, adapter, model)).toBe(true);
  expect(pricingIssues(config, priceDimensions(config, adapter, model))).toEqual([]);
});
it.each([
  ["image", "openai-image", "gpt-image-1"],
  ["video", "vidu", "viduq2"],
] as const)("%s 恢复协议默认能力和完整参数", (kind, adapter, model) => {
  const previous: ModelConfig = {
    ...base,
    kind,
    parameterOrder: ["custom", "count"],
    customParams: {
      custom: { type: "enum", values: ["x", "y"], default: "x", label: "自定义" },
    },
    params: {
      count: { values: ["1"], default: "1" },
    },
    pricing: {
      unit: "request",
      input: 2,
      tiers: [{ on: true, unit: 9, when: { resolution: "1080P" } }],
    },
  };
  const restored = restoreKindTemplate(previous, { adapter, model });
  expect(restored).toMatchObject({
    kind,
    params: { count: { values: ["1", "2", "4"] } },
    customParams: undefined,
    parameterOrder: undefined,
    pricing: previous.pricing,
  });
  if (kind === "video")
    expect(restored.params?.resolution?.values?.map((value) => value.toUpperCase()).sort()).toEqual(
      mediaGenerationOptions(kind, adapter, model)
        .resolutions.map((value) => value.toUpperCase())
        .sort(),
    );
});
it.each(samples)("%s 模板符合 %s / %s 的宿主能力及报价约束", (kind, adapter, model) => {
  const config = applyKindTemplate(base, kind, false, { adapter, model });
  expect(validModelCapabilities(config, adapter, model)).toBe(true);
  expect(pricingIssues(config, priceDimensions(config, adapter, model))).toEqual([]);
});
it.each(samples.filter(([kind]) => kind === "image" || kind === "video"))(
  "%s 的 %s 数量选项保留配置顺序并使用固定默认值",
  (kind, adapter, model) => {
    const config = applyKindTemplate(base, kind, false, { adapter, model });
    config.params = {
      ...config.params,
      count: { values: ["4", "1", "3"], default: "3", open: false, fanout: true },
    };
    const options = modelGenerationOptions(kind, adapter, model, {}, config);
    expect(options.counts).toEqual([4, 1, 3]);
    expect(options.hiddenParameters).toContain("count");
    expect(configuredGenerationInput(config, { count: 4 }).count).toBe(3);
  },
);
it.each([
  [true, false],
  [false, true],
])("时长开放为 %s、范围开放为 %s 时使用固定时长", (open, rangeOpen) => {
  const adapter = "doubao-video",
    model = "doubao-seedance-2-0";
  const config = applyKindTemplate(base, "video", false, { adapter, model });
  const field = config.params!.duration!;
  field.open = open;
  field.range!.open = rangeOpen;
  const options = modelGenerationOptions("video", adapter, model, {}, config);
  expect(options.durationControl).toBe(false);
  expect(options.hiddenParameters).toContain("duration");
  expect(configuredGenerationInput(config, { duration: 9 }).duration).toBe(Number(field.default));
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
