import { type Static, Type } from "@sinclair/typebox";

export const GenerationParameters = Type.Object(
  {
    customParams: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[a-z][a-z0-9_]{0,31}$" }),
        Type.Union([Type.String({ maxLength: 256 }), Type.Number(), Type.Boolean()]),
        { maxProperties: 20, additionalProperties: false },
      ),
    ),
    size: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{1,3}x[1-9][0-9]{1,3}$" })),
    duration: Type.Optional(
      Type.Union([Type.Literal(-1), Type.Integer({ minimum: 1, maximum: 30 })]),
    ),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    quality: Type.Optional(
      Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("standard"),
        Type.Literal("hd"),
      ]),
    ),
    aspectRatio: Type.Optional(Type.String({ pattern: "^(?:[1-9][0-9]?:[1-9][0-9]?|adaptive)$" })),
    resolution: Type.Optional(
      Type.String({ pattern: "^(?:(?:360|480|512|540|720|768|1080)[pP]|(?:1|1\\.5|2|3|4)[kK])$" }),
    ),
    generateAudio: Type.Optional(Type.Boolean()),
    seed: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    negativePrompt: Type.Optional(Type.String({ maxLength: 2000 })),
    makeInstrumental: Type.Optional(Type.Boolean()),
    audioFormat: Type.Optional(
      Type.Union([Type.Literal("mp3"), Type.Literal("wav"), Type.Literal("ogg_opus")]),
    ),
    speaker: Type.Optional(Type.String({ maxLength: 200 })),
    sampleRate: Type.Optional(Type.Integer({ minimum: 8000, maximum: 48000 })),
    speechRate: Type.Optional(Type.Integer({ minimum: -50, maximum: 100 })),
    loudnessRate: Type.Optional(Type.Integer({ minimum: -50, maximum: 100 })),
    pitchRate: Type.Optional(Type.Integer({ minimum: -12, maximum: 12 })),
    videoAction: Type.Optional(Type.Union([Type.Literal("edit"), Type.Literal("extend")])),
  },
  { additionalProperties: false },
);
export type GenerationParameters = Static<typeof GenerationParameters>;
