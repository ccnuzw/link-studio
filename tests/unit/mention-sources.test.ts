import type { CreativeData, ProjectAsset, ProjectCanvasView } from "@link-studio/core";
import { expect, test } from "vitest";
import { mentionSources } from "../../src/renderer/workspace/mention-sources";
import { referenceUsed } from "../../src/renderer/workspace/video-modes";

test("候选按连线和节点顺序分组，排除下游、空文本、运行中、缺失及不兼容素材", () => {
  const node = (id: string, kind: CreativeData["kind"], data: Partial<CreativeData> = {}) => ({
    id,
    type: "creative" as const,
    position: { x: 0, y: 0 },
    data: { kind, label: id, text: "正文", assetId: id, ...data },
  });
  const graph: ProjectCanvasView = {
    nodes: [
      node("target", "video"),
      node("board", "script", { storyboard: [] }),
      node("a", "image"),
      node("b", "script"),
      node("c", "script"),
      node("d", "script"),
      node("empty", "script", { text: "  " }),
      node("running", "script"),
      node("missing", "image"),
      node("audio", "audio"),
      node("child", "script"),
      node("grandchild", "script"),
    ],
    edges: [
      ["board", "target"],
      ["c", "target"],
      ["a", "target"],
      ["c", "target"],
      ["target", "child"],
      ["child", "grandchild"],
    ].map(([source, target], index) => ({ id: `edge-${index}`, source: source!, target: target! })),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const assets = ["a", "audio", "board"].map(
    (assetId) => ({ assetId, availability: "ready" }) as ProjectAsset,
  );
  const result = mentionSources(
    graph,
    "target",
    assets,
    new Set(["running"]),
    (kind) => kind !== "audio",
  );
  expect(result.byId.get("empty")?.text).toBe("  ");
  expect(result.byId.get("b")?.text).toBe("正文");
  expect([...result.linked]).toEqual(["c", "a"]);
  expect(result.entries.map(({ source, linked }) => [source.id, linked])).toEqual([
    ["c", true],
    ["a", true],
    ["b", false],
    ["d", false],
  ]);
});

test("引用格按可接收端口标记，而不是按最终发送的素材标记", () => {
  const audioOnly = { references: { audio: 1 } };
  expect(referenceUsed("character", audioOnly, "omni")).toBe(true);
  expect(referenceUsed("character", audioOnly, "i2v")).toBe(false);
  expect(referenceUsed("image", { references: { image: 1 } }, "i2v")).toBe(true);
  expect(referenceUsed("script", audioOnly, "t2v")).toBe(true);
  expect(referenceUsed("storyboard", audioOnly, "omni")).toBe(false);
  expect(referenceUsed("storyboard", undefined, undefined)).toBe(true);
});
