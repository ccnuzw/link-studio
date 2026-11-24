import { describe, expect, it } from "vitest";
import type { ProjectCanvasView } from "../../packages/link-studio-core/src/canvas";
import {
  mergeCanvasExchange,
  parseCanvasExchange,
  prepareCanvasExchange,
  serializeCanvasExchange,
} from "../../packages/link-studio-core/src/canvas-exchange";
import {
  defaultDirectorScene,
  retimeDirectorScene,
} from "../../packages/link-studio-core/src/director";
import type { ProjectAsset } from "../../packages/link-studio-core/src/projects-api";
import {
  exportVideoCanvas,
  prepareVideoCanvasExchange,
} from "../../packages/link-studio-core/src/video-canvas-exchange";
import upstreamFile from "../fixtures/upstream-reference.canvas.json";
import storyboardFile from "../fixtures/upstream-storyboard.canvas.json";

const canvas: ProjectCanvasView = {
  nodes: [
    {
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      width: 500,
      height: 300,
      data: { label: "一组" },
    },
    {
      id: "image",
      type: "creative",
      parentId: "group",
      position: { x: 20, y: 20 },
      data: {
        kind: "image",
        label: "图片",
        text: "",
        assetId: "11111111-1111-4111-8111-111111111111",
      },
    },
  ],
  edges: [],
  viewport: { x: 1, y: 2, zoom: 1 },
};

