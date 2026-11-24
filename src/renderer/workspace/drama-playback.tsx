import type { DramaDocument, GenerationJob, ProjectAsset } from "@link-studio/core";
import { Pause, Play } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocalPreviewResult } from "./character-card-body";

type Segment = NonNullable<DramaDocument["segments"]>[number];
type PlayItem = {
  id: string;
  seq: number;
  assetId: string;
  seconds: number;
  start: number;
  duration: number;
  left: number;
  width: number;
};
export const clipWidth = (seconds: number) => Math.max(64, Math.round(seconds * 12));
export function playableClips(
  segments: Segment[],
  jobs: ReadonlyMap<string, GenerationJob[]>,
  assets: readonly ProjectAsset[],
) {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  let start = 0,
    left = 0;
  const items: PlayItem[] = [];
  for (const segment of [...segments].sort((first, second) => first.seq - second.seq)) {
    const width = clipWidth(segment.seconds);
    const job = jobs
      .get(`seg:${segment.id}`)
      ?.find((entry) => entry.id === segment.chosen_task_id && entry.status === "succeeded");
    const output = job?.outputs.find((entry) => entry.kind === "video");
    const asset = output?.kind === "video" && byId.get(output.assetId);
    if (asset && asset.availability === "ready" && asset.mediaType === "video") {
      const millis = asset.metadata.durationMs;
      const duration = typeof millis === "number" && millis > 0 ? millis / 1000 : segment.seconds;
      items.push({
        id: segment.id,
        seq: segment.seq,
        assetId: asset.assetId,
        seconds: segment.seconds,
        start,
        duration,
        left,
        width,
      });
      start += duration;
    }
    left += width + 4;
  }
  return items;
}

const clock = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function PlaybackSlot({
  item,
  handle,
  active,
  playing,
  advance,
  pause,
  tick,
  restart,
  toggle,
}: {
  item?: PlayItem;
  handle: string;
  active: boolean;
  playing: boolean;
  advance: () => void;
  pause: () => void;
  tick: (seconds: number) => void;
  restart: number;
  toggle: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const url = useLocalPreviewResult(handle, item?.assetId);
  const reduce = useReducedMotion();
  const onAdvance = useRef(advance);
  useLayoutEffect(() => {
    onAdvance.current = advance;
  }, [advance]);
  useLayoutEffect(() => {
    if (active && video.current) video.current.currentTime = 0;
  }, [active, restart, url]);
  useLayoutEffect(() => {
    if (active && video.current) tick(video.current.currentTime);
  }, [active, tick, restart, url]);
  useEffect(() => {
    const element = video.current;
    if (!element || !active || !playing || url === undefined) return;
    if (!url || element.error) {
      onAdvance.current();
      return;
    }
    let live = true;
    void element.play().catch((error: unknown) => {
      if (live && !(error instanceof DOMException && error.name === "AbortError")) pause();
    });
    return () => {
      live = false;
      element.pause();
    };
  }, [active, playing, url, pause]);
  useEffect(() => {
    if (!active || !playing || reduce) return;
    let frame: number;
    function update() {
      if (video.current) tick(video.current.currentTime);
      frame = requestAnimationFrame(update);
    }
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [active, playing, reduce, tick]);
  return (
    // biome-ignore lint/a11y/useMediaCaption: Generated clips have no caption source; playback controls are provided outside the video.
    <video
      ref={video}
      src={url || undefined}
      playsInline
      preload="auto"
      aria-hidden={!active}
      onClick={toggle}
      onTimeUpdate={(event) => {
        if (active) tick(event.currentTarget.currentTime);
      }}
      onEnded={() => {
        if (active && playing) advance();
      }}
      onError={() => {
        if (active && playing) advance();
      }}
    />
  );
}

export function useDramaPlayback(
  items: PlayItem[],
  select: (id: string) => void,
  host: HTMLElement | null,
  handle: string,
  playhead: RefObject<HTMLDivElement | null>,
  ratio?: string,
  batchHost?: (host: HTMLSpanElement | null) => void,
) {
  const [session, setSession] = useState<{
    id: string;
    slot: number;
    playing: boolean;
    restart: number;
  } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [finished, setFinished] = useState(false);
  const index = items.findIndex((item) => item.id === session?.id);
  const current = items[index],
    next = items[index + 1];
  const last = items.at(-1);
  const total = last ? last.start + last.duration : 0;
  const go = useCallback(
    (item: PlayItem) => {
      setFinished(false);
      setSession((previous) => ({
        id: item.id,
        playing: previous?.playing ?? true,
        slot: previous && previous.id !== item.id ? 1 - previous.slot : (previous?.slot ?? 0),
        restart: (previous?.restart ?? 0) + 1,
      }));
      setElapsed(Math.floor(item.start));
      select(item.id);
    },
    [select],
  );
  const pause = useCallback(
    () => setSession((previous) => previous && { ...previous, playing: false }),
    [],
  );
  const advance = useCallback(() => {
    if (next) go(next);
    else {
      setSession(null);
      setElapsed(0);
      setFinished(true);
    }
  }, [go, next]);
  const toggle = () => {
    if (session) setSession({ ...session, playing: !session.playing });
    else if (items[0] && host) {
      for (const video of host.querySelectorAll("video")) video.pause();
      go(items[0]);
    }
  };
  useEffect(() => {
    if (session && (!current || !host)) {
      setSession(null);
      setElapsed(0);
    }
  }, [session, current, host]);
  const tick = useCallback(
    (seconds: number) => {
      if (!current) return;
      const offset = Math.min(current.duration, Math.max(0, seconds));
      if (playhead.current)
        playhead.current.style.transform = `translateX(${current.left + (current.width * offset) / current.duration}px)`;
      setElapsed(Math.floor(current.start + offset));
    },
    [current, playhead],
  );
  return {
    active: !!current,
    jump: (segment: Segment) => {
      const playable = session && items.find((item) => item.seq >= segment.seq);
      if (playable) go(playable);
      else select(segment.id);
    },
    controls: (
      <div className="drama-playback-controls">
        <button
          type="button"
          aria-label={session?.playing ? "暂停连播" : "连播"}
          aria-pressed={!!session?.playing}
          disabled={!items.length || !host}
          onClick={toggle}
        >
          {session?.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span>
          {clock(current ? elapsed : 0)} / {clock(total)}
        </span>
        {current && <small>{session?.playing ? "连播中" : "已暂停"}</small>}
        {finished && <span role="status">连播结束（没出视频的片段已跳过）</span>}
        {batchHost && <span className="studio-batch-host" ref={batchHost} />}
      </div>
    ),
    stage:
      host &&
      current &&
      session &&
      createPortal(
        <section className="drama-playback-stage" aria-label="连播预览">
          <div
            className="drama-playback-frame"
            style={{
              aspectRatio: ratio && /^\d+:\d+$/.test(ratio) ? ratio.replace(":", "/") : "9/16",
            }}
          >
            {[0, 1].map((slot) => (
              <PlaybackSlot
                key={slot}
                item={slot === session.slot ? current : next}
                active={slot === session.slot}
                playing={session.playing}
                handle={handle}
                advance={advance}
                pause={pause}
                tick={tick}
                restart={session.restart}
                toggle={toggle}
              />
            ))}
            <div className="drama-playback-caption">
              <span>
                片段 {String(current.seq + 1).padStart(2, "0")}{" "}
                <b>{session.playing ? "连播中" : "连播已暂停"}</b>
              </span>
              <span>{current.seconds}s</span>
            </div>
          </div>
        </section>,
        host,
      ),
  };
}
