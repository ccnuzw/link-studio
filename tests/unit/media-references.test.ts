import type { ProjectAsset, ProjectCanvasView } from "@link-studio/core";
import { describe, expect, it } from "vitest";
import { linkedMediaSources, mediaReferences } from "../../src/renderer/workspace/media-references";

const asset = (assetId: string, overrides: Partial<ProjectAsset> = {}): ProjectAsset => ({
  assetId,
  createdAt: "2026-11-21T00:00:00.000Z",
  origin: "imported",
  displayName: `${assetId}.png`,
  mediaType: "image",
  mimeType: "image/png",
  sha256: "a".repeat(64),
  sizeBytes: 42,
  importMode: "copy",
  storage: { kind: "blob", hash: "a".repeat(64) },
  metadata: {},
  availability: "ready",
  ...overrides,
});

describe("画布生成参考素材", () => {
  it("将角色主图、补充图和音色展开为下游参考", () => {
    const linked = linkedMediaSources(
      {
        nodes: [
          {
            id: "character",
            type: "creative",
            position: { x: 0, y: 0 },
            data: {
              kind: "image",
              label: "主角",
              text: "",
              assetId: "main",
              character: {
                name: "主角",
                look: "正装",
                description: "不会作为参考文本发送",
                extraAssetIds: ["extra"],
                voice: { assetId: "voice" },
              },
            },
          },
        ],
        edges: [{ id: "character-video", source: "character", target: "video" }],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      "video",
    );
    const assets = [asset("main"), asset("extra"), asset("voice", { mediaType: "audio" })];
    expect(
      mediaReferences({
        assets,
        linked,
        manual: [],
        imageOnly: false,
        limit: 3,
        counts: { image: 2, audio: 1 },
      }).chosen.map(({ assetId }) => assetId),
    ).toEqual(["main", "extra", "voice"]);
    expect(
      mediaReferences({ assets, linked, manual: [], imageOnly: true, limit: 3 }).chosen.map(
        ({ assetId }) => assetId,
      ),
    ).toEqual(["main", "extra"]);
  });

  it("只读取目标节点的可编辑入边，并随上游换素材更新", () => {
    const canvas: ProjectCanvasView = {
      nodes: [
        {
          id: "source",
          type: "creative",
          position: { x: 0, y: 0 },
          data: { kind: "image", label: "上游", text: "", assetId: "first" },
        },
        {
          id: "text",
          type: "creative",
          position: { x: 0, y: 0 },
          data: { kind: "script", label: "文本", text: "不发送" },
        },
        {
          id: "target",
          type: "creative",
          position: { x: 0, y: 0 },
          data: { kind: "video", label: "下游", text: "" },
        },
      ],
      edges: [
        { id: "outgoing", source: "target", target: "source" },
        { id: "readonly", source: "source", target: "target", readOnly: true },
        { id: "text", source: "text", target: "target" },
        { id: "incoming", source: "source", target: "target" },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    expect(linkedMediaSources(canvas, "target")).toEqual([{ label: "上游", assetId: "first" }]);
    const source = canvas.nodes.find(({ id }) => id === "source");
    if (source?.type !== "creative") throw new Error("Missing source node");
    source.data.assetId = "replacement";
    expect(linkedMediaSources(canvas, "target")).toEqual([
      { label: "上游", assetId: "replacement" },
    ]);
    canvas.edges = canvas.edges.filter(({ id }) => id !== "incoming");
    expect(linkedMediaSources(canvas, "target")).toEqual([]);
  });

  it("过滤不合格素材，保序去重并在超额时保留手动素材", () => {
    const selection = {
      assets: [
        asset("linked"),
        asset("manual"),
        asset("offline", { availability: "missing" }),
        asset("large", { sizeBytes: 10 * 1024 * 1024 + 1 }),
        asset("video", { mediaType: "video" }),
      ],
      linked: [
        { label: "有效", assetId: "linked" },
        { label: "同图", assetId: "linked" },
        { label: "离线", assetId: "offline" },
        { label: "超限", assetId: "large" },
        { label: "不匹配", assetId: "video" },
        { label: "空节点", assetId: undefined },
      ],
      manual: ["offline", "manual"],
      imageOnly: true,
      limit: 1,
    };
    const result = mediaReferences(selection);
    expect(result.chosen.map(({ assetId }) => assetId)).toEqual(["manual"]);
    expect(result.overflow).toBe(1);
    expect(result.unavailable).toEqual(["离线", "超限", "不匹配", "空节点"]);
    expect(
      mediaReferences({ ...selection, manual: ["linked", "manual"], limit: 4 }).chosen.map(
        ({ assetId }) => assetId,
      ),
    ).toEqual(["linked", "manual"]);
  });
});
