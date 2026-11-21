import { type Static, Type } from "@sinclair/typebox";

const strict = { additionalProperties: false };
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$" });
const name = Type.String({ minLength: 1, maxLength: 80 });
const coordinate = Type.Number({ minimum: -1000, maximum: 1000 });
const angle = Type.Number({ minimum: -360, maximum: 360 });
const length = Type.Number({ minimum: 0.05, maximum: 100 });
const position = { x: coordinate, z: coordinate, yaw: angle };
const cameraPose = {
  ...position,
  y: coordinate,
  pitch: Type.Number({ minimum: -90, maximum: 90 }),
  fov: Type.Number({ minimum: 10, maximum: 120 }),
};
const key = {
  t: Type.Number({ minimum: 0, maximum: 15 }),
  ease: Type.Union([Type.Literal("linear"), Type.Literal("smooth")]),
};
export const directorAspects = ["16:9", "9:16", "1:1", "4:3", "21:9"] as const;
export const directorShapes = [
  "box",
  "cylinder",
  "sphere",
  "plane",
  "table",
  "chair",
  "sofa",
  "bed",
  "cabinet",
  "door",
  "wall",
  "stairs",
  "car",
  "tree",
] as const;
export const directorPoses = [
  "stand",
  "walk",
  "run",
  "sit",
  "crouch",
  "point",
  "armsCrossed",
  "wave",
  "talk",
  "raiseHand",
  "lookBack",
  "lying",
] as const;
export const DirectorScene = Type.Object(
  {
    version: Type.Literal(1),
    duration: Type.Number({ minimum: 1, maximum: 15 }),
    activeCameraId: Type.Union([id, Type.Literal("")]),
    characters: Type.Array(
      Type.Object(
        {
          id,
          name,
          ...position,
          color: Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
          model: Type.Optional(Type.Union([Type.Literal("male"), Type.Literal("female")])),
          pose: Type.Union(directorPoses.map((item) => Type.Literal(item))),
          scale: Type.Number({ minimum: 0.8, maximum: 1.2 }),
          keys: Type.Array(Type.Object({ ...position, ...key }, strict), { maxItems: 120 }),
          hidden: Type.Optional(Type.Boolean()),
          locked: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
      { maxItems: 48 },
    ),
    props: Type.Array(
      Type.Object(
        {
          id,
          name,
          ...position,
          shape: Type.Union(directorShapes.map((item) => Type.Literal(item))),
          w: length,
          h: length,
          d: length,
          hidden: Type.Optional(Type.Boolean()),
          locked: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
      { maxItems: 96 },
    ),
    cameras: Type.Array(
      Type.Object(
        {
          id,
          name,
          ...cameraPose,
          aspect: Type.Union(directorAspects.map((item) => Type.Literal(item))),
          lookAt: Type.Optional(id),
          keys: Type.Array(Type.Object({ ...cameraPose, ...key }, strict), { maxItems: 120 }),
        },
        strict,
      ),
      { maxItems: 24 },
    ),
  },
  strict,
);
export type DirectorScene = Static<typeof DirectorScene>;
export type DirectorCamera = DirectorScene["cameras"][number];

export function validDirectorScene(scene: DirectorScene) {
  const items = [...scene.characters, ...scene.props, ...scene.cameras];
  return (
    new Set(items.map(({ id }) => id)).size === items.length &&
    (!scene.activeCameraId || scene.cameras.some(({ id }) => id === scene.activeCameraId)) &&
    [...scene.characters, ...scene.cameras].every(({ keys }) =>
      keys.every(
        ({ t }, index) => t <= scene.duration && (index === 0 || t > (keys[index - 1]?.t ?? 0)),
      ),
    )
  );
}
