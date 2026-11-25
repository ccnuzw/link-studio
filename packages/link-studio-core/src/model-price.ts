import { mediaGenerationOptions, modelGenerationModes } from "./media-generation.ts";
import { includesModelParameter, type ModelConfig } from "./model-config.ts";
import { modelCapabilities, paramKey, wireParamName } from "./model-document.ts";

export type ModelPricing = NonNullable<ModelConfig["pricing"]>;
export type PriceTier = NonNullable<ModelPricing["tiers"]>[number];
export type PriceDimension = {
  key: string;
  label: string;
  values: readonly (string | number | boolean)[];
  initial: string | number | boolean;
  unit?: string;
};

export function priceDimensions(
  config: ModelConfig,
  adapter?: string,
  model = "",
  settings?: Record<string, unknown>,
) {
  const caps = modelCapabilities(config);
  const dimensions: PriceDimension[] = [];
  for (const [name, field] of Object.entries(caps.params ?? {})) {
    if (field.type === "number" || !field.spec) continue;
    const key = paramKey(name) ?? name;
    dimensions.push({
      key,
      label: field.label || name,
      initial: field.default,
      values: field.type === "boolean" ? [true, false] : field.options,
      ...(field.type === "enum" && { unit: field.unit }),
    });
  }
  const inheritedOp =
    !config.parameterOrder && config.pricing?.tiers?.some((tier) => Object.hasOwn(tier.when, "op"));
  const modes =
    config.modes ??
    (inheritedOp
      ? modelGenerationModes(
          config.kind,
          mediaGenerationOptions(config.kind, adapter, model, settings),
        )
      : []);
  const [initialMode, anotherMode] = modes;
  if (initialMode !== undefined && anotherMode !== undefined)
    dimensions.push({ key: "op", label: "生成方式", values: modes, initial: initialMode });
  if (caps.refs?.video?.on)
    dimensions.push({
      key: "ref_video",
      label: "参考素材里有视频",
      values: [true, false],
      initial: false,
    });
  return dimensions;
}

export function boundPricingIssues(
  config: ModelConfig | undefined,
  adapter?: string,
  model = "",
  settings?: Record<string, unknown>,
) {
  return config?.pricing
    ? pricingIssues(config, priceDimensions(config, adapter, model, settings))
    : [];
}

export function hasNumericDuration(config: ModelConfig) {
  return includesModelParameter(config, "duration") && Boolean(config.params?.duration?.range);
}

export function stalePriceCondition(
  key: string,
  value: PriceDimension["initial"],
  dimensions: PriceDimension[],
) {
  const dimension = dimensions.find((item) => item.key === key);
  if (!dimension) return `条件里的「${wireParamName(key)}」已不能作为规格维度`;
  if (
    !dimension.values.some((option) =>
      typeof option === "boolean" ? option === value : String(option) === String(value),
    )
  )
    return `条件里的 ${value} 已不可选`;
}

