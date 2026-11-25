import type { DirectorScene } from "@link-studio/core";
import { Columns2, PictureInPicture2, Plus, Video } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { directorAspectRatio } from "./director-frame-size";
import {
  clampPanel,
  DEFAULT_PANELS,
  fitFrame,
  fitPanels,
  floatingFrame,
  type PanelKind,
  type PanelSizes,
  panelMax,
} from "./director-layout";
import { readFlag, readNumber, writeFlag, writeNumber } from "./director-prefs";
import { createDirectorRenderer } from "./director-renderer";
import { type PendingPoses, sampleCamera } from "./director-sample";
import type { useDirectorModels } from "./use-director-models";

export function useMeasuredBox(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
  fractional = false,
) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const measure = () => {
      const { width, height } = fractional
        ? el.getBoundingClientRect()
        : { width: el.clientWidth, height: el.clientHeight };
      setBox((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled, fractional]);
  return box;
}
export function useDirectorPanels() {
  const [assets, setAssets] = useState(() => readFlag("assets-open", true)),
    [split, setSplit] = useState(() => readFlag("preview-split", false));
  const [area, setArea] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [preferences, setPreferences] = useState(
    () =>
      Object.fromEntries(
        Object.entries(DEFAULT_PANELS).map(([key, value]) => [
          key,
          readNumber(`panel-${key}`, value),
        ]),
      ) as PanelSizes,
  );
  const latest = useRef(preferences);
  useEffect(() => {
    const resize = () => setArea({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sizes = fitPanels(preferences, area, assets);
  function update(kind: PanelKind, value: number) {
    latest.current = {
      ...latest.current,
      [kind]: clampPanel(kind, Math.min(panelMax(kind, sizes, area, assets), value)),
    };
    setPreferences(latest.current);
  }
  function save() {
    for (const [key, value] of Object.entries(latest.current)) writeNumber(`panel-${key}`, value);
  }
  function reset(kind: PanelKind) {
    latest.current = { ...latest.current, [kind]: DEFAULT_PANELS[kind] };
    setPreferences(latest.current);
    save();
  }
  return {
    assets,
    split,
    sizes,
    update,
    save,
    reset,
    toggleAssets: () => {
      writeFlag("assets-open", !assets);
      setAssets(!assets);
    },
    toggleSplit: () => {
      writeFlag("preview-split", !split);
      setSplit(!split);
    },
  };
}

export function DirectorMonitor({
  modelStatus,
  scene,
  time,
  pending,
  split,
  share,
  toggle,
  select,
  add,
}: {
  modelStatus: ReturnType<typeof useDirectorModels>["status"];
  scene: DirectorScene;
  time: number;
  pending: PendingPoses;
  split: boolean;
  share: number;
  toggle: () => void;
  select: (id: string) => void;
  add: () => void;
}) {
  const body = useRef<HTMLDivElement>(null),
    host = useRef<HTMLDivElement>(null),
    shot = useRef<ReturnType<typeof createDirectorRenderer> | null>(null);
  const active = scene.cameras.find((camera) => camera.id === scene.activeCameraId),
    box = useMeasuredBox(body, split && !!active);
  const ratio = directorAspectRatio(active?.aspect ?? "16:9"),
    size = split ? fitFrame(box.width - 32, box.height - 32, ratio) : floatingFrame(ratio);
  const hasActive = !!active;
  useLayoutEffect(() => {
    if (!host.current || !hasActive) return;
    const renderer = createDirectorRenderer();
    shot.current = renderer;
    host.current.append(renderer.canvas);
    return () => {
      renderer.canvas.remove();
      renderer.dispose();
      shot.current = null;
    };
  }, [hasActive]);
  useEffect(() => {
    if (!shot.current || !size.width || !size.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    shot.current.renderShot(
      scene,
      time,
      Math.round(size.width * dpr),
      Math.round(size.height * dpr),
      pending,
    );
  }, [scene, pending, time, size.width, size.height, modelStatus]);
  return (
    <section
      aria-label="机位画面"
      className={`director-monitor ${split ? "split" : "floating"}`}
      style={split ? { width: `${share * 100}%` } : undefined}
    >
      <div className="director-monitor-tabs">
        {scene.cameras.map((camera) => (
          <button
            key={camera.id}
            type="button"
            aria-pressed={active === camera}
            onClick={() => select(camera.id)}
          >
            <Video size={12} />
            {camera.name}
          </button>
        ))}
        <button
          type="button"
          title={scene.cameras.length >= 6 ? "最多 6 个机位" : "新建机位"}
          disabled={scene.cameras.length >= 6}
          onClick={add}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          aria-label={split ? "收成浮窗" : "左右分栏"}
          title={split ? "收成浮窗" : "左右分栏"}
          onClick={toggle}
        >
          {split ? <PictureInPicture2 size={14} /> : <Columns2 size={14} />}
        </button>
      </div>
      {active ? (
        <>
          <div className="director-monitor-info">
            <span>
              FOV {Math.round((pending.cameras.get(active.id) ?? sampleCamera(active, time)).fov)}°
            </span>
            <span>{active.aspect}</span>
            <span>{time.toFixed(2)}s</span>
          </div>
          <div className="director-monitor-body" ref={body}>
            <div ref={host} style={size} />
          </div>
        </>
      ) : (
        <div className="director-monitor-empty">
          还没有机位
          <button type="button" onClick={add}>
            <Plus size={14} />
            添加一台机位
          </button>
        </div>
      )}
    </section>
  );
}
