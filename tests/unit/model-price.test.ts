import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { validModelCapabilities } from "../../packages/link-studio-core/src/media-generation";
import { type ModelConfig, modelFanout } from "../../packages/link-studio-core/src/model-config";
import {
  decodeModelBody,
  encodeModelBody,
} from "../../packages/link-studio-core/src/model-document";
import {
  defaultPriceSpec,
  type ModelPricing,
  priceDimensions,
  pricingIssues,
  publicModelPricing,
  type QuoteSpec,
  quoteModel,
} from "../../packages/link-studio-core/src/model-price";

const vectors: { name: string; pricing: ModelPricing; spec: QuoteSpec; one: number }[] = JSON.parse(
  readFileSync("tests/fixtures/provider-price-vectors.json", "utf8"),
);
it.each(vectors)("$name", ({ pricing, spec, one }) => expect(quoteModel(pricing, spec)).toBe(one));
it("预览补全已声明的固定参数默认值，移除参数后旧条件自然失配", () => {
  const config: ModelConfig = {
    kind: "video",
    name: "样例",
    description: "",
    sort: 0,
    modes: ["t2v"],
    params: { aspectRatio: { values: ["16:9"], default: "16:9", open: false, spec: false } },
    generateAudio: { default: false, open: false, spec: false },
    parameterOrder: ["aspectRatio", "generateAudio"],
  };
  const price: ModelPricing = {
    unit: "request",
    input: 2,
    tiers: [{ on: true, unit: 7, when: { aspectRatio: "16:9", generate_audio: false } }],
  };
  expect(priceDimensions(config)).toEqual([]);
  expect(defaultPriceSpec(config)).toMatchObject({
    params: { aspectRatio: "16:9", generate_audio: false },
    op: "t2v",
    refVideo: false,
  });
  expect(quoteModel(price, defaultPriceSpec(config))).toBe(7);
  expect(
    quoteModel(price, defaultPriceSpec({ ...config, parameterOrder: ["generateAudio"] })),
  ).toBe(2);
});
it("仅 fanout 枚举可拆分，按单任务报价乘模型选择的数量", () => {
  const field = { type: "enum", label: "份数", values: [1, 3], default: 1, fanout: true } as const;
  const config: ModelConfig = {
    kind: "image",
    name: "图片",
    description: "",
    sort: 1,
    customParams: { copies: { ...field, values: [1, 3] } },
  };
  const params = { copies: 3, count: 2 };
  expect(
    quoteModel({ unit: "request", input: 7 }, { params }, modelFanout(config, params).count),
  ).toBe(21);
  expect(quoteModel({ unit: "request", input: 0, pending: true }, { params })).toBeUndefined();
  expect(modelFanout(undefined, params).count).toBe(1);
  const valid = (config: ModelConfig) =>
    validModelCapabilities(config, "openai-image", "gpt-image-1");
  expect(valid(config)).toBe(true);
  expect(
    valid({ ...config, params: { count: { values: ["1"], default: "1", fanout: true } } }),
  ).toBe(false);
  for (const invalid of [0, 1.5, 9])
    expect(valid({ ...config, customParams: { copies: { ...field, values: [1, invalid] } } })).toBe(
      false,
    );
});
it("默认价、Token 双侧价和成本遵守原版积分边界", () => {
  const check = (pricing: ModelPricing) =>
    pricingIssues({ kind: "text", name: "测试", description: "", sort: 0, pricing }, []);
  expect(check({ unit: "token", input: 0, output: 1_000_000 })).toEqual([]);
  expect(check({ unit: "token", input: 10, cost: {} })).toEqual([
    { field: "pricing", text: "按 Token 计费的成本需要输入价与输出价" },
  ]);
  for (const cost of [{ input: 0 }, { output: 0 }, { input: 0, output: 0 }])
    expect(check({ unit: "token", input: 10, cost })).toEqual([]);
  for (const pricing of [
    { unit: "request", input: 0 },
    { unit: "request", input: 1.5 },
    { unit: "request", input: 1_000_001 },
    { unit: "token", input: 0, output: 0 },
    { unit: "token", input: 1, tiers: [{ on: true, unit: 1, when: {} }] },
    { unit: "request", input: 1, cost: { input: -1 } },
  ] satisfies ModelPricing[])
    expect(check(pricing).length).toBeGreaterThan(0);
});
it("对外报价不包含模型和规格成本", () => {
  const price: ModelPricing = {
    unit: "second",
    input: 3,
    cost: { input: 2 },
    tiers: [{ on: true, when: { op: "t2v" }, unit: 5, cost: { input: 4 } }],
  };
  expect(publicModelPricing(price)).toEqual({
    unit: "second",
    input: 3,
    tiers: [{ on: true, when: { op: "t2v" }, unit: 5 }],
  });
});

