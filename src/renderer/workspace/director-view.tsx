import type { DirectorCamera, DirectorScene } from "@link-studio/core";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Vector3 } from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { directorAspectRatio } from "./director-frame-size";
import { attachFreeCamera } from "./director-free-camera";
import { fitFrame } from "./director-layout";
import { createDirectorRenderer } from "./director-renderer";
import { type PendingPoses, sampleCamera, sampleCharacter } from "./director-sample";
import { useMeasuredBox } from "./director-workbench";
import type { useDirectorModels } from "./use-director-models";

export type CameraTransform = Pick<DirectorCamera, "x" | "y" | "z" | "yaw" | "pitch" | "fov">;
const defaultSceneView: CameraTransform = {
  x: 6.5,
  y: 5,
  z: 8.5,
  yaw: (Math.atan2(-6.5, 8.5) * 180) / Math.PI,
  pitch: (Math.atan2(-4, Math.hypot(6.5, 8.5)) * 180) / Math.PI,
  fov: 50,
};
export function DirectorView({
  models,
  scene,
  selectedId,
  time,
  cameraView,
  editCamera,
  cameraGesture,
  labels,
  snap,
  rotate,
  select,
  transform,
  focusRef,
  viewPoseRef,
  pending,
  disabled,
}: {
  models: ReturnType<typeof useDirectorModels>;
  scene: DirectorScene;
  selectedId?: string;
  time: number;
  cameraView: boolean;
  editCamera?: (move: (pose: CameraTransform) => Partial<CameraTransform>) => void;
  cameraGesture: (phase: "begin" | "end") => void;
  labels: boolean;
  snap: boolean;
  rotate: boolean;
  select: (id: string) => void;
  transform: (id: string, patch: Partial<CameraTransform>) => void;
  focusRef: React.RefObject<(() => void) | null>;
  viewPoseRef: React.RefObject<(() => CameraTransform | undefined) | null>;
  pending: PendingPoses;
  disabled: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<ReturnType<typeof createDirectorRenderer>>(null);
  const [failed, setFailed] = useState(false);
  const [sceneView, setSceneView] = useState(defaultSceneView);
  const host = useRef<HTMLDivElement>(null),
    box = useMeasuredBox(host, true, true);
  const gizmo = useRef<TransformControls | null>(null),
    busy = useRef(false),
    skipPick = useRef(false);
  const [tags, setTags] = useState<
    { id: string; text: string; x: number; y: number; draft: boolean }[]
  >([]);
  const figureStatus = models.status;
  const active = scene.cameras.find(({ id }) => id === scene.activeCameraId);
  const ratio = cameraView ? (active?.aspect ?? "16:9") : "16:9";
  const interactive = !disabled && (!cameraView || !!editCamera);
  const pose = active && (pending.cameras.get(active.id) ?? sampleCamera(active, time));
  const latest = useRef({ sceneView, pose, editCamera, cameraGesture });
  latest.current = { sceneView, pose, editCamera, cameraGesture };
  const events = useRef({ transform, selectedId, scene });
  events.current = { transform, selectedId, scene };
  viewPoseRef.current = () => {
    const projection = engine.current?.projection;
    if (!projection) return;
    const direction = projection.getWorldDirection(new Vector3());
    return {
      x: projection.position.x,
      y: Math.max(0.2, projection.position.y),
      z: projection.position.z,
      yaw: (Math.atan2(direction.x, -direction.z) * 180) / Math.PI,
      pitch: (Math.asin(Math.max(-1, Math.min(1, direction.y))) * 180) / Math.PI,
      fov: projection.fov,
    };
  };
  focusRef.current = () => {
    const renderer = engine.current,
      model = selectedId && renderer?.stage.objectOf(selectedId);
    if (!renderer || !model || cameraView) return;
    const point = model.position.clone();
    if (point.y < 0.5) point.y = 1;
    point.addScaledVector(renderer.projection.getWorldDirection(new Vector3()), -4.5);
    setSceneView((view) => ({ ...view, x: point.x, y: point.y, z: point.z }));
  };
  useEffect(() => {
    if (!canvas.current) return;
    try {
      const renderer = createDirectorRenderer(canvas.current);
      engine.current = renderer;
      const control = new TransformControls(renderer.projection, canvas.current);
      gizmo.current = control;
      control.size = 0.85;
      renderer.world.add(control.getHelper());
      control.addEventListener("change", renderer.redraw);
      control.addEventListener("mouseDown", () => {
        busy.current = skipPick.current = true;
        latest.current.cameraGesture("begin");
      });
      control.addEventListener("mouseUp", () => {
        busy.current = false;
        latest.current.cameraGesture("end");
      });
      control.addEventListener("objectChange", () => {
        const { selectedId, scene, transform } = events.current,
          object = control.object;
        if (!object || !selectedId) return;
        transform(selectedId, {
          x: object.position.x,
          z: object.position.z,
          yaw: (-object.rotation.y * 180) / Math.PI,
          ...(scene.cameras.some((item) => item.id === selectedId) && {
            y: object.position.y,
            pitch: (object.rotation.x * 180) / Math.PI,
          }),
        });
      });
      return () => {
        if (busy.current) latest.current.cameraGesture("end");
        control.removeEventListener("change", renderer.redraw);
        control.dispose();
        gizmo.current = null;
        renderer.dispose();
        engine.current = null;
      };
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    const element = canvas.current,
      renderer = engine.current;
    if (!interactive || !element || !renderer) return;
    const controller = attachFreeCamera({
      element,
      camera: renderer.projection,
      allowPan: !cameraView,
      gizmoBusy: busy,
      driver: {
        read: () => {
          return cameraView ? latest.current.pose : latest.current.sceneView;
        },
        write: (patch) => {
          if (cameraView) latest.current.editCamera?.(() => patch);
          else setSceneView((view) => ({ ...view, ...patch }));
        },
        begin: () => {
          if (cameraView) latest.current.cameraGesture("begin");
        },
        end: () => {
          if (cameraView) latest.current.cameraGesture("end");
        },
      },
    });
    let previous = performance.now(),
      frame: number;
    const tick = (now: number) => {
      controller.tick((now - previous) / 1000);
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      controller.dispose();
    };
  }, [cameraView, interactive, active?.id]);
  useEffect(() => {
    const renderer = engine.current;
    if (!renderer || figureStatus === "loading") return;
    if (!box.width || !box.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1),
      aspect = box.width / box.height,
      ratioValue = directorAspectRatio(ratio);
    const viewed =
      cameraView && active && (pending.cameras.get(active.id) ?? sampleCamera(active, time));
    const current = viewed
      ? {
          ...viewed,
          fov:
            aspect >= ratioValue
              ? viewed.fov
              : (2 *
                  Math.atan((Math.tan((viewed.fov * Math.PI) / 360) * ratioValue) / aspect) *
                  180) /
                Math.PI,
        }
      : sceneView;
    renderer.renderOverview(
      scene,
      time,
      Math.floor(box.width * dpr),
      Math.floor(box.height * dpr),
      current,
      selectedId,
      pending,
      viewed ? active?.id : undefined,
      aspect,
    );
    const control = gizmo.current,
      target = selectedId && renderer.stage.objectOf(selectedId);
    if (control) {
      const camera = scene.cameras.some((item) => item.id === selectedId);
      if (!target || cameraView || disabled) {
        if (control.object) control.detach();
      } else {
        if (control.object !== target) control.attach(target);
        control.mode = rotate ? "rotate" : "translate";
        control.showX = !rotate || camera;
        control.showY = rotate || camera;
        control.showZ = !rotate;
        control.translationSnap = snap ? 0.25 : null;
        control.rotationSnap = snap ? Math.PI / 12 : null;
      }
      renderer.redraw();
    }
    const next: { id: string; text: string; x: number; y: number; draft: boolean }[] = [];
    const tag = (id: string, text: string, x: number, y: number, z: number, draft = false) => {
      const projected = new Vector3(x, y, z).project(renderer.projection);
      if (projected.z < 1)
        next.push({
          id: JSON.stringify([id, draft]),
          text,
          x: ((projected.x + 1) * box.width) / 2,
          y: ((1 - projected.y) * box.height) / 2,
          draft,
        });
    };
    for (const actor of scene.characters) {
      if (actor.hidden) continue;
      const pose = pending.characters.get(actor.id) ?? sampleCharacter(actor, time);
      if (labels) tag(actor.id, actor.name, pose.x, 1.95 * (actor.scale || 1), pose.z);
      if (pending.characters.has(actor.id)) tag(actor.id, "未记录 · 按 K", pose.x, 0, pose.z, true);
    }
    for (const camera of scene.cameras) {
      const pose = pending.cameras.get(camera.id) ?? sampleCamera(camera, time);
      if (labels) tag(camera.id, camera.name, pose.x, pose.y + 0.3, pose.z);
      if (pending.cameras.has(camera.id))
        tag(camera.id, "未记录 · 按 K", pose.x, pose.y + 0.3, pose.z, true);
    }
    setTags(next);
  }, [
    scene,
    sceneView,
    time,
    ratio,
    cameraView,
    active,
    pending,
    selectedId,
    rotate,
    snap,
    box,
    disabled,
    labels,
    figureStatus,
  ]);
  const start = useRef<[number, number] | null>(null),
    frame = fitFrame(Math.round(box.width), Math.round(box.height), directorAspectRatio(ratio));
  const hint = cameraView
    ? "机位视角 · 左键按住拖动调整朝向 · 滚轮上下摇 · Ctrl / Alt + 滚轮变焦 · WASD / 方向键平移机位 · 要摆人物请切回导演视角"
    : "导演视角 · 左键按住拖动 · 右键按住平移 · 滚轮上下摇 · Ctrl / Alt + 滚轮变焦 · WASD / 方向键平移 · 点选对象后拖动彩色轴";
  return (
    <div className="director-primary-view" ref={host}>
      {failed ? (
        <p role="status">此设备暂时无法开启 3D 预览，场景仍可编辑和保存。</p>
      ) : (
        <canvas
          ref={canvas}
          role="img"
          aria-label={cameraView ? "机位预览" : "场景预览"}
          aria-describedby="director-scene-gestures"
          data-figure-status={figureStatus}
          tabIndex={0}
          onPointerDownCapture={(event) => {
            start.current = [event.clientX, event.clientY];
            skipPick.current = false;
          }}
          onClick={(event) => {
            const point = start.current,
              renderer = engine.current;
            if (
              !renderer ||
              !interactive ||
              cameraView ||
              skipPick.current ||
              !point ||
              Math.hypot(point[0] - event.clientX, point[1] - event.clientY) > 4
            )
              return;
            const rect = event.currentTarget.getBoundingClientRect();
            select(
              renderer.pick(
                (2 * (event.clientX - rect.left)) / rect.width - 1,
                1 - (2 * (event.clientY - rect.top)) / rect.height,
              ) ?? "",
            );
          }}
        />
      )}
      <div className="director-labels">
        {tags.map((tag) => (
          <span key={tag.id} data-draft={tag.draft} style={{ left: tag.x, top: tag.y }}>
            {tag.text}
          </span>
        ))}
      </div>
      {cameraView && active && pose && frame.width > 0 && (
        <div className="director-film-frame" data-camera-frame style={frame}>
          <span>
            {active.name} · {ratio} · FOV {Math.round(pose.fov)}°
          </span>
          {pending.cameras.has(active.id) && <span>未记录 · 按 K 记录关键帧</span>}
        </div>
      )}
      <span id="director-scene-gestures" title={hint}>
        {hint}
      </span>
      {figureStatus === "simplified" && (
        <div role="status" className="director-model-warning">
          <TriangleAlert />
          人物模型加载失败，已用简化形体代替（导出仍可用）
          <button type="button" onClick={models.retry}>
            重试
          </button>
        </div>
      )}
      {!scene.characters.length && !scene.cameras.length && !scene.props.length && (
        <p className="director-empty-stage">添加人物或机位开始摆位</p>
      )}
    </div>
  );
}
