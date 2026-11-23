import { describe, expect, it } from "vitest";
import { shotDuration, shotDurationTitle } from "../../src/renderer/workspace/shot-video";

describe("分镜视频时长", () => {
  const options = {
    durations: [8, 4, 6],
    durationRange: undefined,
    durationStep: 1,
    manualDuration: false,
  };

  it("用原始小数比较枚举档位，等距取较短时长", () => {
    expect(shotDuration(5.2, options)).toBe(6);
    expect(shotDuration(5, options)).toBe(4);
    expect(shotDuration(6.9, options)).toBe(6);
  });

  it("先四舍五入，再从模型范围下限按步长对齐", () => {
    const range = { ...options, durationRange: { min: 3, max: 11 }, durationStep: 3 };
    expect([1, 4.5, 8, 11, 20].map((seconds) => shotDuration(seconds, range))).toEqual([
      3, 6, 9, 11, 11,
    ]);
    expect(shotDurationTitle(range)).toBe("所选视频模型只支持 3–11s");
  });

  it("模型允许手填时用整数秒，没有时长参数时留给模型默认值", () => {
    expect(shotDuration(4.6, { ...options, durations: [], manualDuration: true })).toBe(5);
    expect(shotDuration(4.6, { ...options, durations: [] })).toBeUndefined();
    expect(shotDuration(4.6)).toBeUndefined();
  });
});
