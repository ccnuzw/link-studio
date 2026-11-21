export const GRID_MAX = 5;
export const GRID_MIN_GAP = 0.02;

export function evenGridLines(count: number) {
  return Array.from({ length: count - 1 }, (_, index) => (index + 1) / count);
}

export function validGridLines(lines: readonly number[], count: number) {
  return (
    lines.length === count - 1 &&
    lines.every((line, index) => line - (lines[index - 1] ?? 0) >= GRID_MIN_GAP - 1e-8) &&
    1 - (lines.at(-1) ?? 0) >= GRID_MIN_GAP - 1e-8
  );
}

export function gridBounds(lines: readonly number[], size: number) {
  const bounds = [0];
  for (const [index, line] of lines.entries()) {
    bounds.push(
      Math.min(
        size - (lines.length - index),
        Math.max((bounds.at(-1) ?? 0) + 1, Math.round(line * size)),
      ),
    );
  }
  return [...bounds, size];
}
