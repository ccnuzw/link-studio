import { type Static, Type } from "@sinclair/typebox";

const strict = { additionalProperties: false };
export const maximumModelPromptLength = 1_000_000;
export const modelContextLimits = {
  window: 10_000_000,
  output: 1_000_000,
  minOutput: 256,
} as const;
const integer = (maximum: number, minimum = 1) => Type.Integer({ minimum, maximum });
const labels = Type.Array(Type.String({ minLength: 1, maxLength: 32 }), {
  minItems: 1,
  maxItems: 30,
  uniqueItems: true,
});
const choice = Type.Object(
  {
    values: labels,
    default: Type.String({ maxLength: 32 }),
    open: Type.Optional(Type.Boolean()),
    label: Type.Optional(Type.String({ maxLength: 64 })),
    spec: Type.Optional(Type.Boolean()),
    unit: Type.Optional(Type.String({ maxLength: 32 })),
    fanout: Type.Optional(Type.Boolean()),
  },
  strict,
);
const customParameter = Type.Union([
  Type.Object(
    {
      type: Type.Literal("enum"),
      values: Type.Array(Type.Union([Type.String({ maxLength: 64 }), Type.Number()]), {
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      }),
      default: Type.Union([Type.String({ maxLength: 64 }), Type.Number()]),
      open: Type.Optional(Type.Boolean()),
      label: Type.Optional(Type.String({ maxLength: 64 })),
      spec: Type.Optional(Type.Boolean()),
      unit: Type.Optional(Type.String({ maxLength: 32 })),
      fanout: Type.Optional(Type.Boolean()),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("number"),
      min: integer(3600),
      max: integer(3600),
      step: Type.Optional(integer(1000000)),
      default: Type.Number(),
      open: Type.Optional(Type.Boolean()),
      label: Type.Optional(Type.String({ maxLength: 64 })),
      unit: Type.Optional(Type.String({ maxLength: 32 })),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("boolean"),
      default: Type.Boolean(),
      open: Type.Optional(Type.Boolean()),
      label: Type.Optional(Type.String({ maxLength: 64 })),
      spec: Type.Optional(Type.Boolean()),
    },
    strict,
  ),
]);
export const maxModelReferenceMB = 500;
export const maxReferencesPerKind = 12;
export const maxMixedReferences = 3 * maxReferencesPerKind;
const reference = Type.Object(
  {
    on: Type.Optional(Type.Boolean()),
    max: integer(maxReferencesPerKind, 0),
    mb: integer(maxModelReferenceMB),
  },
  strict,
);
const credits = integer(1000000, 0);
const priceCost = Type.Object(
  { input: Type.Optional(credits), output: Type.Optional(credits) },
  strict,
);
const priceTier = Type.Object(
  {
    on: Type.Boolean(),
    when: Type.Record(
      Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,31}$" }),
      Type.Union([Type.String({ maxLength: 64 }), Type.Number(), Type.Boolean()]),
      { maxProperties: 16, additionalProperties: false },
    ),
    unit: credits,
    cost: Type.Optional(priceCost),
  },
  strict,
);
export const generationModes = ["t2i", "i2i", "t2v", "i2v", "omni"] as const;
export const modelKinds = ["text", "image", "video", "audio", "agent"] as const;
export type ModelKind = (typeof modelKinds)[number];

