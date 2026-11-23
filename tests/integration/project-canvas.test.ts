import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasOperation } from "../../packages/link-studio-core/src/canvas";
import type { ProjectState } from "../../packages/link-studio-core/src/project";
import { canonicalJson, contentHash } from "../../src/main/project/encoding";
import { type CommitStage, ProjectStore, type StoreOptions } from "../../src/main/project/store";
import { mapVideoCanvas } from "../../src/main/project/video-canvas-mapper";

let parent: string;
const stores: ProjectStore[] = [];
const script = {
  id: "script",
  type: "creative",
  position: { x: 10, y: 20 },
  data: { kind: "script", label: "分镜", text: "午夜车站" },
} as const;

async function create(options?: StoreOptions) {
  const store = await ProjectStore.create(parent, "核心画布", options);
  stores.push(store);
  return store;
}

async function reopen(directory: string) {
  const store = await ProjectStore.open(directory);
  stores.push(store);
  return store;
}

function request(expectedCanvasRevision: number, ...operations: CanvasOperation[]) {
  return { operationId: randomUUID(), expectedCanvasRevision, operations };
}

async function fixture(
  store: ProjectStore,
  canvas: ProjectState["canvas"],
  jobs = store.snapshot.jobs,
) {
  const { commitHash: parentHash, ...body } = store.snapshot;
  const next = { ...body, revision: body.revision + 1, parentHash, canvas, jobs };
  const commitHash = contentHash(next);
  await store.close();
  await writeFile(
    join(store.directory, "state", `000000000002-${commitHash}.json`),
    canonicalJson({ ...next, commitHash }),
  );
  return reopen(store.directory);
}

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "link-studio-canvas-"));
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await rm(parent, { recursive: true, force: true });
});

