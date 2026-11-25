import { type Static, Type } from "@sinclair/typebox";
import { ValueErrorType } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";
import { newestCatalogVersions } from "./catalog-version-order.ts";
import {
  ModelConfig,
  type ModelParameter,
  modelContextLimits,
  modelKinds,
  modelParameterLabels,
} from "./model-config.ts";
import { readDuration } from "./model-duration.ts";
import type { ModelPricing } from "./model-price.ts";
import { requirePresent } from "./require-present.ts";
import type { PluginView, ProviderFields } from "./settings-api.ts";

const strict = { additionalProperties: false };
const optional = Type.Optional;
const string = Type.String();
const bool = Type.Boolean();
const integer = Type.Integer();
const scalar = Type.Union([string, Type.Number(), bool]);
const credits = Type.Integer({ minimum: 0, maximum: 1_000_000 });
const token = Type.Object({ in: credits, out: credits }, strict);
const rates = { unit: optional(credits), per_second: optional(credits), token: optional(token) };
const cost = Type.Object({ on: bool, ...rates }, strict);
const tier = Type.Object(
  { on: bool, when: Type.Record(string, scalar), unit: credits, cost: optional(cost) },
  strict,
);
const parameter = Type.Object(
  {
    type: Type.Literal("enum"),
    label: optional(string),
    open: bool,
    options: Type.Array(Type.Union([string, Type.Number()])),
    default: Type.Union([string, Type.Number()]),
    spec: optional(bool),
    fanout: optional(bool),
    unit: optional(string),
  },
  strict,
);
const numberParameter = Type.Object(
  {
    type: Type.Literal("number"),
    label: optional(string),
    open: bool,
    min: integer,
    max: integer,
    step: optional(integer),
    default: integer,
    unit: optional(string),
  },
  strict,
);
const booleanParameter = Type.Object(
  {
    type: Type.Literal("boolean"),
    label: optional(string),
    open: bool,
    default: bool,
    spec: optional(bool),
  },
  strict,
);
const reference = Type.Object({ on: bool, max: integer, max_mb: integer }, strict);
const capabilities = Type.Object(
  {
    ops: ModelConfig.properties.modes,
    refs: optional(
      Type.Object(
        { image: optional(reference), video: optional(reference), audio: optional(reference) },
        strict,
      ),
    ),
    prompt: optional(Type.Object({ max_length: integer }, strict)),
    context: optional(
      Type.Object({ window: optional(integer), output: optional(integer) }, strict),
    ),
    system: optional(string),
    vision: optional(bool),
    video: optional(bool),
    prompt_format: ModelConfig.properties.promptFormat,
    params: optional(
      Type.Record(string, Type.Union([parameter, booleanParameter, numberParameter])),
    ),
  },
  strict,
);
const protocol = Type.Object(
  { plugin: string, version: optional(string), settings: optional(Type.Record(string, scalar)) },
  strict,
);
const bodySchema = Type.Object(
  {
    key: optional(string),
    kind: Type.Union([Type.Literal(""), ...modelKinds.map((kind) => Type.Literal(kind))]),
    label: string,
    hint: optional(string),
    enabled: optional(bool),
    sort: integer,
    vendor: optional(string),
    tags: ModelConfig.properties.tags,
    channels: Type.Array(
      Type.Object(
        {
          channel: string,
          upstream_model: string,
          protocol: optional(protocol),
          api_format: optional(Type.Union([Type.Literal("openai"), Type.Literal("gemini")])),
          path_prefix: optional(string),
          studio_api: optional(Type.Literal("responses")),
        },
        strict,
      ),
      { minItems: 1, maxItems: 1 },
    ),
    capabilities: optional(capabilities),
    deadline: optional(Type.Union([string, Type.Number()])),
    idle_timeout: optional(Type.Union([string, Type.Number()])),
    pricing: optional(
      Type.Object(
        {
          billing: Type.Union([
            Type.Literal("per_call"),
            Type.Literal("per_second"),
            Type.Literal("token"),
          ]),
          ...rates,
          pending: optional(bool),
          cost: optional(cost),
          tiers: optional(Type.Array(tier)),
        },
        strict,
      ),
    ),
  },
  strict,
);