describe("画布交换", () => {
  it("失败文本节点往返保留可复制的任务引用，缺少任务或已成功时隐藏引用", () => {
    const makeNode = (id: string, extra: object) => ({
      id,
      position: { x: 0, y: 0 },
      type: "canvas",
      data: {
        kind: "script",
        label: id,
        text: "旧稿",
        status: "error",
        errorTaskRef: "task-ref",
        ...extra,
      },
    });
    const file = {
      format: "video-canvas/canvas",
      version: 1,
      assets: {},
      canvas: {
        edges: [],
        nodes: [
          makeNode("failed", { taskId: "job-id" }),
          makeNode("missing", {}),
          makeNode("done", { taskId: "old", status: "done" }),
        ],
      },
    };
    const { nodes } = prepareVideoCanvasExchange(file, []).document;
    expect(nodes[0]?.data).toMatchObject({
      textFailureTask: { id: "job-id", reference: "task-ref" },
    });
    expect(nodes.slice(1).every((node) => !("textFailureTask" in node.data))).toBe(true);
    const exported = JSON.parse(
      exportVideoCanvas({ ...canvas, nodes, edges: [] }, "任务引用", []).json,
    );
    expect(exported.canvas.nodes[0].data).toMatchObject({
      taskId: "job-id",
      errorTaskRef: "task-ref",
    });
    expect(prepareVideoCanvasExchange(exported, []).document.nodes).toEqual(nodes);
  });
  it("旧拉线锚点只换算一次，用未测量的默认尺寸，不移动组和普通左上角节点", () => {
    const position = { x: 500, y: 300 };
    const raw = (id: string, kind: string, extra: object = {}) => ({
      id,
      type: "canvas",
      position,
      data: { kind, label: id },
      ...extra,
    });
    const nodes = [
      raw("group", "group", { type: "group", origin: [1, 0.5] }),
      raw("left", "image", { origin: [0, 0.5] }),
      raw("right", "audio", { origin: [1, 0.5], width: 324, parentId: "group" }),
      raw("plain", "video"),
      raw("invalid", "image", { origin: [0, "0.5"] }),
    ];
    const file = {
      format: "video-canvas/canvas",
      version: 1,
      assets: {},
      canvas: { nodes, edges: [{ id: "linked", source: "left", target: "right" }] },
    };
    const restored = prepareVideoCanvasExchange(file, []).document;
    expect(restored.nodes.map((node) => node.position)).toEqual([
      position,
      { x: 500, y: 138 },
      { x: -76, y: 138 },
      position,
      position,
    ]);
    expect(restored.nodes[2]).toMatchObject({ parentId: "group" });
    expect(restored.edges).toEqual(file.canvas.edges);
    const exchanged = JSON.parse(
      exportVideoCanvas({ ...canvas, nodes: restored.nodes, edges: restored.edges }, "落点", [])
        .json,
    );
    expect(exchanged.canvas.nodes.every((node: object) => !("origin" in node))).toBe(true);
    expect(prepareVideoCanvasExchange(exchanged, []).document.nodes).toEqual(restored.nodes);
  });
  it("文本节点的本地模型键随原版文件往返，未选模型不写入文件", () => {
    const providerId = "11111111-1111-4111-8111-111111111111";
    const data = { kind: "script" as const, label: "正文", text: "第一镜" };
    const node = { id: "text", type: "creative" as const, position: { x: 0, y: 0 }, data };
    const nodes = [node, { ...node, id: "chosen", data: { ...data, generation: { providerId } } }];
    const file = JSON.parse(exportVideoCanvas({ ...canvas, nodes }, "文本模型", []).json);
    expect(file.canvas.nodes.map((entry: typeof node) => entry.data)).toEqual([
      data,
      { ...data, model: providerId },
    ]);
    const restored = prepareVideoCanvasExchange(file, []).document.nodes;
    expect(restored[0]?.data).not.toHaveProperty("generation");
    expect(restored[1]?.data).toMatchObject({ ...data, generation: { modelKey: providerId } });
    expect(
      JSON.parse(exportVideoCanvas({ ...canvas, nodes: restored }, "文本模型", []).json).canvas
        .nodes,
    ).toEqual(file.canvas.nodes);
  });
  it("文本交换保留失败和正文，提示词不能代替正文，也不能带回原任务", () => {
    const fixtures = [
      { status: "error", error: "服务暂时不可用", text: "上一版" },
      { status: "error", params: { prompt: "隐藏提示词" } },
      { status: "running", taskId: "旧任务", prompt: "旧提示词" },
      { status: "done", text: "已完成" },
    ];
    const nodes = fixtures.map((fields, index) => ({
      id: `text-${index}`,
      type: "canvas",
      position: { x: index * 600, y: 10 },
      data: { kind: "script", label: "对白", ...fields },
    }));
    const file = {
      format: "video-canvas/canvas",
      version: 1,
      assets: {},
      canvas: { nodes, edges: [] },
    };
    const restored = prepareVideoCanvasExchange(file, []).document.nodes;
    const output = JSON.parse(exportVideoCanvas({ ...canvas, nodes: restored }, "对白", []).json);
    expect(output.canvas.nodes.map((node: { data: object }) => node.data)).toEqual([
      { kind: "script", label: "对白", status: "error", text: "上一版", error: "服务暂时不可用" },
      { kind: "script", label: "对白", status: "error", text: "" },
      { kind: "script", label: "对白", status: "idle", text: "" },
      { kind: "script", label: "对白", status: "done", text: "已完成" },
    ]);
    expect(prepareVideoCanvasExchange(output, []).document.nodes).toEqual(restored);
  });
  it("上传失败节点保留位置和错误，不携带本地重试文件", () => {
    const node = {
      id: "failed",
      type: "creative" as const,
      position: { x: 155, y: 200 },
      data: {
        kind: "video" as const,
        label: "素材",
        text: "",
        uploaded: true as const,
        uploadFailed: true as const,
      },
    };
    const exported = JSON.parse(exportVideoCanvas({ ...canvas, nodes: [node] }, "上传", []).json);
    expect(exported.canvas.nodes[0].data).toMatchObject({
      kind: "video",
      uploaded: true,
      status: "error",
      error: "上传失败，请重试",
    });
    expect(prepareVideoCanvasExchange(exported, []).document.nodes).toMatchObject([node]);
  });
  it("导演台缩略图按哈希重新绑定，缺图时仍保留场景", () => {
    const original = defaultDirectorScene();
    original.characters[0]!.keys = [0.01, 0.02].map((t, index) => ({
      t,
      x: index,
      z: 0,
      yaw: 0,
      ease: "linear",
    }));
    const director = retimeDirectorScene(original, 1),
      assetId = "11111111-1111-4111-8111-111111111111",
      sha256 = "a".repeat(64);
    expect(director.characters[0]!.keys.map(({ t, x }) => [t, x])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    const image: ProjectAsset = {
      assetId,
      sha256,
      displayName: "director-thumb.jpg",
      mediaType: "image",
      mimeType: "image/jpeg",
      importMode: "copy",
      sizeBytes: 100,
      storage: { kind: "blob", hash: sha256 },
      metadata: {},
      availability: "ready",
    };
    const graph: ProjectCanvasView = {
      ...canvas,
      nodes: [
        {
          id: "director",
          position: { x: 0, y: 0 },
          type: "creative",
          data: {
            kind: "script",
            label: "导演台",
            text: "",
            director,
            directorThumbnailId: assetId,
          },
        },
      ],
    };
    const file = JSON.parse(exportVideoCanvas(graph, "场景", [image]).json);
    expect(file.canvas.nodes[0].data.scene).toEqual({ ...director, thumbHash: sha256 });
    const newId = "22222222-2222-4222-8222-222222222222";
    expect(
      prepareVideoCanvasExchange(file, [{ ...image, assetId: newId }]).document.nodes[0],
    ).toMatchObject({ data: { director, directorThumbnailId: newId } });
    const absent = prepareVideoCanvasExchange(file, []);
    expect(absent.document.nodes[0]).toMatchObject({ data: { director } });
    expect(absent.document.nodes[0]?.data).not.toHaveProperty("directorThumbnailId");
    const native = prepareCanvasExchange(
      parseCanvasExchange(JSON.parse(serializeCanvasExchange(graph, "场景"))),
      new Set(),
    );
    expect(native.report.missingAssetIds).toEqual([assetId]);
    expect(native.document.nodes[0]?.data).toMatchObject({
      director,
      directorThumbnailId: undefined,
    });
  });
  it.each([undefined, "upload", "generated", "library"] as const)(
    "角色音色来源 %s 导入导出往返",
    (origin) => {
      const assetId = "22222222-2222-4222-8222-222222222222";
      const sha256 = "2".repeat(64);
      const audio: ProjectAsset = {
        assetId,
        sha256,
        displayName: "角色音色.wav",
        mediaType: "audio",
        mimeType: "audio/wav",
        importMode: "copy",
        sizeBytes: 10,
        storage: { kind: "blob", hash: sha256 },
        metadata: {},
        availability: "ready",
      };
      const character = {
        name: "林舟",
        look: "夜班",
        description: "",
        extraAssetIds: [],
        voice: { assetId, ...(origin && { origin, name: "角色录音.wav" }) },
      };
      const nodes = canvas.nodes.map((node) =>
        node.type === "creative"
          ? { ...node, data: { kind: "image" as const, label: "角色卡", text: "", character } }
          : node,
      );
      const exported = JSON.parse(exportVideoCanvas({ ...canvas, nodes }, "角色", [audio]).json);
      const expected = {
        mode: "audio",
        assetHash: sha256,
        origin: origin ?? "upload",
        ...(origin && { name: "角色录音.wav" }),
      };
      expect(exported.canvas.nodes[1].data.character.voice).toEqual(expected);
      const imported = prepareVideoCanvasExchange(exported, [audio]).document;
      expect(imported.nodes[1]).toMatchObject({
        data: { character: { voice: { assetId, origin: expected.origin } } },
      });
      const roundTrip = JSON.parse(
        exportVideoCanvas({ ...canvas, nodes: imported.nodes }, "角色", [audio]).json,
      );
      expect(roundTrip.canvas.nodes[1].data.character.voice).toEqual(expected);
    },
  );
  it("原版格式往返保留分镜视频的模式、时长和镜头关联", () => {
    const fixture = structuredClone(storyboardFile);
    const video = fixture.canvas.nodes.find((node) => node.data.kind === "video");
    if (!video?.data.params) throw new Error("缺少分镜视频");
    Object.assign(video.data.params, { duration: 8, op: "i2v" });
    const imported = prepareVideoCanvasExchange(fixture, []).document;
    const originalParams = { prompt: "列车进站", duration: 8, op: "i2v" };
    const exported = JSON.parse(
      exportVideoCanvas({ ...imported, viewport: canvas.viewport }, "分镜", []).json,
    );
    const savedVideo = exported.canvas.nodes.find((node: { id: string }) => node.id === video.id);
    expect(savedVideo.data.params).toEqual(originalParams);
    const restored = prepareVideoCanvasExchange(exported, []).document;
    expect(restored.nodes.find((node) => node.id === video.id)).toMatchObject({
      data: { text: originalParams.prompt, videoMode: "i2v", videoDuration: 8 },
    });
    expect(restored.nodes[0]).toMatchObject({
      data: { storyboard: [expect.objectContaining({ videoNodeId: video.id }), expect.anything()] },
    });
  });
  it.each([-1, 8, 60])(
    "原版参数往返保留自动和镜头时长 %s、零与布尔值，忽略非生成字段",
    (duration) => {
      const params = {
        duration,
        aspect_ratio: "9:16",
        resolution: "720p",
        generate_audio: false,
        seed: 0,
        count: 2,
      };
      const fixture = structuredClone(storyboardFile);
      const video = fixture.canvas.nodes.find((node) => node.data.kind === "video")!;
      Object.assign(video.data, { mediaAspect: 9 / 16, model: "remote-artist-v2" });
      Object.assign(video.data.params!, params, {
        endpoint: "https://example.invalid",
        sample_rate: 5,
      });
      const imported = prepareVideoCanvasExchange(fixture, []).document;
      expect(imported.nodes.find((node) => node.id === video.id)).toMatchObject({
        data: {
          generation: {
            modelKey: "remote-artist-v2",
            params: { aspectRatio: "9:16", generateAudio: false, seed: 0 },
          },
        },
      });
      const exported = JSON.parse(
        exportVideoCanvas({ ...imported, viewport: canvas.viewport }, "参数", []).json,
      );
      expect(
        exported.canvas.nodes.find((node: { id: string }) => node.id === video.id).data,
      ).toMatchObject({ mediaAspect: 9 / 16, model: "remote-artist-v2" });
      expect(
        exported.canvas.nodes.find((node: { id: string }) => node.id === video.id).data.params,
      ).toEqual({ prompt: "列车进站", ...params });
    },
  );
  it.each([
    [undefined, 8],
    ["12", 12],
    ["2.", undefined],
  ] as const)("导出采用当前时长，不覆盖为旧镜头时长：%s", (durationInput, expected) => {
    const nodes = canvas.nodes.map((node) =>
      node.type === "creative"
        ? {
            ...node,
            data: {
              ...node.data,
              kind: "video" as const,
              videoDuration: 5,
              generation: { params: { duration: 8 }, durationInput },
            },
          }
        : node,
    );
    const exported = JSON.parse(exportVideoCanvas({ ...canvas, nodes }, "时长", []).json);
    expect(exported.canvas.nodes[1].data.params.duration).toBe(expected);
  });
  it("两版生成结果只导出当前选中版本，导回后保留模型、时间和选中状态", () => {
    const chosenId = "11111111-1111-4111-8111-111111111111";
    const laterId = "22222222-2222-4222-8222-222222222222";
    const createdAt = "2026-01-02T03:04:05.000Z";
    const outputs = [chosenId, laterId].map((assetId, index) => ({
      id: `v${index}`,
      kind: "image" as const,
      assetId,
      createdAt,
      model: "画布模型",
    }));
    const nodes = canvas.nodes.map((node) =>
      node.type === "creative"
        ? { ...node, data: { ...node.data, outputs, activeOutputId: "v0" } }
        : node,
    );
    const assets: ProjectAsset[] = [chosenId, laterId].map((assetId, index) => ({
      assetId,
      displayName: `第${index}版.png`,
      mediaType: "image",
      mimeType: "image/png",
      importMode: "copy",
      sizeBytes: 10,
      sha256: String(index).repeat(64),
      storage: { kind: "blob", hash: String(index).repeat(64) },
      metadata: {},
      availability: "ready",
    }));
    const result = JSON.parse(exportVideoCanvas({ ...canvas, nodes }, "历史版本", assets).json);
    expect(Object.keys(result.assets)).toEqual([assets[0]!.sha256]);
    expect(result.canvas.nodes[1].data.outputs).toEqual([
      {
        assetHash: assets[0]!.sha256,
        mediaType: "image",
        model: "画布模型",
        createdAt: Date.parse(createdAt),
      },
    ]);
    const restored = prepareVideoCanvasExchange(result, assets);
    expect(restored.document.nodes[1]).toMatchObject({
      data: {
        activeOutputId: chosenId,
        outputs: [{ id: chosenId, assetId: chosenId, model: "画布模型", createdAt }],
      },
    });
    const pending = nodes.map((node) =>
      node.type === "creative"
        ? {
            ...node,
            data: {
              ...node.data,
              assetId: undefined,
              activeOutputId: undefined,
              pendingMediaVersion: { batchId: laterId, outputId: "v0" },
            },
          }
        : node,
    );
    const detached = parseCanvasExchange(
      JSON.parse(serializeCanvasExchange({ ...canvas, nodes: pending }, "跨项目")),
    );
    expect(detached.nodes[1]?.data).toMatchObject({
      activeOutputId: "v0",
      assetId: chosenId,
      outputs,
    });
    expect(detached.nodes[1]?.data).not.toHaveProperty("pendingMediaVersion");
    expect(
      JSON.parse(exportVideoCanvas({ ...canvas, nodes: pending }, "历史版本", assets).json).canvas
        .nodes[1].data,
    ).toEqual(result.canvas.nodes[1].data);
  });
  it("报告原版清单中本地缺失的素材，保留提示词、节点和连线", () => {
    const result = prepareVideoCanvasExchange(upstreamFile, []);
    expect(result.report.missingAssetIds.sort()).toEqual(Object.keys(upstreamFile.assets).sort());
    expect(result.document.nodes).toHaveLength(2);
    expect(result.document.nodes[1]).toMatchObject({
      data: { text: "沿着 @[主图](im) 推进 #[固定镜头](motion/static_shot)" },
    });
    expect(result.document.edges).toEqual([{ id: "im-vid", source: "im", target: "vid" }]);
  });
  it("拒绝新版本及清单不完整的原版文件", () => {
    expect(() => prepareVideoCanvasExchange({ ...upstreamFile, version: 2 }, [])).toThrow("版本");
    expect(() => prepareVideoCanvasExchange({ ...upstreamFile, assets: {} }, [])).toThrow("清单");
  });
  it("保留可用的手动参考素材，报告缺失的引用", () => {
    const available = "11111111-1111-4111-8111-111111111111";
    const missing = "22222222-2222-4222-8222-222222222222";
    const nodes = canvas.nodes.map((node) =>
      node.type === "creative"
        ? { ...node, data: { ...node.data, manualReferenceIds: [available, missing] } }
        : node,
    );
    const exported = parseCanvasExchange(
      JSON.parse(serializeCanvasExchange({ ...canvas, nodes }, "参考素材")),
    );
    const prepared = prepareCanvasExchange(exported, new Set([available]));
    expect(prepared.document.nodes[1]).toMatchObject({ data: { manualReferenceIds: [available] } });
    expect(prepared.report.missingAssetIds).toEqual([missing]);
  });
  it("导出过滤只读/未知记录并保持格式版本", () => {
    const parsed = parseCanvasExchange(JSON.parse(serializeCanvasExchange(canvas, "测试")));
    expect(parsed.format).toBe("link-studio.canvas");
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(0);
  });

  it("缺失素材清空引用，合并时重映射节点、父组和连线", () => {
    const parsed = parseCanvasExchange(
      JSON.parse(serializeCanvasExchange({ ...canvas, edges: [] }, "测试")),
    );
    const prepared = prepareCanvasExchange(parsed, new Set());
    expect(prepared.report.missingAssetIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(prepared.document.nodes[1]).toMatchObject({ data: { assetId: undefined } });
    const withEdge = { ...prepared.document, edges: [] };
    const merged = mergeCanvasExchange(
      { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      withEdge,
      (() => {
        let index = 0;
        return () => `new-${++index}`;
      })(),
    );
    expect(merged.nodes[1]).toMatchObject({ parentId: "new-1" });
    expect(merged.edges).toEqual([]);
  });

  it("拒绝组端点、重复端点、悬空父组和无序父组", () => {
    const base = parseCanvasExchange(JSON.parse(serializeCanvasExchange(canvas, "测试")));
    expect(() =>
      parseCanvasExchange({
        ...base,
        edges: [{ id: "edge", source: "group", target: "image" }],
      }),
    ).toThrow("无效连线");
    expect(
      parseCanvasExchange({
        ...base,
        nodes: [base.nodes[1], base.nodes[0]],
      }).nodes,
    ).toHaveLength(2);
    expect(() =>
      parseCanvasExchange({
        ...base,
        nodes: base.nodes.map((node) =>
          node.type === "creative" ? { ...node, parentId: "missing" } : node,
        ),
      }),
    ).toThrow("无效父组");
    const second = {
      id: "image-2",
      type: "creative" as const,
      position: { x: 20, y: 20 },
      data: {
        ...(base.nodes[1]?.data ?? { kind: "image", label: "图片", text: "" }),
        assetId: undefined,
      },
    };
    expect(() =>
      parseCanvasExchange({
        ...base,
        nodes: [...base.nodes, second],
        edges: [
          { id: "edge-1", source: "image", target: "image-2" },
          { id: "edge-2", source: "image", target: "image-2" },
        ],
      }),
    ).toThrow("无效连线");
  });
});
