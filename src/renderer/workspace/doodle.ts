export const DOODLE_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#facc15",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
  "#ffffff",
] as const;

export const DEFAULT_DOODLE_COLOR: string = DOODLE_COLORS[0];

export const DOODLE_WIDTH_MIN = 2;

export const DOODLE_WIDTH_MAX = 20;

export const DOODLE_WIDTH_DEFAULT = 6;

export type PixelSize = {
  width: number;

  height: number;
};

export type PixelRect = PixelSize & {
  x: number;

  y: number;
};

export function doodleCanvasSize(
  natural: { w: number; h: number },
  maxEdge: number = 4096,
): PixelSize {
  const longest = Math.max(natural.w, natural.h);
  const shrink = longest > maxEdge ? maxEdge / longest : 1;
  return {
    width: Math.max(1, Math.round(natural.w * shrink)),
    height: Math.max(1, Math.round(natural.h * shrink)),
  };
}

export function doodleDisplayRect(natural: { w: number; h: number }, box: PixelSize): PixelRect {
  if (!(natural.w > 0) || !(natural.h > 0)) return { x: 0, y: 0, ...box };
  const byWidth = (box.width * natural.h) / natural.w;
  const fitsHeight = byWidth <= box.height + 1e-6;
  const width = fitsHeight ? box.width : (box.height * natural.w) / natural.h;
  const height = fitsHeight ? byWidth : box.height;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

export function doodleScale(logicalWidth: number, displayWidth: number): number {
  return Number.isFinite(displayWidth) && displayWidth > 0 ? logicalWidth / displayWidth : 1;
}

export function doodleStrokeWidth(screenWidth: number, scale: number): number {
  return screenWidth * scale;
}

export function doodleFontSize(screenWidth: number, scale: number): number {
  return (12 + screenWidth * 1.2) * scale;
}

export type DoodleItemLike = {
  text?: string;
};

export function hasDoodleContent(items: readonly DoodleItemLike[]): boolean {
  return items.some((item) => item.text === undefined || item.text.trim() !== "");
}

export type HistoryStack<T> = {
  push: (item: T) => void;

  undo: () => T | undefined;

  redo: () => T | undefined;

  canUndo: () => boolean;

  canRedo: () => boolean;

  items: () => T[];
};

export function createHistoryStack<T>(): HistoryStack<T> {
  const done: T[] = [];
  const undone: T[] = [];
  return {
    push: (item) => {
      done.push(item);
      undone.length = 0;
    },
    undo: () => {
      if (done.length === 0) return undefined;
      const item = done.pop() as T;
      undone.push(item);
      return item;
    },
    redo: () => {
      if (undone.length === 0) return undefined;
      const item = undone.pop() as T;
      done.push(item);
      return item;
    },
    canUndo: () => done.length > 0,
    canRedo: () => undone.length > 0,
    items: () => [...done],
  };
}
