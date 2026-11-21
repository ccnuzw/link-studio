import { describe, expect, it } from "vitest";
import type { ProjectCanvasView } from "../../packages/link-studio-core/src/canvas";
import {
  mergeCanvasExchange,
  parseCanvasExchange,
  prepareCanvasExchange,
  serializeCanvasExchange,
} from "../../packages/link-studio-core/src/canvas-exchange";

const canvas: ProjectCanvasView = {
  nodes: [
    {
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      width: 500,
      height: 300,
      data: { label: "一组" },
    },
    {
      id: "image",
      type: "creative",
      parentId: "group",
      position: { x: 20, y: 20 },
      data: {
        kind: "image",
        label: "图片",
        text: "",
        assetId: "11111111-1111-4111-8111-111111111111",
      },
    },
  ],
  edges: [],
  viewport: { x: 1, y: 2, zoom: 1 },
};

describe("画布交换", () => {
  it("导出过滤只读/未知记录并保持格式版本", () => {
    const parsed = parseCanvasExchange(JSON.parse(serializeCanvasExchange(canvas, "测试")));
    expect(parsed.format).toBe("link-studio.canvas");
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(0);
  });

  it("缺失素材清空引用，合并时重映射节点、父组和连线", () => {
    const parsed = parseCanvasExchange(
      JSON.parse(serializeCanvasExchange({ ...canvas, edges: [] }, "测试")),
    );
    const prepared = prepareCanvasExchange(parsed, new Set());
    expect(prepared.report.missingAssetIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(prepared.document.nodes[1]).toMatchObject({ data: { assetId: undefined } });
    const withEdge = { ...prepared.document, edges: [] };
    const merged = mergeCanvasExchange(
      { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      withEdge,
      (() => {
        let index = 0;
        return () => `new-${++index}`;
      })(),
    );
    expect(merged.nodes[1]).toMatchObject({ parentId: "new-1" });
    expect(merged.edges).toEqual([]);
  });

  it("拒绝组端点、重复端点、悬空父组和无序父组", () => {
    const base = parseCanvasExchange(JSON.parse(serializeCanvasExchange(canvas, "测试")));
    expect(() =>
      parseCanvasExchange({
        ...base,
        edges: [{ id: "edge", source: "group", target: "image" }],
      }),
    ).toThrow("无效连线");
    expect(
      parseCanvasExchange({
        ...base,
        nodes: [base.nodes[1], base.nodes[0]],
      }).nodes,
    ).toHaveLength(2);
    expect(() =>
      parseCanvasExchange({
        ...base,
        nodes: base.nodes.map((node) =>
          node.type === "creative" ? { ...node, parentId: "missing" } : node,
        ),
      }),
    ).toThrow("无效父组");
    const second = {
      id: "image-2",
      type: "creative" as const,
      position: { x: 20, y: 20 },
      data: {
        ...(base.nodes[1]?.data ?? { kind: "image", label: "图片", text: "" }),
        assetId: undefined,
      },
    };
    expect(() =>
      parseCanvasExchange({
        ...base,
        nodes: [...base.nodes, second],
        edges: [
          { id: "edge-1", source: "image", target: "image-2" },
          { id: "edge-2", source: "image", target: "image-2" },
        ],
      }),
    ).toThrow("无效连线");
  });
});
