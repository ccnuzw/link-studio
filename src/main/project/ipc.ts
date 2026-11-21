import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { app, type BrowserWindow, dialog, ipcMain } from "electron";
import { jobIsTerminal } from "../../../packages/link-studio-core/src/generation.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import type {
  ImportStatus,
  ProjectErrorCode,
  ProjectMethod,
  ProjectRequest,
  ProjectValues,
} from "../../../packages/link-studio-core/src/projects-api.ts";
import {
  ProjectChannels,
  ProjectRequests,
} from "../../../packages/link-studio-core/src/projects-api.ts";
import { MediaComposer } from "../../../packages/media-runtime/src/composition.ts";
import { MediaError } from "../../../packages/media-runtime/src/process.ts";
import { isTrustedDocument } from "../security.ts";
import type { SettingsIpc } from "../settings/ipc.ts";
import { SkillLibrary } from "../skills/library.ts";
import { AssetFiles, servePreview } from "./asset-files.ts";
import { AssetService, copyCandidates, type StagedAsset } from "./assets.ts";
import { CanvasAgentService } from "./canvas-agent.ts";
import { CanvasMedia } from "./canvas-media.ts";
import { ProjectCoordinator, type WindowLease } from "./coordinator.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import { type ExportTargetTransaction, installExportTarget } from "./export-target.ts";
import { GenerationService } from "./generation.ts";
import type { ProjectStore } from "./store.ts";

interface RecentEntry {
  recentEntryId: string;
  projectId: string;
  displayName: string;
  displayPath: string;
  directory: string;
  lastOpenedAt: string;
}

interface ImportJob {
  id: string;
  owner: number;
  projectHandle: string;
  requestHash: string;
  operationId: string;
  mode: "copy" | "reference";
  abort: AbortController;
  status: ImportStatus;
  work?: Promise<void>;
  staged?: StagedAsset;
  grant?: FileGrant;
  expiry?: ReturnType<typeof setTimeout>;
  commit?: { operationId: string; requestHash: string };
}

interface PreviewGrant {
  owner: number;
  projectHandle: string;
  assetId: string;
  stamp: string;
  expiresAt: number;
}

interface FileGrant {
  owner: number;
  projectHandle: string;
  displayName: string;
  path: string;
  handle: FileHandle;
  expiresAt: number;
  expiry?: ReturnType<typeof setTimeout>;
}

export class ProjectIpc {
  private readonly coordinator = new ProjectCoordinator();
  private readonly windows = new Map<number, BrowserWindow>();
  private readonly trustedDocuments = new Map<number, string>();
  private readonly leases = new Map<number, WindowLease>();
  private recents: RecentEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private recentsLoaded = false;
  private loadingRecents: Promise<void> | null = null;
  private readonly recentFile: string;
  private readonly fileGrants = new Map<string, FileGrant>();
  private readonly assetService: AssetService;
  private readonly assetFiles: AssetFiles;
  private readonly composer: MediaComposer;
  private readonly generation: GenerationService;
  private readonly projectOwners = new Map<string, { owner: number; store: ProjectStore }>();
  private readonly canvasAgent: CanvasAgentService;
  private readonly skills: SkillLibrary;
  private readonly imports = new Map<string, ImportJob>();
  private readonly mediaTools = new Map<
    string,
    {
      operationId: string;
      abort: AbortController;
      work: Promise<unknown>;
    }
  >();
  private readonly previews = new Map<string, PreviewGrant>();
  private readonly closing = new Set<string>();
  private readonly pendingCanvas = new Set<number>();
  private readonly closingWindows = new Set<number>();
  private quitting = false;
  private confirmingQuit = false;
  private resumeAfterQuit = false;

