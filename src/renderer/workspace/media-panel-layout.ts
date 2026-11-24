export const canvasControlsInset = 64;
export const nodeActionStripHeight = 40;
export const mediaPanelOffset = 16;

export function mediaPanelOverflow(panelBottom: number, canvasHeight: number) {
  return Math.max(0, Math.ceil(panelBottom - canvasHeight + canvasControlsInset));
}

export function mediaPanelPan(nodeTop: number, overflow: number) {
  return Math.min(
    overflow,
    Math.max(0, Math.floor(nodeTop - canvasControlsInset - nodeActionStripHeight)),
  );
}

export function mediaPanelViewport(
  node: { x: number; y: number; width: number; height: number },
  view: { x: number; y: number; zoom: number },
  canvasHeight: number,
  panelHeight: number,
  minZoom: number,
) {
  const nodeTop = node.y * view.zoom + view.y;
  const panelBottom = nodeTop + node.height * view.zoom + mediaPanelOffset + panelHeight;
  const overflow = mediaPanelOverflow(panelBottom, canvasHeight);
  const pan = mediaPanelPan(nodeTop, overflow);
  if (overflow - pan > mediaPanelOffset && node.height > 0) {
    const top = canvasControlsInset + nodeActionStripHeight;
    const available = canvasHeight - top - canvasControlsInset - mediaPanelOffset - panelHeight;
    const zoom = Math.max(minZoom, available / node.height);
    if (zoom < view.zoom) {
      const center = node.x + node.width / 2;
      return { x: view.x + center * (view.zoom - zoom), y: top - node.y * zoom, zoom };
    }
  }
  return pan ? { ...view, y: view.y - pan } : view;
}

export function mediaPanelLayout(nodeLeft: number, nodeWidth: number, viewportWidth: number) {
  const gutter = 12;
  const width = Math.min(680, Math.max(0, viewportWidth - 2 * gutter));
  const left = nodeLeft + (nodeWidth - width) / 2;
  const shift = Math.max(gutter, Math.min(left, viewportWidth - gutter - width)) - left;
  return { width: Math.round(width), shift: Math.round(shift) };
}
