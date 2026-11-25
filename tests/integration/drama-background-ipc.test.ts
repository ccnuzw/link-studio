import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, type BrowserWindow, dialog, ipcMain } from "electron";
import { expect, test, vi } from "vitest";
import {
  ProjectChannels,
  type ProjectMethod,
} from "../../packages/link-studio-core/src/projects-api";
import { createDrama, dramaDocument } from "../../src/main/project/drama";
import { ProjectIpc } from "../../src/main/project/ipc";
import { ProjectStore } from "../../src/main/project/store";
import { requireTestValue } from "../require-test-value";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), { quit: vi.fn(), isPackaged: false }),
    dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
  };
});

test("桌面 IPC：接回规划、后台确认和真正退出时保留断点", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-ipc-"));
  const store = await ProjectStore.create(root, "小说规划", { projectKind: "drama" });
  const directory = store.directory;
  const model = { id: randomUUID(), revision: 1 };
  await createDrama(
    store,
    { title: "小说规划", sourceKind: "novel", script: "第一章 归来\n远处的脚步渐近。" },
    [],
    [],
    () => [],
    undefined,
    model,
  );
  await store.close();
  const generate = vi.fn(
    (_model, _step, _input, _scope, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(Error("paused")), { once: true }),
      ),
  );
  const registry = {
    reconcileJobPins: vi.fn(),
    indexFilingReferences: vi.fn(),
    agentBinding: () => ({ profile: { config: { contextWindow: 32768 } } }),
    dramaPromptText: async () => "规划",
    dramaAssetStage: generate,
  };
  const settings = { agent: { openCanvas: vi.fn(), closeCanvas: vi.fn() }, registry };
  const ipc = new ProjectIpc(root, root, async () => settings as never, {} as never, "");
  const url = "file:///isolated-renderer.html";
  const frame = { url };
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    session: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
    isCrashed: () => false,
  });
  const window = Object.assign(new EventEmitter(), { webContents: sender, minimize: vi.fn() });
  ipc.registerWindow(window as unknown as BrowserWindow, url);
  const invoke = async (method: ProjectMethod, data: Record<string, unknown> = {}) => {
    const handler = requireTestValue(
      vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === ProjectChannels[method]),
    )[1];
    return handler({ sender, senderFrame: frame } as never, { requestId: randomUUID(), ...data });
  };
  try {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [directory] });
    const selected = await invoke("selectProject");
    const opened = await invoke("open", { directoryToken: selected.value.directoryToken });
    const projectHandle = opened.value.session.projectHandle;
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(await invoke("close", { projectHandle, keepWorking: true })).toMatchObject({ ok: true });
    const recent = (await invoke("listRecent")).value.projects[0];
    expect(recent.activity).toMatchObject({ label: "小说规划中", count: 1, progress: 0 });
    const entry = { recentEntryId: recent.recentEntryId };
    expect(await invoke("removeRecent", entry)).toMatchObject({
      ok: false,
      error: { code: "PROJECT_CONFLICT" },
    });
    const idle = await ProjectStore.create(root, "空闲短剧", { projectKind: "drama" });
    await idle.close();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [idle.directory],
    });
    const other = await invoke("selectProject");
    const idleHandle = (await invoke("open", { directoryToken: other.value.directoryToken })).value
      .session.projectHandle;
    expect(await invoke("close", { projectHandle: idleHandle, keepWorking: true })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(
      async () =>
        expect(await invoke("getState", { projectHandle: idleHandle })).toMatchObject({
          ok: false,
          error: { code: "PROJECT_NOT_OPEN" },
        }),
      { timeout: 5000, interval: 100 },
    );
    expect(await invoke("openRecent", entry)).toMatchObject({
      value: { disposition: "opened", session: { projectHandle } },
    });
    expect(await invoke("close", { projectHandle, keepWorking: true })).toMatchObject({ ok: true });
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    for (const response of [2, 0, 1]) {
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response, checkboxChecked: false });
      app.emit("before-quit", event as never);
      await new Promise((resolve) => setImmediate(resolve));
      expect(window.minimize).toHaveBeenCalledTimes(response === 2 ? 0 : 1);
      expect(app.quit).toHaveBeenCalledTimes(response === 1 ? 2 : 1);
    }
    expect(generate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dialog.showMessageBox).mock.calls[0]?.[0]).toMatchObject({
      buttons: ["继续后台运行", "保存进度并退出", "暂不退出"],
    });
    event.preventDefault.mockClear();
    app.emit("before-quit", event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    window.emit("closed");
    app.emit("will-quit", event as never);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(3));
    app.emit("will-quit", event as never);
    const reopened = await ProjectStore.open(directory);
    try {
      expect(dramaDocument(reopened.snapshot)?.planning).toMatchObject({
        phase: "running",
        pending: { step: "analyze" },
      });
    } finally {
      await reopened.close();
    }
  } finally {
    app.removeAllListeners();
    ipcMain.removeAllListeners();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
