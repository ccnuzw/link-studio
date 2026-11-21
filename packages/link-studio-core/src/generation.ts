import { type Static, Type } from "@sinclair/typebox";
import { CanvasId } from "./canvas.ts";

const strict = { additionalProperties: false };
const uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const GenerationKind = Type.Union([
  Type.Literal("text"),
  Type.Literal("image"),
  Type.Literal("video"),
  Type.Literal("audio"),
]);
export const GenerationInput = Type.Object(
  {
    nodeId: CanvasId,
    purpose: Type.Optional(
      Type.Union([Type.Literal("character-voice"), Type.Literal("storyboard-split")]),
    ),
    storyboardSplitMode: Type.Optional(
      Type.Union([Type.Literal("replace"), Type.Literal("append")]),
    ),
    afterImageJobId: Type.Optional(uuid),
    providerId: uuid,
    expectedProviderRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    expectedCanvasRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    prompt: Type.String({ minLength: 1, maxLength: 16000 }),
    referenceAssetIds: Type.Array(uuid, { maxItems: 12, uniqueItems: true }),
    referenceURLs: Type.Optional(
      Type.Record(uuid, Type.String({ maxLength: 4096 }), { maxProperties: 12 }),
    ),
    op: Type.Optional(Type.Union([Type.Literal("t2v"), Type.Literal("i2v"), Type.Literal("omni")])),
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
      Type.String({ pattern: "^(?:360p|480p|512p|540p|720p|768p|1080p|1K|1\\.5K|2K|3K|4K|4k)$" }),
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
  strict,
);
export type GenerationInput = Static<typeof GenerationInput>;
export type GenerationKind = Static<typeof GenerationKind>;
export type JobStatus =
  | "queued"
  | "submitting"
  | "running"
  | "downloading"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown";
export type JobOutput =
  | { assetId: string; kind: Exclude<GenerationKind, "text"> }
  | { text: string; kind: "text" };
export type GenerationJob = {
  id: string;
  nodeId: string;
  providerId: string;
  providerRevision: number;
  purpose?: GenerationInput["purpose"];
  afterImageJobId?: string;
  voicePrompt?: string;
  kind: GenerationKind;
  providerLabel: string;
  model: string;
  status: JobStatus;
  progress: number;
  outputs: JobOutput[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  bound?: boolean;
  cancelRequested?: boolean;
  canCancelRemote: boolean;
  canRecheck: boolean;
};

export function jobIsTerminal(status: JobStatus) {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "outcome_unknown"
  );
}
