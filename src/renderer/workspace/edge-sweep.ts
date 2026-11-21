type Point = { x: number; y: number };

function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function orientation(first: Point, second: Point, third: Point) {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function segmentsIntersect(
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) {
  const first = orientation(firstStart, firstEnd, secondStart);
  const second = orientation(firstStart, firstEnd, secondEnd);
  const third = orientation(secondStart, secondEnd, firstStart);
  const fourth = orientation(secondStart, secondEnd, firstEnd);
  const epsilon = 0.0001;
  return (
    ((first > epsilon && second < -epsilon) || (first < -epsilon && second > epsilon)) &&
    ((third > epsilon && fourth < -epsilon) || (third < -epsilon && fourth > epsilon))
  );
}

export function edgeIdsHitBySweep(
  edges: ReadonlyArray<{ id: string; readOnly?: true; points: readonly Point[] }>,
  sweep: readonly Point[],
  tolerance = 14,
) {
  const hit = new Set<string>();
  if (sweep.length < 2) return [];
  for (const edge of edges) {
    if (edge.readOnly || edge.points.length < 2) continue;
    const intersects = edge.points.some((point, index) => {
      const previous = edge.points[index - 1];
      if (!previous) return false;
      return sweep.some((cursor, cursorIndex) => {
        const previousCursor = sweep[cursorIndex - 1];
        if (!previousCursor) return false;
        return (
          segmentsIntersect(previous, point, previousCursor, cursor) ||
          distanceToSegment(previous, previousCursor, cursor) <= tolerance ||
          distanceToSegment(point, previousCursor, cursor) <= tolerance ||
          distanceToSegment(previousCursor, previous, point) <= tolerance ||
          distanceToSegment(cursor, previous, point) <= tolerance
        );
      });
    });
    if (intersects) hit.add(edge.id);
  }
  return [...hit];
}
