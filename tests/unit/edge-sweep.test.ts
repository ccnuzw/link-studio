import { describe, expect, it } from "vitest";
import { edgeIdsHitBySweep } from "../../src/renderer/workspace/edge-sweep";

describe("画布扫线断开", () => {
  it("命中可编辑边并跳过只读边", () => {
    expect(
      edgeIdsHitBySweep(
        [
          {
            id: "a",
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
          },
          {
            id: "locked",
            readOnly: true,
            points: [
              { x: 0, y: 20 },
              { x: 100, y: 20 },
            ],
          },
        ],
        [
          { x: 20, y: -4 },
          { x: 80, y: 4 },
        ],
        8,
      ),
    ).toEqual(["a"]);
  });

  it("没有形成轨迹时不产生删除", () => {
    expect(
      edgeIdsHitBySweep(
        [
          {
            id: "a",
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("稀疏扫线穿过折线时仍能命中", () => {
    expect(
      edgeIdsHitBySweep(
        [
          {
            id: "diagonal",
            points: [
              { x: 0, y: 100 },
              { x: 100, y: 0 },
            ],
          },
        ],
        [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        4,
      ),
    ).toEqual(["diagonal"]);
  });
});
