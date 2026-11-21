import type { DirectorCamera, DirectorScene } from "@link-studio/core";
import { useEffect, useRef, useState } from "react";
import * as Three from "three";
import {
  createDirectorFigure,
  disposeDirectorMesh,
  figureAimHeight,
  loadDirectorFigures,
} from "./director-figures";
import { buildPropObject } from "./director-prop-object";

type Pose = { x: number; z: number; yaw: number; y?: number; pitch?: number; fov?: number };
type Key = Pose & { t: number; ease: "smooth" | "linear" };
export type CameraTransform = Pick<DirectorCamera, "x" | "y" | "z" | "yaw" | "pitch" | "fov">;
type SceneView = { yaw: number; pitch: number; distance: number; x: number; z: number };
const defaultSceneView: SceneView = {
  yaw: Math.atan2(8, 12),
  pitch: Math.atan2(10, Math.hypot(8, 12)),
  distance: Math.hypot(8, 10, 12),
  x: 0,
  z: 0,
};

function moveSceneView(view: SceneView, dx: number, dy: number, pan: boolean): SceneView {
  if (pan) {
    const speed = view.distance * 0.0025;
    const sin = Math.sin(view.yaw);
    const cos = Math.cos(view.yaw);
    return {
      ...view,
      x: Three.MathUtils.clamp(view.x - (dx * cos + dy * sin) * speed, -1000, 1000),
      z: Three.MathUtils.clamp(view.z + (dx * sin - dy * cos) * speed, -1000, 1000),
    };
  }
  return {
    ...view,
    yaw: (view.yaw - dx * 0.008) % (2 * Math.PI),
    pitch: Three.MathUtils.clamp(view.pitch + dy * 0.008, 0.05, Math.PI / 2 - 0.02),
  };
}

export function samplePose(pose: Pose, keys: Key[], time: number): Pose {
  const first = keys[0];
  if (!first) return pose;
  if (time <= first.t) return first;
  const index = keys.findIndex(({ t }) => t >= time);
  if (index < 1) return keys.at(-1) ?? first;
  const start = keys[index - 1] ?? first;
  const end = keys[index] ?? start;
  const progress = (time - start.t) / (end.t - start.t);
  const weight = start.ease === "smooth" ? progress ** 2 * (3 - 2 * progress) : progress;
  const mix = (from: number, to: number) => from + (to - from) * weight;
  return {
    x: mix(start.x, end.x),
    z: mix(start.z, end.z),
    yaw: start.yaw + (((((end.yaw - start.yaw) % 360) + 540) % 360) - 180) * weight,
    y: mix(start.y ?? 0, end.y ?? 0),
    pitch: mix(start.pitch ?? 0, end.pitch ?? 0),
    fov: mix(start.fov ?? 45, end.fov ?? 45),
  };
}

export function cameraDirection(scene: DirectorScene, camera: DirectorCamera, time: number) {
  const pose = samplePose(camera, camera.keys, time);
  const target = scene.characters.find(({ id }) => id === camera.lookAt);
  const position = new Three.Vector3(pose.x, pose.y ?? 1.6, pose.z);
  if (target) {
    const actor = samplePose(target, target.keys, time);
    const direction = new Three.Vector3(actor.x, figureAimHeight(target), actor.z).sub(position);
    if (direction.lengthSq() > 1e-8) return direction.normalize();
  }
  const yaw = Three.MathUtils.degToRad(pose.yaw);
  const pitch = Three.MathUtils.degToRad(pose.pitch ?? 0);
  return new Three.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
}

function addMesh(
  group: Three.Object3D,
  geometry: Three.BufferGeometry,
  color: string,
  height: number,
) {
  const mesh = new Three.Mesh(geometry, new Three.MeshStandardMaterial({ color }));
  mesh.position.y = height;
  group.add(mesh);
  return mesh;
}

