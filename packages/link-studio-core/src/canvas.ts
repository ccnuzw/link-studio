import { type Static, Type } from "@sinclair/typebox";
import { DirectorScene } from "./director.ts";

const strict = { additionalProperties: false };
export const CanvasId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$" });
const EdgeId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,249}$" });
const coordinate = Type.Number({ minimum: -1e7, maximum: 1e7 });
export const CanvasPosition = Type.Object({ x: coordinate, y: coordinate }, strict);
export const CanvasViewport = Type.Object(
  { ...CanvasPosition.properties, zoom: Type.Number({ minimum: 0.2, maximum: 2 }) },
  strict,
);
const label = Type.String({ maxLength: 255 });
const assetIdentifier = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Character = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    look: Type.String({ minLength: 1, maxLength: 64 }),
    description: Type.String({ maxLength: 500 }),
    extraAssetIds: Type.Array(assetIdentifier, { maxItems: 4, uniqueItems: true }),
    voice: Type.Optional(Type.Object({ assetId: assetIdentifier }, strict)),
  },
  strict,
);
export type CanvasCharacter = Static<typeof Character>;
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
  },
  strict,
);
export type CanvasShot = Static<typeof CanvasShot>;
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
    text: Type.String({ maxLength: 32768 }),
    assetId: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      }),
    ),
    outputs: Type.Optional(Type.Array(CreativeOutput, { maxItems: 50 })),
    activeOutputId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    character: Type.Optional(Character),
    storyboard: Type.Optional(Type.Array(CanvasShot, { maxItems: 100 })),
    shotId: Type.Optional(CanvasId),
    director: Type.Optional(DirectorScene),
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
export const CanvasGroup = Type.Object(
  {
    ...node,
    type: Type.Literal("group"),
    data: Type.Object({ label }, strict),
    width: Type.Number({ minimum: 100, maximum: 1e6 }),
    height: Type.Number({ minimum: 60, maximum: 1e6 }),
  },
  strict,
);
export const CanvasEdge = Type.Object({ id: EdgeId, source: CanvasId, target: CanvasId }, strict);

export type EditableCanvasNode = Static<typeof CreativeCanvasNode | typeof CanvasGroup>;
export type CreativeData = Static<typeof CreativeData>;
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
    { type: Type.Literal("putNode"), node: Type.Union([CreativeCanvasNode, CanvasGroup]) },
    strict,
  ),
  Type.Object({ type: Type.Literal("removeNode"), id: CanvasId }, strict),
  Type.Object({ type: Type.Literal("putEdge"), edge: CanvasEdge }, strict),
  Type.Object({ type: Type.Literal("removeEdge"), id: EdgeId }, strict),
  Type.Object({ type: Type.Literal("setViewport"), viewport: CanvasViewport }, strict),
]);
export const CanvasOperations = Type.Array(CanvasOperation, { minItems: 1, maxItems: 10001 });
export type CanvasOperation = Static<typeof CanvasOperation>;
