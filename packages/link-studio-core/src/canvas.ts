import { type Static, Type } from "@sinclair/typebox";
import { DirectorScene } from "./director.ts";
import { GenerationParameters } from "./generation-parameters.ts";

const strict = { additionalProperties: false };
export const CanvasId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$" });
export const CanvasModelKey = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" });
const EdgeId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,249}$" });
const coordinate = Type.Number({ minimum: -1e7, maximum: 1e7 });
export const CanvasPosition = Type.Object({ x: coordinate, y: coordinate }, strict);
export const CanvasViewport = Type.Object(
  { ...CanvasPosition.properties, zoom: Type.Number({ minimum: 0.14, maximum: 2 }) },
  strict,
);
const label = Type.String({ maxLength: 255 });
const assetIdentifier = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Character = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    look: Type.String({ maxLength: 64 }),
    description: Type.String({ maxLength: 500 }),
    voicePrompt: Type.Optional(Type.String({ maxLength: 500 })),
    voiceModel: Type.Optional(CanvasModelKey),
    extraAssetIds: Type.Array(assetIdentifier, { maxItems: 4, uniqueItems: true }),
    voice: Type.Optional(
      Type.Object(
        {
          assetId: assetIdentifier,
          name: Type.Optional(label),
          origin: Type.Optional(
            Type.Union([
              Type.Literal("upload"),
              Type.Literal("generated"),
              Type.Literal("library"),
            ]),
          ),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type CanvasCharacter = Static<typeof Character>;
export function characterVoice(
  assetId: string,
  origin: "library" | "upload" | "generated",
  fileName?: string,
): NonNullable<CanvasCharacter["voice"]> {
  const name = fileName
    ?.replace(/^(Child|Teen|Young|Middle-aged|Older) - (Male|Female) - /, "")
    .trim();
  return { assetId, origin, ...(name && { name }) };
}
export const shotSizes = [
  "大远景",
  "远景",
  "全景",
  "中景",
  "中近景",
  "近景",
  "特写",
  "大特写",
] as const;
export const cameraMoves = [
  "固定",
  "推",
  "拉",
  "摇",
  "移",
  "跟",
  "升",
  "降",
  "环绕",
  "变焦",
  "甩镜",
  "手持",
  "航拍",
] as const;
export const CanvasShot = Type.Object(
  {
    id: CanvasId,
    scene: Type.String({ maxLength: 2000 }),
    shot: Type.Union(["", ...shotSizes].map((value) => Type.Literal(value))),
    camera: Type.Union(["", ...cameraMoves].map((value) => Type.Literal(value))),
    action: Type.String({ maxLength: 1000 }),
    dialogue: Type.String({ maxLength: 1000 }),
    duration: Type.Number({ minimum: 1, maximum: 60 }),
    imageNodeId: Type.Optional(CanvasId),
    videoNodeId: Type.Optional(CanvasId),
    imageAssetId: Type.Optional(assetIdentifier),
  },
  strict,
);
export type CanvasShot = Static<typeof CanvasShot>;
export function remapShotLinks(shot: CanvasShot, ids: ReadonlyMap<string, string>): CanvasShot {
  const { imageNodeId, videoNodeId, ...fields } = shot;
  const image = imageNodeId && ids.get(imageNodeId);
  const video = videoNodeId && ids.get(videoNodeId);
  return { ...fields, ...(image && { imageNodeId: image }), ...(video && { videoNodeId: video }) };
}
export const maxStoryboardShots = 200;
export function validStoryboard(shots: CanvasShot[]) {
  return (
    new Set(shots.map(({ id }) => id)).size === shots.length &&
    shots.every(({ duration }) => Number(duration.toFixed(1)) === duration)
  );
}
const kinds = Type.Union([
  Type.Literal("script"),
  Type.Literal("image"),
  Type.Literal("video"),
  Type.Literal("audio"),
]);
const CreativeOutput = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 255 }),
    kind: Type.Union([
      Type.Literal("image"),
      Type.Literal("video"),
      Type.Literal("audio"),
      Type.Literal("text"),
    ]),
    assetId: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      }),
    ),
    text: Type.Optional(Type.String({ maxLength: 32768 })),
    model: Type.Optional(Type.String({ maxLength: 200 })),
    createdAt: Type.String({ maxLength: 64 }),
  },
  strict,
);
export const CreativeData = Type.Object(
  {
    kind: kinds,
    label,
    text: Type.String({ maxLength: 40000 }),
    textStatus: Type.Optional(
      Type.Union([Type.Literal("idle"), Type.Literal("done"), Type.Literal("error")]),
    ),
    textError: Type.Optional(Type.String({ maxLength: 32768 })),
    textFailureTask: Type.Optional(
      Type.Object({
        id: Type.String({ minLength: 1, maxLength: 32768 }),
        reference: Type.String({ minLength: 1, maxLength: 32768 }),
      }),
    ),
    uploaded: Type.Optional(Type.Literal(true)),
    uploadFailed: Type.Optional(Type.Literal(true)),
    mediaAspect: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    assetId: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      }),
    ),
    outputs: Type.Optional(Type.Array(CreativeOutput, { maxItems: 50 })),
    manualReferenceIds: Type.Optional(Type.Array(assetIdentifier, { uniqueItems: true })),
    generation: Type.Optional(
      Type.Object(
        {
          providerId: Type.Optional(assetIdentifier),
          modelKey: Type.Optional(CanvasModelKey),
          params: Type.Optional(
            Type.Object(
              {
                ...GenerationParameters.properties,
                seed: Type.Optional(Type.Number()),
                sampleRate: Type.Optional(Type.Number()),
                speechRate: Type.Optional(Type.Number()),
                loudnessRate: Type.Optional(Type.Number()),
                pitchRate: Type.Optional(Type.Number()),
              },
              strict,
            ),
          ),
          sizeInput: Type.Optional(Type.String({ maxLength: 64 })),
          durationInput: Type.Optional(Type.String({ maxLength: 64 })),
        },
        strict,
      ),
    ),
    videoDuration: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    videoMode: Type.Optional(
      Type.Union([Type.Literal("i2v"), Type.Literal("omni"), Type.Literal("t2v")]),
    ),
    imageMode: Type.Optional(Type.Union([Type.Literal("i2i"), Type.Literal("t2i")])),
    activeOutputId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    pendingMediaVersion: Type.Optional(
      Type.Object(
        { batchId: assetIdentifier, outputId: Type.String({ minLength: 1, maxLength: 255 }) },
        strict,
      ),
    ),
    character: Type.Optional(Character),
    drama: Type.Optional(
      Type.Union([
        Type.Object(
          {
            type: Type.Union([
              Type.Literal("character"),
              Type.Literal("scene"),
              Type.Literal("prop"),
            ]),
            name: Type.String({ minLength: 1, maxLength: 64 }),
            look: Type.String({ maxLength: 64 }),
            description: Type.String(),
            aliases: Type.Array(Type.String({ maxLength: 64 })),
            episodes: Type.Union([
              Type.Null(),
              Type.Array(Type.Integer({ minimum: 1, maximum: 100000 })),
            ]),
          },
          strict,
        ),
        Type.Object(
          {
            episodes: Type.Union([
              Type.Null(),
              Type.Array(Type.Integer({ minimum: 1, maximum: 100000 }), {
                minItems: 1,
                maxItems: 1,
              }),
            ]),
            board: Type.Object(
              {
                segmentId: CanvasId,
                sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
                layout: Type.Union([Type.Literal("2x2"), Type.Literal("3x2"), Type.Literal("3x3")]),
                shotCount: Type.Integer({ minimum: 0 }),
              },
              strict,
            ),
          },
          strict,
        ),
        Type.Object(
          {
            episodes: Type.Union([
              Type.Null(),
              Type.Array(Type.Integer({ minimum: 1, maximum: 100000 })),
            ]),
          },
          strict,
        ),
      ]),
    ),
    storyboard: Type.Optional(Type.Array(CanvasShot, { maxItems: maxStoryboardShots })),
    shotId: Type.Optional(CanvasId),
    director: Type.Optional(DirectorScene),
    directorThumbnailId: Type.Optional(assetIdentifier),
  },
  strict,
);
const node = { id: CanvasId, position: CanvasPosition };
export const CreativeCanvasNode = Type.Object(
  {
    ...node,
    type: Type.Literal("creative"),
    parentId: Type.Optional(CanvasId),
    data: CreativeData,
  },
  strict,
);
export const groupHues = [
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
] as const;
export type GroupHue = (typeof groupHues)[number];
export const groupHue = Type.Union(groupHues.map((hue) => Type.Literal(hue)));
export const CanvasGroup = Type.Object(
  {
    ...node,
    type: Type.Literal("group"),
    data: Type.Object(
      { label, color: Type.Optional(groupHue), labelColor: Type.Optional(groupHue) },
      strict,
    ),
    width: Type.Number({ minimum: 100, maximum: 1e6 }),
    height: Type.Number({ minimum: 60, maximum: 1e6 }),
  },
  strict,
);
export const CanvasEdge = Type.Object({ id: EdgeId, source: CanvasId, target: CanvasId }, strict);

