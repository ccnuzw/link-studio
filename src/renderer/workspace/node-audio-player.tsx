import { Pause, Play } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import "./node-audio-player.css";

import { clockParts, positionToTime, SILENT_PEAK, timeToPosition } from "./audio-peaks";

import { useAudioPeaks } from "./use-audio-peaks";

const BARS = 56;

const KEY_STEP = 1;

type AudioPlayerProps = {
  src: string;
  projectHandle: string;
  assetId: string;

  active?: boolean;
};

export function NodeAudioPlayer({ src, projectHandle, assetId, active = true }: AudioPlayerProps) {
  const reduce = useReducedMotion();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ wasPlaying: boolean } | null>(null);
  const { peaks, duration: decoded } = useAudioPeaks(projectHandle, assetId, src, BARS);

  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [metaDuration, setMetaDuration] = useState(0);

  const [second, setSecond] = useState(0);

  const [playedBars, setPlayedBars] = useState(0);
  const duration = metaDuration || decoded;

  const paint = useCallback(
    (time: number) => {
      const position = timeToPosition(time, duration);
      if (headRef.current) headRef.current.style.transform = `translateX(${position * 100}cqw)`;
      setPlayedBars(Math.floor(position * BARS));
      setSecond(Math.floor(time));
    },
    [duration],
  );

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) paint(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, paint]);

  useEffect(() => {
    paint(audioRef.current?.currentTime ?? 0);
  }, [paint]);

  useEffect(() => {
    if (!active) audioRef.current?.pause();
  }, [active]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    if (audio.paused || audio.ended) void audio.play().catch(() => setFailed(true));
    else audio.pause();
  };

  const seekTo = (time: number) => {
    const audio = audioRef.current;
    if (!audio || !(duration > 0)) return;
    audio.currentTime = Math.min(duration, Math.max(0, time));
    paint(audio.currentTime);
  };

  const seekFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekTo(positionToTime((event.clientX - rect.left) / rect.width, duration));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowRight" ? KEY_STEP : event.key === "ArrowLeft" ? -KEY_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    seekTo((audioRef.current?.currentTime ?? 0) + delta);
  };

  const clock = clockParts(second);

  return (
    <div className="node-audio-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          setMetaDuration(Number.isFinite(value) ? value : 0);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          seekTo(0);
        }}
        onError={() => setFailed(true)}
      />

      <div
        data-slot="audio-wave"
        className="nodrag nowheel nopan node-audio-wave"
        onPointerDown={(event) => {
          if (failed) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { wasPlaying: playing };
          audioRef.current?.pause();
          seekFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragRef.current) seekFromPointer(event);
        }}
        onPointerUp={() => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (drag?.wasPlaying) void audioRef.current?.play().catch(() => setFailed(true));
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <motion.div
          key={peaks ? "ready" : "empty"}
          className="node-audio-bars"
          initial={{ opacity: peaks && !reduce ? 0 : 1 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          {Array.from({ length: BARS }, (_, index) => {
            const peak = peaks?.[index] ?? 0;
            return (
              <span
                key={index}
                aria-hidden
                className="node-audio-bar"
                data-played={index < playedBars}
                data-pending={peaks === undefined}
                style={{ height: peak < SILENT_PEAK ? 2 : `${Math.max(peak, 0.08) * 100}%` }}
              />
            );
          })}
        </motion.div>

        <div
          ref={headRef}
          role="slider"
          tabIndex={0}
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={second}
          onKeyDown={onKeyDown}
          className="node-audio-head"
        >
          <span className="node-audio-line" />
          <span className="node-audio-dot" />
        </div>
      </div>
      <div className="node-audio-footer">
        <span className="node-audio-time" aria-live="off">
          {failed ? (
            <span className="node-audio-dim">--:--:--</span>
          ) : (
            <>
              <span className="node-audio-dim">{clock.dim}</span>
              {clock.bright}
            </>
          )}
        </span>
        <motion.button
          type="button"
          aria-label={playing ? "暂停" : "播放"}
          disabled={failed}
          whileTap={{ scale: 0.96 }}
          onClick={toggle}
          className="nodrag node-audio-toggle"
        >
          {playing ? <Pause className="audio-pause-icon" /> : <Play className="audio-play-icon" />}
        </motion.button>
      </div>
    </div>
  );
}
