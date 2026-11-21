import type { DirectorScene } from "@link-studio/core";
import { Box3, Group, MeshStandardMaterial, type Object3D, SkinnedMesh, Vector3 } from "three";
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
const poses = new Map<string, { body: Group; aim: number }>();
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

function loadModel(model: Model) {
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
    .catch(() => false);
  models.set(model, result);
  return result;
}

export async function loadDirectorFigures(characters: Figure[]) {
  const results = await Promise.all(
    [
      ...new Set(characters.filter(({ hidden }) => !hidden).map(({ model }) => model ?? "male")),
    ].map(loadModel),
  );
  return results.every(Boolean);
}

function posedFigure(figure: Figure) {
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
  const entry = { body: group, aim: (extent.max.y - extent.min.y) * 0.72 };
  poses.set(key, entry);
  return entry;
}

export function createDirectorFigure(figure: Figure) {
  const posed = posedFigure(figure);
  if (!posed) return undefined;
  const group = clone(posed.body);
  const mesh = findSkin(group);
  mesh.material = new MeshStandardMaterial({ color: figure.color, roughness: 0.7 });
  mesh.frustumCulled = false;
  return group;
}

export function figureAimHeight(figure: Figure) {
  return (
    (posedFigure(figure)?.aim ?? (figure.pose === "sit" || figure.pose === "crouch" ? 0.8 : 1.2)) *
    figure.scale
  );
}

export function disposeDirectorMesh(
  mesh: SkinnedMesh | import("three").Mesh | import("three").GridHelper,
) {
  if (mesh instanceof SkinnedMesh) mesh.skeleton.dispose();
  if (!sharedGeometry.has(mesh.geometry)) mesh.geometry.dispose();
}
