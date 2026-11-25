import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";
import type { ProjectCanvasView } from "../../packages/link-studio-core/src/canvas";
import { CreativeCanvasNode } from "../../packages/link-studio-core/src/canvas";
import type {
  CanvasAgentArrange,
  CanvasAgentOps,
} from "../../packages/link-studio-core/src/canvas-agent";
import { mapVideoCanvas } from "../../packages/link-studio-core/src/video-canvas-mapper";
import { exportVideoCanvasParameters } from "../../packages/link-studio-core/src/video-canvas-parameters";
import { canvasBounds, compileArrange } from "../../src/main/project/canvas-agent-layout";
import { compileAgentOps } from "../../src/main/project/canvas-agent-ops";
import { mediaNodeFrame } from "../../src/renderer/workspace/media-node-model";
import fixtures from "../fixtures/canvasgraph/arrange-cases.json";
import frames from "../fixtures/canvasgraph/node-frame-cases.json";
import { requireTestValue } from "../require-test-value";

it("组内整理后按组报告左侧节点留下的重叠", () => {
  const canvas: ProjectCanvasView = {
    viewport: { x: 0, y: 0, zoom: 1 },
    edges: [],
    nodes: [
      {
        id: "left",
        type: "creative",
        position: { x: 0, y: 0 },
        data: { kind: "image", label: "已有图", text: "" },
      },
      {
        id: "frame",
        type: "group",
        position: { x: 400, y: 0 },
        width: 200,
        height: 140,
        data: { label: "分镜组" },
      },
      {
        id: "inside",
        type: "creative",
        parentId: "frame",
        position: { x: 48, y: 72 },
        data: { kind: "audio", label: "声音", text: "" },
      },
    ],
  };
  const result = compileArrange(canvas, { groupId: "frame", layout: "row" }, {});
  expect(result.warnings).toEqual([
    expect.stringContaining("「分镜组」（frame）与「已有图」（left）重叠"),
  ]);
  expect(result.operations.some((op) => op.type === "putNode" && op.node.id === "left")).toBe(
    false,
  );
});

it("横竖图和分组交错创建的 180 种合法顺序均贴合且不重叠", () => {
  const canvas: ProjectCanvasView = {
    nodes: [
      {
        id: "existing",
        type: "creative",
        position: { x: 0, y: 0 },
        data: { kind: "image", label: "已有", text: "" },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const widths: Record<string, number> = { F1: 576, F2: 324, M1: 576, M2: 756, M3: 324, G: 1992 };
  const ratios: Record<string, string> = {
    F1: "16:9",
    F2: "9:16",
    M1: "16:9",
    M2: "21:9",
    M3: "9:16",
  };
  let checked = 0;
  function visit(order: string[]) {
    if (order.length < 6) {
      for (const key of Object.keys(widths)) {
        if (!order.includes(key) && (!key.startsWith("M") || order.includes("G")))
          visit([...order, key]);
      }
      return;
    }
    const ops: CanvasAgentOps["ops"] = order.map((key) =>
      key === "G"
        ? { op: "create_group", tempId: key }
        : {
            op: "create_node",
            kind: key === "M2" ? "video" : "image",
            tempId: key,
            params: { aspect_ratio: requireTestValue(ratios[key]) },
            ...(key.startsWith("M") && { parentGroup: "G" }),
          },
    );
    const result = compileAgentOps(
      canvas,
      { ops },
      (index) => `node-${index}`,
      {},
      { providers: [], plugins: [] },
    );
    let memberX = 48,
      rootX = 696;
    for (const key of order) {
      const operation = result.operations.find(
        (item) => item.type === "putNode" && item.node.id === result.created[key],
      );
      if (operation?.type !== "putNode") throw Error(`缺少 ${key}`);
      if (key.startsWith("M")) {
        expect(operation.node).toMatchObject({
          parentId: result.created.G,
          position: { x: memberX, y: 72 },
        });
        memberX += requireTestValue(widths[key]) + 120;
      } else {
        expect(operation.node.position).toEqual({ x: rootX, y: 0 });
        if (key === "G") expect(operation.node).toMatchObject({ width: widths.G, height: 696 });
        rootX += requireTestValue(widths[key]) + 120;
      }
    }
    checked++;
  }
  visit([]);
  expect(checked).toBe(180);
});

for (const { name, w, h, ...data } of frames.cases) {
  it(`小镜工程导入后节点边界 · ${name}`, () => {
    const imported = mapVideoCanvas(
      { nodes: [{ id: "frame", type: "canvas", data }] },
      () => undefined,
    );
    const node = imported.nodes[0];
    if (!Value.Check(CreativeCanvasNode, node)) throw Error("导入节点异常");
    expect(canvasBounds(node, () => node, {})).toEqual({ x: 0, y: 0, width: w, height: h });
    if (node.data.kind !== "script")
      expect(mediaNodeFrame(node.data, [])).toEqual({ width: w, height: h });
    if (data.params?.ratio)
      expect(exportVideoCanvasParameters(node.data).ratio).toBe(data.params.ratio);
  });
}

for (const fixture of fixtures.cases) {
  it(`小镜布局坐标对照 · ${fixture.name}`, () => {
    const canvas: ProjectCanvasView = {
      nodes: fixture.nodes.map(({ id, x, y, kind }) => ({
        id,
        type: "creative",
        position: { x, y },
        data: { kind: kind as "script" | "image" | "video", label: id, text: "" },
      })),
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const positions = new Map(canvas.nodes.map((node) => [node.id, node.position]));
    const { operations } = compileArrange(
      canvas,
      { layout: fixture.layout as CanvasAgentArrange["layout"], nodeIds: [...positions.keys()] },
      {},
    );
    for (const op of operations)
      if (op.type === "putNode") positions.set(op.node.id, op.node.position);
    expect(Object.fromEntries(positions)).toEqual(fixture.expected);
  });
}