  constructor(
    userData: string,
    developmentMediaPath: string,
    private readonly settings: () => ReturnType<SettingsIpc["open"]>,
  ) {
    this.skills = new SkillLibrary(join(userData, "skills"));
    this.recentFile = join(userData, "projects", "recent.json");
    this.assetFiles = new AssetFiles(join(userData, "asset-locators"));
    const binaries =
      process.env.LINK_STUDIO_MEDIA_BINARIES ??
      join(
        app.isPackaged ? join(process.resourcesPath, "media") : developmentMediaPath,
        `${process.platform}-${process.arch}`,
      );
    const ffprobe = join(binaries, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    const ffmpeg = join(binaries, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    this.assetService = new AssetService(ffprobe);
    this.composer = new MediaComposer({ ffmpeg, ffprobe });
    this.generation = new GenerationService(
      async () => (await this.settings()).registry,
      this.assetService,
      this.assetFiles,
    );
    this.canvasAgent = new CanvasAgentService(
      this.generation,
      async () => (await this.settings()).registry,
      new CanvasMedia(
        this.assetFiles,
        this.assetService,
        join(binaries, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
      ),
      {
        catalog: (query) => this.skills.agentCatalog(query),
        content: (name, version) => this.skills.agentContent(name, version),
      },
    );
    this.register();
    app.on("before-quit", (event) => {
      if (this.confirmingQuit) {
        event.preventDefault();
        return;
      }
      const active = this.resumeAfterQuit ? [] : this.activeGeneration();
      if (active.length) {
        event.preventDefault();
        this.confirmingQuit = true;
        void this.confirmQuit(active)
          .finally(() => {
            this.confirmingQuit = false;
            if (this.resumeAfterQuit) app.quit();
          })
          .catch(() => undefined);
        return;
      }
      this.quitting = true;
    });
    ipcMain.on("link-studio:canvas:pending", (event, pending: unknown) => {
      if (typeof pending !== "boolean" || !this.isWindowSender(event)) return;
      if (pending) this.pendingCanvas.add(event.sender.id);
      else this.pendingCanvas.delete(event.sender.id);
    });
    ipcMain.on("link-studio:canvas:closeResult", (event, saved: unknown) => {
      if (typeof saved !== "boolean" || !this.isWindowSender(event)) return;
      const id = event.sender.id;
      if (!this.closingWindows.delete(id)) return;
      const quitting = this.quitting;
      this.quitting = false;
      if (!saved) {
        this.resumeAfterQuit = false;
        return;
      }
      this.pendingCanvas.delete(id);
      if (quitting) app.quit();
      else this.windows.get(id)?.close();
    });
  }

  private activeGeneration() {
    return [...this.projectOwners.values()].flatMap(({ store }) =>
      this.generation
        .list(store)
        .jobs.filter((job) => !jobIsTerminal(job.status))
        .map((job) => ({ store, job })),
    );
  }

  private async confirmQuit(active: ReturnType<ProjectIpc["activeGeneration"]>) {
    const cancellable = active.filter(
      ({ job }) =>
        !job.cancelRequested &&
        (job.status === "queued" || (job.status === "running" && job.canCancelRemote)),
    );
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: `还有 ${active.length} 项生成任务未完成`,
      detail: cancellable.length
        ? `${cancellable.length} 项可请求取消。请求发出后，灵可会保持打开以确认结果。退出后，重新打开项目可继续查询已受理的任务。`
        : "退出后，重新打开项目可继续查询已受理的任务。",
      buttons: ["继续等待", "退出并稍后恢复", ...(cancellable.length ? ["请求取消任务"] : [])],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) this.resumeAfterQuit = true;
    if (response === 2) {
      for (const { store, job } of cancellable) {
        await this.generation.cancel(store, job.id).catch(() => undefined);
      }
    }
  }

  private isWindowSender(event: Electron.IpcMainEvent) {
    const id = event.sender.id;
    const trusted = this.trustedDocuments.get(id);
    return (
      this.windows.has(id) &&
      trusted &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame &&
      isTrustedDocument(event.senderFrame.url, trusted)
    );
  }

  registerWindow(window: BrowserWindow, rendererUrl: string) {
    const id = window.webContents.id;
    const session = window.webContents.session;
    session.protocol.handle("link-media", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== "preview" || url.search || url.hash)
          return new Response(null, { status: 404 });
        const token = url.pathname.slice(1);
        const grant = this.previews.get(token);
        const active = () =>
          Boolean(
            grant &&
              grant.owner === id &&
              this.windows.get(id) === window &&
              !window.isDestroyed() &&
              isTrustedDocument(window.webContents.getURL(), rendererUrl) &&
              this.previews.get(token) === grant &&
              grant.expiresAt > Date.now(),
          );
        if (!grant || !active()) return new Response(null, { status: 404 });
        const store = this.coordinator.getStore(id, grant.projectHandle);
        const asset = store.snapshot.assets[grant.assetId];
        if (!asset || asset.availability === "deleted") return new Response(null, { status: 404 });
        const response = await servePreview(
          request,
          this.assetFiles,
          store,
          asset,
          grant.stamp,
          active,
        );
        const rendererOrigin = new URL(rendererUrl).origin;
        if (
          response.ok &&
          asset.mediaType === "image" &&
          request.headers.get("origin") === rendererOrigin
        )
          response.headers.set("access-control-allow-origin", rendererOrigin);
        return response;
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    this.windows.set(id, window);
    this.trustedDocuments.set(id, rendererUrl);
    const lease = this.coordinator.registerWindow(id, () => {
      if (!window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.focus();
      }
    });
    this.leases.set(id, lease);
    void this.loadRecents();
    window.on("close", (event) => {
      if (!this.pendingCanvas.has(id) && !this.closingWindows.has(id)) return;
      if (window.webContents.isCrashed()) return;
      event.preventDefault();
      if (this.closingWindows.has(id)) return;
      this.closingWindows.add(id);
      window.webContents.send("link-studio:canvas:saveBeforeClose");
    });
    window.once("closed", () => {
      this.pendingCanvas.delete(id);
      this.closingWindows.delete(id);
      this.windows.delete(id);
      this.trustedDocuments.delete(id);
      this.leases.delete(id);
      session.protocol.unhandle("link-media");
      for (const [token, grant] of this.fileGrants) {
        if (grant.owner !== id) continue;
        void this.discardFileGrant(token);
      }
      for (const [token, grant] of this.previews)
        if (grant.owner === id) this.previews.delete(token);
      void Promise.all([
        this.stopImports(id),
        ...[...this.projectOwners]
          .filter(([, entry]) => entry.owner === id)
          .map(([handle]) => this.stopProjectWork(handle)),
      ])
        .finally(() => this.coordinator.releaseWindow(id, lease))
        .catch(() => undefined);
    });
  }

  private startProjectWork(owner: number, handle: string) {
    const store = this.coordinator.getStore(owner, handle);
    this.projectOwners.set(handle, { owner, store });
    this.canvasAgent.attach(store);
    this.generation.start(store);
    void this.settings()
      .then(({ agent }) => agent.openCanvas(this.canvasAgent.key(store)))
      .catch(() => undefined);
  }

  private async stopProjectWork(handle: string) {
    const entry = this.projectOwners.get(handle);
    if (!entry) return;
    this.projectOwners.delete(handle);
    this.canvasAgent.detach(entry.store);
    const media = this.mediaTools.get(handle);
    media?.abort.abort();
    await Promise.all([
      media?.work.catch(() => undefined),
      this.generation.stop(entry.store),
      this.quitting
        ? undefined
        : this.settings()
            .then(({ agent }) => agent.closeCanvas(this.canvasAgent.key(entry.store)))
            .catch(() => undefined),
    ]);
  }

  canvasCommand(command: string, args: unknown) {
    return this.canvasAgent.command(command, args);
  }

  private register() {
    for (const method of Object.keys(ProjectRequests) as ProjectMethod[]) {
      const channel = ProjectChannels[method];
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request: unknown) => {
        const window = this.windows.get(event.sender.id);
        const requestId =
          request &&
          typeof request === "object" &&
          "requestId" in request &&
          typeof request.requestId === "string"
            ? request.requestId
            : "invalid";
        const trusted = this.trustedDocuments.get(event.sender.id);
        if (
          !window ||
          !event.senderFrame ||
          !trusted ||
          event.senderFrame !== window.webContents.mainFrame ||
          !isTrustedDocument(event.senderFrame.url, trusted) ||
          !Value.Check(ProjectRequests[method], request)
        )
          return {
            ok: false,
            requestId,
            error: {
              code: "VALIDATION_FAILED",
              retryable: false,
              messageKey: "project.invalidRequest",
            },
          };
        try {
          const result = await this.invokeWithMediaLifetime(
            method,
            request as ProjectRequest<typeof method>,
            window,
          );
          return { ok: true, requestId, value: result };
        } catch (error) {
          const projectError = error instanceof ProjectError ? error : null;
          const agentCode =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string" &&
            /^AGENT_[A-Z_]+$/.test(error.code)
              ? error.code
              : undefined;
          const code = projectError?.code ?? agentCode ?? "PROJECT_SAVE_FAILED";
          return {
            ok: false,
            requestId,
            error: {
              code,
              retryable:
                projectError?.code === "PROJECT_IN_USE" ||
                projectError?.code === "PROJECT_SAVE_FAILED",
              messageKey: projectError || agentCode ? `project.${code}` : "project.unexpected",
              ...(projectError?.message ? { message: projectError.message } : {}),
            },
          };
        }
      });
    }
  }

  private async invokeWithMediaLifetime<Method extends ProjectMethod>(
    method: Method,
    request: ProjectRequest<Method>,
    window: BrowserWindow,
  ) {
    if (
      method !== "splitAsset" &&
      method !== "trimAsset" &&
      method !== "inspectAsset" &&
      method !== "annotateAsset" &&
      method !== "exportComposition"
    )
      return this.invoke(method, request, window);
    const input = request as ProjectRequest<
      "splitAsset" | "trimAsset" | "inspectAsset" | "exportComposition"
    >;
    const { projectHandle, requestId } = input;
    this.coordinator.getStore(window.webContents.id, projectHandle);
    if (this.closing.has(projectHandle) || !this.projectOwners.has(projectHandle))
      throw new ProjectError("PROJECT_CLOSED", "项目正在关闭");
    if (this.mediaTools.has(projectHandle))
      throw new ProjectError("PROJECT_CONFLICT", "已有媒体处理任务在运行");
    const abort = new AbortController();
    const work = this.invoke(method, request, window, abort.signal);
    this.mediaTools.set(projectHandle, {
      operationId: "operationId" in input ? input.operationId : requestId,
      abort,
      work,
    });
    try {
      return await work;
    } catch (cause) {
      if (abort.signal.aborted)
        throw new ProjectError(
          method === "exportComposition" ? "EXPORT_CANCELLED" : "ASSET_IMPORT_CANCELLED",
          method === "exportComposition" ? "导出已取消" : "媒体处理已取消",
        );
      throw cause;
    } finally {
      this.mediaTools.delete(projectHandle);
    }
  }

