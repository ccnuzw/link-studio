import {
  type CreativeData,
  dramaVideoModelIssue,
  type GenerationJob,
  modelGenerationOptions,
  type ProjectAsset,
  type ProjectCanvasView,
} from "@link-studio/core";
import { expect, test } from "vitest";
import { dramaVideoInput } from "../../src/renderer/workspace/drama-video-input";

const options = modelGenerationOptions("video", "doubao-video", "doubao-seedance-2-0");
test("开拍和片段禁用不收参考图的视频模型，保留同一适配器的图生视频模型", () => {
  const plugins = [{ hash: "fixture", key: "alibaba-video", origin: "builtin" as const }];
  const issue = (model: string) =>
    dramaVideoModelIssue({ model, channel: {}, pluginHash: "fixture" }, plugins);
  expect(issue("wan2.6-t2v-us")).toContain("不支持参考图");
  expect(issue("wan2.6-i2v-us")).toBe("");
});
const node = (id: string, data: Partial<CreativeData>) => ({
  id,
  type: "creative" as const,
  position: { x: 0, y: 0 },
  data: { kind: "image" as const, label: id, text: "", ...data },
});
const drama = (type: "character" | "scene") => ({
  type,
  episodes: [],
  name: type,
  description: "",
  look: "",
  aliases: [],
});
const graph: ProjectCanvasView = {
  nodes: [
    node("role", {
      drama: drama("character"),
      assetId: "portrait",
      character: {
        name: "林川",
        look: "基础形象",
        description: "",
        extraAssetIds: ["side"],
        voice: { assetId: "voice" },
      },
    }),
    node("scene", { drama: drama("scene"), assetId: "village" }),
    node("audio", { kind: "audio", assetId: "narrator" }),
  ],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};
const assets = ["portrait", "side", "voice", "village", "narrator"].map(
  (assetId) =>
    ({
      assetId,
      availability: "ready",
      mediaType: ["voice", "narrator"].includes(assetId) ? "audio" : "image",
    }) as ProjectAsset,
);
const prompt = "@[林川](role)走进@[村口](scene)，@[旁白](audio)，回望@[村口](scene)";
const plan = (overrides: Partial<typeof options> = {}, jobs: GenerationJob[] = []) =>
  dramaVideoInput(prompt, 40, "4:3", { ...options, ...overrides }, graph, assets, jobs);

test("切换模型后只提交开放且仍可选的分辨率", () => {
  const render = (open: boolean, values: string[], selected: string) => {
    const profile = modelGenerationOptions(
      "video",
      "doubao-video",
      "doubao-seedance-2-0",
      {},
      {
        kind: "video",
        name: "片场",
        description: "",
        sort: 1,
        params: { resolution: { values, default: values[0]!, open } },
      },
    );
    return dramaVideoInput(prompt, 6, "4:3", profile, graph, assets, [], undefined, selected).input;
  };
  expect(render(true, ["720p", "1080p"], "1080p").resolution).toBe("1080p");
  expect(render(true, ["720p"], "1080p")).not.toHaveProperty("resolution");
  expect(render(false, ["720p", "1080p"], "1080p")).not.toHaveProperty("resolution");
});

