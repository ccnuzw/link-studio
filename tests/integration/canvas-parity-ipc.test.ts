import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportVideoCanvas, prepareVideoCanvasExchange } from "@link-studio/core";
import { app, type BrowserWindow, dialog, ipcMain } from "electron";
import { expect, test, vi } from "vitest";
import {
  ProjectChannels,
  type ProjectMethod,
} from "../../packages/link-studio-core/src/projects-api";
import { ProjectCoordinator } from "../../src/main/project/coordinator";
import { ProjectIpc } from "../../src/main/project/ipc";
import { ProjectStore } from "../../src/main/project/store";
import voices from "../../src/renderer/settings/official-voices.json";
import { canvasSeed } from "../../src/renderer/workspace/canvas-seed";
import { requireTestValue } from "../require-test-value";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: false, getAppPath: () => process.cwd() }),
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
  };
});

test.skipIf(process.platform !== "darwin")(
  "官方音色引入、并发保存冲突、副本重开与只读接管",
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "link-parity-"));
    const settings = {
      agent: { openCanvas: vi.fn(), closeCanvas: vi.fn() },
      registry: { reconcileJobPins: vi.fn(), indexFilingReferences: vi.fn() },
    };
    const ipc = new ProjectIpc(
      parent,
      join(process.cwd(), "out/media"),
      async () => settings as never,
      {} as never,
      "",
    );
    const frame = { url: "file:///canvas-test.html" };
    const sender = Object.assign(new EventEmitter(), {
      id: 3,
      mainFrame: frame,
      session: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
      isCrashed: () => false,
      isDestroyed: () => false,
      send: vi.fn(),
    });
    const window = Object.assign(new EventEmitter(), {
      webContents: sender,
      isDestroyed: () => false,
    });
    ipc.registerWindow(window as unknown as BrowserWindow, frame.url);
    const invoke = (method: ProjectMethod, input: Record<string, unknown> = {}) =>
      requireTestValue(
        vi
          .mocked(ipcMain.handle)
          .mock.calls.find(([channel]) => channel === ProjectChannels[method]),
      )[1]({ sender, senderFrame: frame } as never, { requestId: randomUUID(), ...input });
    const ok = async (method: ProjectMethod, input: Record<string, unknown> = {}) => {
      const response = await invoke(method, input);
      expect(response, method).toMatchObject({ ok: true });
      return response.value;
    };
    const create = async (name: string, seed?: Record<string, unknown>) =>
      invoke("create", {
        name,
        projectKind: "canvas",
        operationId: randomUUID(),
        directoryToken: (await ok("selectProjectParent")).directoryToken,
        ...(seed && { canvasSeed: seed }),
      });
    const handles = new Set<string>();
    const second = new ProjectCoordinator();
    second.registerWindow(9, vi.fn());
    try {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [parent] });
      const original = await create("原工程");
      expect(original.ok).toBe(true);
      const projectHandle = original.value.projectHandle;
      handles.add(projectHandle);
      const file = requireTestValue(requireTestValue(voices[0]).url.split("/").at(-1));
      expect(
        (
          await invoke("attachOfficialVoice", {
            projectHandle,
            file: "../wrong.wav",
            operationId: randomUUID(),
          })
        ).ok,
      ).toBe(false);
      const { asset } = await ok("attachOfficialVoice", {
        projectHandle,
        file,
        operationId: randomUUID(),
      });
      expect(asset).toMatchObject({
        mediaType: "audio",
        metadata: { officialVoice: requireTestValue(voices[0]).url },
      });
      expect(
        (await ok("attachOfficialVoice", { projectHandle, file, operationId: randomUUID() })).asset
          .assetId,
      ).toBe(asset.assetId);
      const operations = [
        {
          type: "putNode",
          node: {
            id: "audio",
            type: "creative",
            position: { x: 1, y: 2 },
            data: { label: "本地", kind: "audio", text: "", assetId: asset.assetId },
          },
        },
      ];
      await ok("applyCanvasOperations", {
        projectHandle,
        operations: [{ type: "setViewport", viewport: { x: 10, y: 0, zoom: 1 } }],
        operationId: randomUUID(),
        expectedCanvasRevision: 1,
      });
      expect(
        await invoke("applyCanvasOperations", {
          projectHandle,
          operations,
          operationId: randomUUID(),
          expectedCanvasRevision: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: "CANVAS_REVISION_CONFLICT" } });
      const before = await readdir(parent);
      expect(
        (
          await create("失败副本", {
            operations,
            media: { projectHandle, assetIds: [randomUUID()] },
          })
        ).ok,
      ).toBe(false);
      expect((await readdir(parent)).sort()).toEqual([...before].sort());
      await expect(
        ProjectStore.create(parent, "发布前失败", {
          seed: { operations: [{ type: "setViewport", viewport: { x: 0, y: 0, zoom: 1 } }] },
          onStage: async (stage) => {
            if (stage === "temporary-synced") throw Error("未发布");
          },
        }),
      ).rejects.toMatchObject({ code: "PROJECT_SAVE_FAILED" });
      expect((await readdir(parent)).sort()).toEqual([...before].sort());
      const copy = await create("保全副本", {
        operations,
        media: { projectHandle, assetIds: [asset.assetId] },
      });
      expect(copy.ok).toBe(true);
      handles.add(copy.value.projectHandle);
      expect((await ok("getCanvas", { projectHandle })).canvas.nodes).toEqual([]);
      const path = join(
        parent,
        requireTestValue(
          (await readdir(parent)).find(
            (name) => !before.includes(name) && name.endsWith(".linkstudio"),
          ),
        ),
      );
      const view = await second.open(9, await second.grantProjectDirectory(9, path), "open", true);
      expect(view).toMatchObject({
        disposition: "readOnly",
        canvas: { nodes: [requireTestValue(operations[0]).node] },
      });
      if (view.disposition !== "readOnly") throw Error("预期只读快照");
      await ok("close", { projectHandle: copy.value.projectHandle });
      handles.delete(copy.value.projectHandle);
      const next = await second.open(9, view.directoryToken, "open", true);
      expect(next.disposition).toBe("opened");
      if (next.disposition !== "opened") throw Error("预期接管");
      const reopened = second.getStore(9, next.session.projectHandle);
      expect(reopened.snapshot.assets[asset.assetId]).toMatchObject({
        sha256: asset.sha256,
        storage: { kind: "blob" },
      });
      const { AssetFiles } = await import("../../src/main/project/asset-files");
      const verified = await new AssetFiles(parent).inspect(
        reopened,
        requireTestValue(reopened.snapshot.assets[asset.assetId]),
        true,
      );
      await verified.handle.close();
      await ok("registerLibrary", { projectHandle, assetId: asset.assetId });
      const { items } = await ok("globalLibrary");
      const wire = exportVideoCanvas(view.canvas, "交换测试", [asset]);
      const imported = prepareVideoCanvasExchange(
        JSON.parse(wire.json),
        items.map((item: { asset: typeof asset }) => item.asset),
      );
      expect(imported.report.missingAssetIds).toEqual([]);
      const importedCopy = await create(
        "从个人库导入",
        canvasSeed(imported.document, undefined, true),
      );
      expect(importedCopy.ok).toBe(true);
      handles.add(importedCopy.value.projectHandle);
      const importedGraph = (
        await ok("getCanvas", { projectHandle: importedCopy.value.projectHandle })
      ).canvas;
      const importedId = importedGraph.nodes[0].data.assetId;
      expect(
        items.some(
          (item: { asset: typeof asset }) =>
            item.asset.assetId === importedId && item.asset.sha256 === asset.sha256,
        ),
      ).toBe(true);
      expect(
        (
          await ok("getAssetPreview", {
            projectHandle: importedCopy.value.projectHandle,
            assetId: importedId,
          })
        ).mimeType,
      ).toContain("audio/");
      const { asset: image } = await ok("attachImage", {
        projectHandle,
        operationId: randomUUID(),
        name: "fixture.png",
        bytes: new Uint8Array(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
            "base64",
          ),
        ),
      });
      const thumb = await ok("getAssetPreview", {
        projectHandle,
        assetId: image.assetId,
        variant: "thumb",
      });
      expect(thumb.url).toMatch(/^data:image\/png;base64,/);
      const bitmap = Buffer.from(thumb.url.split(",")[1], "base64");
      expect(bitmap.subarray(1, 4).toString()).toBe("PNG");
      expect(bitmap.readUInt32BE(16)).toBeGreaterThan(0);
      expect(bitmap.readUInt32BE(20)).toBeLessThanOrEqual(576);
      expect((await ProjectStore.inspectCanvas(reopened.directory)).canvas.nodes).toEqual([
        requireTestValue(operations[0]).node,
      ]);
    } finally {
      for (const projectHandle of handles) await invoke("close", { projectHandle });
      await second.releaseWindow(9);
      app.removeAllListeners();
      ipcMain.removeAllListeners();
      await rm(parent, { recursive: true, force: true });
    }
  },
  30000,
);
