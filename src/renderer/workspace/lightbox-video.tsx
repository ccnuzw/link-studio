import { Menu } from "@base-ui/react/menu";
import { Check, Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssetVideo } from "../asset-media";

function clock(seconds: number) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function LightboxVideo({
  src,
  onSize,
  onError,
}: {
  src: string;
  onSize: (width: number, height: number) => void;
  onError: () => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const timer = useRef<number>(0);
  const [idle, setIdle] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [plainSrc, setPlainSrc] = useState<string | null>(null);
  const crossOrigin = plainSrc === src ? null : "anonymous";
  const [state, setState] = useState({ paused: false, muted: false, current: 0, duration: 0 });
  const wake = useCallback(() => {
    clearTimeout(timer.current);
    setIdle(false);
    timer.current = window.setTimeout(() => setIdle(true), 2500);
  }, []);
  const toggle = useCallback(() => {
    const video = player.current;
    if (!video) return;
    if (video.paused || video.ended) void video.play().catch(() => {});
    else video.pause();
  }, []);
  const mute = useCallback(() => {
    if (player.current) player.current.muted = !player.current.muted;
  }, []);
  useEffect(() => {
    const video = player.current!;
    const sync = () =>
      setState({
        paused: video.paused,
        muted: video.muted,
        current: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      });
    const events = ["play", "pause", "ended", "timeupdate", "durationchange", "volumechange"];
    for (const name of events) video.addEventListener(name, sync);
    video.crossOrigin = crossOrigin;
    video.src = src;
    void video.play().catch(() => {});
    sync();
    wake();
    const keys = (event: KeyboardEvent) => {
      if ((event.target as Element)?.closest('[role="menu"]')) return;
      if (event.key === " ") {
        event.preventDefault();
        if (event.type === "keydown" && !event.repeat) {
          toggle();
          wake();
        }
      } else if (event.type === "keydown" && event.key.toLowerCase() === "m") mute();
    };
    document.addEventListener("keydown", keys, true);
    document.addEventListener("keyup", keys, true);
    return () => {
      for (const name of events) video.removeEventListener(name, sync);
      document.removeEventListener("keydown", keys, true);
      document.removeEventListener("keyup", keys, true);
      clearTimeout(timer.current);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, crossOrigin, wake, toggle, mute]);
  return (
    <div className="lightbox-video" onPointerMove={wake}>
      <AssetVideo
        ref={player}
        playsInline
        preload="auto"
        loop={loop}
        onClick={() => {
          toggle();
          wake();
        }}
        onError={() => (crossOrigin ? setPlainSrc(src) : onError())}
        onLoadedMetadata={({ currentTarget }) => {
          if (currentTarget.videoWidth && currentTarget.videoHeight)
            onSize(currentTarget.videoWidth, currentTarget.videoHeight);
        }}
      />
      <div className="lightbox-video-controls" data-hidden={!state.paused && idle}>
        <button
          type="button"
          aria-label={state.paused ? "播放（空格）" : "暂停（空格）"}
          onClick={toggle}
        >
          {state.paused ? <Play /> : <Pause />}
        </button>
        <input
          type="range"
          aria-label="播放进度"
          min="0"
          max={state.duration || 1}
          step="any"
          value={state.current}
          style={{
            background: `linear-gradient(to right,#fff ${(state.current / (state.duration || 1)) * 100}%,rgb(255 255 255 / 35%) 0)`,
          }}
          onChange={({ currentTarget }) => {
            if (player.current) player.current.currentTime = Number(currentTarget.value);
          }}
        />
        <span>
          {clock(state.current)} / {clock(state.duration)}
        </span>
        <Menu.Root>
          <Menu.Trigger aria-label="倍速">{speed}x</Menu.Trigger>
          <Menu.Portal container={player.current?.closest("dialog") ?? undefined}>
            <Menu.Positioner
              side="top"
              align="end"
              sideOffset={4}
              collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
            >
              <Menu.Popup className="canvas-frame-menu canvas-view-menu lightbox-speed-menu">
                <Menu.RadioGroup
                  value={speed}
                  onValueChange={(value) => {
                    setSpeed(value);
                    if (player.current) player.current.playbackRate = value;
                  }}
                >
                  {[0.5, 1, 1.5, 2].map((rate) => (
                    <Menu.RadioItem key={rate} value={rate}>
                      <Menu.RadioItemIndicator className="lightbox-speed-indicator">
                        <Check size={16} />
                      </Menu.RadioItemIndicator>
                      {rate}x
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <button
          type="button"
          aria-label="循环播放"
          aria-pressed={loop}
          onClick={() => setLoop((value) => !value)}
        >
          <Repeat />
        </button>
        <button
          type="button"
          aria-label={state.muted ? "取消静音（M）" : "静音（M）"}
          onClick={mute}
        >
          {state.muted ? <VolumeX /> : <Volume2 />}
        </button>
      </div>
    </div>
  );
}
