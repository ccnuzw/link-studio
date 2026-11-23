type Point = { x: number; y: number };

export function animateArrangement(
  origins: ReadonlyMap<string, Point>,
  targets: ReadonlyMap<string, Point>,
  preview: (positions: ReadonlyMap<string, Point>) => void,
  finish: () => void,
) {
  const start = performance.now();
  const duration = 260;
  let frame = requestAnimationFrame(step);
  function step(now: number) {
    const progress = Math.max(0, (now - start) / duration);
    if (progress >= 1) {
      finish();
      return;
    }
    const eased = 1 - (1 - progress) ** 3;
    const positions = new Map<string, Point>();
    for (const [id, target] of targets) {
      const origin = origins.get(id);
      if (origin)
        positions.set(id, {
          x: origin.x + (target.x - origin.x) * eased,
          y: origin.y + (target.y - origin.y) * eased,
        });
    }
    preview(positions);
    frame = requestAnimationFrame(step);
  }
  return () => cancelAnimationFrame(frame);
}
