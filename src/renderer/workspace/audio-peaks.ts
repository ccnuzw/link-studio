export const SILENT_PEAK = 0.03;

export function computePeaks(samples: Float32Array, bars: number): number[] {
  if (samples.length === 0 || !Number.isInteger(bars) || bars <= 0) return [];
  const peaks = Array.from({ length: bars }, (_, index) => {
    const from = Math.floor((index * samples.length) / bars);
    const to = Math.max(from + 1, Math.floor(((index + 1) * samples.length) / bars));
    let peak = 0;
    for (let sampleIndex = from; sampleIndex < to && sampleIndex < samples.length; sampleIndex++) {
      peak = Math.max(peak, Math.abs(samples[sampleIndex]!));
    }
    return peak;
  });
  const max = Math.max(...peaks);
  return max > 0 ? peaks.map((peak) => peak / max) : peaks;
}

export function clockParts(seconds: number): { dim: string; bright: string } {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const pad = (value: number) => String(value).padStart(2, "0");
  const text = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map(pad)
    .join(":");
  const first = text.search(/[1-9]/);
  const cut = first === -1 ? text.length - 1 : first;
  return { dim: text.slice(0, cut), bright: text.slice(cut) };
}

export function positionToTime(position: number, duration: number): number {
  return Math.min(1, Math.max(0, position)) * duration;
}

export function timeToPosition(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, Math.max(0, time / duration));
}
