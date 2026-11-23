import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";

const DURATION = { base: 0.18, exit: 0.126, fast: 0.12 };
const EASE_OUT = [0.2, 0, 0, 1] as const;
const TAP = { scale: 0.96 };

import { LocalVideoPoster } from "./local-video-poster";
import {
  createVideoSlotPool,
  type FacadeEvent,
  type FacadePhase,
  formatMediaDuration,
  LOAD_TIMEOUT_MS,
  nextFacadePhase,
  remainingLoadingMs,
} from "./node-video-state";
import "./node-video-player.css";

const videoSlots = createVideoSlotPool();

function formatClock(seconds: number): string {
  return formatMediaDuration(seconds * 1000) ?? "0:00";
}

type VideoControlsProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
};

function VideoControls({ videoRef }: VideoControlsProps) {
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => {
      setPaused(video.paused);
      setMuted(video.muted);
      setCurrent(video.currentTime);
      setTotal(Number.isFinite(video.duration) ? video.duration : 0);
    };
    sync();
    const events = [
      "play",
      "pause",
      "ended",
      "timeupdate",
      "durationchange",
      "loadedmetadata",
      "volumechange",
    ];
    events.forEach((name) => {
      video.addEventListener(name, sync);
    });
    return () =>
      events.forEach((name) => {
        video.removeEventListener(name, sync);
      });
  }, [videoRef]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) void video.play().catch(() => {});
    else video.pause();
  };

  const percent = total > 0 ? (current / total) * 100 : 0;

  return (
    <div className="nodrag nowheel node-video-controls">
      <button
        type="button"
        aria-label={paused ? "播放" : "暂停"}
        onClick={togglePlay}
        className="node-video-control"
      >
        {paused ? (
          <Play className="node-video-glyph filled" />
        ) : (
          <Pause className="node-video-glyph filled" />
        )}
      </button>
      <input
        type="range"
        aria-label="播放进度"
        min={0}
        max={total || 1}
        step="any"
        value={current}
        onChange={(e) => {
          const video = videoRef.current;
          if (video) video.currentTime = Number(e.target.value);
        }}
        style={{
          background: `linear-gradient(to right, #fff ${percent}%, rgb(255 255 255 / 0.35) ${percent}%)`,
        }}
        className="node-video-range"
      />
      <span className="node-video-clock">
        {formatClock(current)} / {formatClock(total)}
      </span>
      <button
        type="button"
        aria-label={muted ? "取消静音" : "静音"}
        onClick={() => {
          const video = videoRef.current;
          if (video) video.muted = !video.muted;
        }}
        className="node-video-control"
      >
        {muted ? (
          <VolumeX className="node-video-glyph" />
        ) : (
          <Volume2 className="node-video-glyph" />
        )}
      </button>
    </div>
  );
}

const ENTER = { duration: DURATION.base, ease: EASE_OUT } as const;
const LEAVE = { duration: DURATION.exit, ease: EASE_OUT } as const;
const SWAP = { duration: DURATION.fast, ease: EASE_OUT } as const;

type FacadeVideoProps = {
  src: string;
  phase: FacadePhase;

  onFrame: () => void;

  onError: () => void;

  onRevoke: () => void;

  onVideo?: (video: HTMLVideoElement | null) => void;
};

function FacadeVideo({ src, phase, onFrame, onError, onRevoke, onVideo }: FacadeVideoProps) {
  const id = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isPresent = useIsPresent();

  const onRevokeRef = useRef(onRevoke);
  useEffect(() => {
    onRevokeRef.current = onRevoke;
  });

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    el.src = src;
    videoSlots.acquire(id, {
      isPlaying: () =>
        el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || (!el.paused && !el.ended),
      release: () => onRevokeRef.current(),
    });
    return () => {
      videoSlots.release(id);

      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, [id, src]);

  const onVideoRef = useRef(onVideo);
  useEffect(() => {
    onVideoRef.current = onVideo;
  });
  useEffect(() => {
    if (!isPresent) return;
    onVideoRef.current?.(videoRef.current);
    return () => onVideoRef.current?.(null);
  }, [isPresent]);

  useEffect(() => {
    if (isPresent) return;
    videoRef.current?.pause();
    videoSlots.release(id);
  }, [isPresent, id]);

  useEffect(() => {
    if (phase === "playing") void videoRef.current?.play().catch(() => {});
  }, [phase]);

  return (
    <motion.div
      className="node-video-layer"
      style={{ pointerEvents: phase === "playing" && isPresent ? "auto" : "none" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: phase === "playing" ? 1 : 0, transition: ENTER }}
      exit={{ opacity: 0, transition: LEAVE }}
    >
      <video
        ref={videoRef}
        playsInline
        preload="auto"
        onLoadedData={onFrame}
        onError={onError}
        className="node-video-media"
      />
      <VideoControls videoRef={videoRef} />
    </motion.div>
  );
}