export class DocumentIssue extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path || "模型配置"} · ${message}`);
  }
}
type Body = Static<typeof bodySchema>;
type Price = NonNullable<Body["pricing"]>;
export const paramNames: Record<ModelParameter, string> = {
  size: "size",
  aspectRatio: "aspect_ratio",
  resolution: "resolution",
  quality: "quality",
  duration: "duration",
  count: "count",
  audioFormat: "audio_format",
};
export function paramKey(key: string) {
  return (Object.keys(paramNames) as ModelParameter[]).find((name) => paramNames[name] === key);
}
export function wireParamName(key: string) {
  return Object.hasOwn(paramNames, key) ? paramNames[key as ModelParameter] : key;
}
function readPricing(price: Price): ModelPricing {
  if (price.pending && (price.unit || price.per_second || price.token || price.tiers?.length))
    throw new DocumentIssue("/pricing/pending", "售价待确认时不能填写占位售价或规格价格");
  const unit =
    price.billing === "per_second" ? "second" : price.billing === "token" ? "token" : "request";
  const amount = (entry: Pick<Price, "token" | "per_second" | "unit">) =>
    unit === "token"
      ? { input: entry.token?.in ?? 0, output: entry.token?.out ?? 0 }
      : { input: (unit === "second" ? entry.per_second : entry.unit) ?? 0 };
  const costAmount = (entry: NonNullable<Price["cost"]>) =>
    (unit === "token" ? entry.token : unit === "second" ? entry.per_second : entry.unit) ===
    undefined
      ? {}
      : amount(entry);
  return {
    unit,
    ...(price.pending ? { pending: true, input: 0 } : amount(price)),
    ...(price.cost?.on && { cost: costAmount(price.cost) }),
    ...(price.tiers && {
      tiers: price.tiers.map(({ when, cost, ...rule }) => ({
        ...rule,
        when: Object.fromEntries(
          Object.entries(when).map(([name, value]) => [paramKey(name) ?? name, value]),
        ),
        ...(cost?.on && { cost: costAmount(cost) }),
      })),
    }),
  };
}
function writePricing(price: ModelPricing): Price {
  const amount = (entry: { input?: number; output?: number }) =>
    entry.input === undefined && entry.output === undefined
      ? {}
      : price.unit === "token"
        ? { token: { in: entry.input ?? 0, out: entry.output ?? 0 } }
        : price.unit === "second"
          ? { per_second: entry.input }
          : { unit: entry.input };
  return {
    billing: price.unit === "token" ? "token" : price.unit === "second" ? "per_second" : "per_call",
    ...(price.pending ? { pending: true } : amount(price)),
    ...(price.cost && { cost: { on: true, ...amount(price.cost) } }),
    ...(price.tiers && {
      tiers: price.tiers.map(({ when, cost, ...rule }) => ({
        ...rule,
        when: Object.fromEntries(
          Object.entries(when).map(([key, value]) => [wireParamName(key), value]),
        ),
        ...(cost && { cost: { on: true, ...amount(cost) } }),
      })),
    }),
  };
}

export function modelContextIssue(
  config: Pick<ModelConfig, "kind" | "contextWindow" | "maxOutputTokens">,
) {
  if ((config.kind !== "text" && config.kind !== "agent") || config.maxOutputTokens === undefined)
    return;
  if (config.maxOutputTokens < modelContextLimits.minOutput)
    return `允许范围 ${modelContextLimits.minOutput} – ${modelContextLimits.output}`;
  if (config.contextWindow !== undefined && config.maxOutputTokens >= config.contextWindow)
    return "最大输出必须小于上下文窗口";
}

export function inspectOfflineBody(text: string) {
  if (text.length > 262144) throw new DocumentIssue("", "正文过长");
  const body: unknown = JSON.parse(text);
  const issues: { field: string; text: string }[] = [];
  const errors = [...Value.Errors(bodySchema, body)].flatMap((issue) => {
    if (issue.type === ValueErrorType.Union) {
      const match = issue.errors
        .map((branch) => [...branch])
        .find(
          (branch) =>
            branch.length &&
            branch.every((error) => error.type === ValueErrorType.ObjectAdditionalProperties),
        );
      if (match) return match;
    }
    return [issue];
  });
  for (const issue of errors) {
    if (issue.type !== ValueErrorType.ObjectAdditionalProperties)
      throw new DocumentIssue(issue.path, issue.message);
    const keys = issue.path
      .slice(1)
      .split("/")
      .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
    let parent = body as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) throw new DocumentIssue(issue.path, "字段路径无效");
      parent = parent[key] as Record<string, unknown>;
    }
    delete parent[requirePresent(keys.at(-1), "keys.at(-1)")];
    if (issue.path !== "/params") issues.push({ field: issue.path, text: "未知字段" });
  }
  if (!Value.Check(bodySchema, body)) throw new DocumentIssue("", "字段无效");
  if (body.kind) {
    const context = body.capabilities?.context;
    const text = modelContextIssue({
      kind: body.kind,
      contextWindow: context?.window,
      maxOutputTokens: context?.output,
    });
    if (text) issues.push({ field: "/capabilities/context/output", text });
  }
  return { body, issues };
}

export function decodeModelBody(raw: unknown, plugins: readonly PluginView[]) {
  if (!Value.Check(bodySchema, raw)) {
    const issue = Value.Errors(bodySchema, raw).First();
    throw new DocumentIssue(issue?.path ?? "", issue?.message ?? "字段无效");
  }
  const binding = requirePresent(raw.channels[0], "raw.channels[0]");
  const selected = binding.protocol;
  const candidates = selected
    ? newestCatalogVersions(
        plugins.filter((item) => item.key === selected.plugin && item.kind === raw.kind),
      )
    : [];
  const plugin = selected?.version
    ? candidates.find((item) => item.version === selected.version)
    : candidates[0];
  if (selected && !plugin)
    throw new DocumentIssue(
      `/channels/0/protocol/${candidates.length ? "version" : "plugin"}`,
      "未找到匹配该能力的插件版本",
    );
  if (
    raw.kind !== "agent" &&
    (binding.path_prefix !== undefined ||
      binding.api_format ||
      binding.studio_api ||
      raw.idle_timeout !== undefined)
  )
    throw new DocumentIssue("/channels/0", "网关设置仅用于 Agent 模型");
  const caps = raw.capabilities;
  if (binding.api_format === "gemini" && (binding.path_prefix !== undefined || binding.studio_api))
    throw new DocumentIssue("/channels/0/path_prefix", "Gemini 格式使用固定接口路径");
  const config: ModelConfig = {
    kind: raw.kind || "text",
    name: raw.label,
    description: raw.hint ?? "",
    sort: raw.sort,
  };
  if (raw.vendor) config.logo = raw.vendor;
  if (raw.tags) config.tags = raw.tags;
  if (raw.kind === "agent" && raw.deadline !== undefined && raw.deadline !== "") {
    const deadline = readDuration(
      typeof raw.deadline === "number" ? `${raw.deadline}s` : raw.deadline,
      false,
    );
    if (deadline.error) throw new DocumentIssue("/deadline", deadline.error);
    config.agentDeadlineSeconds = deadline.seconds;
  }
  const time = raw.kind === "agent" ? raw.idle_timeout : raw.deadline;
  if (time !== undefined && time !== "") {
    const parsed = readDuration(typeof time === "number" ? `${time}s` : time, raw.kind === "agent");
    if (parsed.error)
      throw new DocumentIssue(raw.kind === "agent" ? "/idle_timeout" : "/deadline", parsed.error);
    config.timeoutSeconds = parsed.seconds;
  }
  if (caps?.ops) config.modes = caps.ops;
  if (caps?.context?.window !== undefined) config.contextWindow = caps.context.window;
  if (caps?.context?.output !== undefined) config.maxOutputTokens = caps.context.output;
  if (caps?.prompt) config.promptLimit = caps.prompt.max_length;
  if (caps?.system !== undefined) config.systemPrompt = caps.system;
  if (caps?.vision !== undefined) config.vision = caps.vision;
  if (caps?.video !== undefined) config.video = caps.video;
  if (caps?.prompt_format) config.promptFormat = caps.prompt_format;
  if (caps?.refs) {
    for (const kind of ["image", "video", "audio"] as const) {
      const ref = caps.refs[kind];
      if (!ref || (!ref.on && (raw.kind === "text" || raw.kind === "agent"))) continue;
      config.refs ??= {};
      config.refs[kind] = {
        ...(ref.on !== ref.max > 0 && { on: ref.on }),
        max: ref.max,
        mb: ref.max_mb || 1,
      };
    }
  }
  if (caps?.params || raw.pricing?.tiers?.some((tier) => Object.hasOwn(tier.when, "op")))
    config.parameterOrder = [];
  let quantityKey: string | undefined;
  for (const [name, field] of Object.entries(caps?.params ?? {})) {
    if (field.type === "enum" && field.fanout) {
      if (quantityKey)
        throw new DocumentIssue("/capabilities/params", "生成数量（fanout）参数至多一个");
      if (!field.options.every((value) => /^[1-8]$/.test(String(value))))
        throw new DocumentIssue(
          `/capabilities/params/${name}/options`,
          "生成数量的可选值必须是 1 – 8 的整数",
        );
      quantityKey = name;
    }
    const orderKey = name === "generate_audio" ? "generateAudio" : paramKey(name);
    config.parameterOrder ??= [];
    config.parameterOrder.push(orderKey ?? name);
    if (field.type === "number") {
      const path = `/capabilities/params/${name}`;
      if (name !== "duration" || raw.kind !== "video") {
        config.customParams ??= {};
        config.customParams[name] = {
          type: "number",
          min: field.min,
          max: field.max,
          step: field.step,
          default: field.default,
          open: field.open,
          ...(field.label !== undefined && { label: field.label }),
          ...(field.unit !== undefined && { unit: field.unit }),
        };
        continue;
      }
      const step = field.step ?? 1;
      if (field.min < 1 || field.max > 30 || field.min > field.max || step < 1 || step > 30)
        throw new DocumentIssue(path, "时长范围须在 1 至 30 秒之间，步长须为正整数且不超过 30");
      const values = Array.from(
        { length: Math.floor((field.max - field.min) / step) + 1 },
        (_, index) => String(field.min + index * step),
      );
      if (!values.includes(String(field.default)))
        throw new DocumentIssue(`${path}/default`, "默认时长须符合范围和步长");
      config.params ??= {};
      config.params.duration = {
        values,
        default: String(field.default),
        range: {
          min: field.min,
          max: field.max,
          step,
          open: field.open,
          label: field.label,
          unit: field.unit,
        },
      };
      continue;
    }
    if (field.type === "boolean") {
      if (name !== "generate_audio" || raw.kind !== "video") {
        config.customParams ??= {};
        config.customParams[name] = {
          type: "boolean",
          default: field.default,
          open: field.open,
          spec: field.spec ?? false,
          ...(field.label !== undefined && { label: field.label }),
        };
        continue;
      }
      config.generateAudio = {
        open: field.open,
        default: field.default,
        spec: field.spec ?? false,
        ...(field.label !== undefined && { label: field.label }),
      };
      continue;
    }
    const key = paramKey(name);
    if (!key) {
      config.customParams ??= {};
      config.customParams[name] = {
        type: "enum",
        values: field.options,
        default: field.default,
        open: field.open,
        spec: field.spec ?? false,
        ...(field.label !== undefined && { label: field.label }),
        ...(field.unit !== undefined && { unit: field.unit }),
        ...(field.fanout !== undefined && { fanout: field.fanout }),
      };
      continue;
    }
    config.params ??= {};
    config.params[key] = {
      values: field.options.map(String),
      default: String(field.default),
      open: field.open,
      spec: field.spec ?? false,
      ...(field.label !== undefined && { label: field.label }),
      ...(field.unit !== undefined && { unit: field.unit }),
      ...(field.fanout !== undefined && { fanout: field.fanout }),
    };
  }
  if (raw.pricing) config.pricing = readPricing(raw.pricing);
  return {
    config,
    pluginHash: plugin?.hash ?? "",
    settings:
      raw.kind === "agent"
        ? binding.api_format === "gemini"
          ? { api: "gemini" }
          : {
              api: binding.studio_api ?? "chat_completions",
              pathPrefix: binding.path_prefix ?? "",
            }
        : (selected?.settings ?? {}),
    channels: [{ channel: binding.channel, upstream_model: binding.upstream_model }],
    kindSelected: Boolean(raw.kind),
    key: raw.key,
    enabled: raw.enabled,
  };
}

type Source = {
  config: ModelConfig;
  key?: string;
  enabled: boolean;
  kindSelected: boolean;
  channel: string;
  upstream: string;
  plugin?: PluginView;
  settings: ProviderFields["channel"];
};
export function modelCapabilities(config: ModelConfig) {
  const caps: NonNullable<Body["capabilities"]> = {};
  if (config.modes) caps.ops = config.modes;
  if (config.refs)
    caps.refs = Object.fromEntries(
      Object.entries(config.refs).map(([name, ref]) => [
        name,
        { on: ref.on ?? ref.max > 0, max: ref.max, max_mb: ref.mb },
      ]),
    );
  if (config.promptLimit !== undefined) caps.prompt = { max_length: config.promptLimit };
  if (config.contextWindow !== undefined || config.maxOutputTokens !== undefined)
    caps.context = { window: config.contextWindow, output: config.maxOutputTokens };
  if (config.systemPrompt !== undefined) caps.system = config.systemPrompt;
  if (config.vision !== undefined) caps.vision = config.vision;
  if (config.video !== undefined) caps.video = config.video;
  if (config.promptFormat) caps.prompt_format = config.promptFormat;
  if (config.params)
    caps.params = Object.fromEntries(
      (Object.keys(config.params) as ModelParameter[]).map((name) => {
        const field = requirePresent(
          requirePresent(config.params, "config.params")[name],
          "config.params[name]",
        );
        const convert = (value: string) =>
          name === "count" || name === "duration" ? Number(value) : value;
        return [
          paramNames[name],
          {
            type: "enum",
            label: field.label ?? modelParameterLabels[name],
            open: field.open ?? true,
            options: field.values.map(convert),
            default: convert(field.default),
            ...(field.unit !== undefined && { unit: field.unit }),
            ...((field.spec !== undefined || name !== "count") && { spec: field.spec ?? true }),
            ...(field.fanout !== undefined && { fanout: field.fanout }),
          },
        ];
      }),
    );
  if (config.customParams)
    for (const [name, field] of Object.entries(config.customParams)) {
      if (field.type === "enum") {
        caps.params ??= {};
        caps.params[name] = {
          type: "enum",
          label: field.label ?? name,
          open: field.open ?? true,
          options: field.values,
          default: field.default,
          ...(field.unit !== undefined && { unit: field.unit }),
          ...(field.spec !== undefined && { spec: field.spec }),
          ...(field.fanout !== undefined && { fanout: field.fanout }),
        };
      } else if (field.type === "number") {
        caps.params ??= {};
        caps.params[name] = {
          type: "number",
          label: field.label ?? name,
          open: field.open ?? true,
          min: field.min,
          max: field.max,
          step: field.step,
          default: field.default,
          ...(field.unit !== undefined && { unit: field.unit }),
        };
      } else {
        caps.params ??= {};
        caps.params[name] = {
          type: "boolean",
          label: field.label ?? name,
          open: field.open ?? true,
          default: field.default,
          ...(field.spec !== undefined && { spec: field.spec }),
        };
      }
    }
  if (config.generateAudio) {
    caps.params ??= {};
    caps.params.generate_audio = { type: "boolean", ...config.generateAudio };
  }
  const duration = config.params?.duration;
  if (duration?.range) {
    caps.params ??= {};
    caps.params.duration = {
      type: "number",
      ...duration.range,
      default: Number(duration.default),
    };
  }
  if (config.parameterOrder) {
    const order = config.parameterOrder.map((key) =>
      key === "generateAudio" ? "generate_audio" : (paramNames[key as ModelParameter] ?? key),
    );
    const entries = caps.params ?? {};
    caps.params = Object.fromEntries(
      order
        .filter((name) => Object.hasOwn(entries, name))
        .map((name) => [name, requirePresent(entries[name], "entries[name]")]),
    );
  }
  return caps;
}

export function encodeModelBody({
  config,
  key,
  enabled,
  kindSelected,
  channel,
  upstream,
  plugin,
  settings,
}: Source): Body {
  const caps = modelCapabilities(config);
  return {
    key: key ?? "",
    kind: kindSelected ? config.kind : "",
    label: config.name,
    hint: config.description,
    enabled,
    sort: config.sort,
    ...(config.logo && { vendor: config.logo }),
    ...(config.tags && { tags: config.tags }),
    ...(config.kind === "agent" &&
      config.agentDeadlineSeconds && { deadline: `${config.agentDeadlineSeconds}s` }),
    ...(config.timeoutSeconds && {
      [config.kind === "agent" ? "idle_timeout" : "deadline"]: `${config.timeoutSeconds}s`,
    }),
    channels: [
      {
        channel,
        upstream_model: upstream,
        ...(config.kind === "agent"
          ? settings.api === "gemini"
            ? { api_format: "gemini" as const }
            : {
                ...(String(settings.pathPrefix ?? "").trim() && {
                  path_prefix: String(settings.pathPrefix).trim(),
                }),
                ...(settings.api === "responses" && { studio_api: "responses" as const }),
              }
          : plugin
            ? { protocol: { plugin: plugin.key, version: plugin.version, settings } }
            : {}),
      },
    ],
    ...(Object.keys(caps).length && { capabilities: caps }),
    ...(config.pricing && { pricing: writePricing(config.pricing) }),
  };
}