  private async invoke<Method extends ProjectMethod>(
    method: Method,
    request: ProjectRequest<Method>,
    window: BrowserWindow,
    mediaSignal?: AbortSignal,
  ): Promise<ProjectValues[Method]> {
    const input = request as Record<string, unknown>;
    const id = window.webContents.id;
    switch (method) {
      case "saveDirectorPreview": {
        const { projectHandle, mp4 } = request as ProjectRequest<"saveDirectorPreview">;
        const bytes = Buffer.from(mp4.buffer, mp4.byteOffset, mp4.byteLength);
        if (bytes.toString("ascii", 4, 8) !== "ftyp")
          throw new ProjectError("VALIDATION_FAILED", "无效的预演视频");
        this.coordinator.getStore(id, projectHandle);
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          title: "保存导演台预演",
          defaultPath: "导演台预演.mp4",
          filters: [{ name: "MP4", extensions: ["mp4"] }],
        });
        if (canceled || !filePath) return { saved: false } as ProjectValues[Method];
        this.coordinator.getStore(id, projectHandle);
        const temporary = join(dirname(filePath), `.link-studio-${randomUUID()}.tmp`);
        const file = await open(temporary, "wx", 0o600);
        try {
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, filePath);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        return { saved: true } as ProjectValues[Method];
      }
      case "exportComposition": {
        const input = request as ProjectRequest<"exportComposition">;
        const store = this.coordinator.getStore(id, input.projectHandle);
        const state = await this.coordinator.withStore(id, input.projectHandle, async (current) => {
          await current.flush();
          return current.snapshot;
        });
        const requestHash = contentHash({
          kind: "composition-export",
          videoAssetIds: input.videoAssetIds,
          ...(input.bgmAssetId ? { bgmAssetId: input.bgmAssetId } : {}),
          ...(input.sourceVolume !== undefined ? { sourceVolume: input.sourceVolume } : {}),
          ...(input.bgmVolume !== undefined ? { bgmVolume: input.bgmVolume } : {}),
          ...(input.profile ? { profile: input.profile } : {}),
        });
        const previous = store.replayAssetImport(input.operationId, requestHash);
        if (previous) {
          const asset = previous.asset;
          const composition = Object.values(store.snapshot.compositions).find(
            (value) =>
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              (value as Record<string, unknown>).assetId === asset.assetId,
          );
          return {
            asset,
            revision: previous.revision,
            targetName: asset.displayName,
            exportId:
              composition && typeof composition === "object" && !Array.isArray(composition)
                ? String((composition as Record<string, unknown>).exportId ?? "")
                : "",
          } as ProjectValues[Method];
        }
        if (input.expectedRevision > state.revision)
          throw new ProjectError("PROJECT_CONFLICT", "项目状态尚未同步，请刷新后重新导出");
        const videos = input.videoAssetIds.map((assetId) => state.assets[assetId]);
        if (
          videos.some(
            (asset) => !asset || asset.availability === "deleted" || asset.mediaType !== "video",
          )
        )
          throw new ProjectError("EXPORT_SOURCE_MISSING", "导出镜头中有不可用的视频素材");
        const bgm = input.bgmAssetId ? state.assets[input.bgmAssetId] : undefined;
        if (
          input.bgmAssetId &&
          (!bgm || bgm.availability === "deleted" || bgm.mediaType !== "audio")
        )
          throw new ProjectError("EXPORT_SOURCE_MISSING", "所选 BGM 不可用");
        const save = await dialog.showSaveDialog(window, {
          title: "导出成片",
          defaultPath: "灵可成片.mp4",
          filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
          properties: ["showOverwriteConfirmation"],
        });
        if (save.canceled || !save.filePath)
          throw new ProjectError("EXPORT_CANCELLED", "已取消导出");
        const target = save.filePath.toLowerCase().endsWith(".mp4")
          ? save.filePath
          : `${save.filePath}.mp4`;
        const targetBeforeInstall = await lstat(target).catch(() => undefined);
        if (targetBeforeInstall) {
          const confirm = await dialog.showMessageBox(window, {
            type: "warning",
            buttons: ["覆盖", "另存为"],
            defaultId: 1,
            cancelId: 1,
            title: "文件已存在",
            message: "目标文件已经存在，是否覆盖？",
            detail: "覆盖只会替换导出文件，不会修改项目源素材。",
          });
          if (confirm.response !== 0) throw new ProjectError("EXPORT_CANCELLED", "已取消导出");
        }
        const expectedTarget = targetBeforeInstall
          ? {
              exists: true,
              dev: targetBeforeInstall.dev,
              ino: targetBeforeInstall.ino,
              size: targetBeforeInstall.size,
              mtimeMs: targetBeforeInstall.mtimeMs,
              ctimeMs: targetBeforeInstall.ctimeMs,
            }
          : { exists: false };
        const temporaryTarget = join(dirname(target), `.link-studio-export-${randomUUID()}.mp4`);
        const sourceDirectory = join(store.directory, "tmp", `export-${input.operationId}`);
        await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
        const operationProgress = (
          stage: "preparing" | "encoding" | "validating" | "importing" | "completed",
          progress: number,
        ) =>
          window.webContents.send("link-studio:composition:progress", {
            operationId: input.operationId,
            stage,
            progress: Math.max(0, Math.min(100, Math.round(progress))),
          });
        let staged: StagedAsset | undefined;
        let publishedBlob: { path: string; created: boolean } | undefined;
        let targetTransaction: ExportTargetTransaction | undefined;
        try {
          operationProgress("preparing", 0);
          const sourcePaths: string[] = [];
          for (const [index, asset] of videos.entries()) {
            const source = join(sourceDirectory, `${index}.mp4`);
            if (!asset)
              throw new ProjectError("EXPORT_SOURCE_MISSING", "导出镜头中有不可用的视频素材");
            await this.assetFiles.materialize(store, asset, source, mediaSignal);
            sourcePaths.push(source);
          }
          const bgmPath = bgm ? join(sourceDirectory, "bgm.audio") : undefined;
          if (bgm && bgmPath) await this.assetFiles.materialize(store, bgm, bgmPath, mediaSignal);
          let duration = 1;
          const result = await this.composer.export(
            {
              videos: sourcePaths,
              target: temporaryTarget,
              ...(bgmPath ? { bgm: bgmPath } : {}),
              sourceVolume: input.sourceVolume,
              bgmVolume: input.bgmVolume,
              profile: input.profile,
            },
            {
              signal: mediaSignal,
              onRecipe: (recipe) => {
                duration = recipe.duration;
                operationProgress("preparing", 12);
              },
              onStage: (stage) => {
                operationProgress(
                  stage === "prepared" ? "preparing" : stage === "validated" ? "validating" : stage,
                  stage === "prepared" ? 18 : stage === "encoding" ? 20 : 92,
                );
              },
              onProgress: (seconds) =>
                operationProgress("encoding", 20 + (seconds / duration) * 70),
            },
          );
          const exportId = result.recipe.exportId;
          operationProgress("importing", 94);
          const outputHandle = await open(
            temporaryTarget,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            staged = await this.assetService.stage(
              store,
              outputHandle,
              "灵可成片.mp4",
              randomUUID(),
              { signal: mediaSignal },
            );
          } finally {
            await outputHandle.close();
          }
          staged.asset.origin = "derived";
          staged.asset.metadata = {
            ...staged.asset.metadata,
            compositionId: exportId,
            sourceAssetIds: input.videoAssetIds,
            ...(input.bgmAssetId ? { bgmAssetId: input.bgmAssetId } : {}),
          };
          publishedBlob = await this.assetService.publishBlob(store, staged, mediaSignal);
          const composition = {
            exportId,
            assetId: staged.asset.assetId,
            sourceAssetIds: input.videoAssetIds,
            ...(input.bgmAssetId ? { bgmAssetId: input.bgmAssetId } : {}),
            recipe: result.recipe,
          };
          targetTransaction = await installExportTarget(temporaryTarget, target, expectedTarget);
          const committed = await store.commitAsset({
            operationId: input.operationId,
            expectedRevision: state.revision,
            requestHash,
            asset: staged.asset,
            composition: {
              id: exportId,
              value: JSON.parse(
                JSON.stringify(composition),
              ) as ProjectState["compositions"][string],
            },
            signal: mediaSignal,
          });
          await targetTransaction.finalize();
          targetTransaction = undefined;
          operationProgress("completed", 100);
          return {
            asset: committed.asset,
            revision: committed.revision,
            targetName: basename(target),
            exportId,
          } as ProjectValues[Method];
        } catch (error) {
          if (targetTransaction) {
            if (error instanceof ProjectError && error.code === "PROJECT_SAVE_FAILED") {
              throw new ProjectError(
                "EXPORT_COMMIT_UNKNOWN",
                "项目快照提交状态未知，导出文件已保留，请重新打开项目核对",
                { cause: error },
              );
            }
            await targetTransaction.rollback();
          }
          if (
            publishedBlob &&
            !(error instanceof ProjectError && error.code === "EXPORT_COMMIT_UNKNOWN")
          )
            await this.assetService.discardPublishedBlob(publishedBlob);
          if (error instanceof MediaError)
            throw new ProjectError(error.code as ProjectErrorCode, "导出未完成");
          throw error;
        } finally {
          if (staged) await this.assetService.discard(staged);
          await rm(temporaryTarget, { force: true }).catch(() => undefined);
          await rm(sourceDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      case "listJobs":
      case "submitJob":
      case "submitJobs":
      case "cancelJob":
      case "recheckJob":
      case "canvasAgent": {
        const handle = String(input.projectHandle);
        if (this.closing.has(handle)) throw new ProjectError("PROJECT_CLOSED", "项目正在关闭");
        return this.coordinator.withStore(id, handle, async (store) => {
          switch (method) {
            case "listJobs":
              return this.generation.list(store) as ProjectValues[Method];
            case "submitJob": {
              const { operationId, generation } = request as ProjectRequest<"submitJob">;
              return (
                await this.generation.submit(store, [{ id: operationId, input: generation }])
              )[0] as ProjectValues[Method];
            }
            case "submitJobs": {
              const { entries } = request as ProjectRequest<"submitJobs">;
              if (new Set(entries.map(({ id }) => id)).size !== entries.length)
                throw new ProjectError("VALIDATION_FAILED", "批量生成任务编号重复");
              return (await this.generation.submit(store, entries)) as ProjectValues[Method];
            }
            case "cancelJob":
              return (await this.generation.cancel(
                store,
                String(input.jobId),
              )) as ProjectValues[Method];
            case "recheckJob":
              return (await this.generation.recheck(
                store,
                String(input.jobId),
              )) as ProjectValues[Method];
            case "canvasAgent": {
              const { action } = request as ProjectRequest<"canvasAgent">;
              const result = await (await this.settings()).agent.runCanvas(
                this.canvasAgent.key(store),
                action,
              );
              if (action.method !== "exportDiagnostics") return result as ProjectValues[Method];
              const file = await dialog.showSaveDialog(window, {
                title: "导出小灵运行诊断",
                defaultPath: "link-studio-agent-diagnostics.json",
                filters: [{ name: "JSON", extensions: ["json"] }],
              });
              if (file.canceled || !file.filePath)
                return { exported: false } as ProjectValues[Method];
              await writeFile(file.filePath, `${JSON.stringify(result, null, 2)}\n`, {
                mode: 0o600,
                flag: "wx",
              });
              return { exported: true } as ProjectValues[Method];
            }
          }
          throw new ProjectError("VALIDATION_FAILED", "无效的项目任务请求");
        });
      }
      case "selectProject":
      case "selectProjectParent": {
        const testParent = process.env.LINK_STUDIO_TEST_PROJECT_PARENT;
        const result =
          testParent && method === "selectProjectParent"
            ? { canceled: false, filePaths: [testParent] }
            : await dialog.showOpenDialog(window, {
                properties: ["openDirectory", "createDirectory"],
                title: method === "selectProject" ? "选择 Link Studio 项目" : "选择项目存放位置",
              });
        if (result.canceled || !result.filePaths[0])
          return { cancelled: true } as ProjectValues[Method];
        const purpose = method === "selectProject" ? "open" : "create";
        const directoryToken = await this.coordinator.grantProjectDirectory(
          id,
          result.filePaths[0],
          purpose,
        );
        return (
          method === "selectProject"
            ? { cancelled: false, directoryToken }
            : { cancelled: false, directoryToken, displayPath: result.filePaths[0] }
        ) as ProjectValues[Method];
      }
      case "create": {
        const session = await this.coordinator.create(
          id,
          input.directoryToken as string,
          input.operationId as string,
          input.name as string,
        );
        const project = this.coordinator.getSession(id, session.projectHandle);
        this.startProjectWork(id, session.projectHandle);
        const directory = await this.directoryForHandle(id, session.projectHandle);
        await this.recordRecent({ ...project, directory });
        return session as ProjectValues[Method];
      }
      case "open": {
        const result = await this.coordinator.open(id, input.directoryToken as string);
        if (result.disposition === "opened") {
          this.startProjectWork(id, result.session.projectHandle);
          const directory = await this.directoryForHandle(id, result.session.projectHandle);
          await this.recordRecent({ ...result.session, directory });
        }
        return result as ProjectValues[Method];
      }
      case "listRecent":
        await this.loadRecents();
        return {
          projects: this.recents.map(({ directory: _directory, ...entry }) => entry),
        } as ProjectValues[Method];
      case "openRecent": {
        const recent = this.recents.find((entry) => entry.recentEntryId === input.recentEntryId);
        if (!recent) throw new ProjectError("PROJECT_PATH_DENIED", "最近项目入口已失效");
        const directoryToken = await this.coordinator.authorizeRecent(id, recent.directory);
        const result = await this.coordinator.open(id, directoryToken);
        if (result.disposition === "opened") {
          this.startProjectWork(id, result.session.projectHandle);
          await this.recordRecent({ ...result.session, directory: recent.directory });
        }
        return result as ProjectValues[Method];
      }
      case "removeRecent":
        this.recents = this.recents.filter((entry) => entry.recentEntryId !== input.recentEntryId);
        await this.persistRecents();
        return { removed: true } as ProjectValues[Method];
      case "getState":
        return (await this.coordinator.getState(
          id,
          input.projectHandle as string,
        )) as ProjectValues[Method];
      case "getCanvas": {
        return this.coordinator.withStore(
          id,
          input.projectHandle as string,
          async (store) => (await store.readCanvas()) as ProjectValues[Method],
        );
      }
      case "applyCanvasOperations": {
        const { operations, expectedCanvasRevision, operationId } =
          request as ProjectRequest<"applyCanvasOperations">;
        return this.coordinator.withStore(
          id,
          input.projectHandle as string,
          async (store) =>
            (await store.applyCanvasOperations({
              operations,
              expectedCanvasRevision,
              operationId,
            })) as ProjectValues[Method],
        );
      }
      case "rename": {
        const result = await this.coordinator.rename(id, input as never);
        const directory = await this.directoryForHandle(id, input.projectHandle as string);
        await this.recordRecent({
          ...this.coordinator.getSession(id, input.projectHandle as string),
          directory,
        });
        return result as ProjectValues[Method];
      }
      case "flush":
        return (await this.coordinator.flush(
          id,
          input.projectHandle as string,
        )) as ProjectValues[Method];
      case "close": {
        const projectHandle = input.projectHandle as string;
        this.coordinator.getSession(id, projectHandle);
        this.closing.add(projectHandle);
        try {
          await this.stopImports(id, projectHandle);
          await this.stopProjectWork(projectHandle);
          await this.coordinator.close(id, projectHandle);
        } finally {
          this.closing.delete(projectHandle);
          for (const [token, grant] of this.fileGrants) {
            if (grant.owner === id && grant.projectHandle === projectHandle)
              await this.discardFileGrant(token);
          }
          for (const [token, grant] of this.previews) {
            if (grant.owner === id && grant.projectHandle === projectHandle)
              this.previews.delete(token);
          }
        }
        return { closed: true } as ProjectValues[Method];
      }
      case "selectMedia": {
        const projectHandle = input.projectHandle as string;
        this.coordinator.getSession(id, projectHandle);
        const testFiles = process.env.LINK_STUDIO_TEST_MEDIA_FILES?.split("\n").filter(Boolean);
        const selected = testFiles
          ? { canceled: false, filePaths: input.multiSelect ? testFiles : testFiles.slice(0, 1) }
          : await dialog.showOpenDialog(window, {
              properties: input.multiSelect ? ["openFile", "multiSelections"] : ["openFile"],
              filters: [
                {
                  name: "媒体文件",
                  extensions: [
                    "png",
                    "jpg",
                    "jpeg",
                    "webp",
                    "mp4",
                    "mov",
                    "webm",
                    "mp3",
                    "wav",
                    "m4a",
                    "ogg",
                  ],
                },
              ],
            });
        if (selected.canceled) return { cancelled: true } as ProjectValues[Method];
        return this.coordinator.withStore(id, projectHandle, async () => {
          if (this.fileGrants.size + selected.filePaths.length > 32)
            throw new ProjectError("ASSET_SIZE_LIMIT", "请先完成或取消现有媒体导入");
          const files = [];
          try {
            for (const path of selected.filePaths) {
              const handle = await open(
                path,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              );
              if (this.windows.get(id) !== window) {
                await handle.close();
                throw new ProjectError("PROJECT_PATH_DENIED", "窗口授权已失效");
              }
              const token = randomUUID();
              const displayName = basename(path);
              this.putFileGrant(token, {
                owner: id,
                projectHandle,
                displayName,
                path,
                handle,
                expiresAt: Date.now() + 600_000,
              });
              files.push({ fileToken: token, displayName });
            }
          } catch (cause) {
            await Promise.all(files.map(({ fileToken }) => this.discardFileGrant(fileToken)));
            if (cause instanceof ProjectError) throw cause;
            throw new ProjectError("ASSET_READ_FAILED", "无法读取选中的媒体文件", { cause });
          }
          return { cancelled: false, files } as ProjectValues[Method];
        });
      }
      case "discardMedia": {
        const token = input.fileToken as string;
        const grant = this.fileGrants.get(token);
        if (grant?.owner === id && grant.projectHandle === input.projectHandle)
          await this.discardFileGrant(token);
        return { discarded: true } as ProjectValues[Method];
      }
      case "startImport":
        return this.startImport(
          id,
          request as ProjectRequest<"startImport">,
        ) as ProjectValues[Method];
      case "getImport":
      case "cancelImport":
      case "commitImport": {
        const job = this.imports.get(input.importSessionId as string);
        if (method === "commitImport") {
          const { projectHandle, importSessionId, operationId, expectedRevision, choice } =
            request as ProjectRequest<"commitImport">;
          const hash = contentHash({
            kind: "import-commit",
            importSessionId,
            expectedRevision,
            choice: choice ?? null,
          });
          const store = this.coordinator.getStore(id, projectHandle);
          const prior = store.replayAssetImport(operationId, hash);
          if (prior)
            return {
              ...prior,
              phase: "imported",
              copiedBytes: prior.asset.sizeBytes,
              totalBytes: prior.asset.sizeBytes,
            } as ProjectValues[Method];
          if (!job || job.owner !== id || job.projectHandle !== projectHandle)
            throw new ProjectError("TOKEN_INVALID_OR_EXPIRED", "导入会话已失效");
          if (job.commit?.operationId === operationId) {
            if (job.commit.requestHash !== hash)
              throw new ProjectError("OPERATION_ID_REUSED", "操作标识已用于其他请求");
            await job.work;
            return job.status as ProjectValues[Method];
          }
          if (!job.staged || !["duplicate", "conflict"].includes(job.status.phase))
            throw new ProjectError("PROJECT_CONFLICT", "导入会话当前不可提交");
          job.commit = { operationId, requestHash: hash };
          await this.finishImport(job, expectedRevision, operationId, hash, choice);
          return job.status as ProjectValues[Method];
        }
        if (!job || job.owner !== id || job.projectHandle !== input.projectHandle)
          throw new ProjectError("TOKEN_INVALID_OR_EXPIRED", "导入会话已失效");
        if (method === "cancelImport") await this.cancelJob(job);
        return job.status as ProjectValues[Method];
      }
      case "importAsset": {
        const { projectHandle, fileToken, operationId, expectedRevision, choice } =
          request as ProjectRequest<"importAsset">;
        return this.coordinator.withStore(id, projectHandle, async (store) => {
          const requestHash = contentHash({
            kind: "asset-import",
            fileToken,
            expectedRevision,
            choice: choice ?? null,
          });
          const previous = store.replayAssetImport(operationId, requestHash);
          if (previous) return previous as ProjectValues[Method];
          const grant = this.fileGrants.get(fileToken);
          if (
            !grant ||
            grant.owner !== id ||
            grant.projectHandle !== projectHandle ||
            grant.expiresAt <= Date.now()
          )
            throw new ProjectError("TOKEN_INVALID_OR_EXPIRED", "请重新选择媒体文件");
          if (store.snapshot.revision !== expectedRevision)
            throw new ProjectError("PROJECT_CONFLICT", "项目修订号已变化，请刷新后重试");
          this.takeFileGrant(fileToken);
          try {
            const imported = await this.assetService.importCopy(
              store,
              grant.handle,
              grant.displayName,
              operationId,
              choice,
            );
            if (imported.kind === "duplicate") {
              if (this.windows.get(id) === window && grant.expiresAt > Date.now())
                this.putFileGrant(fileToken, grant);
              return {
                duplicate: true,
                candidateAssetIds: imported.candidateAssetIds,
                revision: imported.revision,
              } as ProjectValues[Method];
            }
            return (await store.commitAsset({
              operationId,
              expectedRevision,
              requestHash,
              ...(imported.kind === "reused"
                ? { reuseAssetId: imported.asset.assetId }
                : { asset: imported.asset }),
            })) as ProjectValues[Method];
          } finally {
            if (!this.fileGrants.has(fileToken)) await grant.handle.close().catch(() => undefined);
          }
        });
      }
      case "listAssets": {
        const store = this.coordinator.getStore(id, input.projectHandle as string);
        const assets = Object.values(store.snapshot.assets).filter(
          (asset) => asset.availability !== "deleted",
        );
        const result = [];
        for (const asset of assets) {
          const available = await this.assetFiles.available(store, asset);
          result.push({ ...asset, availability: available ? "ready" : "missing" });
        }
        return {
          assets: result,
        } as ProjectValues[Method];
      }
      case "getAssetPreview": {
        const { projectHandle, assetId } = request as ProjectRequest<"getAssetPreview">;
        const store = this.coordinator.getStore(id, projectHandle);
        const asset = store.snapshot.assets[assetId];
        if (!asset || asset.availability === "deleted")
          throw new ProjectError("ASSET_NOT_FOUND", "素材不可用");
        const { handle, stamp } = await this.assetFiles.inspect(store, asset, true);
        await handle.close();
        this.coordinator.getSession(id, projectHandle);
        for (const [token, grant] of this.previews) {
          if (grant.expiresAt <= Date.now()) {
            this.previews.delete(token);
          } else if (
            grant.owner === id &&
            grant.assetId === assetId &&
            grant.projectHandle === projectHandle
          ) {
            if (grant.stamp === stamp) {
              grant.expiresAt = Date.now() + 600_000;
              return {
                url: `link-media://preview/${token}`,
                mimeType: asset.mimeType,
              } as ProjectValues[Method];
            }
            this.previews.delete(token);
          }
        }
        if (this.previews.size >= 128)
          throw new ProjectError("ASSET_SIZE_LIMIT", "预览授权数量已达上限");
        const token = randomUUID();
        this.previews.set(token, {
          owner: id,
          projectHandle,
          assetId,
          stamp,
          expiresAt: Date.now() + 600_000,
        });
        return {
          url: `link-media://preview/${token}`,
          mimeType: asset.mimeType,
        } as ProjectValues[Method];
      }
      case "inspectAsset": {
        const { projectHandle, assetId, timeMs } = request as ProjectRequest<"inspectAsset">;
        const store = this.coordinator.getStore(id, projectHandle);
        const asset = store.snapshot.assets[assetId];
        if (!asset || asset.availability === "deleted")
          throw new ProjectError("ASSET_NOT_FOUND", "素材不可用");
        if (asset.mediaType !== "video")
          throw new ProjectError("VALIDATION_FAILED", "只有视频素材支持提取关键帧");
        const digest = contentHash({ kind: "frame", assetId, timeMs });
        const frameId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const frame = await this.canvasAgent.inspectMedia(
          store,
          asset,
          timeMs,
          frameId,
          mediaSignal,
        );
        return {
          assetId: frame.assetId,
          mimeType: frame.mime,
          revision: store.snapshot.revision,
        } as ProjectValues[Method];
      }
      case "cancelMediaTool": {
        const { projectHandle, operationId } = request as ProjectRequest<"cancelMediaTool">;
        this.coordinator.getStore(id, projectHandle);
        const media = this.mediaTools.get(projectHandle);
        if (!media || media.operationId !== operationId)
          return { requested: false } as ProjectValues[Method];
        media.abort.abort();
        return { requested: true } as ProjectValues[Method];
      }
      case "trimAsset": {
        const input = request as ProjectRequest<"trimAsset">;
        const store = this.coordinator.getStore(id, input.projectHandle);
        const requestHash = contentHash({
          kind: "asset-trim",
          assetId: input.assetId,
          startMs: input.startMs,
          endMs: input.endMs,
          removeAudio: input.removeAudio,
        });
        const previous = store.replayAssetImport(input.operationId, requestHash);
        if (previous) return previous as ProjectValues[Method];
        const asset = store.snapshot.assets[input.assetId];
        if (!asset || asset.availability === "deleted")
          throw new ProjectError("ASSET_NOT_FOUND", "素材不可用");
        if (input.expectedRevision !== store.snapshot.revision)
          throw new ProjectError("PROJECT_CONFLICT", "项目已更新，请重新读取后裁切");
        const signal = mediaSignal ?? new AbortController().signal;
        let staged: StagedAsset | undefined;
        try {
          staged = await this.canvasAgent.trimMedia(
            store,
            asset,
            input.operationId,
            input.startMs,
            input.endMs,
            input.removeAudio,
            signal,
          );
          await this.assetService.publishBlob(store, staged, signal);
          const result = await store.commitAsset({
            operationId: input.operationId,
            expectedRevision: input.expectedRevision,
            requestHash,
            asset: staged.asset,
            signal,
          });
          return result as ProjectValues[Method];
        } finally {
          if (staged) await this.assetService.discard(staged);
        }
      }
      case "splitAsset": {
        const input = request as ProjectRequest<"splitAsset">;
        const store = this.coordinator.getStore(id, input.projectHandle);
        const requestHash = contentHash({
          kind: "asset-split",
          assetId: input.assetId,
          rows: input.rows,
          columns: input.columns,
          ...(input.xLines ? { xLines: input.xLines } : {}),
          ...(input.yLines ? { yLines: input.yLines } : {}),
        });
        const previous = store.replayAssetBatch(input.operationId, requestHash);
        if (previous) return previous as ProjectValues[Method];
        const asset = store.snapshot.assets[input.assetId];
        if (!asset || asset.availability === "deleted")
          throw new ProjectError("ASSET_NOT_FOUND", "素材不可用");
        if (input.expectedRevision !== store.snapshot.revision)
          throw new ProjectError("PROJECT_CONFLICT", "项目已更新，请重新读取后拆图");
        const signal = mediaSignal ?? new AbortController().signal;
        let staged: StagedAsset[] = [];
        try {
          staged = await this.canvasAgent.splitMedia(
            store,
            asset,
            input.operationId,
            input.rows,
            input.columns,
            signal,
            { x: input.xLines, y: input.yLines },
          );
          for (const item of staged) await this.assetService.publishBlob(store, item, signal);
          const result = await store.commitAssets({
            operationId: input.operationId,
            expectedRevision: input.expectedRevision,
            requestHash,
            assets: staged.map(({ asset: item }) => item),
            signal,
          });
          return result as ProjectValues[Method];
        } finally {
          await Promise.all(staged.map((item) => this.assetService.discard(item)));
        }
      }
      case "annotateAsset": {
        const input = request as ProjectRequest<"annotateAsset">;
        const store = this.coordinator.getStore(id, input.projectHandle);
        const pngHash = contentHash(input.pngData);
        const requestHash = contentHash({
          kind: "asset-annotate",
          assetId: input.assetId,
          pngHash,
          ...(input.purpose ? { purpose: input.purpose } : {}),
        });
        const previous = store.replayAssetImport(input.operationId, requestHash);
        if (previous) return previous as ProjectValues[Method];
        const asset = store.snapshot.assets[input.assetId];
        if (!asset || asset.availability === "deleted" || asset.mediaType !== "image")
          throw new ProjectError("ASSET_NOT_FOUND", "只有可用的图片素材支持涂鸦标注");
        if (input.expectedRevision !== store.snapshot.revision)
          throw new ProjectError("PROJECT_CONFLICT", "项目已更新，请重新读取后保存标注");
        const signal = mediaSignal ?? new AbortController().signal;
        let staged: StagedAsset | undefined;
        try {
          staged = await this.canvasAgent.annotateMedia(
            store,
            asset,
            input.operationId,
            input.pngData,
            signal,
            input.purpose,
          );
          await this.assetService.publishBlob(store, staged, signal);
          const result = await store.commitAsset({
            operationId: input.operationId,
            expectedRevision: input.expectedRevision,
            requestHash,
            asset: staged.asset,
            signal,
          });
          return result as ProjectValues[Method];
        } finally {
          if (staged) await this.assetService.discard(staged);
        }
      }
      case "relocateAsset": {
        const { projectHandle, assetId, fileToken } = request as ProjectRequest<"relocateAsset">;
        return this.coordinator.withStore(id, projectHandle, async (store) => {
          const asset = store.snapshot.assets[assetId];
          if (!asset || asset.availability === "deleted" || asset.storage.kind !== "external")
            throw new ProjectError("ASSET_NOT_FOUND", "外部素材不可用");
          const grant = this.claimFileGrant(id, projectHandle, fileToken);
          try {
            await this.assetFiles.bind(store, asset, grant.path, grant.handle);
            return { revision: store.snapshot.revision } as ProjectValues[Method];
          } finally {
            await grant.handle.close();
          }
        });
      }
      case "removeAsset": {
        return this.coordinator.withStore(id, input.projectHandle as string, async (store) => {
          const receipt = await store.removeAsset({
            operationId: input.operationId as string,
            expectedRevision: input.expectedRevision as number,
            assetId: input.assetId as string,
          });
          for (const [token, grant] of this.previews) {
            if (
              grant.owner === id &&
              grant.projectHandle === input.projectHandle &&
              grant.assetId === input.assetId
            )
              this.previews.delete(token);
          }
          return { removed: true, revision: receipt.revision } as ProjectValues[Method];
        });
      }
      default:
        throw new ProjectError("PROJECT_SCHEMA_INVALID", "不支持的项目操作");
    }
  }

  private claimFileGrant(owner: number, projectHandle: string, token: string) {
    if (this.closing.has(projectHandle)) throw new ProjectError("PROJECT_CLOSED", "项目正在关闭");
    const grant = this.fileGrants.get(token);
    if (
      !grant ||
      grant.owner !== owner ||
      grant.projectHandle !== projectHandle ||
      grant.expiresAt <= Date.now()
    )
      throw new ProjectError("TOKEN_INVALID_OR_EXPIRED", "请重新选择媒体文件");
    this.takeFileGrant(token);
    return grant;
  }

  private startImport(owner: number, input: ProjectRequest<"startImport">) {
    const { projectHandle, operationId, expectedRevision, fileToken, importMode = "copy" } = input;
    const store = this.coordinator.getStore(owner, projectHandle);
    if (this.closing.has(projectHandle)) throw new ProjectError("PROJECT_CLOSED", "项目正在关闭");
    const requestHash = contentHash({
      kind: "import-start",
      fileToken,
      expectedRevision,
      importMode,
    });
    const existing = [...this.imports.values()].find(
      (job) => job.projectHandle === projectHandle && job.operationId === operationId,
    );
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ProjectError("OPERATION_ID_REUSED", "操作标识已用于其他请求");
      return { importSessionId: existing.id };
    }
    const prior = store.replayAssetImport(operationId, requestHash);
    if (this.imports.size >= 128) {
      const oldest = [...this.imports.values()].find(({ status }) =>
        ["imported", "failed", "cancelled"].includes(status.phase),
      );
      if (oldest) {
        clearTimeout(oldest.expiry);
        this.imports.delete(oldest.id);
      }
    }
    if (
      this.imports.size >= 128 ||
      [...this.imports.values()].filter((job) => job.projectHandle === projectHandle && job.grant)
        .length >= 2
    )
      throw new ProjectError("ASSET_SIZE_LIMIT", "请先完成现有导入");
    const job: ImportJob = {
      id: randomUUID(),
      owner,
      projectHandle,
      requestHash,
      operationId,
      mode: importMode,
      abort: new AbortController(),
      status: prior
        ? {
            phase: "imported",
            ...prior,
            copiedBytes: prior.asset.sizeBytes,
            totalBytes: prior.asset.sizeBytes,
          }
        : { phase: "copying", copiedBytes: 0, totalBytes: 0 },
    };
    if (!prior) job.grant = this.claimFileGrant(owner, projectHandle, fileToken);
    this.imports.set(job.id, job);
    this.scheduleExpiry(job);
    if (job.grant) job.work = this.stageImport(job, store, job.grant, expectedRevision);
    return { importSessionId: job.id };
  }

