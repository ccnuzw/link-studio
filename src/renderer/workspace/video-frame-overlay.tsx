import { NodeToolbar, Position, useStore } from "@xyflow/react";
import { Camera, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { frameClock, framePreview, useFrameFilmstrip } from "./frame-filmstrip";
import "./video-frame-overlay.css";

export function VideoFrameOverlay({
  nodeId,
  url,
  busy,
  error,
  close,
  extract,
}: {
  nodeId: string;
  url: string;
  busy: boolean;
  error: string;
  close: () => void;
  extract: (times: number[]) => void;
}) {
  const media = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"] .node-media`,
  );
  const video = useRef<HTMLVideoElement>(null);
  const nextId = useRef(1);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [notice, setNotice] = useState("");
  const [frames, setFrames] = useState<{ id: number; time: number; src: string }[]>([]);
  const thumbs = useFrameFilmstrip(url);
  const layout = useStore((state) => {
    const node = state.nodeLookup.get(nodeId);
    const width = Math.min(680, Math.max(0, state.width - 24));
    const center =
      ((node?.internals.positionAbsolute.x ?? 0) + (node?.measured.width ?? 0) / 2) *
        state.transform[2] +
      state.transform[0];
    const left = center - width / 2;
    return `${width}|${Math.max(12, Math.min(left, state.width - width - 12)) - left}`;
  });
  const [width, shift] = layout.split("|").map(Number);
  const ready = duration > 0 && !failed;
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (!busy && event.key === "Escape") close();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [busy, close]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const sync = () => {
      if (video.current) setCurrent(Math.round(video.current.currentTime * 100) / 100);
      raf = requestAnimationFrame(sync);
    };
    sync();
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const seek = (time: number) => {
    if (!video.current || !ready || busy) return;
    video.current.pause();
    const target = Math.min(duration, Math.max(0, time));
    setCurrent(target);
    setSeeking(true);
    video.current.currentTime = target;
  };
  const pointerSeek = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - rect.left) / rect.width) * duration);
  };
  const capture = () => {
    const player = video.current;
    if (!player || player.seeking || !ready) return;
    const time = Math.min(
      Math.ceil(duration * 1000) - 1,
      Math.round(player.currentTime * 100) * 10,
    );
    if (frames.length >= 9) return setNotice("最多暂存 9 帧");
    if (frames.some((frame) => Math.abs(frame.time - time) < 15))
      return setNotice("这一帧已经截过了");
    player.pause();
    try {
      const frame = { id: nextId.current++, time, src: framePreview(player, 224) };
      setFrames((items) => [...items, frame]);
      setNotice("");
    } catch {
      setNotice("读不出视频画面");
    }
  };
  if (!media) return null;
  return (
    <>
      {createPortal(
        <div className="frame-stage nodrag nopan">
          <video
            ref={video}
            src={url}
            muted={muted}
            playsInline
            disablePictureInPicture
            preload="auto"
            crossOrigin="anonymous"
            onLoadedData={(event) => {
              if (Number.isFinite(event.currentTarget.duration))
                setDuration(event.currentTarget.duration);
            }}
            onError={() => setFailed(true)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onSeeked={(event) => {
              setSeeking(false);
              setCurrent(Math.round(event.currentTarget.currentTime * 100) / 100);
            }}
          />
          {failed && <span>读不出视频画面</span>}
          <button
            type="button"
            aria-label={muted ? "预览开声音" : "预览静音"}
            aria-pressed={muted}
            onClick={() => setMuted(!muted)}
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </button>
        </div>,
        media,
      )}
      <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom} offset={16}>
        <fieldset
          aria-label="截取帧"
          className="frame-panel nodrag nopan nowheel"
          style={{ width, translate: `${shift}px 0` }}
        >
          <div
            className="frame-track"
            role="slider"
            tabIndex={ready ? 0 : -1}
            aria-label="播放位置"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={current}
            aria-valuetext={frameClock(current)}
            aria-disabled={!ready || busy}
            onPointerDown={(event) => {
              if (event.button !== 0 || !ready || busy) return;
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              pointerSeek(event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) pointerSeek(event);
            }}
            onKeyDown={(event) => {
              const dir = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (dir) {
                event.preventDefault();
                event.stopPropagation();
                seek(current + dir * (event.shiftKey ? 1 : 1 / 30));
              }
            }}
          >
            <div className="frame-strip" aria-hidden="true">
              {thumbs.map((thumb) => (
                <img key={thumb.slot} src={thumb.src} alt="" draggable={false} />
              ))}
            </div>
            <i style={{ left: `${Math.min(100, (current / (duration || 1)) * 100)}%` }} />
            {!duration && !failed && <span>加载中…</span>}
          </div>
          <div className="frame-controls">
            <div>
              <button
                type="button"
                aria-label="关闭截取帧"
                title="关闭"
                disabled={busy}
                onClick={close}
              >
                <X />
              </button>
              <i />
              <button
                type="button"
                aria-label={playing ? "暂停" : "播放"}
                disabled={!ready || busy}
                onClick={() => {
                  const player = video.current;
                  if (!player) return;
                  if (playing) player.pause();
                  else {
                    if (player.ended) player.currentTime = 0;
                    void player.play().catch(() => setNotice("无法播放视频"));
                  }
                }}
              >
                {playing ? <Pause /> : <Play />}
              </button>
              <time>
                {frameClock(current)} / {frameClock(duration)}
              </time>
            </div>
            <div>
              {frames.map((frame) => (
                <div className="frame-thumb" key={frame.id}>
                  <img src={frame.src} alt={`#${frame.id}`} />
                  <b>#{frame.id}</b>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`丢弃 #${frame.id}`}
                    onClick={() => {
                      setFrames(frames.filter((item) => item.id !== frame.id));
                      setNotice("");
                    }}
                  >
                    <X size={12} />
                  </button>
                  <div className="frame-pop">
                    <img src={frame.src} alt="" />
                    <span>{frameClock(frame.time / 1000)} 截取帧</span>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="frame-capture"
                aria-label="截取帧"
                title="截取当前画面"
                disabled={!ready || seeking || busy}
                onClick={capture}
              >
                <Camera />
                {!frames.length && "截取帧"}
              </button>
            </div>
            <button
              className="frame-confirm"
              type="button"
              disabled={!frames.length || busy}
              onClick={() => extract(frames.map((frame) => frame.time))}
            >
              确认
            </button>
          </div>
          {(notice || error || failed) && (
            <output>{error || (failed ? "读不出视频画面" : notice)}</output>
          )}
        </fieldset>
      </NodeToolbar>
    </>
  );
}
