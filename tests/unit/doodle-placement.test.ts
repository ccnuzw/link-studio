import { describe, expect, it } from "vitest";
import { placeBeside } from "../../src/renderer/workspace/frame-placement";

describe("标注图避让", () => {
  const source = { x: -300, y: 110, width: 576, height: 324 };
  const size = { width: 324, height: 480 };
  const first = { x: 356, y: 32, ...size };

  it("按派生图的高垂直居中，恰好相距 40 时不避让", () => {
    expect(placeBeside(source, [source, { ...first, x: 720 }], size)).toEqual(first);
    expect(placeBeside(source, [source, { ...first, x: 719 }], size).y).toBe(552);
  });

  it("既避开已有派生图，也避开更大的组框；最多下移 60 格", () => {
    expect(placeBeside(source, [first, { ...first, y: 552 }], size).y).toBe(1072);
    expect(placeBeside(source, [{ ...first, height: 100_000 }], size).y).toBe(32 + 60 * 520);
  });
});
