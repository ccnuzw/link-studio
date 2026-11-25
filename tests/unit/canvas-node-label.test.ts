import { expect, it } from "vitest";
import { assetNodeLabel, availableNodeLabel } from "../../src/renderer/workspace/node-label";
import { cloneSelection } from "../../src/renderer/workspace/selection-actions";

it("按所有现有节点标题补第一个空号", () => {
  expect(availableNodeLabel("视频", ["视频 2"])).toBe("视频");
  expect(availableNodeLabel("图片", ["图片", "图片 4", "图片 2"])).toBe("图片 3");
});

it("素材节点去最后一个扩展名并按字符截断", () => {
  expect(assetNodeLabel(" 角色   图.v2.png ", "图片")).toBe("角色 图.v2");
  expect(assetNodeLabel(".参考", "图片")).toBe(".参考");
  expect(assetNodeLabel(`${"🎬".repeat(41)}.mp4`, "视频")).toBe("🎬".repeat(40));
  expect(assetNodeLabel("  ", "音频")).toBe("音频");
});

it("复制用户自定义的「副本 2」标题，保留带空格的编号", () => {
  const graph = {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "source",
        type: "creative" as const,
        position: { x: 0, y: 0 },
        data: { kind: "script" as const, label: "镜头 副本 2", text: "" },
      },
    ],
    edges: [],
  };
  expect(cloneSelection(graph, graph, () => "copy").nodes[0]?.data.label).toBe("镜头 副本 2 副本");
});
