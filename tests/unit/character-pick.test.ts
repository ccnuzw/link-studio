import type { CreativeData } from "@link-studio/core";
import { expect, test } from "vitest";
import {
  bindCharacterMedia,
  characterShowsGenerator,
} from "../../src/renderer/workspace/character-pick";

test("自选主图保留历史，回到生成版本恢复提示词面板", () => {
  const createdAt = "2026-10-01T08:00:00Z";
  const data: CreativeData = {
    kind: "image",
    label: "角色",
    text: "",
    assetId: "rendered",
    activeOutputId: "job:0",
    outputs: [{ id: "job:0", assetId: "rendered", kind: "image", createdAt, model: "模型" }],
    character: { name: "角色", look: "基础", description: "", extraAssetIds: ["manual"] },
  };
  expect(characterShowsGenerator(data)).toBe(true);
  expect(characterShowsGenerator({ ...data, activeOutputId: undefined })).toBe(true);
  const picked = bindCharacterMedia(data, "main", ["manual"], createdAt);
  expect(picked.character?.extraAssetIds).toEqual([]);
  expect(picked.outputs?.map((item) => item.id)).toEqual(["job:0", "manual"]);
  expect(characterShowsGenerator(picked)).toBe(false);
  expect(characterShowsGenerator({ ...picked, activeOutputId: undefined })).toBe(false);
  expect(bindCharacterMedia(picked, "main", ["manual"], createdAt).outputs).toBe(picked.outputs);
  expect(characterShowsGenerator({ ...picked, assetId: "rendered", activeOutputId: "job:0" })).toBe(
    true,
  );
});

test("引入整组真人替换主图和补充图，保留旧主图为历史且不覆盖音色", () => {
  const data: CreativeData = {
    kind: "image",
    label: "角色",
    text: "",
    assetId: "old",
    character: {
      name: "角色",
      look: "基础",
      description: "",
      extraAssetIds: ["side"],
      voice: { assetId: "voice", origin: "library" },
    },
  };
  const picked = bindCharacterMedia(
    data,
    "human",
    ["front", "front", "left", "right", "back", "new", "overflow"],
    "2026-10-01T08:00:00Z",
  );
  expect(picked.outputs?.map((item) => item.id)).toEqual(["old", "front"]);
  expect(picked.character).toEqual({
    ...data.character,
    extraAssetIds: ["left", "right", "back", "new"],
  });
  expect(picked.activeOutputId).toBe("front");
  expect(bindCharacterMedia(picked, "human", [], "")).toBe(picked);
});
