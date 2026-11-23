import { type PointerEvent, useRef, useState } from "react";

type Point = { x: number; y: number };
export function assetMarquee(start: Point, end: Point) {
  const width = Math.abs(end.x - start.x),
    height = Math.abs(end.y - start.y);
  return Math.max(width, height) < 4
    ? null
    : { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width, height };
}

export function useAssetMarquee(
  ids: ReadonlySet<string>,
  selected: ReadonlySet<string>,
  change: (ids: Set<string>) => void,
  clear: () => void,
) {
  const drag = useRef<{
    pointer: number;
    start: Point;
    base: ReadonlySet<string>;
    append: boolean;
  }>(undefined);
  const [box, setBox] = useState<ReturnType<typeof assetMarquee>>(null);
  const local = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    drag.current = undefined;
    setBox(null);
    if (!cancelled && !active.append && !assetMarquee(active.start, local(event))) clear();
  };
  return {
    box,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (
          event.button !== 0 ||
          drag.current ||
          (event.target as Element).closest("button,a,input,textarea,[role='button']")
        )
          return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          start: local(event),
          base: selected,
          append: event.shiftKey || event.metaKey || event.ctrlKey,
        };
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const active = drag.current;
        if (!active || active.pointer !== event.pointerId) return;
        const next = assetMarquee(active.start, local(event));
        setBox(next);
        if (!next) return;
        const origin = event.currentTarget.getBoundingClientRect(),
          picked = new Set(active.append ? active.base : []);
        for (const card of event.currentTarget.querySelectorAll<HTMLElement>("[data-asset-id]")) {
          const id = card.dataset.assetId;
          if (!id || !ids.has(id)) continue;
          const rect = card.getBoundingClientRect(),
            left = origin.left + next.left,
            top = origin.top + next.top;
          if (
            rect.left < left + next.width &&
            rect.right > left &&
            rect.top < top + next.height &&
            rect.bottom > top
          )
            picked.add(id);
        }
        if (selected.size !== picked.size || [...picked].some((id) => !selected.has(id)))
          change(picked);
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
    },
  };
}
