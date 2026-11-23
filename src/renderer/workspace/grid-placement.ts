import type { Rect } from "./alignment";

export function imageFrameSize(width: number, height: number) {
  const ratio = width / height;
  if (!(ratio > 0) || !Number.isFinite(ratio)) return undefined;
  return ratio >= 1
    ? { width: Math.round(324 * ratio), height: 324 }
    : { width: 324, height: Math.round(324 / ratio) };
}

export function planGridPlacement(
  source: Rect,
  taken: Rect[],
  sizes: Pick<Rect, "width" | "height">[],
  columns: number,
) {
  const widths = Array<number>(columns).fill(0);
  const heights = Array<number>(Math.ceil(sizes.length / columns)).fill(0);
  sizes.forEach((size, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    widths[column] = Math.max(widths[column] ?? 0, size.width);
    heights[row] = Math.max(heights[row] ?? 0, size.height);
  });
  const offsets = (lengths: number[], gap: number) => {
    let end = -gap;
    const starts = lengths.map((length) => {
      const start = end + gap;
      end = start + length;
      return start;
    });
    return { starts, end };
  };
  const horizontal = offsets(widths, 80);
  const vertical = offsets(heights, 40);
  const left = source.x + source.width + 80;
  let top = source.y + (source.height - vertical.end) / 2;
  for (let shift = 0; shift < 60; shift++) {
    const hits = taken.filter(
      (box) =>
        left < box.x + box.width + 40 &&
        box.x < left + horizontal.end + 40 &&
        top < box.y + box.height + 40 &&
        box.y < top + vertical.end + 40,
    );
    if (!hits.length) break;
    top = Math.max(...hits.map((box) => box.y + box.height)) + 40;
  }
  const bounded = (position: number) => Math.max(-1e7, Math.min(1e7, position));
  return sizes.map((_, index) => ({
    x: bounded(left + (horizontal.starts[index % columns] ?? 0)),
    y: bounded(top + (vertical.starts[Math.floor(index / columns)] ?? 0)),
  }));
}

export function gridNodeLabel(title: string, index: number, columns: number, labels: Set<string>) {
  const suffix = ` ${Math.floor(index / columns) + 1}-${(index % columns) + 1}`;
  const base = [...title].slice(0, 37 - suffix.length).join("") + suffix;
  let label = base;
  for (let count = 2; labels.has(label); count++) label = `${base} ${count}`;
  labels.add(label);
  return label;
}
