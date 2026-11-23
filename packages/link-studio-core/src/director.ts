import { type Static, Type } from "@sinclair/typebox";

const strict = { additionalProperties: false };
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$" });
const name = Type.String({ minLength: 1, maxLength: 80 });
const coordinate = Type.Number();
const angle = Type.Number();
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
          keys: Type.Array(Type.Object({ ...position, ...key }, strict), { maxItems: 1501 }),
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
          d: Type.Number({ minimum: 0.02, maximum: 100 }),
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
          keys: Type.Array(Type.Object({ ...cameraPose, ...key }, strict), { maxItems: 1501 }),
        },
        strict,
      ),
      { maxItems: 24 },
    ),
  },
  strict,
);
export type DirectorScene = Static<typeof DirectorScene>;
export function defaultDirectorScene(): DirectorScene {
  const actor = crypto.randomUUID(),
    camera = crypto.randomUUID();
  return {
    version: 1,
    duration: 5,
    activeCameraId: camera,
    characters: [
      {
        id: actor,
        name: "角色A",
        model: "male",
        pose: "stand",
        color: "#d4d4d8",
        scale: 1,
        x: 0,
        z: 0,
        yaw: 180,
        keys: [],
      },
    ],
    props: [],
    cameras: [
      {
        id: camera,
        name: "机位1",
        aspect: "16:9",
        x: 0,
        y: 1.6,
        z: 4,
        yaw: 0,
        pitch: (Math.atan2(1.3 - 1.6, 4) * 180) / Math.PI,
        fov: 50,
        lookAt: actor,
        keys: [],
      },
    ],
  };
}
export type DirectorCamera = DirectorScene["cameras"][number];

export function cloneDirectorScene(scene: DirectorScene, newId: () => string) {
  const copy = structuredClone(scene),
    ids = new Map<string, string>();
  for (const item of [...copy.characters, ...copy.props, ...copy.cameras]) {
    const id = newId();
    ids.set(item.id, id);
    item.id = id;
  }
  for (const camera of copy.cameras) {
    if (camera.lookAt) camera.lookAt = ids.get(camera.lookAt);
  }
  copy.activeCameraId = ids.get(scene.activeCameraId) ?? copy.cameras[0]?.id ?? "";
  return copy;
}
export function retimeDirectorScene(scene: DirectorScene, value: number): DirectorScene {
  const duration = Math.min(15, Math.max(1, Math.round(value * 2) / 2));
  if (duration === scene.duration) return scene;
  const retime = <Key extends { t: number }>(keys: Key[]) => [
    ...new Map(
      keys.map((key) => {
        const t = Math.round(((key.t * duration) / scene.duration) * 100) / 100;
        return [t, { ...key, t }];
      }),
    ).values(),
  ];
  return {
    ...scene,
    duration,
    characters: scene.characters.map((actor) => ({ ...actor, keys: retime(actor.keys) })),
    cameras: scene.cameras.map((camera) => ({ ...camera, keys: retime(camera.keys) })),
  };
}

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
