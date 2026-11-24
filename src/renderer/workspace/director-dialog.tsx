import {
  type DirectorScene,
  MAX_DIRECTOR_SCENE_BYTES,
  retimeDirectorScene,
  sameDirectorKeyTime,
} from "@link-studio/core";
import { Move, PanelLeftClose, PanelLeftOpen, RotateCw, Scan, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { DirectorHeader, DirectorTool } from "./director-chrome";
import { HEADER_HEIGHT, NAV_WIDTH, PANEL_LIMITS, type PanelKind } from "./director-layout";
import { NUDGE_STEP, ResizeHandle } from "./director-resize";
import { ViewModeSwitch } from "./director-view-menu";
import { DirectorMonitor, useDirectorPanels } from "./director-workbench";
import { useDirectorModels } from "./use-director-models";
import "./director-workbench.css";
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { disposeThumbRenderer } from "./director-asset-thumbs";
import { type AssetTab, DirectorAssets } from "./director-assets";
import { supportsDirectorExport } from "./director-export";
import { DirectorExportDialog } from "./director-export-dialog";
import { directorHistory, initDirectorHistory, type SceneEdit } from "./director-history";
import { PROP_PRESETS } from "./director-prop-presets";
import { type PendingPoses, sampleCamera, sampleCharacter } from "./director-sample";
import { DirectorSidebar, type ObjectPatch } from "./director-sidebar";
import type { DirectorTake } from "./director-take-placement";
import { DirectorTimeline } from "./director-timeline";
import { type CameraTransform, DirectorView } from "./director-view";

const toolPrefs = { labels: true, snap: true, rotate: false, assetTab: "character" as AssetTab };
const emptyPoses: PendingPoses = { characters: new Map(), cameras: new Map() };

function nextName(prefix: string, items: { name: string }[]) {
  let number = 1;
  while (items.some((item) => item.name === `${prefix}${number}`)) number++;
  return `${prefix}${number}`;
}

export function DirectorDialog({
  label,
  initial,
  projectHandle,
  place,
  checkCapacity,
  write,
  finish,
}: {
  label: string;
  initial: DirectorScene;
  projectHandle: string;
  place: (takes: DirectorTake[]) => void;
  checkCapacity: (count: number) => void;
  write: (scene: DirectorScene) => void;
  finish: (scene: DirectorScene, changed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [history, dispatch] = useReducer(directorHistory, initial, initDirectorHistory);
  const { scene } = history;
  const models = useDirectorModels(scene.characters);
  const setScene = (update: SceneEdit) => dispatch({ type: "edit", update });
  const original = useRef(initial),
    saved = useRef(initial),
    latest = useRef(scene),
    writer = useRef(write);
  latest.current = scene;
  writer.current = write;
  const [saveStatus, setSaveStatus] = useState("已保存到节点");
  function flush() {
    if (saved.current === latest.current) return true;
    const bytes = new TextEncoder().encode(JSON.stringify(latest.current)).length;
    if (bytes > MAX_DIRECTOR_SCENE_BYTES) {
      setSaveStatus(`场景数据过大（${Math.ceil(bytes / 1024)}KB，上限 256KB），请删减关键帧或对象`);
      return false;
    }
    writer.current(latest.current);
    saved.current = latest.current;
    return true;
  }
  const flushPending = useEffectEvent(flush);
  useEffect(() => {
    if (scene === saved.current) {
      setSaveStatus("已保存到节点");
      return;
    }
    setSaveStatus("保存中…");
    const timer = setTimeout(() => {
      if (flushPending()) setSaveStatus("已保存到节点");
    }, 500);
    return () => clearTimeout(timer);
  }, [scene]);
  useEffect(
    () => () => {
      if (
        latest.current !== saved.current &&
        new TextEncoder().encode(JSON.stringify(latest.current)).length <= MAX_DIRECTOR_SCENE_BYTES
      )
        writer.current(latest.current);
    },
    [],
  );
  function close() {
    if (flush()) finish(scene, original.current !== scene);
  }
  const [pending, setPending] = useState(emptyPoses);
  function discardPose(id: string) {
    setPending((previous) => {
      const characters = new Map(previous.characters),
        cameras = new Map(previous.cameras);
      characters.delete(id);
      cameras.delete(id);
      return { characters, cameras };
    });
  }
  const [time, seek] = useState(0);
  const clock = useRef(time);
  function setTime(next: number) {
    clock.current = next;
    setPending(emptyPoses);
    seek(next);
  }
  const [cameraView, setCameraView] = useState(false);
  const panels = useDirectorPanels(),
    { sizes } = panels,
    main = useRef<HTMLElement>(null),
    focusRef = useRef<(() => void) | null>(null);
  const [labels, setLabels] = useState(toolPrefs.labels),
    [snap, setSnap] = useState(toolPrefs.snap),
    [rotate, setRotate] = useState(toolPrefs.rotate);
  const [assetTab, setAssetTab] = useState<AssetTab>(toolPrefs.assetTab),
    viewPoseRef = useRef<(() => CameraTransform | undefined) | null>(null);
  useEffect(() => {
    Object.assign(toolPrefs, { labels, snap, rotate, assetTab });
  }, [labels, snap, rotate, assetTab]);
  useEffect(() => disposeThumbRenderer, []);
  const shortcuts = useRef<(key: string) => boolean>(() => false);
  const [playing, play] = useState(false);
  function setPlaying(next: boolean) {
    setPending(emptyPoses);
    play(next);
  }
  function travel(type: "undo" | "redo") {
    setPending(emptyPoses);
    setPicked(undefined);
    dispatch({ type });
  }
  const recordSelected = useRef<() => void>(() => {});
  const playback = useRef({ playing, time, duration: scene.duration });
  playback.current = { playing, time, duration: scene.duration };
  function togglePlayback() {
    const current = playback.current;
    if (!current.playing && current.time >= current.duration) setTime(0);
    setPlaying(!current.playing);
  }
  const [selectedObject, setSelectedObject] = useState("");
  const [picked, setPicked] = useState<{ id: string; time: number }>();
  const [exporting, setExportOpen] = useState(false),
    [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    void supportsDirectorExport().then(
      (value) => {
        if (mounted) setSupported(value);
      },
      () => {
        if (mounted) setSupported(false);
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  const shortcutPlayback = useEffectEvent(togglePlayback);
  const shortcutTravel = useEffectEvent(travel);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey || event.isComposing) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [role="separator"], .director-divider, [data-director-menu], [contenteditable="true"]',
        )
      )
        return;
      if (
        event.key === " " &&
        event.target instanceof HTMLElement &&
        event.target.closest("button, input")
      )
        return;
      if (event.target instanceof HTMLElement && event.target.closest(".ds-sidebar"))
        event.stopPropagation();
      if (!event.ctrlKey && !event.metaKey) {
        if (event.key === " " && !exporting) {
          event.preventDefault();
          event.stopPropagation();
          shortcutPlayback();
        }
        if (event.key.toLowerCase() === "k" && !exporting) {
          recordSelected.current();
        }
        if (!exporting && shortcuts.current(event.key.toLowerCase())) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault();
      event.stopPropagation();
      if (!exporting) shortcutTravel(key === "y" || event.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [exporting]);
  const camera = scene.cameras.find(({ id }) => id === scene.activeCameraId);
  const figure = scene.characters.find(({ id }) => id === selectedObject);
  const prop = scene.props.find(({ id }) => id === selectedObject);
  const previewTime = Math.min(time, scene.duration);
  const editTime = Math.round(previewTime * 100) / 100;
  const cameraPose =
    camera && (pending.cameras.get(camera.id) ?? sampleCamera(camera, previewTime));
  const figurePose =
    figure && (pending.characters.get(figure.id) ?? sampleCharacter(figure, previewTime));

  function record(id: string) {
    const actor = scene.characters.find((item) => item.id === id),
      cam = scene.cameras.find((item) => item.id === id),
      track = actor ?? cam;
    if (!track) return;
    function insert<Pose extends object>(
      keys: Array<Pose & { t: number; ease: "smooth" | "linear" }>,
      pose: Pose,
    ) {
      return [
        ...keys.filter((key) => !sameDirectorKeyTime(key.t, editTime)),
        { ...pose, t: editTime, ease: "smooth" as const },
      ].sort((left, right) => left.t - right.t);
    }
    if (actor)
      setScene({
        ...scene,
        characters: scene.characters.map((item) =>
          item !== actor
            ? item
            : {
                ...item,
                keys: insert(
                  item.keys,
                  pending.characters.get(id) ?? sampleCharacter(item, previewTime),
                ),
              },
        ),
      });
    else if (cam)
      setScene({
        ...scene,
        cameras: scene.cameras.map((item) =>
          item !== cam
            ? item
            : {
                ...item,
                keys: insert(item.keys, pending.cameras.get(id) ?? sampleCamera(item, previewTime)),
              },
        ),
      });
    discardPose(id);
    setPicked({ id, time: editTime });
  }
  recordSelected.current = () => {
    if (selectedObject) record(selectedObject);
  };
  function choose(id: string) {
    setPicked(undefined);
    setSelectedObject(id);
    if (scene.cameras.some((item) => item.id === id)) dispatch({ type: "selectCamera", id });
  }
  function removeObject(id: string) {
    if (!id) return;
    const cameras = scene.cameras
      .filter((item) => item.id !== id)
      .map((item) => (item.lookAt === id ? { ...item, lookAt: undefined } : item));
    setScene({
      ...scene,
      characters: scene.characters.filter((item) => item.id !== id),
      props: scene.props.filter((item) => item.id !== id),
      cameras,
      activeCameraId: cameras.some((item) => item.id === scene.activeCameraId)
        ? scene.activeCameraId
        : (cameras[0]?.id ?? ""),
    });
    discardPose(id);
    if (!cameras.length) setCameraView(false);
    if (selectedObject === id) setSelectedObject("");
    if (picked?.id === id) setPicked(undefined);
  }
  function removeSelected() {
    removeObject(selectedObject);
  }
  function updateObject(id: string, patch: ObjectPatch) {
    const apply = <Item extends { id: string }>(items: Item[]) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item));
    setScene((current) => ({
      ...current,
      characters: apply(current.characters),
      props: apply(current.props),
      cameras: apply(current.cameras),
    }));
  }
  function deleteSelection() {
    if (picked) {
      setScene({
        ...scene,
        characters: scene.characters.map((item) =>
          item.id === picked.id
            ? { ...item, keys: item.keys.filter((key) => !sameDirectorKeyTime(key.t, picked.time)) }
            : item,
        ),
        cameras: scene.cameras.map((item) =>
          item.id === picked.id
            ? { ...item, keys: item.keys.filter((key) => !sameDirectorKeyTime(key.t, picked.time)) }
            : item,
        ),
      });
      setPicked(undefined);
    } else removeSelected();
  }
  shortcuts.current = (key) => {
    if (key === "1" || key === "2") setRotate(key === "2");
    else if (key === "f") focusRef.current?.();
    else if (key === "escape" && selectedObject) choose("");
    else if ((key === "delete" || key === "backspace") && (picked || selectedObject))
      deleteSelection();
    else return false;
    return true;
  };
  function transform(id: string, moved: Partial<CameraTransform>) {
    if (camera?.id === id) {
      editCamera(() => moved);
      return;
    }
    const actor = scene.characters.find((item) => item.id === id),
      prop = scene.props.find((item) => item.id === id);
    if (actor?.locked || prop?.locked) return;
    const base = actor ? (pending.characters.get(id) ?? sampleCharacter(actor, previewTime)) : prop;
    if (!base) return;
    const pose = { x: moved.x ?? base.x, z: moved.z ?? base.z, yaw: moved.yaw ?? base.yaw };
    if (actor?.keys.length)
      setPending((previous) => ({
        ...previous,
        characters: new Map(previous.characters).set(id, pose),
      }));
    else updateObject(id, pose);
  }
  function divider(kind: PanelKind, label: string, style: React.CSSProperties) {
    const vertical = kind !== "timeline",
      sign = kind === "assets" ? 1 : -1,
      unit = () => (kind === "split" ? main.current?.clientWidth || 1 : 1);
    return (
      <ResizeHandle
        value={sizes[kind]}
        limits={PANEL_LIMITS[kind]}
        orientation={vertical ? "vertical" : "horizontal"}
        label={label}
        style={style}
        onStart={() => sizes[kind] * unit()}
        onMove={(start, delta) => panels.update(kind, (start + sign * delta) / unit())}
        onEnd={panels.save}
        onReset={() => panels.reset(kind)}
        onNudge={(direction) =>
          panels.update(kind, sizes[kind] + (direction * NUDGE_STEP * sign) / unit())
        }
      />
    );
  }

  function editCamera(move: (pose: CameraTransform) => Partial<CameraTransform>) {
    if (!camera || !cameraPose) return;
    const moved = move(cameraPose);
    if (moved.y !== undefined) moved.y = Math.max(0.1, moved.y);
    if (moved.pitch !== undefined) moved.pitch = Math.max(-85, Math.min(85, moved.pitch));
    if (camera.keys.length)
      setPending((previous) => ({
        ...previous,
        cameras: new Map(previous.cameras).set(camera.id, {
          ...(previous.cameras.get(camera.id) ?? cameraPose),
          ...moved,
        }),
      }));
    else updateObject(camera.id, moved);
  }

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.focus({ preventScroll: true });
    return () => {
      element?.close();
    };
  }, []);
  const advancePlayback = useEffectEvent((next: number, duration: number) => {
    setTime(next);
    if (next >= duration) setPlaying(false);
  });
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const duration = playback.current.duration;
      const next = Math.min(duration, clock.current + (now - last) / 1000);
      last = now;
      advancePlayback(next, duration);
      if (next < duration) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  function addCamera(pose?: CameraTransform) {
    if (scene.cameras.length >= 6) return;
    const id = crypto.randomUUID();
    setScene((current) => ({
      ...current,
      activeCameraId: id,
      cameras: [
        ...current.cameras,
        {
          id,
          name: nextName("机位", current.cameras),
          aspect: "16:9",
          x: 3,
          y: 1.6,
          z: 3,
          yaw: -45,
          pitch: (Math.atan2(1.3 - 1.6, Math.hypot(3, 3)) * 180) / Math.PI,
          fov: 50,
          ...pose,
          keys: [],
        },
      ],
    }));
    choose(id);
  }

  function addCharacter(model: "male" | "female" = "male") {
    if (scene.characters.length >= 8) return;
    const id = crypto.randomUUID();
    setScene((current) => ({
      ...current,
      characters: [
        ...current.characters,
        {
          id,
          name: `角色${[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((letter) => !current.characters.some((actor) => actor.name === `角色${letter}`)) ?? current.characters.length + 1}`,
          color:
            [
              "#d4d4d8",
              "#fca5a5",
              "#93c5fd",
              "#86efac",
              "#fcd34d",
              "#c4b5fd",
              "#f9a8d4",
              "#67e8f9",
            ].find((color) => !current.characters.some((actor) => actor.color === color)) ??
            "#d4d4d8",
          x:
            (current.characters.length % 2 ? 1 : -1) *
            Math.ceil(current.characters.length / 2) *
            1.2,
          z: 0,
          yaw: 180,
          model,
          pose: "stand",
          scale: 1,
          keys: [],
        },
      ],
    }));
    choose(id);
  }

  function addProp(shape: DirectorScene["props"][number]["shape"] = "box", assetLabel?: string) {
    if (scene.props.length >= 30) return;
    const preset = PROP_PRESETS[shape];
    const id = crypto.randomUUID();
    setScene((current) => ({
      ...current,
      props: [
        ...current.props,
        {
          id,
          name: nextName(assetLabel ?? preset.label, current.props),
          shape,
          x: 2 + (current.props.length % 4) * 1.5,
          z: -1.5 - Math.floor(current.props.length / 4) * 1.5,
          yaw: 0,
          w: preset.size[0],
          h: preset.size[1],
          d: preset.size[2],
        },
      ],
    }));
    choose(id);
  }

  return (
    <motion.dialog
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
      ref={dialog}
      tabIndex={-1}
      className="image-doodle-dialog director-dialog"
      style={{ gridTemplateRows: `${HEADER_HEIGHT}px minmax(0,1fr) ${sizes.timeline}px` }}
      aria-label={`导演台：${label}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!exporting) close();
      }}
    >
      <DirectorHeader
        label={label}
        undo={history.past.length && !history.base && !exporting ? () => travel("undo") : undefined}
        redo={
          history.future.length && !history.base && !exporting ? () => travel("redo") : undefined
        }
        snap={snap}
        labels={labels}
        toggleSnap={() => setSnap(!snap)}
        toggleLabels={() => setLabels(!labels)}
        status={saveStatus}
        close={close}
        blocked={
          !scene.cameras.length
            ? "没有机位，先添加一台机位"
            : supported === false
              ? "当前浏览器不支持 H.264 视频编码，请用新版 Chrome / Edge 导出"
              : null
        }
        onExport={() => setExportOpen(true)}
      />
      <div
        className="director-editor-layout"
        style={{
          gridTemplateColumns: `${NAV_WIDTH}px ${panels.assets ? sizes.assets + "px " : ""}minmax(0,1fr) ${sizes.sidebar}px`,
        }}
      >
        <nav aria-label="工具" className="director-tool-rail">
          <DirectorTool
            title={panels.assets ? "折叠资产面板" : "展开资产面板（添加人物、物体、机位）"}
            active={panels.assets}
            onClick={panels.toggleAssets}
          >
            {panels.assets ? <PanelLeftClose /> : <PanelLeftOpen />}
          </DirectorTool>
          <i />
          <DirectorTool title="移动（1）" active={!rotate} onClick={() => setRotate(false)}>
            <Move />
          </DirectorTool>
          <DirectorTool title="旋转（2）" active={rotate} onClick={() => setRotate(true)}>
            <RotateCw />
          </DirectorTool>
          <i />
          <DirectorTool
            title="聚焦选中（F）"
            disabled={!selectedObject}
            onClick={() => focusRef.current?.()}
          >
            <Scan />
          </DirectorTool>
          <DirectorTool
            title="删除选中（Delete）"
            disabled={!selectedObject}
            onClick={removeSelected}
          >
            <Trash2 />
          </DirectorTool>
        </nav>
        {panels.assets && (
          <DirectorAssets
            tab={assetTab}
            setTab={setAssetTab}
            toggle={panels.toggleAssets}
            onCameraFromView={() => {
              const pose = viewPoseRef.current?.();
              if (pose) addCamera(pose);
            }}
            scene={scene}
            addCharacter={addCharacter}
            addProp={(shape) => addProp(shape, PROP_PRESETS[shape].label)}
            addCamera={addCamera}
          />
        )}
        <main ref={main} className="director-preview">
          <div
            className="director-view-shell"
            style={{ right: panels.split ? `${sizes.split * 100}%` : 0 }}
          >
            <DirectorView
              models={models}
              scene={scene}
              selectedId={selectedObject}
              disabled={exporting}
              pending={pending}
              cameraGesture={(phase) => {
                if (phase === "begin" && playing) setPlaying(false);
                dispatch({ type: phase });
              }}
              time={previewTime}
              cameraView={cameraView && !!camera}
              select={choose}
              transform={transform}
              labels={labels}
              snap={snap}
              rotate={rotate}
              focusRef={focusRef}
              viewPoseRef={viewPoseRef}
              editCamera={!exporting && camera ? editCamera : undefined}
            />
            <ViewModeSwitch
              cameras={scene.cameras}
              viewedId={cameraView && camera ? camera.id : null}
              select={(id) => {
                if (id) choose(id);
                setCameraView(!!id);
              }}
            />
          </div>
          <DirectorMonitor
            scene={scene}
            modelStatus={models.status}
            time={previewTime}
            pending={pending}
            split={panels.split}
            share={sizes.split}
            toggle={panels.toggleSplit}
            select={choose}
            add={() => addCamera()}
          />
          {panels.split &&
            divider("split", "机位画面宽度", {
              top: 0,
              bottom: 0,
              left: `${(1 - sizes.split) * 100}%`,
              width: 8,
              marginLeft: -4,
            })}
        </main>
        {panels.assets &&
          divider("assets", "资产面板宽度", {
            left: NAV_WIDTH + sizes.assets - 4,
            top: 0,
            bottom: 0,
            width: 8,
          })}
        {divider("sidebar", "属性栏宽度", {
          right: sizes.sidebar - 4,
          top: 0,
          bottom: 0,
          width: 8,
        })}
        <DirectorSidebar
          scene={scene}
          selectedId={selectedObject}
          pose={figurePose ?? prop ?? cameraPose}
          t={previewTime}
          pending={pending.characters.has(selectedObject) || pending.cameras.has(selectedObject)}
          select={choose}
          removeObject={removeObject}
          updateObject={updateObject}
          commitTransform={(id, patch) => {
            if (patch.w !== undefined || patch.h !== undefined || patch.d !== undefined)
              updateObject(id, patch);
            else transform(id, patch);
          }}
          add={(kind) =>
            kind === "character" ? addCharacter() : kind === "camera" ? addCamera() : addProp()
          }
        />
      </div>
      <DirectorTimeline
        scene={scene}
        t={previewTime}
        selectedId={selectedObject}
        selectedKey={picked}
        pending={pending}
        playing={playing}
        toggle={togglePlayback}
        setTime={setTime}
        setDuration={(value) => {
          const next = retimeDirectorScene(scene, value);
          if (next !== scene) {
            setScene(next);
            setTime(Math.min(previewTime, next.duration));
          }
        }}
        select={choose}
        selectKey={setPicked}
        recordKey={record}
        deleteSelectedKey={deleteSelection}
        write={(next) => {
          discardPose(selectedObject);
          setScene(next);
        }}
        change={(id, from, to, ease) => {
          function update<
            Track extends DirectorScene["characters"][number] | DirectorScene["cameras"][number],
          >(track: Track): Track {
            if (track.id !== id) return track;
            if (ease)
              return {
                ...track,
                keys: track.keys.map((key) =>
                  sameDirectorKeyTime(key.t, from) ? { ...key, ease } : key,
                ),
              };
            const moving = track.keys.find((key) => sameDirectorKeyTime(key.t, from));
            if (!moving) return track;
            const rest = track.keys.filter(
              (key) => !sameDirectorKeyTime(key.t, from) && !sameDirectorKeyTime(key.t, to),
            );
            return {
              ...track,
              keys: [...rest, { ...moving, t: to }].sort((left, right) => left.t - right.t),
            };
          }
          setScene((current) => ({
            ...current,
            characters: current.characters.map(update),
            cameras: current.cameras.map(update),
          }));
        }}
      />
      {divider("timeline", "时间轴高度", {
        left: 0,
        right: 0,
        bottom: sizes.timeline - 4,
        height: 8,
      })}
      {exporting && (
        <DirectorExportDialog
          scene={scene}
          label={label}
          projectHandle={projectHandle}
          place={place}
          checkCapacity={checkCapacity}
          close={() => setExportOpen(false)}
          back={close}
        />
      )}
    </motion.dialog>
  );
}