export function pricingIssues(config: ModelConfig, dimensions: PriceDimension[]) {
  const issues: { field: string; text: string }[] = [];
  const price = config.pricing;
  if (!price) return issues;
  const credits = (value: number | undefined) =>
    value === undefined || (Number.isInteger(value) && value >= 0 && value <= 1000000);
  const checkNumbers = (field: string, values: (number | undefined)[]) => {
    if (!values.every(credits))
      issues.push({ field, text: "价格和成本必须是 0 至 100 万的整数积分" });
  };
  checkNumbers("pricing", [price.input, price.output, price.cost?.input, price.cost?.output]);
  if (price.pending && (price.input !== 0 || price.output !== undefined || price.tiers?.length))
    issues.push({ field: "pricing", text: "售价待确认时不能填写占位售价或规格价格" });
  if (price.unit === "token") {
    if (price.cost && price.cost.input === undefined && price.cost.output === undefined)
      issues.push({ field: "pricing", text: "按 Token 计费的成本需要输入价与输出价" });
    if (!price.pending && !price.input && !price.output)
      issues.push({ field: "pricing", text: "输入价与输出价不能都为 0" });
    if (price.tiers?.length) issues.push({ field: "pricing", text: "按 Token 计费不支持规格价格" });
  } else if (!price.pending && price.input === 0)
    issues.push({ field: "pricing", text: "默认价格必须大于 0 积分" });
  if (config.kind === "agent" && price.unit !== "token")
    issues.push({ field: "pricing", text: "Agent 模型只能按 Token 计费" });
  if (price.unit === "token" && !["text", "agent"].includes(config.kind))
    issues.push({ field: "pricing", text: "只有文本、Agent 模型按 Token 计费" });
  if (price.unit === "second" && !hasNumericDuration(config))
    issues.push({ field: "pricing", text: "按秒计费需要一个名为 duration 的数字参数（视频时长）" });
  if (price.unit !== "token")
    (price.tiers ?? []).forEach((tier, index) => {
      checkNumbers(`tier-${index}`, [tier.unit, tier.cost?.input, tier.cost?.output]);
      for (const [key, value] of Object.entries(tier.when)) {
        if (key === "op" && config.modes?.some((mode) => mode === value)) continue;
        const problem = stalePriceCondition(key, value, dimensions);
        if (!problem) continue;
        issues.push({
          field: `tier-${index}`,
          text: `第 ${index + 1} 条规格价格：${problem}，请调整或删除`,
        });
        break;
      }
    });
  return issues;
}
export type QuoteSpec = {
  op?: string;
  refVideo?: boolean;
  params: Record<string, unknown>;
  promptChars?: number;
  outputTokens?: number;
};

export function defaultPriceSpec(config: ModelConfig): QuoteSpec {
  const caps = modelCapabilities(config);
  const defaults = Object.entries(caps.params ?? {}).map(([name, field]) => [
    paramKey(name) ?? name,
    field.default,
  ]);
  return {
    params: Object.fromEntries(defaults),
    op: caps.ops?.[0],
    refVideo: false,
    promptChars: 0,
  };
}

export function tokenCredits(inputRate: number, outputRate: number, input: number, output: number) {
  return Math.max(1, Math.ceil((inputRate * input + outputRate * output) / 1000000));
}

export function matchPriceTier(pricing: ModelPricing, spec: QuoteSpec) {
  let matches = -1;
  let matched: PriceTier | undefined;
  for (const tier of pricing.tiers ?? []) {
    const conditions = Object.entries(tier.when);
    if (!tier.on || conditions.length <= matches) continue;
    if (
      !conditions.every(([key, expected]) => {
        const actual =
          key === "op"
            ? spec.op
            : key === "ref_video"
              ? !!spec.refVideo
              : key === "generate_audio"
                ? (spec.params.generate_audio ?? spec.params.generateAudio)
                : spec.params[key];
        return typeof expected === "boolean"
          ? actual === expected
          : actual != null && String(actual) === String(expected);
      })
    )
      continue;
    matches = conditions.length;
    matched = tier;
  }
  return matched;
}

export function quoteModel(pricing: ModelPricing, spec: QuoteSpec, quantity = 1) {
  if (pricing.pending) return undefined;
  if (pricing.unit === "token")
    return (
      quantity *
      tokenCredits(
        pricing.input,
        pricing.output ?? 0,
        spec.promptChars ?? 0,
        spec.outputTokens ?? 0,
      )
    );
  const rate = matchPriceTier(pricing, spec)?.unit ?? pricing.input;
  const duration = Number(spec.params.duration);
  return pricing.unit === "second"
    ? quantity * rate * (Number.isFinite(duration) ? Math.trunc(duration) : 0)
    : quantity * rate;
}

export function publicModelPricing(pricing: ModelPricing | undefined) {
  if (!pricing) return undefined;
  const { cost: _cost, tiers, ...base } = pricing;
  return { ...base, ...(tiers && { tiers: tiers.map(({ cost: _cost, ...tier }) => tier) }) };
}

export function modelPriceLabel(pricing?: ModelPricing) {
  if (!pricing) return "";
  if (pricing.pending) return "待定价";
  if (pricing.unit === "token") return "按 Token";
  const units = (pricing.tiers ?? []).filter((tier) => tier.on).map((tier) => tier.unit);
  const suffix = units.some((unit) => unit !== pricing.input) ? "起" : "";
  return `${Math.min(pricing.input, ...units)} ${pricing.unit === "second" ? "积分/秒" : "积分"}${suffix}`;
}
