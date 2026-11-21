import type { ProjectAsset } from "@link-studio/core";
import { useEffect, useRef, useState } from "react";

export function VideoTrimDialog({
  asset,
  url,
  busy,
  error,
  cancel,
  close,
  save,
}: {
  asset: ProjectAsset;
  url: string;
  busy: boolean;
  error: string;
  cancel?: () => void;
  close: () => void;
  save: (startMs: number, endMs: number, removeAudio: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(Number(asset.metadata.durationMs) || 0);
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState(duration ? String(duration / 1000) : "");
  const [removeAudio, setRemoveAudio] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const startMs = Math.round(Number(start) * 1000);
  const endMs = Math.round(Number(end) * 1000);
  const valid =
    start !== "" &&
    end !== "" &&
    Number.isSafeInteger(startMs) &&
    Number.isSafeInteger(endMs) &&
    startMs >= 0 &&
    endMs > startMs &&
    (!duration || endMs <= duration);
  useEffect(() => dialog.current?.showModal(), []);

  return (
    <dialog
      ref={dialog}
      className="grid-split-dialog video-frame-dialog"
      aria-labelledby="video-trim-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <h2 id="video-trim-title">裁切视频</h2>
        <span>{asset.displayName}</span>
      </header>
      <video
        ref={video}
        src={url}
        controls
        muted={removeAudio}
        preload="metadata"
        onError={() => setPreviewError(true)}
        onLoadedMetadata={({ currentTarget }) => {
          if (duration || !Number.isFinite(currentTarget.duration)) return;
          const milliseconds = Math.round(currentTarget.duration * 1000);
          setDuration(milliseconds);
          setEnd((value) => value || String(milliseconds / 1000));
        }}
        onTimeUpdate={({ currentTarget }) => {
          if (!currentTarget.paused && valid && currentTarget.currentTime >= endMs / 1000)
            currentTarget.pause();
        }}
      />
      <fieldset className="video-trim-fields" disabled={busy}>
        <legend>保留片段</legend>
        <div className="video-trim-grid">
          {(
            [
              ["入点", start, setStart],
              ["出点", end, setEnd],
            ] as const
          ).map(([label, value, change]) => (
            <div key={label}>
              <label>
                {label}（秒）
                <input
                  type="number"
                  min="0"
                  max={duration ? duration / 1000 : undefined}
                  step="0.001"
                  value={value}
                  onChange={(event) => change(event.target.value)}
                />
              </label>
              {duration > 0 && (
                <input
                  type="range"
                  aria-label={`拖动${label}`}
                  min="0"
                  max={duration / 1000}
                  step="0.001"
                  value={Number(value) || 0}
                  onChange={(event) => {
                    change(event.target.value);
                    if (video.current && !previewError) {
                      video.current.pause();
                      video.current.currentTime = Number(event.target.value);
                    }
                  }}
                />
              )}
            </div>
          ))}
        </div>
        <label className="video-trim-audio">
          <input
            type="checkbox"
            checked={removeAudio}
            onChange={(event) => setRemoveAudio(event.target.checked)}
          />
          移除音轨
        </label>
        <button
          type="button"
          disabled={!valid || previewError}
          onClick={() => {
            const player = video.current;
            if (!player) return;
            player.currentTime = startMs / 1000;
            void player.play().catch(() => setPreviewError(true));
          }}
        >
          预览选区
        </button>
        <span>{valid ? `片段时长 ${(endMs - startMs) / 1000} 秒` : "请选择有效的入点和出点"}</span>
      </fieldset>
      {previewError && <p>当前视频无法预览，可输入起止时间裁切。</p>}
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={busy && !cancel} onClick={busy ? cancel : close}>
          {busy ? "取消裁切" : "关闭"}
        </button>
        <button
          type="button"
          className="grid-split-primary"
          disabled={busy || !valid}
          onClick={() => {
            video.current?.pause();
            save(startMs, endMs, removeAudio);
          }}
        >
          {busy ? "正在裁切…" : "裁切并加入画布"}
        </button>
      </footer>
    </dialog>
  );
}
