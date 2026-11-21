import type { EditableCanvasNode, ProjectCanvasView } from "@link-studio/core";
import { describe, expect, it } from "vitest";
import { canvasDiff, rebaseCanvas } from "../../src/renderer/workspace/canvas-model";

const script: EditableCanvasNode = {
  id: "script",
  type: "creative",
  position: { x: 0, y: 0 },
  data: { kind: "script", label: "脚本", text: "原稿" },
};
const image: EditableCanvasNode = {
  id: "image",
  type: "creative",
  position: { x: 300, y: 0 },
  data: { kind: "image", label: "参考图", text: "" },
};
const base: ProjectCanvasView = {
  nodes: [script, image],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};
const revisedScript = { ...script, data: { ...script.data, text: "本地改稿" } };
const draft = {
  ...base,
  nodes: [revisedScript, image],
};

describe("画布冲突恢复", () => {
  it("同时保留非重叠的本地和磁盘变更", () => {
    const moved = { ...image, position: { x: 100, y: 50 } };
    const saved = { ...base, nodes: [script, moved] };
    expect(rebaseCanvas(base, draft, saved)).toEqual({ ...base, nodes: [revisedScript, moved] });
  });

  it("不覆盖同一节点的较新改动，保持本地草稿", () => {
    const saved = {
      ...base,
      nodes: [{ ...script, data: { ...script.data, text: "磁盘改稿" } }, image],
    };
    expect(rebaseCanvas(base, draft, saved)).toBeNull();
    expect(canvasDiff(base, draft)).toEqual([{ type: "putNode", node: revisedScript }]);
  });

  it("重放已落盘的相同改动时只合并尚未保存的编辑", () => {
    const saved = { ...draft, viewport: { x: 10, y: 15, zoom: 1 } };
    const moved = { ...image, position: { x: 100, y: 50 } };
    expect(rebaseCanvas(base, { ...draft, nodes: [revisedScript, moved] }, saved)).toEqual({
      ...saved,
      nodes: [revisedScript, moved],
    });
    expect(rebaseCanvas(base, { ...base, nodes: [image] }, { ...base, nodes: [image] })).toEqual({
      ...base,
      nodes: [image],
    });
  });

  it("合并不会让新连线指向已删除节点", () => {
    const localEdge = { id: "edge", source: script.id, target: image.id };
    expect(
      rebaseCanvas(base, { ...base, edges: [localEdge] }, { ...base, nodes: [script] }),
    ).toBeNull();
  });
});