describe("S2 项目画布", () => {
  it("把旧导演台的场景和机位映射到本地节点并剥离远程缩略图", async () => {
    const store = await create();
    const scene = {
      version: 1,
      duration: 4,
      activeCameraId: "camera-1",
      characters: [],
      props: [],
      cameras: [
        {
          id: "camera-1",
          name: "主机位",
          aspect: "16:9",
          x: 0,
          y: 2,
          z: 5,
          yaw: 0,
          pitch: -5,
          fov: 55,
          keys: [],
        },
      ],
    };
    const mapped = mapVideoCanvas(
      {
        nodes: [
          {
            id: "director-1",
            type: "canvas",
            position: { x: 0, y: 0 },
            data: {
              kind: "director",
              label: "主场景",
              scene: { ...scene, thumb: { url: "https://example.invalid/signed" } },
            },
          },
        ],
      },
      () => undefined,
    );
    expect(mapped.nodes).toHaveLength(1);
    expect(mapped.nodes[0]).toMatchObject({ type: "creative", data: { director: scene } });
    expect(JSON.stringify(mapped)).not.toContain("example.invalid");
    const opened = await fixture(store, mapped);
    expect(opened.getCanvas().canvas.nodes[0]).toMatchObject({
      type: "creative",
      data: { director: scene },
    });
  });

  it("独立画布 CAS、同版本并发、跨进程重开后的回执幂等", async () => {
    const store = await create();
    await store.rename({
      operationId: randomUUID(),
      expectedRevision: 1,
      name: "重命名不影响画布修订",
    });
    const first = request(1, { type: "putNode", node: script });
    const second = request(1, {
      type: "putNode",
      node: { ...script, data: { ...script.data, text: "旧修订" } },
    });
    const results = await Promise.allSettled([
      store.applyCanvasOperations(first),
      store.applyCanvasOperations(second),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: { revision: 3, canvasRevision: 2 } });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { code: "CANVAS_REVISION_CONFLICT" },
    });
    await store.close();
    const restored = await reopen(store.directory);
    expect(restored.getCanvas().canvas.nodes).toEqual([script]);
    expect(await restored.applyCanvasOperations(first)).toEqual({ revision: 3, canvasRevision: 2 });
    await expect(
      restored.applyCanvasOperations({ ...second, operationId: first.operationId }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" });
    expect(await readdir(join(store.directory, "state"))).toHaveLength(3);
  });

  it("原子校验分组、端点、载荷和素材引用", async () => {
    const store = await create();
    const missingAsset = {
      ...script,
      data: { kind: "image", label: "图片", text: "", assetId: randomUUID() },
    } as const;
    await expect(
      store.applyCanvasOperations(request(1, { type: "putNode", node: missingAsset })),
    ).rejects.toMatchObject({ code: "CANVAS_REFERENCE_MISSING" });
    const transient = { ...script, selected: true };
    const invalidBatches = [
      request(1, { type: "putNode", node: transient }),
      request(1, { type: "putNode", node: { ...script, parentId: "missing" } }),
      request(
        1,
        { type: "putNode", node: script },
        { type: "putEdge", edge: { id: "no-target", source: "script", target: "missing" } },
      ),
      request(1, { type: "putNode", node: script }, { type: "putNode", node: script }),
    ];
    for (const batch of invalidBatches)
      await expect(store.applyCanvasOperations(batch)).rejects.toMatchObject({
        code: "CANVAS_OPERATION_INVALID",
      });
    expect(store.getCanvas()).toMatchObject({
      canvas: { nodes: [], edges: [] },
      canvasRevision: 1,
      revision: 1,
    });
    const group = {
      id: "group",
      type: "group",
      position: { x: 100, y: 200 },
      width: 300,
      height: 200,
      data: { label: "第一幕" },
    } as const;
    const member = { ...script, parentId: group.id };
    const viewport = { x: -100, y: 20, zoom: 1.3 };
    await store.applyCanvasOperations(
      request(
        1,
        { type: "putNode", node: member },
        { type: "putNode", node: group },
        { type: "setViewport", viewport },
      ),
    );
    await expect(
      store.applyCanvasOperations(request(2, { type: "removeNode", id: group.id })),
    ).rejects.toMatchObject({ code: "CANVAS_OPERATION_INVALID" });
    await store.close();
    expect((await reopen(store.directory)).getCanvas().canvas).toEqual({
      nodes: [member, group],
      edges: [],
      viewport,
    });
  });

  it("兼容占位与连线保留原始记录，正常节点仍可保存", async () => {
    const store = await create();
    const future = {
      id: "future",
      type: "director",
      position: { x: 64, y: 128 },
      data: { label: "导演台", raw: { keyframes: [1, 2, 3] } },
    };
    const edge = { id: "future-edge", source: "script", target: "future", futurePort: "camera" };
    const restored = await fixture(store, {
      ...store.snapshot.canvas,
      revision: 2,
      nodes: [script, future],
      edges: [edge],
    });
    expect(restored.getCanvas().canvas).toMatchObject({
      nodes: [script, { id: "future", type: "unknown", data: { label: "导演台" } }],
      edges: [{ id: "future-edge", readOnly: true }],
    });
    expect(restored.getCanvas().canvas.nodes[1]?.data).toEqual({ label: "导演台" });
    for (const operation of [
      { type: "removeNode", id: "future" },
      { type: "removeNode", id: "script" },
      { type: "removeEdge", id: edge.id },
    ] as const) {
      await expect(restored.applyCanvasOperations(request(2, operation))).rejects.toMatchObject({
        code: "CANVAS_OPERATION_INVALID",
      });
    }
    await restored.applyCanvasOperations(
      request(2, { type: "putNode", node: { ...script, data: { ...script.data, text: "改稿" } } }),
    );
    await restored.close();
    expect((await reopen(store.directory)).snapshot.canvas).toMatchObject({
      nodes: [{ data: { text: "改稿" } }, future],
      edges: [edge],
    });
  });

  it.each(["temporary-synced", "snapshot-published"] as const)(
    "保存中断 %s 后按同一操作回执恢复",
    async (fault) => {
      let stage: CommitStage | undefined;
      const store = await create({
        onStage: async (current) => {
          if (current === stage) {
            stage = undefined;
            throw new Error("disk failure");
          }
        },
      });
      const write = request(1, { type: "putNode", node: script });
      const indexedRevisions: number[] = [];
      await store.observeGenerationHistory((state) => indexedRevisions.push(state.revision));
      stage = fault;
      await expect(store.applyCanvasOperations(write)).rejects.toMatchObject({
        code: "PROJECT_SAVE_FAILED",
      });
      expect(store.getCanvas().canvasRevision).toBe(1);
      expect((await store.readCanvas()).canvasRevision).toBe(fault === "temporary-synced" ? 1 : 2);
      expect(indexedRevisions).toEqual([1, fault === "temporary-synced" ? 1 : 2]);
      expect(await store.applyCanvasOperations(write)).toEqual({ revision: 2, canvasRevision: 2 });
      expect(await readdir(join(store.directory, "state"))).toHaveLength(2);
    },
  );

  it("删除节点仍保留历史任务", async () => {
    const store = await create();
    const jobs = { completed: { nodeId: script.id, status: "succeeded" } };
    const restored = await fixture(
      store,
      { ...store.snapshot.canvas, revision: 2, nodes: [script] },
      jobs,
    );
    await restored.applyCanvasOperations(request(2, { type: "removeNode", id: script.id }));
    await restored.close();
    const reopened = await reopen(store.directory);
    expect(reopened.getCanvas().canvas.nodes).toEqual([]);
    expect(reopened.snapshot.jobs).toEqual(jobs);
  });

  it("迁移角色形象名保留空白，只有属性缺失才使用基础形象", async () => {
    const looks = [undefined, "", "   ", "  夜班  "];
    const mapped = mapVideoCanvas(
      {
        nodes: looks.map((look, index) => ({
          id: `actor-${index}`,
          type: "canvas",
          position: { x: 0, y: 0 },
          data: {
            kind: "character",
            character: { name: "林舟", look, voicePrompt: look, voiceModel: "audio-seed-1" },
          },
        })),
      },
      () => undefined,
    );
    const restored = await fixture(await create(), mapped);
    expect(
      restored
        .getCanvas()
        .canvas.nodes.map((node) => node.type === "creative" && node.data.character?.look),
    ).toEqual(["基础形象", "", "   ", "  夜班  "]);
    expect(
      restored
        .getCanvas()
        .canvas.nodes.map((node) => node.type === "creative" && node.data.character?.voicePrompt),
    ).toEqual(looks);
    expect(restored.getCanvas().canvas.nodes[0]).toMatchObject({
      data: { character: { voiceModel: "audio-seed-1" } },
    });
  });

  it("将 video-canvas 的四类节点、分组和连线映射到本地字段", async () => {
    const store = await create();
    const localAssetId = randomUUID();
    const upstream = {
      viewport: { x: 60, y: -12, zoom: 0.8 },
      nodes: [
        {
          id: "group",
          type: "group",
          position: { x: 1, y: 2 },
          width: 600,
          height: 700,
          data: { label: "第一幕", color: "purple" },
        },
        ...["script", "image", "video", "audio", "director"].map((kind) => ({
          id: kind,
          type: "canvas",
          position: { x: 10, y: 20 },
          parentId: "group",
          selected: true,
          dragging: true,
          data: {
            kind,
            label: kind,
            text: kind === "script" ? "脚本" : undefined,
            assetId: "upstream-asset",
            params: { prompt: "提示词" },
            src: "https://example.invalid/?token=secret",
            uploadProgress: 42,
            model: "web-model",
            taskId: "web-task",
          },
        })),
      ],
      edges: [
        { id: "script-image", source: "script", target: "image", selected: true },
        { id: "image-director", source: "image", target: "director" },
      ],
    };
    const mapped = mapVideoCanvas(upstream, (id, kind) =>
      id === "upstream-asset" && kind === "image" ? localAssetId : undefined,
    );
    expect(mapped.nodes[1]).toMatchObject({
      type: "creative",
      parentId: "group",
      data: { kind: "script", text: "脚本" },
    });
    expect(mapped.nodes[2]).toMatchObject({ data: { assetId: localAssetId, text: "提示词" } });
    expect(mapped.nodes[3]).toMatchObject({ data: { kind: "video", text: "提示词" } });
    expect(mapped.nodes[4]).toMatchObject({ data: { kind: "audio", text: "提示词" } });
    for (const node of mapped.nodes.slice(2, 5))
      expect(node).toMatchObject({ data: { generation: { modelKey: "web-model" } } });
    expect(JSON.stringify(mapped)).not.toMatch(
      /secret|upstream-asset|uploadProgress|"model":|web-task|selected|dragging/,
    );
    const restored = await fixture(store, mapped);
    expect(restored.getCanvas().canvas).toMatchObject({
      viewport: upstream.viewport,
      edges: [{ id: "script-image" }, { id: "image-director", readOnly: true }],
    });
    expect(restored.getCanvas().canvas.nodes.at(-1)?.type).toBe("unknown");
  });
});
