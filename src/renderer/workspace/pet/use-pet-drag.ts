import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { PET_MARGIN, type Rect, type Size } from "./placement";

const DRAG_THRESHOLD = 4;
const DIR_WINDOW_MS = 80;

export type DragDir = "left" | "right" | null;

export const petTransform = (x: number, y: number) => `translate3d(${x}px, ${y}px, 0)`;

type Options = {
  elRef: React.RefObject<HTMLElement | null>;
  rect: Rect;
  area: Size;
  enabled: boolean;
  onDraggingChange: (dragging: boolean) => void;
  onDirChange: (dir: DragDir) => void;
  onCommit: (rect: Rect) => void;
  onClick: () => void;
};

type Session = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  dragging: boolean;
  x: number;
  y: number;
  samples: Array<{ t: number; x: number }>;
  dir: DragDir;
  lastMoveAt: number;
};

export function usePetDrag(options: Options) {
  const opts = useRef(options);

  useLayoutEffect(() => {
    opts.current = options;
  });
  const session = useRef<Session | null>(null);
  const suppressClick = useRef(false);
  const dirTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (dirTimer.current !== null) window.clearTimeout(dirTimer.current);
    },
    [],
  );

  const clampPos = (x: number, y: number) => {
    const { area, rect } = opts.current;
    return {
      x: Math.max(PET_MARGIN, Math.min(x, area.width - PET_MARGIN - rect.width)),
      y: Math.max(PET_MARGIN, Math.min(y, area.height - PET_MARGIN - rect.height)),
    };
  };

  const armDirTimer = () => {
    if (dirTimer.current !== null) return;
    dirTimer.current = window.setTimeout(function check() {
      const s = session.current;
      dirTimer.current = null;
      if (!s || !s.dragging || s.dir === null) return;
      const rest = DIR_WINDOW_MS - (performance.now() - s.lastMoveAt);
      if (rest > 0) {
        dirTimer.current = window.setTimeout(check, rest);
        return;
      }
      s.dir = null;
      s.samples = [];
      opts.current.onDirChange(null);
    }, DIR_WINDOW_MS);
  };

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    suppressClick.current = false;
    const { rect } = opts.current;
    session.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.x,
      originY: rect.y,
      dragging: false,
      x: rect.x,
      y: rect.y,
      samples: [],
      dir: null,
      lastMoveAt: 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = session.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.dragging) {
      if (!opts.current.enabled || Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      s.dragging = true;
      opts.current.onDraggingChange(true);
    }
    const pos = clampPos(s.originX + dx, s.originY + dy);
    s.x = pos.x;
    s.y = pos.y;
    const el = opts.current.elRef.current;
    if (el) el.style.transform = petTransform(pos.x, pos.y);

    const now = performance.now();
    s.lastMoveAt = now;
    s.samples.push({ t: now, x: pos.x });
    while (s.samples.length > 1 && now - s.samples[0]!.t > DIR_WINDOW_MS) s.samples.shift();
    const moved = pos.x - s.samples[0]!.x;
    const dir: DragDir = moved > 1 ? "right" : moved < -1 ? "left" : null;
    if (dir !== s.dir) {
      s.dir = dir;
      opts.current.onDirChange(dir);
    }
    if (dir !== null) armDirTimer();
  };

  const finish = (e: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const s = session.current;
    if (!s || s.pointerId !== e.pointerId) return;
    session.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!s.dragging) return;
    suppressClick.current = true;
    if (s.dir !== null) opts.current.onDirChange(null);
    opts.current.onDraggingChange(false);
    if (commit) {
      const { rect } = opts.current;
      opts.current.onCommit({ ...rect, x: s.x, y: s.y });
    } else {
      const el = opts.current.elRef.current;
      const { rect } = opts.current;
      if (el) el.style.transform = petTransform(rect.x, rect.y);
    }
  };

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    opts.current.onClick();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, true),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
    onClick,
  };
}
