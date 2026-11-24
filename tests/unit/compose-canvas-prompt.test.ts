import type { CreativeData, ProjectAsset, ProjectCanvasView } from "@link-studio/core";
import { expect, test } from "vitest";
import {
  agentReferenceInput,
  agentSources,
  checkApprovedRoleJobs,
  type RoleJob,
} from "../../src/main/project/canvas-agent-references";
import {
  composeCanvasPrompt,
  composeLinkedPrompt,
} from "../../src/renderer/workspace/compose-canvas-prompt";
import { linkedMediaSources, mediaReferences } from "../../src/renderer/workspace/media-references";
import fixture from "../fixtures/canvas-prompt-compose.json";

type Source = {
  id: string;
  kind: string;
  label: string;
  text?: string;
  assetId?: string;
  character?: { name: string; voice?: string; extras?: string[] };
};

function graphFrom(nodes: Source[]): ProjectCanvasView {
  const target = "target";
  return {
    nodes: [...nodes, { id: target, kind: "video", label: "目标" } as Source].map((source) => ({
      id: source.id,
      type: "creative",
      position: { x: 0, y: 0 },
      data: {
        kind: source.kind === "character" ? "image" : (source.kind as CreativeData["kind"]),
        label: source.label,
        text: source.text ?? "",
        assetId: source.assetId,
        character: source.character && {
          name: source.character.name,
          description: "",
          look: "基础形象",
          extraAssetIds: source.character.extras ?? [],
          voice: source.character.voice ? { assetId: source.character.voice } : undefined,
        },
      },
    })),
    edges: nodes.map(({ id }) => ({ id: `edge-${id}`, source: id, target })),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

test.each(fixture.cases)("固定版共用样例 · $name", (example) => {
  const graph = graphFrom(example.nodes);
  const linked = linkedMediaSources(graph, "target");
  const assets: ProjectAsset[] = linked.flatMap((link) => {
    if (!link.assetId) return [];
    const node = graph.nodes.find(
      (node) => node.type === "creative" && node.data.assetId === link.assetId,
    );
    const kind = node?.type === "creative" ? node.data.kind : undefined;
    const mediaType =
      ("part" in link && link.part === "voice") || kind === "audio"
        ? "audio"
        : kind === "video"
          ? "video"
          : "image";
    return [
      { assetId: link.assetId, sizeBytes: 128, availability: "ready", mediaType } as ProjectAsset,
    ];
  });
  const { chosen } = mediaReferences({
    assets,
    linked,
    manual: [],
    imageOnly: false,
    video: true,
    limit: 99,
  });
  expect(composeCanvasPrompt(example.prompt, graph, "target", chosen)).toBe(example.expect);
  const sources = agentSources(graph, "target");
  const target: CreativeData = {
    kind: "video",
    label: "镜头",
    text: example.prompt,
    videoMode: "omni",
  };
  const result = agentReferenceInput(
    sources,
    target,
    Object.fromEntries(assets.map((asset) => [asset.assetId, asset])),
    [],
    { frameLimit: 2, referenceLimit: 12, references: { image: 9, audio: 3, video: 3 } },
    ["t2v", "i2v", "omni"],
    true,
  );
  expect(composeLinkedPrompt(target.text, sources, true, result.refs, "agent")).toBe(
    example.expect,
  );
});

test("Agent 根据实际模式保留必要参考，并只在名额不足时裁掉角色补充图", () => {
  const graph = graphFrom([
    {
      id: "lead",
      kind: "character",
      assetId: "21",
      label: "林夏",
      character: { name: "林夏", voice: "31", extras: ["22"] },
    },
    { id: "scene", kind: "image", assetId: "11", label: "街景" },
    {
      id: "second",
      kind: "character",
      assetId: "41",
      label: "同名角色",
      character: { name: "林夏" },
    },
  ]);
  const assets = Object.fromEntries(
    ["11", "21", "22", "31", "41"].map((assetId) => [
      assetId,
      {
        assetId,
        availability: "ready" as const,
        mediaType: assetId === "31" ? ("audio" as const) : ("image" as const),
      },
    ]),
  );
  const run = (mode: CreativeData["videoMode"], image: number, audio = true, missing = false) =>
    agentReferenceInput(
      agentSources(graph, "target"),
      { kind: "video", text: "", label: "镜头", videoMode: mode, manualReferenceIds: ["11"] },
      missing ? { ...assets, "11": { ...assets["11"]!, availability: "missing" } } : assets,
      [],
      { frameLimit: 2, referenceLimit: 4, references: { image, audio: 1 } },
      ["t2v", "i2v", "omni"],
      audio,
    );
  expect(run("omni", 3).refs.map((asset) => asset.assetId)).toEqual(["11", "21", "31", "41"]);
  expect(() => run("omni", 2)).toThrow("参考图片最多 2 个，请移除多余的参考素材");
  expect(() => run("omni", 3, false)).toThrow("开启声音生成");
  expect(() => run("t2v", 3)).toThrow("主图未就绪");
  expect(() => run("omni", 3, true, true)).toThrow("参考素材不可用");
  graph.edges.pop();
  expect(() => run("i2v", 3)).toThrow("声音未带入");
  expect(() => run(undefined, 3)).toThrow("声音未带入");
  expect(run("omni", 3).refs.map((asset) => asset.assetId)).toEqual(["11", "21", "31", "22"]);
});

test("运行中的文本不追加旧稿，显式引用使用写入时的名字，其他来源保持顺序", () => {
  const graph = graphFrom([
    { id: "first", kind: "script", label: "对白", text: "旧稿" },
    { id: "second", kind: "script", label: "环境", text: "雨声" },
  ]);
  const running = new Set(["first"]);
  expect(composeCanvasPrompt("", graph, "target", [], running)).toBe("雨声");
  expect(composeCanvasPrompt("镜头 @[旧标题](first)", graph, "target", [], running)).toBe(
    "镜头 旧标题\n\n雨声",
  );
  expect(composeLinkedPrompt("", agentSources(graph, "target"), true, [])).toBe("旧稿\n\n雨声");
  running.add("second");
  expect(composeCanvasPrompt("", graph, "target", [], running)).toBe("");
  running.delete("first");
  expect(composeCanvasPrompt("镜头 @[旧标题](first)", graph, "target", [], running)).toBe(
    "镜头 旧稿",
  );
});

test("物理断线、源删除均保留引用写入时的名字", () => {
  const graph = graphFrom([{ id: "text", label: "新名", kind: "script", text: "剧本" }]);
  const read = () => composeCanvasPrompt("@[旧名](text)", graph, "target", []);
  expect(read()).toBe("剧本");
  const edges = graph.edges;
  graph.edges = [];
  expect(read()).toBe("旧名");
  graph.edges = edges;
  graph.nodes = graph.nodes.filter((node) => node.id !== "text");
  expect(read()).toBe("旧名");
});

test("Go 助手只解释 @ 引用；画布编辑器另外展开预设", () => {
  const graph = graphFrom([
    { id: "script", kind: "script", label: "对白", text: "#[武侠江湖](style/wuxia) 雨落屋檐" },
  ]);
  const text = "#[旧预设](motion/unknown) @[对白](node:script)";
  expect(composeLinkedPrompt(text, agentSources(graph, "target"), false, [], "agent")).toBe(
    "#[旧预设](motion/unknown) #[武侠江湖](style/wuxia) 雨落屋檐",
  );
  expect(composeCanvasPrompt(text, graph, "target", [])).not.toContain("#[");
});

test("审批后只检查当前角色任务；不确定结果须等待，被新任务替代后不再阻塞", () => {
  const graph = graphFrom([
    {
      id: "lead",
      label: "主角",
      kind: "character",
      assetId: "21",
      character: { name: "林夏", extras: ["22"] },
    },
  ]);
  const old: RoleJob = {
    nodeId: "lead",
    kind: "audio",
    status: "outcome_unknown",
    purpose: "character-voice",
    createdAt: "2026-11-22T03:01:00Z",
  };
  const current: RoleJob = { ...old, status: "succeeded", createdAt: "2026-11-22T04:01:00Z" };
  const check = (jobs: RoleJob[], refs = ["21"]) =>
    checkApprovedRoleJobs(graph, "target", true, refs, jobs);
  expect(() => check([old])).toThrow("等待声音生成完成");
  expect(() => check([current, old])).not.toThrow();
  expect(() => check([old, current])).not.toThrow();
  const avatar: RoleJob = { ...current, kind: "image", purpose: undefined, status: "running" };
  expect(() => check([avatar], ["22"])).toThrow("主图正在生成");
  expect(() => check([avatar], [])).not.toThrow();
  expect(() => check([{ ...old, nodeId: "another" }])).not.toThrow();
});
