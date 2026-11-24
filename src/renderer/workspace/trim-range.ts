export function trimBoundary(
  which: "start" | "end",
  value: number,
  start: number,
  end: number,
  duration: number,
) {
  const rounded = Math.min(duration, Math.max(0, Math.round(value * 100) / 100));
  return which === "start"
    ? Math.min(rounded, Math.max(0, end - 0.5))
    : Math.max(rounded, Math.min(duration, start + 0.5));
}

export function trimAllowed(start: number, end: number, duration: number, removeAudio: boolean) {
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end - start >= 500 &&
    (!duration || end <= duration) &&
    (removeAudio || !duration || start > 20 || end < duration - 20)
  );
}
