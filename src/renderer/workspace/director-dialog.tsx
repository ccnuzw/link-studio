import {
  type DirectorScene,
  directorAspects,
  directorPoses,
  directorShapes,
} from "@link-studio/core";
import { useEffect, useRef, useState } from "react";
import { DirectorAssets } from "./director-assets";
import { PROP_PRESETS } from "./director-prop-presets";
import { DirectorTimeline } from "./director-timeline";
import { type CameraTransform, DirectorView, samplePose } from "./director-view";

const poseNames: Record<DirectorScene["characters"][number]["pose"], string> = {
  stand: "站立",
  walk: "行走",
  run: "跑步",
  sit: "坐姿",
  crouch: "蹲姿",
  point: "指向",
  armsCrossed: "抱臂",
  wave: "招手",
  talk: "交谈",
  raiseHand: "举手",
  lookBack: "回头",
  lying: "躺卧",
};

export function DirectorDialog({
  initial,
  projectHandle,
  save,
  close,
}: {
  initial: DirectorScene;
  projectHandle: string;
  save: (scene: DirectorScene) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scene, setScene] = useState(initial);
  const [time, setTime] = useState(0);
  const [cameraView, setCameraView] = useState(false);
  const [guides, setGuides] = useState(true);
  const [playing, setPlaying] = useState(false);
  const playbackStart = useRef(0);
  const [selectedObject, setSelectedObject] = useState("");
  const exportController = useRef<AbortController>(undefined);
  const [exportProgress, setExportProgress] = useState<number>();
  const [exportError, setExportError] = useState("");
  const [exportSaved, setExportSaved] = useState(false);
  const [savingPreview, setSavingPreview] = useState(false);
  const exporting = exportProgress !== undefined || savingPreview;
  const camera = scene.cameras.find(({ id }) => id === scene.activeCameraId);
  const figure = scene.characters.find(({ id }) => id === selectedObject);
  const prop = scene.props.find(({ id }) => id === selectedObject);
  const object = figure ?? prop;
  const previewTime = Math.min(time, scene.duration);
  const editTime = Math.min(scene.duration, Number(previewTime.toFixed(1)));

  function editCamera(move: (pose: CameraTransform) => Partial<CameraTransform>) {
    setScene((current) => ({
      ...current,
      cameras: current.cameras.map((item) => {
        if (item.id !== current.activeCameraId) return item;
        const existing = item.keys.find(({ t }) => t === editTime);
        if (!existing && item.keys.length >= 120) return item;
        const sampled = samplePose(item, item.keys, editTime);
        const pose = {
          x: sampled.x,
          y: sampled.y ?? item.y,
          z: sampled.z,
          yaw: sampled.yaw,
          pitch: sampled.pitch ?? item.pitch,
          fov: sampled.fov ?? item.fov,
        };
        const moved = move(pose);
        const lookAt = moved.yaw === undefined ? item.lookAt : undefined;
        if (!item.keys.length) return { ...item, ...moved, lookAt };
        return {
          ...item,
          lookAt,
          keys: [
            ...item.keys.filter(({ t }) => t !== editTime),
            { ...pose, ...moved, t: editTime, ease: existing?.ease ?? "smooth" },
          ].sort((left, right) => left.t - right.t),
        };
      }),
    }));
  }

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      exportController.current?.abort();
      element?.close();
    };
  }, []);
  useEffect(() => {
    if (!playing) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const next = Math.min(
        scene.duration,
        playbackStart.current + (performance.now() - started) / 1000,
      );
      setTime(next);
      if (next >= scene.duration) setPlaying(false);
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing, scene.duration]);

  function addCamera() {
    const id = crypto.randomUUID();
    setScene((current) => ({
      ...current,
      activeCameraId: id,
      cameras: [
        ...current.cameras,
        {
          id,
          name: `机位 ${current.cameras.length + 1}`,
          aspect: "16:9",
          x: 0,
          y: 1.5,
          z: 5,
          yaw: 0,
          pitch: 0,
          fov: 45,
          keys: [],
        },
      ],
    }));
  }

  function addCharacter(model: "male" | "female" = "male") {
    const id = crypto.randomUUID();
    setScene((current) => ({
      ...current,
      characters: [
        ...current.characters,
        {
          id,
          name: `人物 ${current.characters.length + 1}`,
          color: "#a9bfff",
          x: 0,
          z: 0,
          yaw: 0,
          model,
          pose: "stand",
          scale: 1,
          keys: [],
        },
      ],
    }));
    setSelectedObject(id);
  }

  function addProp(shape: DirectorScene["props"][number]["shape"] = "box", assetLabel?: string) {
    const preset = PROP_PRESETS[shape];
    const id = crypto.randomUUID();
    setScene((current) => ({
      ...current,
      props: [
        ...current.props,
        {
          id,
          name: `${assetLabel ?? "道具"} ${current.props.length + 1}`,
          shape,
          x: 1,
          z: 0,
          yaw: 0,
          w: preset.size[0],
          h: preset.size[1],
          d: preset.size[2],
        },
      ],
    }));
    setSelectedObject(id);
  }

  async function savePreview() {
    if (!camera || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExportProgress(0);
    setExportError("");
    setExportSaved(false);
    try {
      const { exportDirectorVideo } = await import("./director-export");
      const mp4 = await exportDirectorVideo(scene, controller.signal, setExportProgress);
      controller.signal.throwIfAborted();
      setSavingPreview(true);
      setExportProgress(undefined);
      const result = await window.desktop.projects.saveDirectorPreview({ projectHandle, mp4 });
      if (!result.ok) throw new Error("无法写入预演视频，请检查存放位置后重试。");
      setExportSaved(result.value.saved);
    } catch (error) {
      if (!controller.signal.aborted)
        setExportError(error instanceof Error ? error.message : "无法导出导演台预演。");
    } finally {
      exportController.current = undefined;
      setExportProgress(undefined);
      setSavingPreview(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="image-doodle-dialog director-dialog"
      aria-labelledby="director-title"
      onCancel={(event) => {
        event.preventDefault();
        if (savingPreview) return;
        if (exporting) exportController.current?.abort();
        else close();
      }}
    >
      <header>
        <h2 id="director-title">导演台</h2>
        <button type="button" aria-label="关闭导演台" disabled={exporting} onClick={close}>
          ×
        </button>
      </header>
      <div className="director-editor-layout">
        <DirectorAssets
          addCharacter={addCharacter}
          addProp={(shape) => addProp(shape, PROP_PRESETS[shape].label)}
          addCamera={addCamera}
        />
        <div className="director-preview">
          <DirectorView
            scene={scene}
            time={previewTime}
            cameraView={cameraView && !!camera}
            guides={guides}
            editCamera={
              !playing &&
              !exporting &&
              camera &&
              (camera.keys.length < 120 || camera.keys.some(({ t }) => t === editTime))
                ? editCamera
                : undefined
            }
          />
        </div>
      </div>
      <div className="director-controls">
        <button type="button" onClick={() => setCameraView(false)} aria-pressed={!cameraView}>
          场景
        </button>
        <button
          type="button"
          disabled={!camera}
          onClick={() => setCameraView(true)}
          aria-pressed={cameraView}
        >
          机位
        </button>
        {cameraView && camera && (
          <button type="button" aria-pressed={guides} onClick={() => setGuides(!guides)}>
            三分线
          </button>
        )}
        <button
          type="button"
          disabled={exporting}
          onClick={() => {
            if (!playing) {
              playbackStart.current = previewTime >= scene.duration ? 0 : previewTime;
              setTime(playbackStart.current);
            }
            setPlaying(!playing);
          }}
        >
          {playing ? "暂停预演" : "播放预演"}
        </button>
        <label>
          时间{" "}
          <input
            type="range"
            min="0"
            max={scene.duration}
            step="0.1"
            value={previewTime}
            disabled={exporting}
            onChange={(event) => {
              setPlaying(false);
              setTime(event.currentTarget.valueAsNumber);
            }}
          />
        </label>
        <output aria-label="当前时间">{previewTime.toFixed(1)} 秒</output>
      </div>
      <DirectorTimeline
        scene={scene}
        time={previewTime}
        selectedObject={selectedObject}
        disabled={playing || exporting}
        select={(id, kind, nextTime) => {
          setTime(nextTime);
          if (kind === "camera") setScene((current) => ({ ...current, activeCameraId: id }));
          else setSelectedObject(id);
        }}
        change={(id, from, to, ease) => {
          function update<
            Track extends DirectorScene["characters"][number] | DirectorScene["cameras"][number],
          >(track: Track): Track {
            if (track.id !== id || track.keys.some(({ t }) => t === to && t !== from)) return track;
            return {
              ...track,
              keys: track.keys
                .map((key) => (key.t === from ? { ...key, t: to, ease } : key))
                .sort((left, right) => left.t - right.t),
            };
          }
          setScene((current) => ({
            ...current,
            characters: current.characters.map(update),
            cameras: current.cameras.map(update),
          }));
          setTime(to);
        }}
      />
      <fieldset className="outpaint-fields director-controls" disabled={playing || exporting}>
        <legend>场景与机位</legend>
        <label>
          场景时长（秒）
          <input
            type="number"
            min="1"
            max="15"
            step="0.1"
            value={scene.duration}
            onChange={(event) => {
              const duration = event.currentTarget.valueAsNumber;
              if (!Number.isFinite(duration) || duration < 1 || duration > 15) return;
              if (
                [...scene.characters, ...scene.cameras].some(({ keys }) =>
                  keys.some(({ t }) => t > duration),
                )
              )
                return;
              setScene({ ...scene, duration });
            }}
          />
        </label>
        <button
          type="button"
          disabled={scene.characters.length >= 48}
          onClick={() => addCharacter()}
        >
          添加人物
        </button>
        <button type="button" disabled={scene.props.length >= 96} onClick={() => addProp()}>
          添加道具
        </button>
        <button type="button" disabled={scene.cameras.length >= 24} onClick={addCamera}>
          添加机位
        </button>
        <label>
          人物或道具
          <select
            value={selectedObject}
            onChange={(event) => setSelectedObject(event.target.value)}
          >
            <option value="">请选择</option>
            {[...scene.characters, ...scene.props].map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {object && (
          <>
            {(
              [
                ["x", "横向站位", -1000, 1000],
                ["z", "纵深站位", -1000, 1000],
                ["yaw", "朝向", -360, 360],
              ] as const
            ).map(([field, label, min, max]) => (
              <label key={field}>
                {label}
                <input
                  type="number"
                  step="0.1"
                  min={min}
                  max={max}
                  value={object[field]}
                  disabled={object.locked}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    if (!Number.isFinite(value) || value < min || value > max) return;
                    setScene({
                      ...scene,
                      characters: scene.characters.map((item) =>
                        item.id === object.id ? { ...item, [field]: value } : item,
                      ),
                      props: scene.props.map((item) =>
                        item.id === object.id ? { ...item, [field]: value } : item,
                      ),
                    });
                  }}
                />
              </label>
            ))}
            {figure && (
              <>
                <label>
                  人物模型
                  <select
                    value={figure.model ?? "male"}
                    disabled={figure.locked}
                    onChange={(event) => {
                      const model = event.target.value === "female" ? "female" : "male";
                      setScene((current) => ({
                        ...current,
                        characters: current.characters.map((item) =>
                          item.id === figure.id ? { ...item, model } : item,
                        ),
                      }));
                    }}
                  >
                    <option value="male">男性人台</option>
                    <option value="female">女性人台</option>
                  </select>
                </label>
                <label>
                  人物姿势
                  <select
                    value={figure.pose}
                    disabled={figure.locked}
                    onChange={(event) => {
                      const pose = event.target.value as typeof figure.pose;
                      setScene((current) => ({
                        ...current,
                        characters: current.characters.map((item) =>
                          item.id === figure.id ? { ...item, pose } : item,
                        ),
                      }));
                    }}
                  >
                    {directorPoses.map((pose) => (
                      <option key={pose} value={pose}>
                        {poseNames[pose]}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset className="outpaint-full director-controls">
                  <legend>人物走位关键帧</legend>
                  <button
                    type="button"
                    disabled={
                      figure.locked ||
                      (figure.keys.length >= 120 && !figure.keys.some(({ t }) => t === previewTime))
                    }
                    onClick={() => {
                      const t = Number(previewTime.toFixed(1));
                      const { x, z, yaw } = figure;
                      const keys = [
                        ...figure.keys.filter((key) => key.t !== t),
                        { t, x, z, yaw, ease: "smooth" as const },
                      ].sort((left, right) => left.t - right.t);
                      setScene({
                        ...scene,
                        characters: scene.characters.map((item) =>
                          item.id === figure.id ? { ...item, keys } : item,
                        ),
                      });
                    }}
                  >
                    记录人物关键帧
                  </button>
                  {figure.keys.map(({ t }) => (
                    <span key={t} className="director-controls">
                      <button
                        type="button"
                        aria-label={`跳到 ${t} 秒人物关键帧`}
                        onClick={() => setTime(t)}
                      >
                        {t} 秒
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${t} 秒人物关键帧`}
                        disabled={figure.locked}
                        onClick={() =>
                          setScene({
                            ...scene,
                            characters: scene.characters.map((item) =>
                              item.id === figure.id
                                ? { ...item, keys: item.keys.filter((key) => key.t !== t) }
                                : item,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </fieldset>
              </>
            )}
            {prop && (
              <label>
                形状
                <select
                  aria-label="道具形状"
                  value={prop.shape}
                  disabled={prop.locked}
                  onChange={(event) => {
                    const shape = event.target.value as typeof prop.shape;
                    const [w, h, d] = PROP_PRESETS[shape].size;
                    setScene((current) => ({
                      ...current,
                      props: current.props.map((item) =>
                        item.id === prop.id ? { ...item, shape, w, h, d } : item,
                      ),
                    }));
                  }}
                >
                  {(
                    [
                      ["geometry", "几何体"],
                      ["object", "物体"],
                    ] as const
                  ).map(([category, label]) => (
                    <optgroup key={category} label={label}>
                      {directorShapes
                        .filter((shape) => PROP_PRESETS[shape].category === category)
                        .map((shape) => (
                          <option key={shape} value={shape}>
                            {PROP_PRESETS[shape].label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            )}
            {prop &&
              (
                [
                  ["w", "宽度"],
                  ["h", "高度"],
                  ["d", "深度"],
                ] as const
              ).map(([field, label]) => (
                <label key={field}>
                  {label}（米）
                  <input
                    type="number"
                    min="0.05"
                    max="100"
                    step="0.01"
                    value={prop[field]}
                    disabled={prop.locked}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (!Number.isFinite(value) || value < 0.05 || value > 100) return;
                      setScene((current) => ({
                        ...current,
                        props: current.props.map((item) =>
                          item.id === prop.id ? { ...item, [field]: value } : item,
                        ),
                      }));
                    }}
                  />
                </label>
              ))}
            <button
              type="button"
              disabled={object.locked}
              onClick={() => {
                setScene({
                  ...scene,
                  characters: scene.characters.filter(({ id }) => id !== object.id),
                  props: scene.props.filter(({ id }) => id !== object.id),
                  cameras: scene.cameras.map((item) =>
                    item.lookAt === object.id ? { ...item, lookAt: undefined } : item,
                  ),
                });
                setSelectedObject("");
              }}
            >
              移除选中对象
            </button>
          </>
        )}
        <label>
          当前机位
          <select
            value={scene.activeCameraId}
            onChange={(event) => {
              if (!event.target.value) setCameraView(false);
              setScene({ ...scene, activeCameraId: event.target.value });
            }}
          >
            <option value="">未选择</option>
            {scene.cameras.map(({ id, name }) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {camera && (
          <>
            <label>
              机位看向
              <select
                value={camera.lookAt ?? ""}
                onChange={(event) => {
                  const lookAt = event.target.value || undefined;
                  setScene({
                    ...scene,
                    cameras: scene.cameras.map((item) =>
                      item.id === camera.id ? { ...item, lookAt } : item,
                    ),
                  });
                }}
              >
                <option value="">手动设置角度</option>
                {scene.characters.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              画幅
              <select
                value={camera.aspect}
                onChange={(event) =>
                  setScene({
                    ...scene,
                    cameras: scene.cameras.map((item) =>
                      item.id === camera.id
                        ? { ...item, aspect: event.target.value as typeof camera.aspect }
                        : item,
                    ),
                  })
                }
              >
                {directorAspects.map((aspect) => (
                  <option key={aspect}>{aspect}</option>
                ))}
              </select>
            </label>
            {(
              [
                ["x", "横向位置", -1000, 1000],
                ["y", "机位高度", -1000, 1000],
                ["z", "纵深位置", -1000, 1000],
                ["yaw", "偏航角", -360, 360],
                ["pitch", "俯仰角", -90, 90],
                ["fov", "视场角", 10, 120],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step="0.1"
                  value={camera[key]}
                  disabled={!!camera.lookAt && (key === "yaw" || key === "pitch")}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    if (Number.isFinite(value))
                      setScene({
                        ...scene,
                        cameras: scene.cameras.map((item) =>
                          item.id === camera.id
                            ? { ...item, [key]: Math.min(max, Math.max(min, value)) }
                            : item,
                        ),
                      });
                  }}
                />
              </label>
            ))}
            <button
              type="button"
              disabled={camera.keys.length >= 120}
              onClick={() => {
                const { x, y, z, yaw, pitch, fov } = camera;
                const t = Number(previewTime.toFixed(1));
                const keys = [
                  ...camera.keys.filter((key) => key.t !== t),
                  { t, x, y, z, yaw, pitch, fov, ease: "smooth" as const },
                ].sort((left, right) => left.t - right.t);
                setScene({
                  ...scene,
                  cameras: scene.cameras.map((item) =>
                    item.id === camera.id ? { ...item, keys } : item,
                  ),
                });
              }}
            >
              记录机位关键帧
            </button>
            <fieldset className="outpaint-full director-controls">
              <legend>机位关键帧</legend>
              {camera.keys.map(({ t }) => (
                <button
                  type="button"
                  key={t}
                  aria-label={`删除 ${t} 秒关键帧`}
                  onClick={() =>
                    setScene({
                      ...scene,
                      cameras: scene.cameras.map((item) =>
                        item.id === camera.id
                          ? { ...item, keys: item.keys.filter((key) => key.t !== t) }
                          : item,
                      ),
                    })
                  }
                >
                  {t} 秒 ×
                </button>
              ))}
            </fieldset>
          </>
        )}
      </fieldset>
      {exportError && (
        <p role="alert" className="image-doodle-error">
          {exportError}
        </p>
      )}
      {exportProgress !== undefined && (
        <progress aria-label="预演导出进度" max={1} value={exportProgress} />
      )}
      {exportSaved && <p role="status">预演视频已保存。</p>}
      <footer>
        <button
          type="button"
          disabled={savingPreview}
          onClick={exporting ? () => exportController.current?.abort() : close}
        >
          {savingPreview ? "正在保存…" : exporting ? "取消导出" : "取消"}
        </button>
        <button
          type="button"
          disabled={!camera || playing || exporting}
          onClick={() => void savePreview()}
        >
          导出预演 MP4
        </button>
        <button
          type="button"
          className="settings-primary"
          disabled={exporting}
          onClick={() => save(scene)}
        >
          保存场景
        </button>
      </footer>
    </dialog>
  );
}