export const ModelConfig = Type.Object(
  {
    kind: Type.Union(modelKinds.map((kind) => Type.Literal(kind))),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 500 }),
    logo: Type.Optional(Type.String({ maxLength: 40 })),
    tags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 12, pattern: "^\\S(?:.*\\S)?$" }), {
        maxItems: 5,
        uniqueItems: true,
      }),
    ),
    sort: integer(2147483647, 0),
    promptLimit: Type.Optional(integer(maximumModelPromptLength)),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.001, maximum: 86400 })),
    agentDeadlineSeconds: Type.Optional(Type.Number({ minimum: 0.001, maximum: 86400 })),
    contextWindow: Type.Optional(integer(modelContextLimits.window)),
    maxOutputTokens: Type.Optional(integer(modelContextLimits.output)),
    vision: Type.Optional(Type.Boolean()),
    video: Type.Optional(Type.Boolean()),
    systemPrompt: Type.Optional(Type.String({ maxLength: 16000 })),
    modes: Type.Optional(
      Type.Array(Type.Union(generationModes.map((mode) => Type.Literal(mode))), {
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
      }),
    ),
    refs: Type.Optional(
      Type.Object(
        {
          image: Type.Optional(reference),
          video: Type.Optional(reference),
          audio: Type.Optional(reference),
        },
        strict,
      ),
    ),
    params: Type.Optional(
      Type.Object(
        {
          size: Type.Optional(choice),
          aspectRatio: Type.Optional(choice),
          resolution: Type.Optional(choice),
          quality: Type.Optional(choice),
          duration: Type.Optional(
            Type.Object(
              {
                ...choice.properties,
                range: Type.Optional(
                  Type.Object(
                    {
                      min: integer(30),
                      max: integer(30),
                      step: integer(30),
                      open: Type.Boolean(),
                      label: Type.Optional(Type.String({ maxLength: 64 })),
                      unit: Type.Optional(Type.String({ maxLength: 32 })),
                    },
                    strict,
                  ),
                ),
              },
              strict,
            ),
          ),
          count: Type.Optional(choice),
          audioFormat: Type.Optional(choice),
        },
        strict,
      ),
    ),
    customParams: Type.Optional(
      Type.Record(Type.String({ pattern: "^[a-z][a-z0-9_]{0,31}$" }), customParameter, {
        maxProperties: 20,
        additionalProperties: false,
      }),
    ),
    parameterOrder: Type.Optional(
      Type.Array(Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,31}$" }), {
        uniqueItems: true,
        maxItems: 24,
      }),
    ),
    promptFormat: Type.Optional(Type.Union([Type.Literal("seedance"), Type.Literal("h3")])),
    generateAudio: Type.Optional(
      Type.Object(
        {
          open: Type.Boolean(),
          default: Type.Boolean(),
          spec: Type.Boolean(),
          label: Type.Optional(Type.String({ maxLength: 64 })),
        },
        strict,
      ),
    ),
    pricing: Type.Optional(
      Type.Object(
        {
          unit: Type.Union([
            Type.Literal("request"),
            Type.Literal("second"),
            Type.Literal("token"),
          ]),
          input: Type.Number({ minimum: 0, maximum: 10000000 }),
          pending: Type.Optional(Type.Boolean()),
          output: Type.Optional(Type.Number({ minimum: 0, maximum: 10000000 })),
          tiers: Type.Optional(Type.Array(priceTier, { maxItems: 100 })),
          cost: Type.Optional(priceCost),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type ModelConfig = Static<typeof ModelConfig>;
export type ModelParameter = keyof NonNullable<ModelConfig["params"]>;
export type CustomModelParameter = NonNullable<ModelConfig["customParams"]>[string];
export type CustomModelParameterMap = NonNullable<ModelConfig["customParams"]>;

export function fanoutFields(config?: ModelConfig) {
  return Object.entries({ ...config?.params, ...config?.customParams }).filter(
    ([key, field]) =>
      (!config?.parameterOrder || config.parameterOrder.includes(key)) &&
      "fanout" in field &&
      field.fanout,
  );
}

export function modelFanout(config: ModelConfig | undefined, params: Record<string, unknown>) {
  const entry = fanoutFields(config)[0];
  if (!entry) return { key: undefined, count: 1 };
  const [key, field] = entry;
  const count = Number(params[key] ?? field.default);
  return { key, count: Number.isInteger(count) && count >= 1 && count <= 8 ? count : 1 };
}

export function validCustomName(key: string) {
  return (
    /^[a-z][a-z0-9_]{0,31}$/.test(key) &&
    !Object.hasOwn(Object.prototype, key) &&
    ![
      "prompt",
      "op",
      "system",
      "max_tokens",
      "images",
      "videos",
      "audios",
      "size",
      "duration",
      "quality",
      "count",
      "n",
      "resolution",
      "aspect_ratio",
      "audio_format",
      "generate_audio",
      "ref_video",
    ].includes(key)
  );
}

export function validCustomValue(field: CustomModelParameter, value: unknown) {
  if (field.type === "enum") return field.values.some((item) => item === value);
  if (field.type === "boolean") return typeof value === "boolean";
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= field.min &&
    value <= field.max &&
    (value - field.min) % (field.step ?? 1) === 0
  );
}

export function validCustomInput(
  config: ModelConfig | undefined,
  values?: Record<string, unknown>,
) {
  return Object.entries(values ?? {}).every(([key, value]) => {
    const field = config?.customParams?.[key];
    return (
      validCustomName(key) &&
      field &&
      (!config?.parameterOrder || config.parameterOrder.includes(key)) &&
      (field.open === false || validCustomValue(field, value))
    );
  });
}

export function modelParameterOrder(config?: ModelConfig) {
  if (config?.parameterOrder) return config.parameterOrder;
  if (
    (config?.kind === "image" || config?.kind === "video") &&
    (config.params || config.customParams || config.generateAudio)
  )
    return [
      ...Object.keys(config.params ?? {}),
      ...Object.keys(config.customParams ?? {}),
      ...(config.generateAudio ? ["generateAudio"] : []),
    ];
  return undefined;
}

export function includesModelParameter(
  config: ModelConfig | undefined,
  key: ModelParameter | "generateAudio",
) {
  return modelParameterOrder(config)?.includes(key) ?? true;
}

export function quoteQuantity(config: ModelConfig | undefined, params: Record<string, unknown>) {
  const fanout = modelFanout(config, params);
  if (fanout.key || config?.parameterOrder) return fanout.count;
  return Math.max(1, Number(params.count) || 1);
}

export const modelKindLabels: Record<ModelKind, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
  agent: "Agent",
};
export const modelModeLabels = {
  t2i: "文生图",
  i2i: "图生图",
  t2v: "文生视频",
  i2v: "图生视频",
  omni: "全能参考",
};
export const modelParameterLabels: Record<ModelParameter, string> = {
  size: "尺寸",
  aspectRatio: "比例",
  resolution: "清晰度",
  quality: "质量",
  duration: "时长",
  count: "生成数量",
  audioFormat: "音频格式",
};
