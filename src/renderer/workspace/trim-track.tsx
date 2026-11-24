import { useRef } from "react";
import { useFrameFilmstrip } from "./frame-filmstrip";
import { trimBoundary } from "./trim-range";

export function TrimTrack({
  url,
  start,
  end,
  duration,
  change,
  seek,
  busy,
}: {
  url: string;
  start: number;
  end: number;
  duration: number;
  change: (which: "start" | "end", time: number) => void;
  seek: (time: number) => void;
  busy: boolean;
}) {
  const frames = useFrameFilmstrip(url);
  const track = useRef<HTMLDivElement>(null);
  const timeAt = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    return ((clientX - rect.left) * duration) / Math.max(1, rect.width);
  };
  const move = (which: "start" | "end", time: number) => {
    const next = trimBoundary(which, time, start, end, duration);
    change(which, next);
    seek(next);
  };
  return (
    <div
      className="canvas-trim-track"
      ref={track}
      onPointerDown={(event) => {
        if (!busy) seek(Math.max(start, Math.min(end, timeAt(event.clientX))));
      }}
    >
      {frames.map((cell) => (
        <img key={cell.slot} src={cell.src} alt="" draggable={false} />
      ))}
      <span
        className="trim-range"
        style={{ left: `${(start / duration) * 100}%`, right: `${100 - (end / duration) * 100}%` }}
      />
      {(["start", "end"] as const).map((which) => {
        const value = which === "start" ? start : end;
        return (
          <button
            key={which}
            type="button"
            role="slider"
            aria-label={`拖动${which === "start" ? "入点" : "出点"}`}
            aria-valuemin={which === "start" ? 0 : Math.min(start + 0.5, duration)}
            aria-valuemax={which === "end" ? duration : Math.max(0, end - 0.5)}
            aria-valuenow={value}
            style={{ left: `${(value / duration) * 100}%` }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!busy && event.currentTarget.hasPointerCapture(event.pointerId))
                move(which, timeAt(event.clientX));
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              move(
                which,
                value + (event.shiftKey ? 1 : 0.1) * (event.key === "ArrowRight" ? 1 : -1),
              );
            }}
          />
        );
      })}
    </div>
  );
}
