import { expect, test } from "vitest";
import { linkBodyAt } from "../../src/renderer/workspace/link-rules";

test("连线按组成员绝对边界命中最上层可连接节点", () => {
  const nodes = ["back", "front", "unmeasured", "source"].map((id) => ({ id, type: "creative" }));
  nodes.push({ id: "group", type: "group" });
  const bounds = (id: string) => ({
    x: -70,
    y: 40,
    width: id === "unmeasured" ? undefined : 244,
    height: 180,
  });
  const edge = { x: 174, y: 220 };
  expect(linkBodyAt(nodes, "source", edge, bounds, () => true)).toBe("front");
  expect(linkBodyAt(nodes, "source", edge, bounds, (id) => id !== "front")).toBe("back");
  expect(linkBodyAt(nodes, "source", { ...edge, x: 174.01 }, bounds, () => true)).toBeUndefined();
});