export type EditableCanvasNode = Static<typeof CreativeCanvasNode | typeof CanvasGroup>;
export type CreativeData = Static<typeof CreativeData>;
export function restoreMediaVersion(data: CreativeData): CreativeData {
  if (!data.pendingMediaVersion) return data;
  const { pendingMediaVersion, ...rest } = data;
  const previous = data.outputs?.find((output) => output.id === pendingMediaVersion.outputId);
  return !data.assetId && previous?.assetId
    ? { ...rest, assetId: previous.assetId, activeOutputId: previous.id }
    : rest;
}
export function isPlainGeneratedMedia(data: CreativeData) {
  return (
    (data.kind === "image" || data.kind === "video" || data.kind === "audio") &&
    !data.uploaded &&
    !data.uploadFailed &&
    !data.character &&
    !data.drama &&
    !data.shotId &&
    !data.storyboard &&
    !data.director
  );
}
export function dramaAssetMeta(data: Pick<CreativeData, "drama">) {
  return data.drama && "type" in data.drama ? data.drama : undefined;
}
export function dramaBoardMeta(data: Pick<CreativeData, "drama">) {
  return data.drama && "board" in data.drama ? data.drama.board : undefined;
}
export type CreativeOutput = Static<typeof CreativeOutput>;
export type CanvasEdge = Static<typeof CanvasEdge>;
export type CanvasViewport = Static<typeof CanvasViewport>;
export type CompatibilityNode = {
  id: string;
  type: "unknown";
  position: { x: number; y: number };
  parentId?: string;
  data: { label: string };
};
export type ProjectCanvasView = {
  nodes: (EditableCanvasNode | CompatibilityNode)[];
  edges: (CanvasEdge & { readOnly?: true })[];
  viewport: CanvasViewport;
};

export function outputKindForNode(kind: CreativeData["kind"]): CreativeOutput["kind"] {
  return kind === "script" ? "text" : kind;
}
export const CanvasOperation = Type.Union([
  Type.Object(
    {
      type: Type.Literal("putNode"),
      node: Type.Union([CreativeCanvasNode, CanvasGroup]),
      beforeId: Type.Optional(CanvasId),
    },
    strict,
  ),
  Type.Object({ type: Type.Literal("removeNode"), id: CanvasId }, strict),
  Type.Object(
    { type: Type.Literal("putEdge"), edge: CanvasEdge, beforeId: Type.Optional(EdgeId) },
    strict,
  ),
  Type.Object({ type: Type.Literal("removeEdge"), id: EdgeId }, strict),
  Type.Object({ type: Type.Literal("setViewport"), viewport: CanvasViewport }, strict),
]);
export const CanvasOperations = Type.Array(CanvasOperation, { minItems: 1, maxItems: 10001 });
export type CanvasOperation = Static<typeof CanvasOperation>;
