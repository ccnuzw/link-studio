export const PET_MARGIN = 12;
export const PANEL_GAP = 8;

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type PetBounds = { pet: Rect | null; stage: Rect };
export function panelSize(area: Size, bottomInset = PET_MARGIN): Size {
  return { width: 400, height: Math.min(600, area.height - PET_MARGIN - bottomInset) };
}
export function placePanel(pet: Rect, area: Size, want: Size) {
  const fitX = (x: number) => clamp(x, PET_MARGIN, area.width - PET_MARGIN - want.width);
  const fitY = (y: number) => clamp(y, PET_MARGIN, area.height - PET_MARGIN - want.height);
  const right = pet.x + pet.width / 2 >= area.width / 2;
  const x = fitX(right ? pet.x + pet.width - want.width : pet.x);
  const above = pet.y - PANEL_GAP - want.height,
    below = pet.y + pet.height + PANEL_GAP;
  if (above >= PET_MARGIN) return { x, y: above, origin: `bottom ${right ? "right" : "left"}` };
  if (below + want.height <= area.height - PET_MARGIN)
    return { x, y: below, origin: `top ${right ? "right" : "left"}` };
  const y = fitY(pet.y + (pet.height - want.height) / 2);
  return pet.x + pet.width / 2 > area.width / 2
    ? { x: fitX(pet.x - PANEL_GAP - want.width), y, origin: "center right" }
    : { x: fitX(pet.x + pet.width + PANEL_GAP), y, origin: "center left" };
}

export type PetCorner = "br" | "bl" | "tr" | "tl";
export type PetAnchor = { corner: PetCorner; dx: number; dy: number };

export const DEFAULT_ANCHOR: PetAnchor = { corner: "br", dx: PET_MARGIN, dy: PET_MARGIN };

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

export function anchorOf(rect: Rect, area: Size): PetAnchor {
  const left = rect.x + rect.width / 2 < area.width / 2;
  const top = rect.y + rect.height / 2 < area.height / 2;
  const dx = left ? rect.x : area.width - (rect.x + rect.width);
  const dy = top ? rect.y : area.height - (rect.y + rect.height);
  return {
    corner: `${top ? "t" : "b"}${left ? "l" : "r"}` as PetCorner,
    dx: Math.max(PET_MARGIN, dx),
    dy: Math.max(PET_MARGIN, dy),
  };
}

export function rectOf(anchor: PetAnchor, area: Size, size: Size): Rect {
  const fromLeft = anchor.corner === "tl" || anchor.corner === "bl";
  const fromTop = anchor.corner === "tl" || anchor.corner === "tr";
  const x = fromLeft ? anchor.dx : area.width - anchor.dx - size.width;
  const y = fromTop ? anchor.dy : area.height - anchor.dy - size.height;
  return {
    x: clamp(x, PET_MARGIN, area.width - PET_MARGIN - size.width),
    y: clamp(y, PET_MARGIN, area.height - PET_MARGIN - size.height),
    ...size,
  };
}
