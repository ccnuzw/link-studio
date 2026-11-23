import { describe, expect, it } from "vitest";
import {
  gridNodeLabel,
  imageFrameSize,
  planGridPlacement,
} from "../../src/renderer/workspace/grid-placement";

describe("宫格派生节点", () => {
  it("每行、每列按最大框排布，整组越过连续障碍，远处节点不影响落点", () => {
    const source = { x: -100, y: -100, width: 540, height: 324 };
    const sizes = [
      [13, 6],
      [7, 6],
      [13, 9],
      [7, 9],
    ].map(([width, height]) => imageFrameSize(width ?? 0, height ?? 0) ?? { width: 0, height: 0 });
    expect(
      planGridPlacement(
        source,
        [
          source,
          { x: 620, y: 0, width: 300, height: 200 },
          { x: 620, y: 600, width: 350, height: 100 },
          { x: 620, y: 1900, width: 300, height: 200 },
        ],
        sizes,
        2,
      ),
    ).toEqual([
      { x: 520, y: 740 },
      { x: 1302, y: 740 },
      { x: 520, y: 1104 },
      { x: 1302, y: 1104 },
    ]);
    expect(sizes[3]).toEqual({ width: 324, height: 417 });
  });

  it("截短长标题时不截断字符，保留格号且跳过已有编号", () => {
    const title = "🌅".repeat(50);
    const base = `${"🌅".repeat(33)} 2-1`;
    const used = new Set([base, `${base} 2`, `${base} 4`]);
    expect(gridNodeLabel(title, 2, 2, used)).toBe(`${base} 3`);
    expect(gridNodeLabel(title, 2, 2, used)).toBe(`${base} 5`);
  });
});
