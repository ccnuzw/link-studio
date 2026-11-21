import type { DirectorScene } from "@link-studio/core";

type PropShape = DirectorScene["props"][number]["shape"];
type GeometryShape = "box" | "plane" | "cylinder" | "sphere";

export type PartKind = "box" | "cylinder" | "sphere";

export type Part = {
  kind: PartKind;

  center: readonly [number, number, number];

  size: readonly [number, number, number];

  axis?: "x" | "y" | "z";
};

export type PropCategory = "geometry" | "object";

export type PropPreset = {
  label: string;
  category: PropCategory;

  size: readonly [number, number, number];

  parts?: readonly Part[];
};

const box = (center: Part["center"], size: Part["size"]): Part => ({ kind: "box", center, size });

const legs = (x: number, z: number, size: Part["size"], y: number): Part[] =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sz): Part => box([sx * x, y, sz * z], size)));

const STAIR_STEPS = 5;
const stairs = (): Part[] =>
  Array.from({ length: STAIR_STEPS }, (_, i) => {
    const height = (i + 1) / STAIR_STEPS;
    const depth = 1 / STAIR_STEPS;
    return box([0, height / 2, 0.5 - depth / 2 - depth * i], [1, height, depth]);
  });

export const PROP_PRESETS: Record<PropShape, PropPreset> = {
  box: { label: "立方体", category: "geometry", size: [1, 1, 1] },
  cylinder: { label: "圆柱", category: "geometry", size: [0.6, 1, 0.6] },
  sphere: { label: "球体", category: "geometry", size: [0.8, 0.8, 0.8] },
  plane: { label: "平面", category: "geometry", size: [4, 2.5, 0.05] },

  table: {
    label: "桌子",
    category: "object",
    size: [1.4, 0.75, 0.8],
    parts: [box([0, 0.96, 0], [1, 0.08, 1]), ...legs(0.455, 0.4, [0.05, 0.92, 0.09], 0.46)],
  },
  chair: {
    label: "椅子",
    category: "object",
    size: [0.45, 0.9, 0.45],
    parts: [
      box([0, 0.5, 0], [1, 0.06, 1]),
      ...legs(0.4, 0.4, [0.1, 0.47, 0.1], 0.235),
      box([0, 0.76, 0.45], [1, 0.48, 0.1]),
    ],
  },
  sofa: {
    label: "沙发",
    category: "object",
    size: [2, 0.85, 0.9],
    parts: [
      box([0, 0.2, 0], [1, 0.4, 1]),
      box([0, 0.7, 0.375], [1, 0.6, 0.25]),
      box([-0.44, 0.55, -0.125], [0.12, 0.3, 0.75]),
      box([0.44, 0.55, -0.125], [0.12, 0.3, 0.75]),
    ],
  },
  bed: {
    label: "床",
    category: "object",
    size: [1.6, 0.6, 2],
    parts: [
      box([0, 0.175, 0], [1, 0.35, 1]),
      box([0, 0.45, 0], [0.96, 0.2, 0.96]),
      box([0, 0.675, 0.47], [1, 0.65, 0.06]),
      box([-0.24, 0.6, 0.36], [0.35, 0.1, 0.16]),
      box([0.24, 0.6, 0.36], [0.35, 0.1, 0.16]),
    ],
  },
  cabinet: {
    label: "柜子",
    category: "object",
    size: [0.9, 1.8, 0.45],
    parts: [
      box([0, 0.5, 0.02], [1, 1, 0.96]),
      box([0, 0.5, -0.48], [0.02, 0.94, 0.04]),
      box([-0.07, 0.5, -0.48], [0.04, 0.2, 0.04]),
      box([0.07, 0.5, -0.48], [0.04, 0.2, 0.04]),
    ],
  },
  door: {
    label: "门",
    category: "object",
    size: [0.95, 2.1, 0.12],
    parts: [
      box([-0.46, 0.5, 0], [0.08, 1, 1]),
      box([0.46, 0.5, 0], [0.08, 1, 1]),
      box([0, 0.975, 0], [1, 0.05, 1]),
      box([0, 0.475, 0], [0.84, 0.95, 0.4]),
      box([0.3, 0.45, -0.3], [0.06, 0.05, 0.2]),
    ],
  },
  wall: {
    label: "墙",
    category: "object",
    size: [4, 2.6, 0.2],
    parts: [box([0, 0.47, 0], [1, 0.94, 0.8]), box([0, 0.97, 0], [1, 0.06, 1])],
  },
  stairs: { label: "楼梯", category: "object", size: [1.2, 1.8, 3], parts: stairs() },
  car: {
    label: "汽车",
    category: "object",
    size: [1.9, 1.5, 4.4],
    parts: [
      box([0, 0.325, 0], [0.9, 0.35, 1]),
      box([0, 0.75, 0.05], [0.76, 0.5, 0.5]),
      ...[-1, 1].flatMap((sx) =>
        [-1, 1].map(
          (sz): Part => ({
            kind: "cylinder",
            center: [sx * 0.45, 0.15, sz * 0.32],
            size: [0.1, 0.3, 0.3],
            axis: "x",
          }),
        ),
      ),
    ],
  },
  tree: {
    label: "树",
    category: "object",
    size: [2, 4, 2],
    parts: [
      { kind: "cylinder", center: [0, 0.2, 0], size: [0.12, 0.4, 0.12] },
      { kind: "sphere", center: [0, 0.65, 0], size: [1, 0.7, 1] },
    ],
  },
};

const GEOMETRY_PART: Record<GeometryShape, PartKind> = {
  box: "box",
  plane: "box",
  cylinder: "cylinder",
  sphere: "sphere",
};

export function propParts(shape: PropShape): readonly Part[] {
  const preset = PROP_PRESETS[shape];
  if (preset.parts) return preset.parts;
  return [
    {
      kind: GEOMETRY_PART[shape as GeometryShape],
      center: [0, 0.5, 0],
      size: [1, 1, 1],
    },
  ];
}
