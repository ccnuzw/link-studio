import { type Static, Type } from "@sinclair/typebox";

const strict = { additionalProperties: false };
const integer = (maximum: number, minimum = 1) => Type.Integer({ minimum, maximum });
const labels = Type.Array(Type.String({ minLength: 1, maxLength: 32 }), {
  minItems: 1,
  maxItems: 30,
  uniqueItems: true,
});
const choice = Type.Object({ values: labels, default: Type.String({ maxLength: 32 }) }, strict);
const reference = Type.Object({ max: integer(12, 0), mb: integer(20) }, strict);
export const generationModes = ["t2i", "i2i", "t2v", "i2v", "omni"] as const;
export const modelKinds = ["text", "image", "video", "audio", "agent"] as const;
export type ModelKind = (typeof modelKinds)[number];

export const ModelConfig = Type.Object(
  {
    kind: Type.Union(modelKinds.map((kind) => Type.Literal(kind))),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 500 }),
    logo: Type.Optional(Type.String({ maxLength: 40 })),
    sort: integer(100000, 0),
    promptLimit: Type.Optional(integer(16000)),
    timeoutSeconds: Type.Optional(integer(3600, 10)),
    contextWindow: Type.Optional(integer(2000000)),
    maxOutputTokens: Type.Optional(integer(200000)),
    vision: Type.Optional(Type.Boolean()),
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
          duration: Type.Optional(choice),
          count: Type.Optional(choice),
          audioFormat: Type.Optional(choice),
        },
        strict,
      ),
    ),
    promptFormat: Type.Optional(Type.Union([Type.Literal("seedance"), Type.Literal("h3")])),
    pricing: Type.Optional(
      Type.Object(
        {
          unit: Type.Union([
            Type.Literal("request"),
            Type.Literal("second"),
            Type.Literal("token"),
          ]),
          input: Type.Number({ minimum: 0, maximum: 10000000 }),
          output: Type.Optional(Type.Number({ minimum: 0, maximum: 10000000 })),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type ModelConfig = Static<typeof ModelConfig>;
export type ModelParameter = keyof NonNullable<ModelConfig["params"]>;

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
