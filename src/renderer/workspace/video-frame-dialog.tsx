import type { ProjectAsset } from "@link-studio/core";
import { useEffect, useRef, useState } from "react";

export function VideoFrameDialog({
  asset,
  url,
  linked,
  busy,
  error,
  close,
  extract,
}: {
  asset: ProjectAsset;
  url: string;
  linked: boolean;
  busy: boolean;
  error: string;
  close: () => void;
  extract: (timeMs: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [seconds, setSeconds] = useState("0");
  const [previewFailed, setPreviewFailed] = useState(false);
  const duration = Number(asset.metadata.durationMs) || 86_400_001;
  const timeMs = Math.round(Number(seconds) * 1000);
  const valid =
    seconds.trim() !== "" &&
    Number.isSafeInteger(timeMs) &&
    timeMs >= 0 &&
    timeMs < duration &&
    timeMs <= 86_400_000;
  useEffect(() => dialog.current?.showModal(), []);

  return (
    <dialog
      ref={dialog}
      className="grid-split-dialog video-frame-dialog"
      aria-labelledby="video-frame-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <h2 id="video-frame-title">提取视频帧</h2>
        <span>{asset.displayName}</span>
      </header>
      <video
        ref={video}
        src={url}
        controls
        muted
        preload="metadata"
        onError={() => setPreviewFailed(true)}
        onSeeked={() => {
          if (video.current)
            setSeconds(String(Math.round(video.current.currentTime * 1000) / 1000));
        }}
      />
      <section className="grid-split-controls" aria-label="提帧位置">
        <label>
          时间（秒）{" "}
          <input
            type="number"
            min="0"
            max={Math.min(duration - 1, 86_400_000) / 1000}
            step="0.001"
            value={seconds}
            disabled={busy}
            onChange={(event) => setSeconds(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || !valid || previewFailed}
          onClick={() => {
            if (video.current) {
              video.current.pause();
              video.current.currentTime = timeMs / 1000;
            }
          }}
        >
          定位预览
        </button>
        <button
          type="button"
          disabled={busy || previewFailed}
          onClick={() => {
            if (video.current) {
              video.current.pause();
              setSeconds(String(Math.floor(video.current.currentTime * 1000) / 1000));
            }
          }}
        >
          使用播放位置
        </button>
      </section>
      {previewFailed && <p>当前视频无法播放预览，可输入时间提取。</p>}
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="grid-split-primary"
          disabled={busy || !valid}
          onClick={() => {
            video.current?.pause();
            extract(timeMs);
          }}
        >
          {busy ? "正在提取…" : linked ? "提取并加入画布" : "提取并预览"}
        </button>
      </footer>
    </dialog>
  );
}