  private async stageImport(
    job: ImportJob,
    store: ProjectStore,
    grant: FileGrant,
    expectedRevision: number,
  ) {
    try {
      job.staged = await this.assetService.stage(
        store,
        grant.handle,
        grant.displayName,
        job.operationId,
        {
          signal: job.abort.signal,
          onProgress: (copiedBytes, totalBytes) => {
            job.status = { phase: "copying", copiedBytes, totalBytes };
          },
        },
      );
      if (job.mode === "reference") {
        job.staged.asset.importMode = "reference";
        job.staged.asset.storage = { kind: "external", locatorId: randomUUID() };
      }
      await this.commitJob(job, expectedRevision, job.operationId, job.requestHash);
    } catch (error) {
      await this.failImport(job, error);
    }
  }

  private async finishImport(
    job: ImportJob,
    revision: number,
    operationId: string,
    hash: string,
    choice?: "reuse" | "independent",
  ) {
    job.work = this.commitJob(job, revision, operationId, hash, choice).catch((error) =>
      this.failImport(job, error),
    );
    await job.work;
  }

  private async commitJob(
    job: ImportJob,
    expectedRevision: number,
    operationId: string,
    requestHash: string,
    choice?: "reuse" | "independent",
  ) {
    const { staged, grant } = job;
    if (!staged || !grant) return;
    job.abort.signal.throwIfAborted();
    const { copiedBytes, totalBytes } = job.status;
    job.status = { phase: "committing", copiedBytes, totalBytes };
    await this.coordinator.withStore(job.owner, job.projectHandle, async (store) => {
      job.abort.signal.throwIfAborted();
      const previous = store.replayAssetImport(operationId, requestHash);
      if (previous) {
        await this.cleanJob(job);
        job.status = { phase: "imported", ...previous, copiedBytes, totalBytes };
        return;
      }
      const state = store.snapshot;
      if (state.revision !== expectedRevision) {
        job.status = { phase: "conflict", copiedBytes, totalBytes };
        return;
      }
      const candidates = [];
      for (const candidate of copyCandidates(state, staged.asset)) {
        if (await this.assetFiles.available(store, candidate)) candidates.push(candidate);
      }
      job.abort.signal.throwIfAborted();
      if (candidates.length && !choice) {
        job.status = {
          phase: "duplicate",
          candidateAssetIds: candidates.map(({ assetId }) => assetId),
          copiedBytes,
          totalBytes,
        };
        return;
      }
      const reuse = choice === "reuse" ? candidates[0] : undefined;
      if (choice === "reuse" && !reuse) {
        job.status = { phase: "conflict", copiedBytes, totalBytes };
        return;
      }
      if (job.mode === "copy") await this.assetService.publishBlob(store, staged, job.abort.signal);
      else if (!reuse)
        await this.assetFiles.bind(store, staged.asset, grant.path, grant.handle, job.abort.signal);
      job.abort.signal.throwIfAborted();
      const result = await store.commitAsset({
        operationId,
        expectedRevision,
        requestHash,
        signal: job.abort.signal,
        ...(reuse ? { reuseAssetId: reuse.assetId } : { asset: staged.asset }),
      });
      await this.cleanJob(job);
      job.status = { phase: "imported", ...result, copiedBytes, totalBytes };
    });
  }

