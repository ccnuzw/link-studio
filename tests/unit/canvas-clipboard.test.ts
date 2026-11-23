import type { ProjectCanvasView } from "@link-studio/core";
import { defaultDirectorScene } from "@link-studio/core";
import { expect, it } from "vitest";
import {
  type CanvasFragment,
  captureSelection,
  cloneSelection,
  detachExternalNodes,
  mapFragmentMedia,
} from "../../src/renderer/workspace/selection-actions";

it("跨工程重新绑定历史版本、角色声音、附图和分镜素材，不改写节点、模型或输出编号", () => {
  const source: CanvasFragment = {
    nodes: [
      {
        type: "creative",
        id: "id",
        position: { x: 2, y: 3 },
        parentId: "group",
        data: {
          kind: "image",
          text: "id",
          label: "id",
          assetId: "id",
          manualReferenceIds: ["extra"],
          activeOutputId: "id",
          outputs: [{ id: "id", kind: "image", assetId: "id", createdAt: "" }],
          character: {
            name: "角色",
            look: "造型",
            description: "",
            extraAssetIds: ["extra"],
            voice: { assetId: "voice" },
          },
          generation: { providerId: "id" },
          storyboard: [
            {
              id: "id",
              scene: "",
              shot: "",
              camera: "",
              dialogue: "",
              duration: 2,
              imageAssetId: "still",
              imageNodeId: "id",
              action: "",
            },
          ],
          directorThumbnailId: "thumb",
        },
      },
    ],
    edges: [{ id: "outside", source: "external", target: "id" }],
    parentOrigins: new Map([["group", { x: 100, y: 200 }]]),
  };
  const fragment = mapFragmentMedia(detachExternalNodes(source), (id) => `target-${id}`);
  expect(fragment.nodes[0]).toMatchObject({
    id: "id",
    position: { x: 102, y: 203 },
    data: {
      text: "id",
      assetId: "target-id",
      manualReferenceIds: ["target-extra"],
      activeOutputId: "id",
      outputs: [{ id: "id", assetId: "target-id" }],
      generation: { providerId: "id" },
      character: { extraAssetIds: ["target-extra"], voice: { assetId: "target-voice" } },
      storyboard: [{ id: "id", imageNodeId: "id", imageAssetId: "target-still" }],
      directorThumbnailId: "target-thumb",
    },
  });
  expect(fragment.edges).toEqual([]);
  expect(fragment.nodes[0]).not.toHaveProperty("parentId");
  expect(source.edges).toHaveLength(1);
  expect(source.nodes[0]?.data).toHaveProperty("assetId", "id");
});

it("复制导演台不复用对象标识或旧缩略图，机位引用跟随新人物", () => {
  const director = defaultDirectorScene(),
    graph: ProjectCanvasView = {
      viewport: { x: 0, y: 0, zoom: 1 },
      edges: [],
      nodes: [
        {
          id: "dir",
          type: "creative",
          position: { x: 0, y: 0 },
          data: {
            kind: "script",
            label: "导演台",
            text: "",
            director,
            directorThumbnailId: "11111111-1111-4111-8111-111111111111",
          },
        },
      ],
    };
  const clone = cloneSelection(captureSelection(graph, new Set(["dir"]))!, graph, () =>
    crypto.randomUUID(),
  ).nodes[0];
  expect(clone?.type).toBe("creative");
  if (clone?.type !== "creative") throw Error("缺少副本");
  const scene = clone.data.director!;
  expect(scene.characters[0]?.id).not.toBe(director.characters[0]?.id);
  expect(scene.cameras[0]?.lookAt).toBe(scene.characters[0]?.id);
  expect(scene.activeCameraId).toBe(scene.cameras[0]?.id);
  expect(scene.activeCameraId).not.toBe(director.activeCameraId);
  expect(clone.data.directorThumbnailId).toBeUndefined();
});

it("只复制组成员时保留父组，指针放置用画布坐标，仅保留输入边", () => {
  const graph: ProjectCanvasView = {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "group",
        type: "group",
        position: { x: 180, y: 90 },
        width: 600,
        height: 450,
        data: { label: "组" },
      },
      {
        id: "child",
        type: "creative",
        parentId: "group",
        position: { x: 20, y: 30 },
        data: { kind: "image", label: "画面", text: "" },
      },
      {
        id: "outside",
        type: "creative",
        position: { x: 0, y: 0 },
        data: { kind: "script", label: "说明", text: "hi" },
      },
    ],
    edges: [
      { id: "incoming", source: "outside", target: "child" },
      { id: "outgoing", source: "child", target: "outside" },
    ],
  };
  const copy = captureSelection(graph, new Set(["child"]));
  if (!copy) throw new Error("无选区");
  const result = cloneSelection(copy, graph, () => crypto.randomUUID(), { x: 310, y: 200 });
  expect(result.nodes[0]).toMatchObject({
    parentId: "group",
    position: { x: 130, y: 110 },
    data: { label: "画面 副本" },
  });
  expect(result.edges).toMatchObject([{ source: "outside", target: result.nodes[0]?.id }]);
  const orphan = cloneSelection(
    copy,
    { ...graph, nodes: [] },
    () => crypto.randomUUID(),
    undefined,
    48,
  );
  expect(orphan.nodes[0]).toMatchObject({ position: { x: 248, y: 168 } });
  expect(orphan.nodes[0]).not.toHaveProperty("parentId");
  expect(orphan.edges).toEqual([]);
});
