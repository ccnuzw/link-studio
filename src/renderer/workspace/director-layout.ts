export type Frame = { width: number; height: number };

export const FLOATING_FRAME = { width: 296, maxHeight: 236 } as const;

export function fitFrame(boxWidth: number, boxHeight: number, ratio: number): Frame {
  if (!(boxWidth > 0) || !(boxHeight > 0) || !(ratio > 0)) return { width: 0, height: 0 };
  if (boxWidth / boxHeight > ratio) {
    return { width: Math.round(boxHeight * ratio), height: Math.round(boxHeight) };
  }
  return { width: Math.round(boxWidth), height: Math.round(boxWidth / ratio) };
}

export function floatingFrame(ratio: number): Frame {
  const width = FLOATING_FRAME.width;
  const height = Math.round(width / ratio);
  if (height <= FLOATING_FRAME.maxHeight) return { width, height };
  return {
    width: Math.round(FLOATING_FRAME.maxHeight * ratio),
    height: FLOATING_FRAME.maxHeight,
  };
}

export type PanelKind = "assets" | "sidebar" | "timeline" | "split";

export type PanelSizes = Record<PanelKind, number>;

export const PANEL_LIMITS: Record<PanelKind, { min: number; max: number; default: number }> = {
  assets: { min: 200, max: 480, default: 272 },
  sidebar: { min: 240, max: 480, default: 280 },
  timeline: { min: 140, max: 480, default: 200 },
  split: { min: 0.25, max: 0.75, default: 0.5 },
};

export const DEFAULT_PANELS: PanelSizes = {
  assets: PANEL_LIMITS.assets.default,
  sidebar: PANEL_LIMITS.sidebar.default,
  timeline: PANEL_LIMITS.timeline.default,
  split: PANEL_LIMITS.split.default,
};

export const NAV_WIDTH = 52;
export const HEADER_HEIGHT = 48;

export const MIN_VIEWPORT = { width: 360, height: 220 } as const;

export function clampPanel(kind: PanelKind, value: number): number {
  const { min, max, default: fallback } = PANEL_LIMITS[kind];
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function fitPanels(
  sizes: PanelSizes,
  area: { width: number; height: number },
  assetsOpen: boolean,
): PanelSizes {
  let assets = clampPanel("assets", sizes.assets);
  let sidebar = clampPanel("sidebar", sizes.sidebar);
  let timeline = clampPanel("timeline", sizes.timeline);
  let overflow = NAV_WIDTH + (assetsOpen ? assets : 0) + sidebar + MIN_VIEWPORT.width - area.width;
  if (overflow > 0 && assetsOpen) {
    const cut = Math.min(overflow, assets - PANEL_LIMITS.assets.min);
    assets -= cut;
    overflow -= cut;
  }
  if (overflow > 0) {
    sidebar -= Math.min(overflow, sidebar - PANEL_LIMITS.sidebar.min);
  }
  const maxTimeline = area.height - HEADER_HEIGHT - MIN_VIEWPORT.height;
  timeline = Math.max(PANEL_LIMITS.timeline.min, Math.min(timeline, maxTimeline));
  return { assets, sidebar, timeline, split: clampPanel("split", sizes.split) };
}

export function panelMax(
  kind: PanelKind,
  sizes: PanelSizes,
  area: { width: number; height: number },
  assetsOpen: boolean,
): number {
  const { min, max } = PANEL_LIMITS[kind];
  let room = max;
  if (kind === "assets") room = area.width - NAV_WIDTH - sizes.sidebar - MIN_VIEWPORT.width;
  if (kind === "sidebar") {
    room = area.width - NAV_WIDTH - (assetsOpen ? sizes.assets : 0) - MIN_VIEWPORT.width;
  }
  if (kind === "timeline") room = area.height - HEADER_HEIGHT - MIN_VIEWPORT.height;
  return Math.max(min, Math.min(max, room));
}
