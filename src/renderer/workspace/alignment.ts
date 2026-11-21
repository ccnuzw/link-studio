export type Axis = "x" | "y";
export type AnchorIndex = 0 | 1 | 2;
export type Rect = { x: number; y: number; width: number; height: number };
export type SnapTarget = { id: string; rect: Rect };
export type AxisLock = { targetId: string; movingAnchor: AnchorIndex; value: number };
export type Guide = { axis: Axis; value: number; from: number; to: number };
export type AxisSnap = { delta: number; lock: AxisLock };

const ANCHORS: readonly AnchorIndex[] = [0, 1, 2];
export const ALIGN_ENTER_PX = 4;
export const ALIGN_RELEASE_PX = 8;

export function anchorValue(rect: Rect, axis: Axis, anchor: AnchorIndex) {
  const start = axis === "x" ? rect.x : rect.y;
  const size = axis === "x" ? rect.width : rect.height;
  return anchor === 0 ? start : anchor === 1 ? start + size / 2 : start + size;
}

export function findAxisSnap(
  moving: Rect,
  targets: readonly SnapTarget[],
  axis: Axis,
  enter: number,
  release: number,
  lock?: AxisLock,
): AxisSnap | null {
  if (lock && targets.some(({ id }) => id === lock.targetId)) {
    const delta = lock.value - anchorValue(moving, axis, lock.movingAnchor);
    if (Math.abs(delta) <= release) return { delta, lock };
  }
  let best: AxisSnap | null = null;
  let nearest = enter;
  for (const target of targets) {
    for (const movingAnchor of ANCHORS) {
      for (const targetAnchor of ANCHORS) {
        const delta =
          anchorValue(target.rect, axis, targetAnchor) - anchorValue(moving, axis, movingAnchor);
        if (Math.abs(delta) >= nearest) continue;
        nearest = Math.abs(delta);
        best = {
          delta,
          lock: {
            targetId: target.id,
            movingAnchor,
            value: anchorValue(target.rect, axis, targetAnchor),
          },
        };
      }
    }
  }
  return best;
}

export function alignmentGuides(moving: Rect, target: Rect, axis: Axis): Guide[] {
  const along = axis === "x" ? "y" : "x";
  const size = axis === "x" ? "height" : "width";
  const movingStart = moving[along];
  const movingEnd = movingStart + moving[size];
  const targetStart = target[along];
  const targetEnd = targetStart + target[size];
  const from =
    movingEnd < targetStart
      ? movingEnd
      : targetEnd < movingStart
        ? targetEnd
        : Math.max(movingStart, targetStart);
  const to =
    movingEnd < targetStart
      ? targetStart
      : targetEnd < movingStart
        ? movingStart
        : Math.min(movingEnd, targetEnd);
  if (to <= from) return [];
  const values: number[] = [];
  for (const movingAnchor of ANCHORS) {
    for (const targetAnchor of ANCHORS) {
      const mine = anchorValue(moving, axis, movingAnchor);
      const theirs = anchorValue(target, axis, targetAnchor);
      if (Math.abs(mine - theirs) <= 0.5 && !values.includes(theirs)) values.push(theirs);
    }
  }
  return values.sort((left, right) => left - right).map((value) => ({ axis, value, from, to }));
}
