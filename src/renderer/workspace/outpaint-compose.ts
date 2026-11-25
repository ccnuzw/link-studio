import { frameHeight, frameWidth, type OriginSize, type OutpaintFrame } from "./outpaint-geometry";

export const COMPOSE_MAX_EDGE = 4096;

export type ComposePlan = {
  width: number;
  height: number;
  imageX: number;
  imageY: number;
  imageW: number;
  imageH: number;

  scaled: boolean;
};

export function planCompose(input: {
  natural: OriginSize;
  origin: OriginSize;
  frame: OutpaintFrame;
  maxEdge?: number;
}): ComposePlan {
  const { natural, origin, frame, maxEdge = COMPOSE_MAX_EDGE } = input;
  const sx = natural.w / origin.w;
  const sy = natural.h / origin.h;
  const fullW = frameWidth(frame) * sx;
  const fullH = frameHeight(frame) * sy;
  const shrink = Math.max(fullW, fullH) > maxEdge ? maxEdge / Math.max(fullW, fullH) : 1;

  const width = Math.max(1, Math.round(fullW * shrink));
  const height = Math.max(1, Math.round(fullH * shrink));
  const imageW = Math.min(width, Math.round(natural.w * shrink));
  const imageH = Math.min(height, Math.round(natural.h * shrink));

  const imageX = Math.min(Math.round(0 - frame.x0 * sx * shrink), width - imageW);
  const imageY = Math.min(Math.round(0 - frame.y0 * sy * shrink), height - imageH);
  return { width, height, imageX, imageY, imageW, imageH, scaled: shrink < 1 };
}
