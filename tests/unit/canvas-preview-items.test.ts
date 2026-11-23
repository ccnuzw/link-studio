import type { ProjectAsset } from "@link-studio/core";
import { expect, test } from "vitest";
import { collectCanvasPreviews } from "../../src/renderer/workspace/canvas-preview-items";

const asset: ProjectAsset = {
  assetId: "image",
  displayName: "image.png",
  mediaType: "image",
  mimeType: "image/png",
  sizeBytes: 72,
  sha256: "",
  importMode: "copy",
  storage: { kind: "blob", hash: "" },
  metadata: {},
  availability: "ready",
};
function node(id: string, x: number, y: number, height?: number) {
  return {
    id,
    type: "creative",
    position: { x, y },
    measured: { height },
    data: { kind: "image", assetId: asset.assetId, label: id },
  };
}

test("同行以首项半高为界，边界归前一行，组内成员按画布绝对位置排序", () => {
  const group = { ...node("group", 200, 300), type: "group" };
  const result = collectCanvasPreviews(
    [
      node("next", -200, 351),
      { ...node("grouped", 50, 0, 100), parentId: group.id },
      node("left", 0, 350, 900),
      group,
      node("first", 500, 0),
      node("same", 0, 162),
    ],
    [asset],
  );
  expect(result.map((item) => item.id)).toEqual(["same", "first", "left", "grouped", "next"]);
});

test("同素材的不同节点都可翻看，空节点、角色、音频和缺失素材排除", () => {
  const basic = node("first", 0, 0);
  const result = collectCanvasPreviews(
    [
      basic,
      { ...basic, id: "second" },
      { ...basic, id: "character", data: { ...basic.data, character: {} } },
      { ...basic, id: "audio", data: { ...basic.data, kind: "audio" } },
      { ...basic, id: "empty", data: { ...basic.data, assetId: undefined } },
      { ...basic, id: "missing", data: { ...basic.data, assetId: "offline" } },
    ],
    [asset, { ...asset, assetId: "offline", availability: "missing" }],
  );
  expect(result.map((item) => item.id)).toEqual(["first", "second"]);
});
