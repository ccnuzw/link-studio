import { describe, expect, it } from "vitest";
import { alignmentGuides, findAxisSnap } from "../../src/renderer/workspace/alignment";

describe("canvas alignment", () => {
  const target = { id: "target", rect: { x: 100, y: 80, width: 200, height: 120 } };

  it("snaps matching anchors and keeps a lock within release distance", () => {
    const moving = { x: 296, y: 300, width: 120, height: 80 };
    const first = findAxisSnap(moving, [target], "x", 5, 10);
    expect(first?.delta).toBe(4);
    expect(first?.lock.targetId).toBe("target");

    const locked = findAxisSnap({ ...moving, x: 304 }, [target], "x", 1, 10, first?.lock);
    expect(locked?.delta).toBe(-4);
    expect(locked?.lock).toEqual(first?.lock);
  });

  it("creates a guide only across the visible gap or overlap", () => {
    expect(alignmentGuides({ x: 300, y: 90, width: 100, height: 80 }, target.rect, "x")).toEqual([
      { axis: "x", value: 300, from: 90, to: 170 },
    ]);
    expect(alignmentGuides({ x: 301, y: 300, width: 100, height: 80 }, target.rect, "x")).toEqual(
      [],
    );
  });
});