  private async failImport(job: ImportJob, error: unknown) {
    await this.cleanJob(job);
    const { copiedBytes, totalBytes } = job.status;
    job.status =
      job.abort.signal.aborted &&
      !(error instanceof ProjectError && error.code === "PROJECT_SAVE_FAILED")
        ? { phase: "cancelled", copiedBytes, totalBytes }
        : {
            phase: "failed",
            copiedBytes,
            totalBytes,
            code: error instanceof ProjectError ? error.code : "PROJECT_SAVE_FAILED",
          };
  }

  private async cleanJob(job: ImportJob) {
    const { staged, grant } = job;
    job.staged = undefined;
    job.grant = undefined;
    if (staged) await this.assetService.discard(staged);
    await grant?.handle.close().catch(() => undefined);
    if (this.imports.has(job.id)) this.scheduleExpiry(job);
  }

  private scheduleExpiry(job: ImportJob) {
    clearTimeout(job.expiry);
    job.expiry = setTimeout(() => {
      void this.cancelJob(job)
        .finally(() => {
          clearTimeout(job.expiry);
          this.imports.delete(job.id);
        })
        .catch(() => undefined);
    }, 600_000);
    job.expiry.unref();
  }

  private async cancelJob(job: ImportJob) {
    job.abort.abort();
    await job.work;
    if (["duplicate", "conflict"].includes(job.status.phase)) await this.failImport(job, undefined);
  }

