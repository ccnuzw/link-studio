import { type Static, Type } from "@sinclair/typebox";
import { CanvasId } from "./canvas.ts";
import { GenerationParameters } from "./generation-parameters.ts";
import { maximumModelPromptLength } from "./model-config.ts";

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
      Type.Union([
        Type.Literal("character-voice"),
        Type.Literal("storyboard-split"),
        Type.Literal("drama-segment"),
        Type.Literal("drama-board"),
      ]),
    ),
    board: Type.Optional(
      Type.Object(
        {
          segmentId: CanvasId,
          sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          settingsRevision: Type.Optional(Type.Integer({ minimum: 1 })),
          refs: Type.Array(CanvasId, { uniqueItems: true, maxItems: 12 }),
        },
        strict,
      ),
    ),
    storyboardSplitMode: Type.Optional(
      Type.Union([Type.Literal("replace"), Type.Literal("append")]),
    ),
    afterImageJobId: Type.Optional(uuid),
    providerId: uuid,
    expectedProviderRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    expectedCanvasRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    prompt: Type.String({ minLength: 1, maxLength: maximumModelPromptLength }),
    referenceAssetIds: Type.Array(uuid, { maxItems: 12, uniqueItems: true }),
    referenceURLs: Type.Optional(
      Type.Record(uuid, Type.String({ maxLength: 4096 }), { maxProperties: 12 }),
    ),
    op: Type.Optional(Type.Union([Type.Literal("t2v"), Type.Literal("i2v"), Type.Literal("omni")])),
    ...GenerationParameters.properties,
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
  quotedCredits?: number;
  settledCredits?: number;
  batchId?: string;
  outputPrompt?: string;
  unsubmittedCount?: number;
  id: string;
  nodeId: string;
  providerId: string;
  providerRevision: number;
  purpose?: GenerationInput["purpose"];
  storyboardSplitMode?: GenerationInput["storyboardSplitMode"];
  storyboardShotIds?: string[];
  afterImageJobId?: string;
  voicePrompt?: string;
  kind: GenerationKind;
  providerLabel: string;
  model: string;
  status: JobStatus;
  progress: number;
  outputs: JobOutput[];
  createdAt: string;
  submittedAt?: string;
  updatedAt: string;
  error?: string;
  errorMessage?: string;
  bound?: boolean;
  cancelRequested?: boolean;
  canCancelRemote: boolean;
  canRecheck: boolean;
};

export const queueFullMessage = "排队任务已达上限，请等前面的任务完成后再试";
export const defaultGenerationConcurrency = 4;
export const defaultGenerationQueueMultiplier = 5;
export const missingJobBindingMessage =
  "本机找不到这次提交使用的模型或渠道配置，无法查询原任务。请到原供应商核对结果，避免重复生成。";

export function jobFailureReason(job?: GenerationJob) {
  return job?.errorMessage || job?.error;
}

export function jobIsTerminal(status: JobStatus) {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "outcome_unknown"
  );
}
