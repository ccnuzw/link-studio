import type { DirectorScene } from "@link-studio/core";
import {
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";

type FigureModel = NonNullable<DirectorScene["characters"][number]["model"]>;
type PropShape = DirectorScene["props"][number]["shape"];

import {
  createFigure,
  disposeDirectorMesh,
  figureModelStatus,
  loadFigureModel,
  measureFigure,
} from "./director-figures";
import { buildPropObject } from "./director-prop-object";
import { PROP_PRESETS } from "./director-prop-presets";
import { createThumbCache } from "./director-thumbs";

const SIZE = 240;

const VIEW_DIRECTION = new Vector3(0.55, 0.32, -1).normalize();
const FOV = 28;

const MARGIN = 1.22;

export const characterThumbKey = (model: FigureModel) => `character:${model}`;
export const propThumbKey = (shape: PropShape) => `prop:${shape}`;

type Shooter = {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
};

let shooter: Shooter | null = null;

function getShooter(): Shooter {
  if (shooter) return shooter;
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  scene.add(new HemisphereLight(0xe4e8ff, 0x2a2a30, 1.35));
  const sun = new DirectionalLight(0xffffff, 1.9);
  sun.position.set(3, 6, -4);
  scene.add(sun);
  shooter = { renderer, scene, camera: new PerspectiveCamera(FOV, 1, 0.05, 200) };
  return shooter;
}

export function disposeThumbRenderer() {
  if (!shooter) return;
  shooter.renderer.dispose();
  shooter.renderer.forceContextLoss();
  shooter = null;
}

function shoot(object: Group, box: Box3): string {
  const { renderer, scene, camera } = getShooter();
  scene.add(object);
  try {
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.x, size.y, size.z) * MARGIN;
    const distance = radius / (2 * Math.tan((FOV / 2) * (Math.PI / 180)));
    camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/png");
  } finally {
    scene.remove(object);
    object.traverse((node) => {
      if (node instanceof Mesh) {
        disposeDirectorMesh(node);
        if (!Array.isArray(node.material)) node.material.dispose();
      }
    });
  }
}

async function renderAssetThumb(key: string): Promise<string | null> {
  const [kind, id] = key.split(":");
  if (kind === "character") {
    const model = id as FigureModel;
    await loadFigureModel(model);

    if (figureModelStatus(model) !== "ready") return null;
    const figure = createFigure({ pose: "stand", color: "#d4d4d8", model });
    return shoot(figure.group, measureFigure(figure.group));
  }
  if (kind === "prop") {
    const shape = id as PropShape;
    const material = new MeshStandardMaterial({ color: 0xa9b6c6, roughness: 0.85 });
    const root = new Group();
    const body = buildPropObject(shape, material);
    const [w, h, d] = PROP_PRESETS[shape].size;
    body.scale.set(w, h, d);
    root.add(body);
    return shoot(root, new Box3().setFromObject(root));
  }
  return null;
}

export const assetThumbs = createThumbCache(renderAssetThumb);