export function DirectorView({
  scene,
  time,
  cameraView,
  editCamera,
  guides,
}: {
  scene: DirectorScene;
  time: number;
  cameraView: boolean;
  editCamera?: (move: (pose: CameraTransform) => Partial<CameraTransform>) => void;
  guides: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Three.WebGLRenderer>(null);
  const [failed, setFailed] = useState(false);
  const [sceneView, setSceneView] = useState(defaultSceneView);
  const drag = useRef<{ id: number; x: number; y: number; pan: boolean }>(undefined);
  const zoom = (factor: number) => {
    setSceneView((view) => ({
      ...view,
      distance: Three.MathUtils.clamp(view.distance * factor, 1, 100),
    }));
  };
  const [figureStatus, setFigureStatus] = useState<"loading" | "ready" | "simplified">("loading");
  const active = scene.cameras.find(({ id }) => id === scene.activeCameraId);
  const ratio = cameraView ? (active?.aspect ?? "16:9") : "16:9";
  const interactive = !cameraView || !!editCamera;
  function moveCamera(dx: number, dy: number, pan: boolean) {
    editCamera?.((pose) => {
      const yaw = Three.MathUtils.degToRad(pose.yaw);
      return pan
        ? {
            x: Three.MathUtils.clamp(pose.x - dx * Math.cos(yaw) * 0.01, -1000, 1000),
            z: Three.MathUtils.clamp(pose.z - dx * Math.sin(yaw) * 0.01, -1000, 1000),
            y: Three.MathUtils.clamp(pose.y + dy * 0.01, -1000, 1000),
          }
        : {
            yaw: (pose.yaw - dx * 0.2) % 360,
            pitch: Three.MathUtils.clamp(pose.pitch + dy * 0.2, -89, 89),
          };
    });
  }
  useEffect(() => {
    const element = canvas.current;
    if (!element || !cameraView || !editCamera) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1;
      editCamera((pose) => ({
        fov: Three.MathUtils.clamp(pose.fov * Math.exp(event.deltaY * factor * 0.001), 10, 120),
      }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [cameraView, editCamera]);
  useEffect(() => {
    if (!canvas.current) return;
    try {
      const renderer = new Three.WebGLRenderer({ canvas: canvas.current, antialias: true });
      engine.current = renderer;
      return () => {
        renderer.dispose();
        renderer.forceContextLoss();
        engine.current = null;
      };
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    let current = true;
    setFigureStatus("loading");
    void loadDirectorFigures(scene.characters).then((ready) => {
      if (current) setFigureStatus(ready ? "ready" : "simplified");
    });
    return () => {
      current = false;
    };
  }, [scene.characters]);
  useEffect(() => {
    const renderer = engine.current;
    if (renderer && figureStatus !== "loading")
      renderDirectorFrame(renderer, scene, time, cameraView, undefined, sceneView);
  }, [cameraView, figureStatus, scene, sceneView, time]);
  return failed ? (
    <p role="status">此设备暂时无法开启 3D 预览，场景仍可编辑和保存。</p>
  ) : (
    <>
      <div
        className="director-frame"
        style={{
          width: `min(100%, ${directorFrameSize(ratio).width}px, calc(42dvh * (${ratio.replace(":", " / ")})))`,
        }}
      >
        <canvas
          ref={canvas}
          role="img"
          aria-label={cameraView ? "机位预览" : "场景预览"}
          aria-describedby={interactive ? "director-scene-gestures" : undefined}
          tabIndex={interactive ? 0 : undefined}
          data-figure-status={figureStatus}
          data-interactive={interactive}
          onPointerDown={(event) => {
            if (!interactive || event.button !== 0 || !event.isPrimary) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              pan: event.shiftKey,
            };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!interactive || !start || start.id !== event.pointerId) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            drag.current = { ...start, x: event.clientX, y: event.clientY };
            if (cameraView) moveCamera(dx, dy, start.pan);
            else setSceneView((view) => moveSceneView(view, dx, dy, start.pan));
          }}
          onLostPointerCapture={(event) => {
            if (drag.current?.id === event.pointerId) drag.current = undefined;
          }}
          onKeyDown={(event) => {
            if (!interactive || event.metaKey || event.ctrlKey || event.altKey) return;
            const step = {
              ArrowLeft: [-20, 0],
              ArrowRight: [20, 0],
              ArrowUp: [0, -15],
              ArrowDown: [0, 15],
            }[event.key];
            if (step) {
              event.preventDefault();
              const [dx = 0, dy = 0] = step;
              if (cameraView) moveCamera(dx, dy, event.shiftKey);
              else setSceneView((view) => moveSceneView(view, dx, dy, event.shiftKey));
            }
          }}
          style={{ aspectRatio: ratio.replace(":", " / ") }}
        />
        {cameraView && active && (
          <>
            {guides && <div className="director-thirds" aria-hidden="true" />}
            <span className="director-frame-label">
              {active.name} · {ratio} ·{" "}
              {Math.round(samplePose(active, active.keys, time).fov ?? active.fov)}°
            </span>
          </>
        )}
      </div>
      {figureStatus === "simplified" && <p role="status">人物模型无法加载，正在使用简模预览。</p>}
      {!cameraView && (
        <div className="director-scene-tools">
          <small id="director-scene-gestures">拖动或方向键旋转，按住 Shift 平移</small>
          <fieldset aria-label="场景视角">
            <button type="button" onClick={() => zoom(0.8)}>
              放大视角
            </button>
            <button type="button" onClick={() => zoom(1.25)}>
              缩小视角
            </button>
            <button type="button" onClick={() => setSceneView(defaultSceneView)}>
              重置视角
            </button>
          </fieldset>
        </div>
      )}
      {cameraView && editCamera && (
        <small id="director-scene-gestures" className="director-camera-gestures">
          拖动或方向键转动机位，按住 Shift 平移，滚轮调整视场角。
        </small>
      )}
    </>
  );
}

export function directorFrameSize(ratio: string, maxWidth = 900, maxHeight = 500) {
  const [width = 16, height = 9] = ratio.split(":").map(Number);
  const aspect = width / height;
  return {
    width: Math.round(Math.min(maxWidth, maxHeight * aspect) / 2) * 2,
    height: Math.round(Math.min(maxWidth / aspect, maxHeight) / 2) * 2,
  };
}

export function renderDirectorFrame(
  renderer: Three.WebGLRenderer,
  scene: DirectorScene,
  time: number,
  cameraView: boolean,
  size?: { width: number; height: number },
  sceneView = defaultSceneView,
) {
  const active = scene.cameras.find(({ id }) => id === scene.activeCameraId);
  const { width, height } =
    size ?? directorFrameSize(cameraView ? (active?.aspect ?? "16:9") : "16:9");
  const aspect = width / height;
  const canvas = renderer.domElement;
  if (canvas.width !== width || canvas.height !== height) renderer.setSize(width, height, false);
  const stage = new Three.Scene();
  stage.background = new Three.Color("#23283a");
  stage.add(
    new Three.GridHelper(40, 40, "#6a79a0", "#394256"),
    new Three.HemisphereLight("#edf4ff", "#414657", 2.5),
  );
  const keyLight = new Three.DirectionalLight("#fff1d7", 2);
  keyLight.position.set(3, 8, 5);
  stage.add(keyLight);
  for (const figure of scene.characters.filter(({ hidden }) => !hidden)) {
    const pose = samplePose(figure, figure.keys, time);
    const model = createDirectorFigure(figure);
    const group = model ?? new Three.Group();
    group.position.set(pose.x, 0, pose.z);
    group.rotation.y = Three.MathUtils.degToRad(pose.yaw);
    group.scale.setScalar(figure.scale);
    if (!model) {
      addMesh(group, new Three.CapsuleGeometry(0.23, 0.92), figure.color, 0.72);
      addMesh(group, new Three.SphereGeometry(0.19), figure.color, 1.57);
      addMesh(group, new Three.BoxGeometry(0.12, 0.09, 0.24), "#edf2ff", 1.57).position.z = -0.15;
    }
    stage.add(group);
  }
  for (const prop of scene.props.filter(({ hidden }) => !hidden)) {
    const object = buildPropObject(
      prop.shape,
      new Three.MeshStandardMaterial({ color: "#8e9fbd" }),
    );
    object.scale.set(prop.w, prop.h, prop.d);
    object.position.set(prop.x, 0, prop.z);
    object.rotation.y = Three.MathUtils.degToRad(prop.yaw);
    stage.add(object);
  }
  const camera = new Three.PerspectiveCamera(45, aspect, 0.05, 3000);
  if (cameraView && active) {
    const pose = samplePose(active, active.keys, time);
    camera.fov = pose.fov ?? 45;
    camera.position.set(pose.x, pose.y ?? 1.6, pose.z);
    camera.lookAt(camera.position.clone().add(cameraDirection(scene, active, time)));
  } else {
    const { x, z, yaw, pitch, distance } = sceneView;
    const horizontal = distance * Math.cos(pitch);
    camera.position.set(
      x + horizontal * Math.sin(yaw),
      distance * Math.sin(pitch),
      z + horizontal * Math.cos(yaw),
    );
    camera.lookAt(x, 0, z);
    for (const item of scene.cameras) {
      const pose = samplePose(item, item.keys, time);
      const mesh = addMesh(
        stage,
        new Three.ConeGeometry(0.23, 0.45, 4),
        item.id === active?.id ? "#ffc675" : "#9bb3ee",
        pose.y ?? 1.6,
      );
      mesh.position.x = pose.x;
      mesh.position.z = pose.z;
      mesh.quaternion.setFromUnitVectors(
        new Three.Vector3(0, 1, 0),
        cameraDirection(scene, item, time),
      );
    }
  }
  camera.updateProjectionMatrix();
  try {
    renderer.render(stage, camera);
  } finally {
    const materials = new Set<Three.Material>();
    stage.traverse((item) => {
      if (item instanceof Three.Mesh || item instanceof Three.GridHelper) {
        disposeDirectorMesh(item);
        for (const material of Array.isArray(item.material) ? item.material : [item.material])
          materials.add(material);
      }
    });
    for (const material of materials) material.dispose();
  }
}