type VideoPlayerProps = {
  src: string;
  assetId: string;
  projectHandle: string;

  durationMs?: number | null;

  active?: boolean;

  onVideo?: (video: HTMLVideoElement | null) => void;

  playSignal?: number;
  onFailure: (message: string) => void;
};

export function NodeVideoPlayer({
  src,
  assetId,
  projectHandle,
  durationMs,
  onFailure,
  active = true,
  onVideo,
  playSignal,
}: VideoPlayerProps) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<FacadePhase>("idle");
  const [frameReady, setFrameReady] = useState(false);

  const [posterSettled, setPosterSettled] = useState(false);

  const [session, setSession] = useState(0);
  const startedAt = useRef(0);
  const duration = formatMediaDuration(durationMs);

  const dispatch = useCallback(
    (event: FacadeEvent) => setPhase((current) => nextFacadePhase(current, event)),
    [],
  );
  const fail = useCallback(() => {
    dispatch("error");
    onFailure("视频无法播放");
  }, [dispatch, onFailure]);

  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) setPhase(nextFacadePhase(phase, "deactivate"));
  }

  useEffect(() => {
    if (phase !== "loading" || !frameReady) return;
    const timer = setTimeout(
      () => dispatch("ready"),
      remainingLoadingMs(startedAt.current, performance.now()),
    );
    return () => clearTimeout(timer);
  }, [phase, frameReady, dispatch]);

  useEffect(() => {
    if (phase !== "loading") return;
    const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, fail]);

  const start = useCallback(() => {
    startedAt.current = performance.now();
    setFrameReady(false);
    setSession((n) => n + 1);
    dispatch("play");
  }, [dispatch]);

  const lastSignal = useRef(playSignal);
  useEffect(() => {
    if (playSignal === lastSignal.current) return;
    lastSignal.current = playSignal;
    if (phase === "idle") start();
  }, [playSignal, phase, start]);

  const loading = phase === "loading";
  const playing = phase === "playing";
  const transition = playing ? LEAVE : ENTER;

  return (
    <div className="node-video-player">
      <LocalVideoPoster
        assetId={assetId}
        projectHandle={projectHandle}
        onSettledChange={setPosterSettled}
      />
      <AnimatePresence>
        {phase !== "idle" && (
          <FacadeVideo
            key={session}
            src={src}
            phase={phase}
            onFrame={() => setFrameReady(true)}
            onError={fail}
            onRevoke={() => dispatch("revoke")}
            onVideo={onVideo}
          />
        )}
      </AnimatePresence>

      <motion.div
        className="node-video-dim"
        initial={false}
        animate={{ opacity: loading ? 1 : 0 }}
        transition={loading ? ENTER : LEAVE}
      />
      <motion.button
        type="button"
        aria-label="播放视频"
        disabled={phase !== "idle"}
        initial={false}
        animate={{
          opacity: playing || !posterSettled ? 0 : 1,
          scale: playing && !reduce ? 0.9 : 1,
        }}
        whileHover={phase === "idle" && !reduce ? { scale: 1.06 } : undefined}
        whileTap={phase === "idle" ? TAP : undefined}
        transition={transition}
        onClick={start}
        className="nodrag node-video-start"
        style={{ pointerEvents: playing ? "none" : undefined }}
      >
        <motion.span
          className="node-video-start-bg"
          initial={false}
          animate={{ opacity: loading ? 0 : 1 }}
          transition={SWAP}
        />
        <motion.span
          className="node-video-start-icon"
          initial={false}
          animate={{ opacity: loading ? 0 : 1, scale: loading && !reduce ? 0.6 : 1 }}
          transition={SWAP}
        >
          <Play className="node-video-triangle" />
        </motion.span>
        <motion.span
          className="node-video-start-icon"
          initial={false}
          animate={{ opacity: loading ? 1 : 0, scale: loading || reduce ? 1 : 0.8 }}
          transition={SWAP}
        >
          <svg
            viewBox="0 0 28 28"
            className={reduce ? "node-video-ring" : "node-video-ring spin"}
            aria-hidden
          >
            <circle
              cx="14"
              cy="14"
              r="11"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.25"
              strokeWidth="2.4"
            />
            <circle
              cx="14"
              cy="14"
              r="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeDasharray="22 66"
            />
          </svg>
        </motion.span>
      </motion.button>
      <span role="status" className="node-video-status">
        {loading ? "视频加载中" : ""}
      </span>
      {duration && (
        <motion.span
          className="node-video-duration"
          initial={false}
          animate={{ opacity: playing || !posterSettled ? 0 : 1 }}
          transition={transition}
        >
          {duration}
        </motion.span>
      )}
    </div>
  );
}
