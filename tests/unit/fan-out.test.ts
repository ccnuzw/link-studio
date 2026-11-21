import { describe, expect, it } from "vitest";
import { fanOutTargetPosition } from "../../src/renderer/workspace/fan-out";

describe("画布扇出布局", () => {
  it("用父组绝对坐标计算目标位置", () => {
    expect(
      fanOutTargetPosition(
        [
          {
            id: "child",
            parentId: "group",
            position: { x: 40, y: 30 },
            measured: { width: 200, height: 100 },
          },
          { id: "free", position: { x: 500, y: 100 }, measured: { width: 100, height: 100 } },
        ],
        new Map([["group", { x: 300, y: 200 }]]),
      ),
    ).toEqual({ x: 960, y: 115 });
  });

  it("空选择不创建目标", () => {
    expect(fanOutTargetPosition([], new Map())).toBeUndefined();
  });
});
