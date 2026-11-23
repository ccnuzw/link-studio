import type { DirectorScene } from "@link-studio/core";
import {
  Box3,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SkinnedMesh,
  SphereGeometry,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import femaleAsset from "./director-assets/female.glb?inline";
import maleAsset from "./director-assets/male.glb?inline";
import { applyBoneRotations, captureRest } from "./director-pose";
import { POSE_ROTATIONS } from "./director-poses";

type Figure = DirectorScene["characters"][number];
type Model = NonNullable<Figure["model"]>;
type Template = { body: Group; mesh: SkinnedMesh; scale: number };

const files = { male: maleAsset, female: femaleAsset };
const heights = { male: 1.78, female: 1.68 };
const models = new Map<Model, Promise<boolean>>();
const templates = new Map<Model, Template>();
const poses = new Map<string, Group>();
const sharedGeometry = new WeakSet<object>();

function findSkin(root: Object3D) {
  let mesh: SkinnedMesh | undefined;
  root.traverse((node) => {
    if (node instanceof SkinnedMesh) mesh ??= node;
  });
  if (!mesh) throw new Error("人物模型缺少骨骼网格");
  return mesh;
}

function bounds(mesh: SkinnedMesh) {
  mesh.updateWorldMatrix(true, true);
  const box = new Box3();
  const point = new Vector3();
  const count = mesh.geometry.getAttribute("position").count;
  for (let index = 0; index < count; index++) {
    mesh.getVertexPosition(index, point);
    box.expandByPoint(point.applyMatrix4(mesh.matrixWorld));
  }
  return box;
}

export function measureFigure(group: Group) {
  group.updateMatrixWorld(true);
  return bounds(findSkin(group));
}

export function loadFigureModel(model: Model) {
  const existing = models.get(model);
  if (existing) return existing;
  const result = Promise.resolve()
    .then(async () => {
      const uri = files[model];
      const bytes = Uint8Array.from(atob(uri.slice(uri.indexOf(",") + 1)), (byte) =>
        byte.charCodeAt(0),
      );
      const { scene } = await new GLTFLoader().parseAsync(bytes.buffer, "");
      const body = new Group();
      body.rotation.y = Math.PI;
      body.add(scene);
      body.updateMatrixWorld(true);
      const mesh = findSkin(body);
      const height = bounds(mesh).getSize(new Vector3()).y;
      if (!(height > 0)) return false;
      sharedGeometry.add(mesh.geometry);
      templates.set(model, { body, mesh, scale: heights[model] / height });
      return true;
    })
    .catch(() => false)
    .then((ready) => {
      if (!ready) models.delete(model);
      return ready;
    });
  models.set(model, result);
  return result;
}

export const figureModelStatus = (model: Model = "male") =>
  templates.has(model) ? "ready" : "unavailable";

export async function loadDirectorFigures(characters: Figure[]) {
  const results = await Promise.all(
    [...new Set(characters.map(({ model }) => model ?? "male"))].map(loadFigureModel),
  );
  return results.every(Boolean);
}

function posedFigure(figure: Pick<Figure, "model" | "pose">) {
  const model = figure.model ?? "male";
  const key = `${model}:${figure.pose}`;
  const cached = poses.get(key);
  if (cached) return cached;
  const template = templates.get(model);
  if (!template) return undefined;
  const posed = clone(template.body);
  const mesh = findSkin(posed);
  applyBoneRotations(
    mesh.skeleton,
    captureRest(template.mesh.skeleton),
    POSE_ROTATIONS[figure.pose],
  );
  const body = new Group();
  body.scale.setScalar(template.scale);
  body.add(posed);
  body.updateMatrixWorld(true);
  const extent = bounds(mesh);
  const group = new Group();
  group.add(body);
  body.position.y = -extent.min.y;
  poses.set(key, group);
  return group;
}

export function createFigure(figure: Pick<Figure, "model" | "pose" | "color">) {
  const posed = posedFigure(figure);
  const material = new MeshStandardMaterial({
    color: figure.color,
    roughness: 0.7,
    metalness: 0.05,
  });
  if (!posed) {
    const group = new Group(),
      body = new Mesh(new CapsuleGeometry(0.24, 1.1, 4, 12), material),
      head = new Mesh(new SphereGeometry(0.115, 20, 14), material);
    body.position.y = 0.83;
    head.position.y = 1.66;
    body.castShadow = head.castShadow = true;
    group.add(body, head);
    return { group, material };
  }
  const group = clone(posed) as Group;
  group.traverse((node) => {
    if (node instanceof Mesh) {
      node.material = material;
      node.castShadow = true;
      node.frustumCulled = false;
    }
  });
  return { group, material };
}

export function disposeDirectorMesh(
  mesh: SkinnedMesh | import("three").Mesh | import("three").GridHelper,
) {
  if (mesh instanceof SkinnedMesh) mesh.skeleton.dispose();
  if (!sharedGeometry.has(mesh.geometry)) mesh.geometry.dispose();
}
