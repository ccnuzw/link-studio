import type { ProjectAsset } from "@link-studio/core";
import { expect, test } from "vitest";
import { videoDisplayAspect } from "../../packages/media-runtime/src/probe";
import { pickAsset, planAssetNodes } from "../../src/renderer/workspace/asset-node-batch";
import { mediaNodeFrame } from "../../src/renderer/workspace/media-node-model";

function asset(
  assetId: string,
  mediaType: ProjectAsset["mediaType"],
  metadata: ProjectAsset["metadata"] = {},
): ProjectAsset {
  return {
    assetId,
    displayName: `镜头.${mediaType}`,
    mediaType,
    metadata,
    availability: "ready",
    importMode: "copy",
    mimeType: "",
    sha256: assetId,
    sizeBytes: 0,
    storage: { kind: "blob", hash: assetId },
  };
}

test("混合素材按逐卡宽度和逐行最高卡排布，从已有标题中取空号", () => {
  const files = [
    asset("1", "image", { width: 9, height: 16 }),
    asset("2", "video"),
    asset("3", "audio", { width: 16, height: 9 }),
    asset("4", "image", { width: 0, height: 90 }),
    asset("5", "video", { width: 4, height: 3 }),
  ];
  const nodes = planAssetNodes(files, { x: -100, y: 50 }, ["镜头", "镜头 3"]);
  expect(
    nodes.map((node) => [node.position.x, node.position.y, node.data.label, node.data.mediaAspect]),
  ).toEqual([
    [-100, 50, "镜头 2", 9 / 16],
    [264, 50, "镜头 4", undefined],
    [880, 50, "镜头 5", undefined],
    [1244, 50, "镜头 6", undefined],
    [-100, 666, "镜头 7", 4 / 3],
  ]);
});

test("画布排布和节点框均按视频的显示尺寸，旧记录仍能使用编码尺寸", () => {
  const stream = { index: 0, codec_type: "video", codec_name: "h264", width: 64, height: 48 };
  const first = asset("1", "video", {
    width: 64,
    height: 48,
    displayAspect: videoDisplayAspect({ ...stream, sample_aspect_ratio: "2:3" })!,
  });
  const second = asset("2", "video", {
    width: 64,
    height: 48,
    displayAspect: videoDisplayAspect({ ...stream, side_data_list: [{ rotation: -90 }] })!,
  });
  const third = asset("3", "video", { width: 64, height: 48 });
  const nodes = planAssetNodes([first, second, third], { x: 0, y: 0 }, []);
  expect(nodes.map((node) => node.data.mediaAspect)).toEqual([64 / 72, 0.75, 4 / 3]);
  expect(nodes.map((node) => node.position.x)).toEqual([0, 364, 728]);
  expect(
    [first, second, third].map((asset, index) =>
      mediaNodeFrame(nodes[index]!.data, [], asset.metadata),
    ),
  ).toEqual([
    { width: 324, height: 365 },
    { width: 324, height: 432 },
    { width: 432, height: 324 },
  ]);
});

test("单选可替换或取消；上传不会替换已有选择；多选保留顺序及上限", () => {
  const first = asset("1", "audio"),
    next = asset("2", "audio");
  expect(pickAsset([first], next, false, 1)).toEqual([next]);
  expect(pickAsset([first], next, true, 1)).toEqual([first]);
  expect(pickAsset([first], first, false, 1)).toEqual([]);
  expect(pickAsset([first], first, true)).toEqual([first]);
  const selected = Array.from({ length: 20 }, (_, index) => asset(String(index), "video"));
  expect(pickAsset(selected, asset("21", "audio"))).toBe(selected);
  expect(pickAsset(pickAsset(selected, first), first).at(-1)).toBe(first);
});
