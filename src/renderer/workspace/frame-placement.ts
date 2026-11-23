import type { Rect } from "./alignment";
import { frameClock } from "./frame-filmstrip";

export function planFramePlacement(
  origin: Rect,
  taken: Rect[],
  labels: Set<string>,
  title: string,
  spec: number | "首帧" | "尾帧",
) {
  const suffix = typeof spec === "number" ? frameClock(spec / 1000).replace(":", "-") : spec;
  const base = [...`${title.replace(/[\\/:*?"<>|]/g, "_").trim()}-${suffix}`.replace(/\s+/g, " ")]
    .slice(0, 40)
    .join("");
  let label = base;
  for (let index = 2; labels.has(label); index++) label = `${base} ${index}`;
  labels.add(label);
  const box = placeBeside(origin, taken, { width: origin.width, height: origin.width });
  taken.push(box);
  return { position: { x: box.x, y: box.y }, label };
}

export function placeBeside(
  origin: Rect,
  taken: Rect[],
  size: Pick<Rect, "width" | "height">,
): Rect {
  const box = {
    x: Math.min(1e7, origin.x + origin.width + 80),
    y: origin.y,
    ...size,
  };
  box.y += (origin.height - box.height) / 2;
  for (
    let shift = 0;
    shift < 60 &&
    taken.some(
      (rect) =>
        box.x < rect.x + rect.width + 40 &&
        rect.x < box.x + box.width + 40 &&
        box.y < rect.y + rect.height + 40 &&
        rect.y < box.y + box.height + 40,
    );
    shift++
  )
    box.y += box.height + 40;
  box.y = Math.max(-1e7, Math.min(1e7, box.y));
  return box;
}
