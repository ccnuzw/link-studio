export function parseAspect(value: unknown): number | null {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value ?? ""));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

export type OriginSize = { w: number; h: number };

export type OutpaintFrame = { x0: number; y0: number; x1: number; y1: number };

export type FrameHandle = "t" | "b" | "l" | "r" | "tl" | "tr" | "bl" | "br";

export const MAX_MULT = 3;

export const OUTPAINT_MULTS = [1, 1.25, 1.5, 2, 3] as const;

export const RATIO_PRESETS = [
  { key: "21:9", r: 21 / 9 },
  { key: "4:3", r: 4 / 3 },
  { key: "1:1", r: 1 },
  { key: "3:4", r: 3 / 4 },
  { key: "9:16", r: 9 / 16 },
] as const;

const RATIO_EPS = 0.004;

const RATIO_MAX_TERM = 24;

export const frameWidth = (frame: OutpaintFrame) => frame.x1 - frame.x0;
export const frameHeight = (frame: OutpaintFrame) => frame.y1 - frame.y0;

export const frameCap = (origin: OriginSize) => MAX_MULT * Math.max(origin.w, origin.h);

function centered(origin: OriginSize, w: number, h: number): OutpaintFrame {
  const dx = (w - origin.w) / 2;
  const dy = (h - origin.h) / 2;

  return { x0: 0 - dx, y0: 0 - dy, x1: origin.w + dx, y1: origin.h + dy };
}

export function frameByMult(origin: OriginSize, mult: number): OutpaintFrame {
  return centered(origin, origin.w * mult, origin.h * mult);
}

export function frameByRatio(origin: OriginSize, ratio: number): OutpaintFrame {
  return origin.w / origin.h >= ratio
    ? centered(origin, origin.w, origin.w / ratio)
    : centered(origin, origin.h * ratio, origin.h);
}

export function fitsCap(origin: OriginSize, frame: OutpaintFrame): boolean {
  return Math.max(frameWidth(frame), frameHeight(frame)) <= frameCap(origin) + 0.01;
}

export function longMult(origin: OriginSize, frame: OutpaintFrame): number {
  return Math.max(frameWidth(frame), frameHeight(frame)) / Math.max(origin.w, origin.h);
}

export function detectRatio(origin: OriginSize, frame: OutpaintFrame): "orig" | string | null {
  const ratio = frameWidth(frame) / frameHeight(frame);
  if (Math.abs(ratio / (origin.w / origin.h) - 1) < RATIO_EPS) return "orig";
  const hit = RATIO_PRESETS.find((preset) => Math.abs(ratio / preset.r - 1) < RATIO_EPS);
  return hit ? hit.key : null;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function moveFrame(
  origin: OriginSize,
  frame: OutpaintFrame,
  dx: number,
  dy: number,
): OutpaintFrame {
  const w = frameWidth(frame);
  const h = frameHeight(frame);
  const x0 = clamp(frame.x0 + dx, origin.w - w, 0);
  const y0 = clamp(frame.y0 + dy, origin.h - h, 0);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

export function resizeFrame(
  handle: FrameHandle,
  origin: OriginSize,
  start: OutpaintFrame,
  dx: number,
  dy: number,
): { frame: OutpaintFrame; limited: boolean } {
  const cap = frameCap(origin);
  let { x0, y0, x1, y1 } = start;
  let limited = false;

  if (handle.length === 1) {
    if (handle === "l") {
      const want = start.x0 + dx;
      x0 = clamp(want, start.x1 - cap, 0);
      limited = want < start.x1 - cap;
    } else if (handle === "r") {
      const want = start.x1 + dx;
      x1 = clamp(want, origin.w, start.x0 + cap);
      limited = want > start.x0 + cap;
    } else if (handle === "t") {
      const want = start.y0 + dy;
      y0 = clamp(want, start.y1 - cap, 0);
      limited = want < start.y1 - cap;
    } else {
      const want = start.y1 + dy;
      y1 = clamp(want, origin.h, start.y0 + cap);
      limited = want > start.y0 + cap;
    }
    return { frame: { x0, y0, x1, y1 }, limited };
  }

  const sw = frameWidth(start);
  const sh = frameHeight(start);
  const aspect = sw / sh;
  const hx = handle.includes("l") ? -1 : 1;
  const hy = handle.includes("t") ? -1 : 1;
  const ax = hx < 0 ? start.x1 : start.x0;
  const ay = hy < 0 ? start.y1 : start.y0;
  const want = (sw + hx * dx + (sh + hy * dy) * aspect) / 2;

  const lo = Math.max(hx > 0 ? origin.w - ax : ax, (hy > 0 ? origin.h - ay : ay) * aspect);
  const hi = Math.min(cap, cap * aspect);
  const w = clamp(want, lo, Math.max(lo, hi));
  if (want > hi + 0.5) limited = true;
  const h = w / aspect;
  return {
    frame: {
      x0: hx > 0 ? ax : ax - w,
      x1: hx > 0 ? ax + w : ax,
      y0: hy > 0 ? ay : ay - h,
      y1: hy > 0 ? ay + h : ay,
    },
    limited,
  };
}

export function toRatio(ratio: number): string {
  let best = { p: 1, q: 1, err: Number.POSITIVE_INFINITY };
  for (let p = 1; p <= RATIO_MAX_TERM; p++) {
    for (let q = 1; q <= RATIO_MAX_TERM; q++) {
      const err = Math.abs(Math.log(p / q / ratio));
      if (err < best.err - 1e-9 || (Math.abs(err - best.err) <= 1e-9 && p + q < best.p + best.q)) {
        best = { p, q, err };
      }
    }
  }
  return `${best.p}:${best.q}`;
}

export function ratioOfFrame(origin: OriginSize, frame: OutpaintFrame): string {
  const detected = detectRatio(origin, frame);
  if (detected === "orig") return toRatio(origin.w / origin.h);
  if (detected) return detected;
  return toRatio(frameWidth(frame) / frameHeight(frame));
}

export function snapRatio(ratio: string, options: readonly unknown[]): string {
  const target = parseAspect(ratio);
  if (target === null) return ratio;
  let best: { option: string; err: number } | null = null;
  for (const option of options) {
    const value = parseAspect(option);
    if (value === null) continue;
    const err = Math.abs(Math.log(value / target));
    if (!best || err < best.err) best = { option: String(option), err };
  }
  return best?.option ?? ratio;
}
