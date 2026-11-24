import { type DirectorScene, sameDirectorKeyTime } from "@link-studio/core";
import { Diamond, Pause, Play, SkipBack, Trash2, UserRound, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { applyPreset, CAMERA_PRESETS, type CameraPresetId } from "./director-presets";
import type { PendingPoses } from "./director-sample";
import "./director-time-track.css";

const DURATIONS = Array.from({ length: 29 }, (_, index) => 1 + index / 2);
const ROW = 28,
  RULER = 24,
  FIELD_CLASS = "dt-field";
const cn = (...classes: (string | false)[]) => classes.filter(Boolean).join(" ");
type Selection = { id: string; time: number };
export function DirectorTimeline({
  scene,
  t,
  selectedId,
  selectedKey,
  pending,
  playing,
  toggle,
  setTime,
  setDuration,
  recordKey,
  select,
  selectKey,
  change,
  deleteSelectedKey,
  write,
}: {
  scene: DirectorScene;
  t: number;
  selectedId: string;
  selectedKey?: Selection;
  pending: PendingPoses;
  playing: boolean;
  toggle: () => void;
  setTime: (time: number) => void;
  setDuration: (duration: number) => void;
  recordKey: (id: string) => void;
  select: (id: string) => void;
  selectKey: (key?: Selection) => void;
  change: (id: string, from: number, to: number, ease?: "linear" | "smooth") => void;
  deleteSelectedKey: () => void;
  write: (scene: DirectorScene) => void;
}) {
  const [notice, notify] = useState<{ text: string }>();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => notify(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  function track(
    event: React.PointerEvent,
    move: (event: PointerEvent) => void,
    finish?: () => void,
    cancel?: () => void,
  ) {
    stop.current();
    const pointer = event.pointerId;
    function cleanup() {
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("blur", reset);
      stop.current = () => {};
    }
    function drag(event: PointerEvent) {
      if (event.pointerId === pointer) move(event);
    }
    function up(event: PointerEvent) {
      if (event.pointerId !== pointer) return;
      cleanup();
      finish?.();
    }
    function reset() {
      cleanup();
      cancel?.();
    }
    function abort(event: PointerEvent) {
      if (event.pointerId === pointer) reset();
    }
    window.addEventListener("pointermove", drag);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", reset);
    stop.current = reset;
  }
  const [presetId, setPresetId] = useState<CameraPresetId>("dollyIn");
  const preset = CAMERA_PRESETS.find((p) => p.id === presetId)!;
  const [strength, setStrength] = useState(preset.defaultStrength);
  const lanesRef = useRef<HTMLDivElement>(null);

  const isCamera = !!selectedId && scene.cameras.some((c) => c.id === selectedId);
  const keyable = isCamera || (!!selectedId && scene.characters.some((c) => c.id === selectedId));
  const rows = [
    ...scene.cameras.map((item) => ({ item, icon: <Video className="dt-small-icon" /> })),
    ...scene.characters.map((item) => ({ item, icon: <UserRound className="dt-small-icon" /> })),
  ];
  const pct = (time: number) => `${(time / scene.duration) * 100}%`;

  const timeAt = (clientX: number) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * scene.duration;
  };

  const scrub = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    selectKey(undefined);
    setTime(timeAt(event.clientX));
    const move = (e: PointerEvent) => setTime(timeAt(e.clientX));
    track(event, move);
  };

  const grabKey = (event: React.PointerEvent, id: string, keyTime: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    selectKey({ id, time: keyTime });
    setTime(keyTime);
    let target = keyTime;
    const element = event.currentTarget as HTMLElement;
    const move = (e: PointerEvent) => {
      target = Math.round(timeAt(e.clientX) * 100) / 100;
      element.style.left = pct(target);
    };
    const up = () => {
      if (Math.abs(target - keyTime) >= 0.01) {
        change(id, keyTime, target);
        selectKey({ id, time: target });
        setTime(target);
      }
    };
    track(event, move, up, () => {
      element.style.left = pct(keyTime);
    });
  };

  const runPreset = () => {
    if (!isCamera || !selectedId) return;
    const { scene: next, warning } = applyPreset(
      scene,
      selectedId,
      presetId,
      preset.unit ? strength : undefined,
    );
    write(next);
    notify({ text: warning ?? `已套用「${preset.label}」，按空格播放` });
  };

  return (
    <section className="dt-timeline" aria-label="时间轴">
      <div className="dt-bar">
        <IconButton title={playing ? "暂停（空格）" : "播放（空格）"} onClick={() => toggle()}>
          {playing ? <Pause className="dt-icon" /> : <Play className="dt-icon" />}
        </IconButton>
        <IconButton title="回到开头" onClick={() => setTime(0)}>
          <SkipBack className="dt-icon" />
        </IconButton>
        <span className="dt-clock">
          F{Math.round(t * 24)} · {t.toFixed(2)}s / {scene.duration.toFixed(1)}s
        </span>
        <label className="dt-label">
          时长
          <select
            aria-label="时长"
            className={FIELD_CLASS}
            value={scene.duration}
            onChange={(event) => setDuration(Number(event.target.value))}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d}s
              </option>
            ))}
          </select>
        </label>
        <Divider />
        <button
          type="button"
          disabled={!keyable}
          title={keyable ? "把选中对象此刻的样子记成关键帧（K）" : "先选中一个人物或机位"}
          onClick={() => selectedId && recordKey(selectedId)}
          className="dt-action"
        >
          <Diamond className="dt-small-icon" />
          记录关键帧
        </button>
        <Divider />
        <select
          className={FIELD_CLASS}
          aria-label="运镜预设"
          value={presetId}
          disabled={!isCamera}
          title={isCamera ? preset.description : "先选中一台机位"}
          onChange={(event) => {
            const next = CAMERA_PRESETS.find((p) => p.id === event.target.value)!;
            setPresetId(next.id);
            setStrength(next.defaultStrength);
          }}
        >
          {CAMERA_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              运镜：{p.label}
            </option>
          ))}
        </select>
        {preset.unit && (
          <label className="dt-label">
            <input
              aria-label="运镜强度"
              type="number"
              className={cn(FIELD_CLASS, "dt-strength")}
              disabled={!isCamera}
              min={preset.min}
              max={preset.max}
              step={preset.step}
              value={strength}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value))
                  setStrength(Math.min(preset.max, Math.max(preset.min, value)));
              }}
            />
            {preset.unit}
          </label>
        )}
        <button type="button" disabled={!isCamera} onClick={runPreset} className="dt-action">
          套用
        </button>
        {selectedKey && (
          <button
            type="button"
            title="删除选中的关键帧（Delete）"
            onClick={() => deleteSelectedKey()}
            className="dt-delete"
          >
            <Trash2 className="dt-small-icon" />
            删除关键帧
          </button>
        )}
      </div>

      <div className="dt-body">
        <div className="dt-row-names">
          <div style={{ height: RULER }} />
          {rows.map(({ item, icon }) => (
            <button
              key={item.id}
              type="button"
              onClick={() => select(item.id)}
              className={cn("dt-name", selectedId === item.id && "dt-selected")}
              style={{ height: ROW }}
            >
              {icon}
              <span className="dt-truncate">{item.name}</span>
            </button>
          ))}
        </div>
        <div ref={lanesRef} className="dt-lanes" onPointerDown={scrub}>
          <div className="dt-ruler" style={{ height: RULER }}>
            {Array.from({ length: Math.floor(scene.duration) + 1 }, (_, second) => second).map(
              (s) => (
                <span key={s} className="dt-tick" style={{ left: pct(s) }}>
                  {s}s
                </span>
              ),
            )}
          </div>
          {rows.map(({ item }) => (
            <div
              key={item.id}
              className={cn("dt-row", selectedId === item.id && "dt-active")}
              style={{ height: ROW }}
            >
              {item.keys.map((key, index) => {
                const chosen =
                  selectedKey?.id === item.id && Math.abs(selectedKey.time - key.t) < 0.005;
                const occurrence = item.keys
                  .slice(0, index)
                  .filter((frame) => frame.t === key.t).length;
                return (
                  <button
                    key={`${key.t}:${occurrence}`}
                    type="button"
                    onClick={(event) => {
                      if (event.detail === 0) {
                        selectKey({ id: item.id, time: key.t });
                        setTime(key.t);
                      }
                    }}
                    aria-label={`${item.name} · ${key.t} 秒`}
                    title={`${key.t.toFixed(2)}s · ${key.ease === "linear" ? "线性" : "缓入缓出"}（右键切换）`}
                    onPointerDown={(event) => grabKey(event, item.id, key.t)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      const first = item.keys.find((frame) => sameDirectorKeyTime(frame.t, key.t));
                      change(item.id, key.t, key.t, first?.ease === "linear" ? "smooth" : "linear");
                    }}
                    className={cn(
                      "dt-key",
                      chosen ? "dt-chosen" : "dt-smooth",
                      key.ease === "linear" && !chosen && "dt-linear",
                    )}
                    style={{ left: pct(key.t) }}
                  />
                );
              })}
              {(pending.characters.has(item.id) || pending.cameras.has(item.id)) && (
                <span title="未记录，按 K 写入" className="dt-pending" style={{ left: pct(t) }} />
              )}
            </div>
          ))}
          <div className="dt-head" style={{ left: pct(t) }}>
            <span className="dt-knob" />
          </div>
          {rows.every(({ item }) => item.keys.length === 0) && (
            <p className="dt-empty">
              选中机位，从上方选一个运镜预设点「套用」；或拖动对象后按 K 记录关键帧
            </p>
          )}
        </div>
      </div>
      {notice && <output className="dt-notice">{notice.text}</output>}
    </section>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" title={title} onClick={onClick} className="dt-icon-button">
      {children}
    </button>
  );
}

function Divider() {
  return <span className="dt-rule" />;
}
