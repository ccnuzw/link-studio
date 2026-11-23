import type { DirectorScene } from "@link-studio/core";
import {
  ACESFilmicToneMapping,
  Color,
  Fog,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from "three";
import {
  type CameraPose,
  type PendingPoses,
  sampleCamera,
  sampleCharacter,
} from "./director-sample";
import { applyCameraPose, createStage, STAGE_BACKGROUND } from "./director-stage";

export function createDirectorRenderer(canvas?: HTMLCanvasElement) {
  const engine = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: !canvas });
  engine.setPixelRatio(1);
  engine.shadowMap.enabled = true;
  if (canvas) {
    engine.toneMapping = ACESFilmicToneMapping;
    engine.shadowMap.type = PCFSoftShadowMap;
  }
  const world = new Scene();
  world.background = new Color(STAGE_BACKGROUND);
  world.fog = new Fog(STAGE_BACKGROUND, 20, 45);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.05, 200),
    stage = createStage({ helpers: !!canvas });
  world.add(stage.root);
  function sync(
    scene: DirectorScene,
    time: number,
    width: number,
    height: number,
    helpers: boolean,
    selectedId?: string,
    pending?: PendingPoses,
  ) {
    if (engine.domElement.width !== width || engine.domElement.height !== height)
      engine.setSize(width, height, false);
    stage.guides.visible = stage.helpers.visible = helpers;
    stage.sync(
      scene,
      (id) => {
        const actor = scene.characters.find((item) => item.id === id);
        if (actor) return pending?.characters.get(id) ?? sampleCharacter(actor, time);
        const item = scene.cameras.find((item) => item.id === id);
        if (item) return pending?.cameras.get(id) ?? sampleCamera(item, time);
      },
      { selectedId },
    );
  }
  return {
    stage,
    world,
    redraw: () => engine.render(world, camera),
    pick(x: number, y: number) {
      const ray = new Raycaster();
      ray.setFromCamera(new Vector2(x, y), camera);
      const hit = ray.intersectObjects(stage.pickables(), true)[0];
      return hit && stage.idOf(hit.object);
    },
    canvas: engine.domElement,
    projection: camera,
    renderShot(
      scene: DirectorScene,
      time: number,
      width: number,
      height: number,
      pending?: PendingPoses,
    ) {
      const active = scene.cameras.find((item) => item.id === scene.activeCameraId);
      if (!active) return false;
      sync(scene, time, width, height, false, undefined, pending);
      applyCameraPose(
        camera,
        pending?.cameras.get(active.id) ?? sampleCamera(active, time),
        width / height,
      );
      engine.render(world, camera);
      return true;
    },
    renderOverview(
      scene: DirectorScene,
      time: number,
      width: number,
      height: number,
      pose: CameraPose,
      selectedId?: string,
      pending?: PendingPoses,
      viewedId?: string,
      aspect = width / height,
    ) {
      sync(scene, time, width, height, true, selectedId, pending);
      for (const item of scene.cameras) {
        const model = stage.objectOf(item.id);
        if (model) model.visible = item.id !== viewedId;
      }
      applyCameraPose(camera, pose, aspect);
      engine.render(world, camera);
    },
    dispose() {
      stage.dispose();
      engine.dispose();
      engine.forceContextLoss();
    },
  };
}
