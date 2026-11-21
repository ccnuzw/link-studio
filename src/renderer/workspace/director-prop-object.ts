import type { DirectorScene } from "@link-studio/core";
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type MeshStandardMaterial,
  SphereGeometry,
} from "three";

import { type Part, propParts } from "./director-prop-presets";

type PropShape = DirectorScene["props"][number]["shape"];

function partGeometry(part: Part): BufferGeometry {
  if (part.kind === "box") return new BoxGeometry(1, 1, 1);
  if (part.kind === "sphere") return new SphereGeometry(0.5, 32, 20);
  const cylinder = new CylinderGeometry(0.5, 0.5, 1, 32);

  if (part.axis === "x") cylinder.rotateZ(Math.PI / 2);
  if (part.axis === "z") cylinder.rotateX(Math.PI / 2);
  return cylinder;
}

export function buildPropObject(shape: PropShape, material: MeshStandardMaterial): Group {
  const root = new Group();
  for (const part of propParts(shape)) {
    const mesh = new Mesh(partGeometry(part), material);
    mesh.position.set(...part.center);
    mesh.scale.set(...part.size);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  return root;
}
