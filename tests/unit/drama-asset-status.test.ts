import type { CreativeData, GenerationJob } from "@link-studio/core";
import { expect, it } from "vitest";
import { dramaAssetStatus } from "../../src/renderer/workspace/drama-asset-status";

const node: CreativeData = { kind: "image", label: "图", text: "" };
const failed: GenerationJob = {
  nodeId: "node",
  kind: "image",
  id: "job",
  providerId: "provider",
  providerLabel: "测试",
  providerRevision: 1,
  model: "model",
  status: "failed",
  progress: 0,
  createdAt: "",
  updatedAt: "",
  outputs: [],
  canRecheck: false,
  canCancelRemote: false,
  errorMessage: "不能生成",
};
it("上传进度优先；失败和正在生成不被待写提示词遮住", () => {
  expect(dramaAssetStatus("node", node, [failed], true, 0)).toEqual({
    state: "uploading",
    progress: 0,
  });
  expect(dramaAssetStatus("node", node, [failed], true, "interrupted")).toMatchObject({
    state: "error",
    upload: true,
  });
  expect(dramaAssetStatus("node", node, [failed], true)).toMatchObject({
    state: "error",
    message: "不能生成",
  });
  expect(dramaAssetStatus("node", node, [{ ...failed, status: "downloading" }], true).state).toBe(
    "running",
  );
});
it("带内容优先于分析；已有提示词的空图不显示正在分析", () => {
  expect(dramaAssetStatus("node", { ...node, text: "   " }, [], true).state).toBe("analyzing");
  expect(dramaAssetStatus("node", { ...node, text: "蓝色蜡印" }, [], true).state).toBe("idle");
  expect(dramaAssetStatus("node", { ...node, assetId: "image" }, [failed], true).state).toBe(
    "done",
  );
  expect(dramaAssetStatus("node", { ...node, kind: "script", text: "回信" }, [], true).state).toBe(
    "done",
  );
});
it("角色音色的失败或排队不替代主图；文本的失败可覆盖草稿", () => {
  const character = {
    ...node,
    character: { name: "收信人", look: "雨衣", description: "", extraAssetIds: [] },
  };
  for (const status of ["failed", "queued"] as const)
    expect(
      dramaAssetStatus(
        "node",
        character,
        [{ ...failed, kind: "audio", purpose: "character-voice", status }],
        false,
      ).state,
    ).toBe("idle");
  expect(dramaAssetStatus("node", character, [failed], false).state).toBe("error");
  expect(
    dramaAssetStatus(
      "node",
      { ...node, kind: "script", text: "半句", textStatus: "error", textError: "中断" },
      [],
      false,
    ),
  ).toMatchObject({ state: "error", message: "中断" });
});