test("故事板沿用采用版，只在全能模式占图片1，关闭后恢复原编号", () => {
  const board = node("board", {
    drama: {
      episodes: [1],
      board: { segmentId: "seg", sourceHash: "old", shotCount: 2, layout: "2x2" },
    },
    assetId: "board-image",
  });
  const boardGraph = { ...graph, nodes: [...graph.nodes, board] };
  const available = [...assets, { ...assets[0]!, assetId: "board-image" }];
  const build = (
    off: boolean,
    overrides: Partial<typeof options> = {},
    prompt = "@[村口](scene)",
  ) =>
    dramaVideoInput(prompt, 6, "4:3", { ...options, ...overrides }, boardGraph, available, [], {
      segmentId: "seg",
      sourceHash: "new",
      off,
    });
  const { boardLine } = build(false);
  expect(boardLine).toContain("第1到第2格");
  expect(boardLine).toContain("第3到第4格不用");
  expect(boardLine).toContain("4:3 画幅重新构图");
  expect(build(false)).toMatchObject({
    board: { state: "stale" },
    input: {
      op: "omni",
      prompt: `${boardLine}\n图片2`,
      referenceAssetIds: ["board-image", "village"],
    },
    notices: ["故事板已过期，原稿在出图之后改过"],
  });
  expect(build(true)).toMatchObject({
    boardLine: "",
    board: { state: "off" },
    input: { prompt: "图片1", referenceAssetIds: ["village"] },
  });
  expect(build(false, { modes: ["i2v"] })).toMatchObject({
    boardLine: "",
    board: { state: "unsupported", reason: "当前模型把第一张图当首帧，故事板未带入" },
    input: { op: "i2v", prompt: "图片1", referenceAssetIds: ["village"] },
  });
  const english = build(false, {}, "Track slowly past @[村口](scene). <d>你在哪里？</d>");
  expect(english.boardLine).toMatch(/^Image 1 is the storyboard grid/);
  expect(english.input.prompt.startsWith(`${english.boardLine}\n`)).toBe(true);
  expect(build(false, { references: { image: 1 } }).errors.join("")).toContain("含故事板 1 张");
});

test("角色、场景与旁白分别按图片和音频编号，重复提及复用同一张图", () => {
  const result = plan();
  expect(result.errors).toEqual([]);
  expect(result.input).toMatchObject({
    op: "omni",
    duration: 15,
    aspectRatio: "4:3",
    referenceAssetIds: ["village", "narrator", "portrait", "voice", "side"],
  });
  expect(result.input.prompt).toContain("林川（图片2中的人物）走进图片1，音频1，回望图片1");
  expect(result.input.prompt).toContain("补充视角：图片3");
  expect(result.input.prompt).toContain("音色参考音频2");
});

test("参考图限额优先保留角色主图，声音超限时阻止提交", () => {
  const result = plan({ references: { image: 2, audio: 1 } });
  expect(result.input.referenceAssetIds).toEqual(["village", "narrator", "portrait"]);
  expect(result.errors.join("")).toContain("参考音频");
  expect(result.notices.join("")).toContain("参考图最多 2 张");
});

test("声音任务进行中时阻止提交，场景节点已删除时沿用原名", () => {
  expect(
    plan({}, [
      { nodeId: "role", purpose: "character-voice", status: "running" } as GenerationJob,
    ]).errors.join(""),
  ).toContain("声音仍在生成");
  const result = dramaVideoInput(
    "@[旧场景](gone)",
    3,
    "4:3",
    { ...options, durations: [4, 8] },
    graph,
    assets,
    [],
  );
  expect(result.input).toMatchObject({
    prompt: "旧场景",
    op: "t2v",
    duration: 4,
    referenceAssetIds: [],
  });
  expect(result.notices).toContain("引用已失效：旧场景");
});

test("无主图和音色的角色退回文字，而已有的两张场景图不能被静默截断", () => {
  const alternate: ProjectCanvasView = {
    ...graph,
    nodes: [
      node("role", {
        drama: drama("character"),
        character: { name: "林川", look: "基础形象", description: "", extraAssetIds: [] },
      }),
      node("entrance", { drama: drama("scene"), assetId: "village" }),
      node("exit", { drama: drama("scene"), assetId: "side" }),
    ],
  };
  const text = dramaVideoInput("@[林川](role)推开门", 5, "4:3", options, alternate, assets, []);
  expect(text.errors).toEqual([]);
  expect(text.input).toMatchObject({ prompt: "林川推开门", op: "t2v", referenceAssetIds: [] });
  const overflow = dramaVideoInput(
    "@[入口](entrance)到@[出口](exit)",
    5,
    "4:3",
    { ...options, references: { image: 1 } },
    alternate,
    assets,
    [],
  );
  expect(overflow.errors).toContain("参考图最多 1 个，请移除多余的");
});
