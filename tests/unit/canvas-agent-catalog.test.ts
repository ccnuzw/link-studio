import { expect, test } from "vitest";
import type { ProjectCanvasView } from "../../packages/link-studio-core/src/canvas";
import { agentCanvasCatalog } from "../../src/main/project/canvas-agent-catalog";

test("目录优先列出选中的节点，分组成员上限 50，摘要按 Unicode 字符截断", () => {
  const position = { x: 0, y: 0 };
  const nodes: ProjectCanvasView["nodes"] = Array.from({ length: 210 }, (_, index) => ({
    id: `shot-${index}`,
    type: "creative",
    parentId: "group",
    position,
    data: { kind: "script", label: `镜头 ${index}`, text: "🎞".repeat(61) },
  }));
  nodes.push({
    id: "group",
    type: "group",
    position,
    width: 200,
    height: 200,
    data: { label: "摄影组" },
  });
  const canvas = { nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const catalog = agentCanvasCatalog(
    canvas,
    ["missing", "shot-209", "group", "group"],
    (value) => value,
  );
  expect(catalog).toMatchObject({ total: 211, omitted: 11, edgeCount: 0 });
  expect(catalog.nodes).toHaveLength(200);
  expect(catalog.nodes?.slice(0, 2)).toEqual([
    {
      id: "shot-209",
      type: "canvas",
      kind: "script",
      label: "镜头 209",
      group: "group",
      hasOutput: false,
      prompt: "🎞".repeat(60) + "…",
    },
    { id: "group", type: "group", label: "摄影组", members: 210, hasOutput: false },
  ]);
  expect(catalog.selected).toEqual([
    { id: "shot-209", type: "canvas", kind: "script", label: "镜头 209" },
    {
      id: "group",
      type: "group",
      label: "摄影组",
      memberIds: nodes.slice(0, 50).map((node) => node.id),
      moreMembers: 160,
    },
  ]);
  expect(agentCanvasCatalog({ ...canvas, nodes: [] }, [], (value) => value)).toEqual({
    nodes: null,
    total: 0,
    omitted: 0,
    edgeCount: 0,
  });
});
