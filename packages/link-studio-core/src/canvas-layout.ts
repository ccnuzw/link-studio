export type ArrangeMode = "row" | "column" | "grid";
export type LayoutRect = { x: number; y: number; width: number; height: number };

export function canvasAnchorPosition(
  point: Pick<LayoutRect, "x" | "y">,
  horizontal: number,
  vertical: number,
) {
  return { x: point.x - 576 * horizontal, y: point.y - 324 * vertical };
}

export function layoutPositions(items: (LayoutRect & { id: string })[], mode: ArrangeMode) {
  const ordered = [...items].sort((first, second) =>
    mode === "row"
      ? first.x - second.x || first.y - second.y
      : first.y - second.y || first.x - second.x,
  );
  const columns =
    mode === "row" ? ordered.length : mode === "column" ? 1 : Math.ceil(Math.sqrt(ordered.length));
  const widths: number[] = [];
  const heights: number[] = [];
  for (const [index, item] of ordered.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    widths[column] = Math.max(widths[column] ?? 0, item.width);
    heights[row] = Math.max(heights[row] ?? 0, item.height);
  }
  const starts = (sizes: number[], start: number, gap: number) =>
    sizes.map((size) => {
      const value = start;
      start += size + gap;
      return value;
    });
  const xs = starts(widths, Math.min(...items.map((item) => item.x)), 120);
  const ys = starts(heights, Math.min(...items.map((item) => item.y)), 80);
  return new Map(
    ordered.map((item, index) => [
      item.id,
      { x: xs[index % columns] ?? 0, y: ys[Math.floor(index / columns)] ?? 0 },
    ]),
  );
}
