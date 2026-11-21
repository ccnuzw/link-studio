import { describe, expect, it } from "vitest";
import {
  outpaintAspect,
  outpaintSize,
  planOutpaint,
} from "../../src/renderer/workspace/image-outpaint";

describe("扩图画框", () => {
  it("完整保留原图并按对齐位置补透明区域", () => {
    expect(planOutpaint(300, 200, 2, "自由", 100, 0, 1)).toEqual({
      width: 600,
      height: 200,
      imageWidth: 300,
      imageHeight: 200,
      left: 300,
      top: 0,
    });
  });

  it("按目标比例扩展并限制边长", () => {
    const plan = planOutpaint(4000, 2000, 2, "9:16", 50, 50);
    expect(plan.height).toBe(2048);
    expect(plan.width).toBe(1152);
    expect(plan.left).toBe(288);
    expect(outpaintAspect(["16:9", "9:16"], plan)).toBe("9:16");
    expect(outpaintAspect(["16:9", "adaptive"], plan)).toBe("adaptive");
    expect(outpaintSize(["1024x1024", "1024x1536", "1536x1024"], plan)).toBe("1024x1536");
  });
});
