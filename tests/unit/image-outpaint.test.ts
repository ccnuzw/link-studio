import { describe, expect, it } from "vitest";
import { outpaintSize } from "../../src/renderer/workspace/image-outpaint";
import { planCompose } from "../../src/renderer/workspace/outpaint-compose";
import {
  fitsCap,
  frameByMult,
  frameByRatio,
  frameHeight,
  frameWidth,
  moveFrame,
  resizeFrame,
} from "../../src/renderer/workspace/outpaint-geometry";

const origin = { w: 320, h: 180 };
describe("扩图的实际合成与取景", () => {
  it("2× 透明底图保留原图像素，仅在 4096 上限降采样", () => {
    const natural = { w: 1920, h: 1080 };
    expect(planCompose({ natural, origin, frame: frameByMult(origin, 2) })).toEqual({
      width: 3840,
      height: 2160,
      imageX: 960,
      imageY: 540,
      imageW: 1920,
      imageH: 1080,
      scaled: false,
    });
    const big = planCompose({ natural, origin, frame: frameByMult(origin, 3) });
    expect(big.width).toBe(4096);
    expect(big.height).toBe(2304);
    expect(big.scaled).toBe(true);
    expect(outpaintSize(["1024x1024", "1536x1024"], big)).toBe("1536x1024");
  });
  it("移动不露出原图，角柄锁比例，边柄独立并受 3× 上限约束", () => {
    const frame = frameByMult(origin, 2);
    expect(moveFrame(origin, frame, 900, -900)).toEqual({ x0: 0, x1: 640, y0: -180, y1: 180 });
    const edge = resizeFrame("r", origin, frame, 900, 0);
    expect(edge.limited).toBe(true);
    expect(frameWidth(edge.frame)).toBe(960);
    const corner = resizeFrame("br", origin, frame, 40, 20).frame;
    expect(frameWidth(corner) / frameHeight(corner)).toBeCloseTo(16 / 9);
    expect(fitsCap(origin, frameByRatio(origin, 0.2))).toBe(false);
  });
});