  private async stopImports(owner: number, projectHandle?: string) {
    await Promise.all(
      [...this.imports.values()]
        .filter(
          (job) => job.owner === owner && (!projectHandle || projectHandle === job.projectHandle),
        )
        .map(async (job) => {
          this.imports.delete(job.id);
          clearTimeout(job.expiry);
          await this.cancelJob(job);
        }),
    );
  }

  private putFileGrant(token: string, grant: FileGrant) {
    grant.expiry = setTimeout(
      () => void this.discardFileGrant(token),
      grant.expiresAt - Date.now(),
    );
    grant.expiry.unref();
    this.fileGrants.set(token, grant);
  }

  private takeFileGrant(token: string) {
    const grant = this.fileGrants.get(token);
    if (grant) clearTimeout(grant.expiry);
    this.fileGrants.delete(token);
    return grant;
  }

  private async discardFileGrant(token: string) {
    await this.takeFileGrant(token)
      ?.handle.close()
      .catch(() => undefined);
  }

  private async directoryForHandle(windowId: number, handle: string) {
    return this.coordinator.getDirectory(windowId, handle);
  }

  private async recordRecent(session: { projectId: string; name: string; directory: string }) {
    const canonical = await import("node:fs/promises").then(({ realpath }) =>
      realpath(session.directory),
    );
    const existing = this.recents.find((entry) => entry.directory === canonical);
    const entry: RecentEntry = {
      recentEntryId: existing?.recentEntryId ?? randomUUID(),
      projectId: session.projectId,
      displayName: session.name,
      displayPath: canonical,
      directory: canonical,
      lastOpenedAt: new Date().toISOString(),
    };
    this.recents = [entry, ...this.recents.filter((item) => item.directory !== canonical)].slice(
      0,
      30,
    );
    await this.persistRecents();
  }

  private async loadRecents() {
    if (this.recentsLoaded) return;
    if (!this.loadingRecents) {
      this.loadingRecents = readFile(this.recentFile, "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => [])
        .then((loaded) => {
          if (Array.isArray(loaded))
            this.recents = loaded
              .filter(
                (entry): entry is RecentEntry =>
                  entry &&
                  typeof entry === "object" &&
                  typeof entry.recentEntryId === "string" &&
                  typeof entry.projectId === "string" &&
                  typeof entry.displayName === "string" &&
                  typeof entry.directory === "string" &&
                  typeof entry.lastOpenedAt === "string",
              )
              .slice(0, 30);
          this.recentsLoaded = true;
        });
    }
    await this.loadingRecents;
  }

  private persistRecents() {
    const action = async () => {
      await mkdir(dirname(this.recentFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.recentFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.recents), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.recentFile);
    };
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
