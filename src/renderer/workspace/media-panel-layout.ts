export function mediaPanelLayout(nodeLeft: number, nodeWidth: number, viewportWidth: number) {
  const gutter = 12;
  const width = Math.min(680, Math.max(0, viewportWidth - 2 * gutter));
  const left = nodeLeft + (nodeWidth - width) / 2;
  const shift = Math.max(gutter, Math.min(left, viewportWidth - gutter - width)) - left;
  return { width: Math.round(width), shift: Math.round(shift) };
}