it("Token 成本可以留空或为零，与冻结价和创作端输出隔离", () => {
  const price: ModelPricing = { unit: "token", input: 2000, output: 3000 };
  for (const cost of [{}, { input: 0, output: 0 }, { input: 3000, output: 1500 }]) {
    expect(publicModelPricing({ ...price, cost })).toEqual(price);
    expect(
      quoteModel({ ...price, cost }, { params: {}, promptChars: 1000, outputTokens: 8192 }),
    ).toBe(27);
  }
});

it("规格按声明顺序，包括固定维度；不借协议补全已移除参数、唯一生成方式或参考视频", () => {
  const config: ModelConfig = {
    kind: "video",
    name: "视频",
    sort: 0,
    description: "",
    modes: ["t2v"],
    params: {
      duration: { values: ["5", "8"], default: "5", spec: true, unit: "秒" },
      quality: { values: ["hd"], default: "hd" },
    },
    generateAudio: { default: true, spec: true, open: false },
    parameterOrder: ["generateAudio", "duration"],
  };
  const dims = priceDimensions(config);
  expect(dims.map((field) => field.key)).toEqual(["generate_audio", "duration"]);
  expect(dims[1]).toMatchObject({ initial: 5, values: [5, 8], unit: "秒" });
  expect(
    priceDimensions({ ...config, modes: ["i2v", "t2v"], refs: { video: { max: 1, mb: 1 } } })
      .slice(2)
      .map((field) => field.key),
  ).toEqual(["op", "ref_video"]);
  expect(
    pricingIssues(
      {
        ...config,
        pricing: { unit: "request", input: 2, tiers: [{ on: true, unit: 4, when: { op: "t2v" } }] },
      },
      dims,
    ),
  ).toEqual([]);
  for (const when of [{ op: "i2v" }, { ref_video: false }, { quality: "hd" }] as Record<
    string,
    string | boolean
  >[]) {
    expect(
      pricingIssues(
        { ...config, pricing: { unit: "request", input: 2, tiers: [{ on: true, unit: 4, when }] } },
        dims,
      )[0]?.field,
    ).toBe("tier-0");
  }
});

it("仅旧桌面规则继承协议生成方式，导入正文缺 ops 时不接受该价格条件", () => {
  const legacy: ModelConfig = {
    kind: "image",
    name: "图片",
    sort: 0,
    description: "",
    pricing: { unit: "request", input: 8, tiers: [{ on: true, when: { op: "i2i" }, unit: 12 }] },
  };
  const dims = (model: ModelConfig) => priceDimensions(model, "openai-image", "gpt-image-1");
  expect(dims(legacy).find((field) => field.key === "op")?.values).toEqual(["t2i", "i2i"]);
  expect(pricingIssues(legacy, dims(legacy))).toEqual([]);
  const encoded = encodeModelBody({
    config: legacy,
    key: "",
    enabled: false,
    kindSelected: true,
    channel: "test",
    upstream: "gpt-image-1",
    settings: {},
  });
  const imported = decodeModelBody(encoded, []).config;
  expect(dims(imported)).toEqual([]);
  expect(pricingIssues(imported, dims(imported))[0]?.field).toBe("tier-0");
});

it("JSON 保存的成本开关区分关闭、已打开未填和显式零，不把空输入写成零售价", () => {
  for (const cost of [undefined, { on: true }, { on: true, token: { in: 0, out: 0 } }]) {
    const pricing = { billing: "token", pending: true, ...(cost && { cost }) };
    const { config } = decodeModelBody(
      {
        kind: "text",
        label: "文本",
        sort: 0,
        enabled: false,
        channels: [{ channel: "test", upstream_model: "sample" }],
        pricing,
      },
      [],
    );
    expect(
      encodeModelBody({
        config,
        kindSelected: true,
        enabled: false,
        channel: "test",
        upstream: "sample",
        settings: {},
      }).pricing,
    ).toEqual(pricing);
  }
});

it("按秒计价只接受实际声明且未移除的数字时长，不把枚举或协议推导当作数字", () => {
  const model: ModelConfig = {
    kind: "video",
    sort: 0,
    name: "视频",
    description: "",
    pricing: { unit: "second", input: 2 },
  };
  const dimensions = [{ key: "duration", label: "时长", values: [5, 7], initial: 5 }];
  const duration = { values: ["5", "7"], default: "5" };
  const check = (config: ModelConfig) =>
    pricingIssues(config, dimensions).map((issue) => issue.field);
  expect(check(model)).toEqual(["pricing"]);
  expect(check({ ...model, params: { duration } })).toEqual(["pricing"]);
  const numeric = {
    ...model,
    params: { duration: { ...duration, range: { min: 5, max: 7, step: 2, open: true } } },
  };
  expect(check(numeric)).toEqual([]);
  expect(check({ ...numeric, parameterOrder: [] })).toEqual(["pricing"]);
});
