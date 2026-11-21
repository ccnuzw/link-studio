import type { DirectorScene } from "@link-studio/core";
import { useState } from "react";

type TrackKind = "character" | "camera";
type Ease = DirectorScene["cameras"][number]["keys"][number]["ease"];

export function DirectorTimeline({
  scene,
  time,
  selectedObject,
  disabled,
  select,
  change,
}: {
  scene: DirectorScene;
  time: number;
  selectedObject: string;
  disabled: boolean;
  select: (id: string, kind: TrackKind, time: number) => void;
  change: (id: string, from: number, to: number, ease: Ease) => void;
}) {
  const [picked, setPicked] = useState<{ id: string; time: number }>();
  const tracks = [
    ...scene.characters.map((item) => ({ ...item, kind: "character" as const })),
    ...scene.cameras.map((item) => ({ ...item, kind: "camera" as const })),
  ];
  const track = tracks.find(
    ({ id, kind }) =>
      id === picked?.id &&
      (kind === "camera" ? id === scene.activeCameraId : id === selectedObject),
  );
  const key = track?.keys.find(({ t }) => t === picked?.time);
  if (!tracks.length) return null;
  return (
    <fieldset className="director-timeline" disabled={disabled}>
      <legend>关键帧时间轴</legend>
      {tracks.map(({ id, name, keys, kind }) => (
        <div className="director-track" key={id}>
          <button type="button" title={name} onClick={() => select(id, kind, time)}>
            {name}
          </button>
          <div className="director-track-keys">
            <span
              className="director-playhead"
              aria-hidden="true"
              style={{ left: `${(time / scene.duration) * 100}%` }}
            />
            {keys.map(({ t }) => (
              <button
                key={t}
                type="button"
                aria-label={`${name} · ${t} 秒`}
                title={`${t} 秒`}
                aria-pressed={track?.id === id && key?.t === t}
                style={{ left: `${(t / scene.duration) * 100}%` }}
                onClick={() => {
                  setPicked({ id, time: t });
                  select(id, kind, t);
                }}
              >
                ◆
              </button>
            ))}
          </div>
        </div>
      ))}
      {track && key && (
        <form
          className="director-controls"
          key={`${track.id}-${key.t}`}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const next = Number(form.get("time"));
            if (
              !Number.isFinite(next) ||
              next < 0 ||
              next > scene.duration ||
              track.keys.some(({ t }) => t === next && t !== key.t)
            )
              return;
            change(track.id, key.t, next, form.get("ease") === "linear" ? "linear" : "smooth");
            setPicked({ id: track.id, time: next });
          }}
        >
          <label>
            关键帧时间{" "}
            <input
              type="number"
              name="time"
              min={0}
              max={scene.duration}
              step="any"
              defaultValue={key.t}
              required
              onInput={(event) => {
                const input = event.currentTarget;
                input.setCustomValidity(
                  track.keys.some(({ t }) => t === input.valueAsNumber && t !== key.t)
                    ? "这个时间已有关键帧。"
                    : "",
                );
              }}
            />
          </label>
          <label>
            过渡{" "}
            <select name="ease" defaultValue={key.ease}>
              <option value="smooth">平滑</option>
              <option value="linear">线性</option>
            </select>
          </label>
          <button type="submit">更新关键帧</button>
        </form>
      )}
    </fieldset>
  );
}
