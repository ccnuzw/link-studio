import { execFile } from "node:child_process";
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
import { basename, dirname, extname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  app,
  type BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  ipcMain,
  Notification,
} from "electron";
import { canvasNoticeTitle } from "../../../packages/link-studio-core/src/agent-notice.ts";
import { canvasAgentMediaModels } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import {
  dramaAgentModels,
  dramaVideoModelIssue,
} from "../../../packages/link-studio-core/src/drama.ts";
import { dramaImageFields } from "../../../packages/link-studio-core/src/drama-image-params.ts";
import {
  hasAsciiControl,
  sanitizeFileName,
} from "../../../packages/link-studio-core/src/file-name.ts";
import { jobIsTerminal } from "../../../packages/link-studio-core/src/generation.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import type {
  ImportStatus,
  ProjectErrorCode,
  ProjectMethod,
  ProjectRequest,
  ProjectValues,
  RecentProject,
} from "../../../packages/link-studio-core/src/projects-api.ts";
import {
  ProjectChannels,
  ProjectRequests,
  projectImportConcurrency,
} from "../../../packages/link-studio-core/src/projects-api.ts";
import { MediaComposer } from "../../../packages/media-runtime/src/composition.ts";
import { MediaError } from "../../../packages/media-runtime/src/process.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import officialVoices from "../../renderer/settings/official-voices.json" with { type: "json" };
import { isTrustedDocument } from "../security.ts";
import type { SettingsIpc } from "../settings/ipc.ts";
import { imagePreviewBlob } from "../settings/trial-media.ts";
import { SkillLibrary } from "../skills/library.ts";
import {
  AssetFiles,
  type AssetRecord,
  type MediaLocation,
  readOnly,
  servePreview,
  verifyContent,
} from "./asset-files.ts";
import { AssetService, copyCandidates, type StagedAsset } from "./assets.ts";
import { CanvasAgentService } from "./canvas-agent.ts";
import { CanvasClipboardMedia } from "./canvas-clipboard.ts";
import { CanvasMedia } from "./canvas-media.ts";
import { ProjectCoordinator, type WindowLease } from "./coordinator.ts";
import { attachDirectorTake } from "./director-take.ts";
import {
  addDramaEpisode,
  addDramaSegment,
  chooseDramaTake,
  createDrama,
  deleteDramaEpisode,
  deleteDramaSegment,
  dramaDocument,
  editDramaField,
  reorderDramaSegments,
  saveDramaScript,
  setDramaSegmentPrompt,
  setDramaSegmentSeconds,
  updateDramaBoardSettings,
} from "./drama.ts";
import { adaptDramaSegment } from "./drama-adaptation.ts";
import { DramaDrafts, expiredDramaSource } from "./drama-drafts.ts";
import {
  estimateDramaJob,
  estimateDramaSource,
  quoteDramaContinuation,
  quoteDramaSource,
} from "./drama-estimate.ts";
import { dramaImageModels } from "./drama-image-models.ts";
import { storyboardClearHash, submitApprovedDramaJob } from "./drama-job.ts";
import { controlDramaPlanning, extendDramaPlanning } from "./drama-planning.ts";
import { preflightDramaSource } from "./drama-source.ts";
import { contentHash } from "./encoding.ts";
import { CanvasGenerationFeedback, ProjectError } from "./errors.ts";
import { type ExportTargetTransaction, installExportTarget } from "./export-target.ts";
import { FilingHistory, type HistoryCursor } from "./filing-history.ts";
import { activeMediaJobCount, GenerationService } from "./generation.ts";
import { PersonalLibrary } from "./personal-library.ts";
import type { ProjectStore } from "./store.ts";

interface RecentEntry {
  projectKind?: "canvas" | "drama";
  recentEntryId: string;
  projectId: string;
  displayName: string;
  displayPath: string;
  directory: string;
  lastOpenedAt: string;
}

const mediaFilters = {
  image: { name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] },
  video: { name: "视频", extensions: ["mp4", "mov", "webm"] },
  audio: { name: "音频", extensions: ["mp3", "wav", "m4a", "ogg"] },
};

interface ImportJob {
  forCanvasUpload?: boolean;
  forLibrary?: boolean;
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
  library?: boolean;
  owner: number;
  projectHandle: string;
  assetId: string;
  stamp: string;
  expiresAt: number;
}

interface FileGrant {
  clipboard?: { size: number; received: number; kind: "image" | "video" | "audio" };
  owner: number;
  projectHandle: string;
  displayName: string;
  path: string;
  handle: FileHandle;
  expiresAt: number;
  expiry?: ReturnType<typeof setTimeout>;
}

interface FilingUploads {
  session: string;
  abort: AbortController;
  active: Map<string, AbortController>;
  receipts: Map<string, string>;
  destinations: Map<string, string | undefined>;
}

interface FilingPage {
  historyCursor?: HistoryCursor;
  carryOrigin?: { project: string; asset: string; sha256: string; choice: string };
  history?: ProjectRequest<"filingLibraryPage">["history"];
  page: string;
  channel: string;
  revision: number;
  folder?: string;
  search?: string;
  next?: number;
  choices: Map<string, string>;
  tokens: Map<string, string>;
  expires: number;
  abort: AbortController;
  uploads: FilingUploads;
}

function filingChoice(grant: FilingPage, assetId: string) {
  const choice = grant.tokens.get(assetId) ?? randomUUID();
  grant.choices.set(choice, assetId);
  grant.tokens.set(assetId, choice);
  return choice;
}

export class ProjectIpc {
  private readonly coordinator = new ProjectCoordinator();
  private readonly windows = new Map<number, BrowserWindow>();
  private readonly noticeScopes = new Map<number, { handle: string; hidden: boolean }>();
  private readonly notices = new Map<number, { handle: string; notice: Notification }>();
  private libraryChanged() {
    for (const window of this.windows.values())
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("link-studio:library:changed");
  }
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
  private readonly clipboardMedia: CanvasClipboardMedia;
  private readonly library: PersonalLibrary;
  private readonly globalImports = new Map<number, Map<string, AbortController>>();
  private readonly filingHistory: FilingHistory;
  private async globalMedia(library: "history" | "personal", assetId: string) {
    if (library === "personal") {
      const asset = await this.library.filingSelection(assetId);
      return asset && { asset, location: this.library };
    }
    const history = await this.filingHistory.lookup(`history:${assetId}`);
    return history && { asset: history.asset, location: history.canvas };
  }
  private readonly dramaDrafts: DramaDrafts;
  private readonly composer: MediaComposer;
  private readonly canvasMedia: CanvasMedia;
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
  private readonly filingPages = new Map<number, FilingPage>();
  private closeFilingPage(owner: number) {
    const grant = this.filingPages.get(owner);
    grant?.abort.abort();
    grant?.uploads.abort.abort();
    this.filingPages.delete(owner);
  }
  private filingPageGrant(owner: number, page: string) {
    const grant = this.filingPages.get(owner);
    if (
      !grant ||
      grant.page !== page ||
      grant.expires <= Date.now() ||
      this.hasForegroundProject(owner)
    )
      throw new ProjectError("ASSET_NOT_FOUND", "图片选择已失效，请重新选择");
    return grant;
  }
  private filingSession(owner: number, session: string) {
    const grant = this.filingPages.get(owner);
    if (!grant || grant.uploads.session !== session)
      throw new ProjectError("ASSET_NOT_FOUND", "上传窗口已关闭");
    return this.filingPageGrant(owner, grant.page);
  }
  private readonly closing = new Set<string>();
  private readonly pendingCanvas = new Set<number>();
  private readonly closingWindows = new Set<number>();
  private quitting = false;
  private confirmingQuit = false;
  private resumeAfterQuit = false;
  private readonly activityCache = new WeakMap<
    ProjectStore,
    { revision: number; activity?: RecentProject["activity"] }
  >();
  private reapTimer?: NodeJS.Timeout;
  private readonly windowReleases = new Set<Promise<void>>();

  private activity(store: ProjectStore) {
    const cached = this.activityCache.get(store);
    if (cached?.revision === store.revision) return cached.activity;
    const state = store.snapshot;
    const doc = dramaDocument(state);
    const jobs =
      doc?.jobs?.filter((job) => job.status === "running" || job.status === "queued") ?? [];
    const plan = doc?.planning;
    const planning = plan?.phase === "running" || !!plan?.pending;
    const media = activeMediaJobCount(state);
    const count = jobs.length + Number(planning) + media;
    const first = jobs.find((job) => job.status === "running") ?? jobs[0];
    const names = {
      scripts: "分集剧本",
      breakdown: "资产拆解",
      asset_prompts: "资产补词",
      storyboard: "分镜脚本",
      compose: "成片合成",
    };
    const activity = count
      ? {
          count,
          label: first
            ? `${names[first.step]}${first.status === "queued" ? "排队中" : "中"}`
            : planning
              ? "小说规划中"
              : "素材生成中",
          progress: first
            ? first.progress
            : planning && plan
              ? Math.floor((100 * plan.cursor) / plan.end)
              : undefined,
        }
      : undefined;
    this.activityCache.set(store, { revision: state.revision, activity });
    return activity;
  }

  private scheduleRelease() {
    if (this.reapTimer) return;
    this.reapTimer = setTimeout(async () => {
      try {
        await this.coordinator.releaseIdle(
          (store) => !!this.activity(store),
          (handle) => this.stopProjectWork(handle),
        );
      } catch {
        console.warn("后台项目暂未释放");
      }
      this.reapTimer = undefined;
      if ([...this.projectOwners.keys()].some((handle) => this.coordinator.isParked(handle)))
        this.scheduleRelease();
    }, 2500);
    this.reapTimer.unref();
  }

  private hasForegroundProject(owner: number) {
    return [...this.projectOwners].some(
      ([handle, entry]) => entry.owner === owner && !this.coordinator.isParked(handle),
    );
  }

  constructor(
    userData: string,
    developmentMediaPath: string,
    private readonly settings: () => ReturnType<SettingsIpc["open"]>,
    private readonly trialMedia: SettingsIpc["trialMedia"],
    private readonly providerRunner: string,
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
    this.clipboardMedia = new CanvasClipboardMedia(this.assetFiles, this.assetService);
    this.library = new PersonalLibrary(
      join(userData, "personal-library"),
      this.assetFiles,
      this.assetService,
    );
    this.filingHistory = new FilingHistory(
      join(userData, "projects", "generated-images.sqlite"),
      this.assetFiles,
      () => this.recents,
    );
    this.dramaDrafts = new DramaDrafts(join(userData, "projects", "drama-drafts.sqlite"));
    this.composer = new MediaComposer({ ffmpeg, ffprobe });
    this.canvasMedia = new CanvasMedia(this.assetFiles, this.assetService, ffmpeg);
    this.generation = new GenerationService(
      async () => (await this.settings()).registry,
      this.assetService,
      this.assetFiles,
    );
    this.canvasAgent = new CanvasAgentService(
      this.generation,
      async () => (await this.settings()).registry,
      this.canvasMedia,
      {
        catalog: (query) => this.skills.agentCatalog(query),
        page: (id, offset, file, pinned) => this.skills.agentPage(id, offset, file, pinned),
      },
    );
    this.register();
    app.on("will-quit", (event) => {
      if (this.windowReleases.size) {
        event.preventDefault();
        void Promise.all([...this.windowReleases]).then(() => app.quit());
        return;
      }
      this.library.close();
      this.filingHistory.close();
      this.dramaDrafts.close();
    });
    app.on("before-quit", (event) => {
      if (this.confirmingQuit) {
        event.preventDefault();
        return;
      }
      const active = this.resumeAfterQuit ? [] : this.activeGeneration();
      const count = this.resumeAfterQuit
        ? 0
        : [...this.projectOwners.values()].reduce(
            (total, { store }) => total + (this.activity(store)?.count ?? 0),
            0,
          );
      if (count) {
        event.preventDefault();
        this.confirmingQuit = true;
        void this.confirmQuit(active, count)
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
    ipcMain.on("link-studio:canvas:noticeScope", (event, handle: unknown, hidden: unknown) => {
      if (typeof hidden !== "boolean" || !this.isWindowSender(event)) return;
      const owner = event.sender.id;
      if (handle === null) this.noticeScopes.delete(owner);
      else if (typeof handle === "string" && this.projectOwners.get(handle)?.owner === owner)
        this.noticeScopes.set(owner, { handle, hidden });
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

  private async confirmQuit(active: ReturnType<ProjectIpc["activeGeneration"]>, count: number) {
    if (
      count > active.length ||
      active.some(({ store }) => store.snapshot.extensions["link-studio:workspace"] === "drama")
    ) {
      const { response } = await dialog.showMessageBox({
        type: "question",
        message: `还有 ${count} 项任务未完成`,
        detail: "退出后本地任务会暂停。下次打开对应项目时，灵可会尝试从已保存的进度恢复。",
        buttons: ["继续后台运行", "保存进度并退出", "暂不退出"],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 1) this.resumeAfterQuit = true;
      if (response === 0) for (const window of this.windows.values()) window.minimize();
      return;
    }
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
        if (url.hostname === "global-assets") {
          const path = /^\/(personal|history)\/([0-9a-f-]{36})$/.exec(url.pathname);
          const active = () =>
            this.windows.get(id) === window &&
            !window.isDestroyed() &&
            isTrustedDocument(window.webContents.getURL(), rendererUrl);
          if (!path || url.search || url.hash || !active())
            return new Response(null, { status: 404 });
          const media = await this.globalMedia(
            path[1] === "history" ? "history" : "personal",
            path[2]!,
          );
          if (!media) return new Response(null, { status: 404 });
          const { location, asset } = media;
          const { handle, stamp } = await this.assetFiles.inspect(location, asset, true);
          await handle.close();
          return await servePreview(request, this.assetFiles, location, asset, stamp, active);
        }
        if (url.hostname === "filing-library") {
          const parts = url.pathname.split("/");
          if (
            request.method !== "GET" ||
            url.search ||
            url.hash ||
            parts.length !== 3 ||
            !parts[1] ||
            !parts[2] ||
            this.windows.get(id) !== window ||
            window.isDestroyed() ||
            !isTrustedDocument(window.webContents.getURL(), rendererUrl)
          )
            return new Response(null, { status: 404 });
          const grant = this.filingPageGrant(id, parts[1]);
          const item = grant.choices.get(parts[2]);
          if (!item) return new Response(null, { status: 404 });
          const { registry } = await this.settings();
          registry.checkFilingLibrary(grant.channel, grant.revision);
          const { bytes, asset } = await this.filingImage(item);
          const blob = imagePreviewBlob(bytes);
          if (blob.type !== asset.mimeType) return new Response(null, { status: 404 });
          this.filingPageGrant(id, parts[1]);
          registry.checkFilingLibrary(grant.channel, grant.revision);
          return new Response(blob, {
            headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          });
        }
        if (
          url.hostname === "trial" &&
          this.windows.get(id) === window &&
          !window.isDestroyed() &&
          isTrustedDocument(window.webContents.getURL(), rendererUrl)
        )
          return this.trialMedia.serve(id, request);
        if (url.hostname !== "preview" || url.search || url.hash)
          return new Response(null, { status: 404 });
        const [token, action, encodedName, ...extra] = url.pathname.slice(1).split("/");
        if (
          !token ||
          (action !== undefined && (action !== "download" || !encodedName || extra.length))
        )
          return new Response(null, { status: 404 });
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
        const asset = grant.library
          ? await this.library.get(grant.assetId)
          : store.snapshot.assets[grant.assetId];
        if (!asset || asset.availability === "deleted") return new Response(null, { status: 404 });
        const downloadName = encodedName && decodeURIComponent(encodedName);
        if (
          downloadName &&
          (downloadName.length > 300 ||
            sanitizeFileName(downloadName) !== downloadName ||
            extname(downloadName).toLowerCase() !== extname(asset.displayName).toLowerCase())
        )
          return new Response(null, { status: 404 });
        const response = await servePreview(
          request,
          this.assetFiles,
          grant.library ? this.library : store,
          asset,
          grant.stamp,
          active,
        );
        const rendererOrigin = new URL(rendererUrl).origin;
        if (response.ok && downloadName)
          response.headers.set(
            "content-disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(downloadName).replace(/['()*]/g, (char) => "%" + char.charCodeAt(0).toString(16))}`,
          );
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
    window.webContents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) {
        this.closeFilingPage(id);
        this.clipboardMedia.forget(id);
      }
    });
    const lease = this.coordinator.registerWindow(id, (activation) => {
      if (!window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (isTrustedDocument(window.webContents.getURL(), rendererUrl)) {
          const directory = this.projectOwners.get(activation.projectHandle)?.store.directory;
          const recentEntryId = this.recents.find(
            (entry) => entry.directory === directory,
          )?.recentEntryId;
          window.webContents.send("link-studio:projects:activate", {
            ...activation,
            recentEntryId,
          });
        }
      }
    });
    this.leases.set(id, lease);
    void this.loadRecents();
    window.on("close", (event) => {
      if (
        !this.quitting &&
        !window.webContents.isCrashed() &&
        [...this.projectOwners.values()].some(
          (entry) => entry.owner === id && this.activity(entry.store),
        )
      ) {
        event.preventDefault();
        queueMicrotask(() => app.quit());
        return;
      }
      if (!this.pendingCanvas.has(id) && !this.closingWindows.has(id)) return;
      if (window.webContents.isCrashed()) return;
      event.preventDefault();
      if (this.closingWindows.has(id)) return;
      this.closingWindows.add(id);
      window.webContents.send("link-studio:canvas:saveBeforeClose");
    });
    window.once("closed", () => {
      for (const task of this.globalImports.get(id)?.values() ?? []) task.abort();
      this.globalImports.delete(id);
      this.clipboardMedia.forget(id);
      this.noticeScopes.delete(id);
      this.clearNotice(id);
      this.closeFilingPage(id);
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
      const release = Promise.all([
        this.stopImports(id),
        ...[...this.projectOwners]
          .filter(([, entry]) => entry.owner === id)
          .map(([handle]) => this.stopProjectWork(handle)),
      ])
        .finally(() => this.coordinator.releaseWindow(id, lease))
        .then(() => undefined)
        .catch(() => undefined);
      this.windowReleases.add(release);
      void release.finally(() => this.windowReleases.delete(release));
    });
  }

  private filingImage(key: string) {
    return key.startsWith("history:")
      ? this.filingHistory.image(key)
      : this.library.filingImage(key);
  }

  private startProjectWork(owner: number, handle: string) {
    this.closeFilingPage(owner);
    if (this.projectOwners.has(handle)) return;
    const store = this.coordinator.getStore(owner, handle);
    this.projectOwners.set(handle, { owner, store });
    this.canvasAgent.attach(store);
    this.generation.start(store);
    void this.settings()
      .then(({ agent, registry }) => {
        store.observeCharacterImages((state) => registry.indexFilingReferences(state));
        return agent.openCanvas(this.canvasAgent.key(store));
      })
      .catch(() => undefined);
  }

  private async stopProjectWork(handle: string) {
    const entry = this.projectOwners.get(handle);
    if (!entry) return;
    this.projectOwners.delete(handle);
    if (this.noticeScopes.get(entry.owner)?.handle === handle)
      this.noticeScopes.delete(entry.owner);
    if (this.notices.get(entry.owner)?.handle === handle) this.clearNotice(entry.owner);
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

  private clearNotice(owner: number) {
    const notice = this.notices.get(owner);
    this.notices.delete(owner);
    notice?.notice.close();
  }

  private async showCanvasNotice(args: unknown) {
    const data = args as { project?: unknown; kind?: unknown } | null;
    if ((data?.kind !== "approval" && data?.kind !== "settled") || !Notification.isSupported())
      return;
    const isBackground = (owner: number, hidden: boolean) => {
      const window = this.windows.get(owner);
      return (
        window && !window.isDestroyed() && (hidden || !window.isVisible() || window.isMinimized())
      );
    };
    const candidates = [...this.noticeScopes].filter(([owner, scope]) =>
      isBackground(owner, scope.hidden),
    );
    if (!candidates.length) return;
    const { registry } = await this.settings();
    if (registry.agentNoticePermission({}).permission !== "granted") return;
    for (const [owner, scope] of candidates) {
      const { handle } = scope;
      if (this.noticeScopes.get(owner) !== scope || !isBackground(owner, scope.hidden)) continue;
      const entry = this.projectOwners.get(handle),
        window = this.windows.get(owner);
      if (
        !entry ||
        entry.owner !== owner ||
        this.canvasAgent.key(entry.store) !== data.project ||
        !window ||
        window.isDestroyed() ||
        !isTrustedDocument(window.webContents.getURL(), this.trustedDocuments.get(owner) ?? "")
      )
        continue;
      this.clearNotice(owner);
      const notice = new Notification({ title: canvasNoticeTitle(data.kind, entry.store.name) });
      this.notices.set(owner, { handle, notice });
      const forget = () => {
        if (this.notices.get(owner)?.notice === notice) this.notices.delete(owner);
      };
      notice.once("close", forget);
      notice.once("failed", forget);
      notice.once("click", () => {
        if (
          this.notices.get(owner)?.notice !== notice ||
          this.projectOwners.get(handle) !== entry ||
          window.isDestroyed()
        )
          return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        this.clearNotice(owner);
      });
      notice.show();
    }
  }

  canvasCommand(command: string, args: unknown) {
    if (command === "notice") return this.showCanvasNotice(args);
    return this.canvasAgent.command(command, args).catch((error) => {
      if (command === "generate-preview" && error instanceof CanvasGenerationFeedback)
        return { previewError: error.message };
      throw error;
    });
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
      method !== "attachImage" &&
      method !== "attachDirectorTake" &&
      method !== "attachOfficialVoice" &&
      method !== "attachFiledImage" &&
      method !== "attachLibrary" &&
      method !== "pasteCanvasClipboard" &&
      method !== "enrollImage" &&
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
      case "filingLibraryClose": {
        const input = request as ProjectRequest<"filingLibraryClose">,
          current = this.filingPages.get(id);
        const closed =
          "page" in input
            ? current?.page === input.page
            : current?.uploads.session === input.session;
        if (closed) this.closeFilingPage(id);
        return { closed } as ProjectValues[Method];
      }
      case "filingLibraryMore":
      case "filingLibraryPage": {
        const input = request as ProjectRequest<"filingLibraryPage" | "filingLibraryMore">;
        const { channelId, channelRevision, before } = input;
        if (this.hasForegroundProject(id))
          throw new ProjectError("PROJECT_CONFLICT", "请使用当前项目的素材选择器");
        const continuation = "page" in input ? this.filingPageGrant(id, input.page) : undefined;
        if (
          (continuation &&
            (continuation.channel !== channelId ||
              continuation.revision !== channelRevision ||
              continuation.next !== before)) ||
          (!continuation && before !== undefined)
        )
          throw new ProjectError("VALIDATION_FAILED", "无效的续读位置");
        const folder = "page" in input ? continuation?.folder : input.folder,
          search = "page" in input ? continuation?.search : input.search,
          carry = "carry" in input ? input.carry : undefined;
        const history = "page" in input ? continuation?.history : input.history;
        if (history && folder)
          throw new ProjectError("VALIDATION_FAILED", "生成历史不属于个人库文件夹");
        let carriedId = "initialItem" in input ? input.initialItem : undefined;
        if (carry) {
          const previous = this.filingPageGrant(id, carry.page);
          carriedId = previous.choices.get(carry.choice);
          if (!carriedId || previous.channel !== channelId || previous.revision !== channelRevision)
            throw new ProjectError("VALIDATION_FAILED", "无法保留此图片选择");
        }
        const previous =
          "session" in input && input.session ? this.filingSession(id, input.session) : undefined;
        if (previous && (previous.channel !== channelId || previous.revision !== channelRevision))
          throw new ProjectError("VALIDATION_FAILED", "上传目标与渠道不一致");
        const grant: FilingPage = continuation ?? {
          page: randomUUID(),
          channel: channelId,
          revision: channelRevision,
          folder,
          search,
          history,
          expires: Date.now() + 15 * 60 * 1000,
          choices: new Map(),
          tokens: new Map(),
          abort: new AbortController(),
          uploads: previous?.uploads ?? {
            session: randomUUID(),
            abort: new AbortController(),
            active: new Map(),
            receipts: new Map(),
            destinations: new Map(),
          },
        };
        if (!continuation && !previous) {
          this.closeFilingPage(id);
          this.filingPages.set(id, grant);
        }
        const { registry } = await this.settings();
        registry.checkFilingLibrary(channelId, channelRevision);
        if (history) await this.loadRecents();
        const results =
          history &&
          (await this.filingHistory.page(history, search ?? "", continuation?.historyCursor));
        const { assets, folders, next } = results
          ? {
              assets: results.items.map((entry) => entry.asset),
              folders: [],
              next: results.next ? (before ?? 0) + 1 : undefined,
            }
          : await this.library.filingPage(before, search, folder);
        const listed = assets.find((asset) => asset.assetId === carriedId);
        const carriedHistory =
          !listed && carriedId?.startsWith("history:")
            ? await this.filingHistory.selection(carriedId)
            : undefined;
        const carried =
          listed ??
          carriedHistory?.asset ??
          (carriedId && !carriedId.startsWith("history:")
            ? await this.library.filingSelection(carriedId)
            : undefined);
        const candidates = carried && !assets.includes(carried) ? [...assets, carried] : assets;
        const origins = await this.library.filingOrigins(
          candidates.filter((asset) => !asset.assetId.startsWith("history:")),
        );
        for (const entry of results?.items ?? []) origins.set(entry.asset.assetId, entry.origin);
        if (carriedHistory) origins.set(carriedHistory.asset.assetId, carriedHistory.origin);
        const members = await this.library.filingMembership(results?.items ?? []);
        const owners = registry.projectFilings(
          this.library.projectId,
          candidates,
          channelId,
          origins,
        );
        this.filingPageGrant(id, previous?.page ?? grant.page);
        registry.checkFilingLibrary(channelId, channelRevision);
        if (continuation && grant.next !== before)
          throw new ProjectError("VALIDATION_FAILED", "此页已读取");
        if (previous) {
          previous.abort.abort();
          this.filingPages.set(id, grant);
        }
        if (carried) {
          const origin = origins.get(carried.assetId);
          if (origin)
            grant.carryOrigin = {
              ...origin,
              sha256: carried.sha256,
              choice: filingChoice(grant, carried.assetId),
            };
        }
        const choices = candidates.map((asset, index) => {
          const origin = origins.get(asset.assetId),
            alias = grant.carryOrigin;
          if (
            index < assets.length &&
            alias &&
            origin?.project === alias.project &&
            origin.asset === alias.asset &&
            asset.sha256 === alias.sha256
          )
            grant.tokens.set(asset.assetId, alias.choice);
          const choice = filingChoice(grant, asset.assetId);
          const reason = owners.get(asset.assetId)?.filingHumanName
            ? "已在真人库"
            : asset.sizeBytes > 10 * 1024 * 1024 ||
                !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType)
              ? "请选择 10 MiB 以内的 PNG、JPEG 或 WebP 图片"
              : undefined;
          const entry = results?.items[index];
          return {
            choice,
            name: asset.displayName,
            ...(reason && { reason }),
            ...(entry && {
              prompt: entry.prompt,
              model: entry.model,
              createdAt: asset.createdAt,
              inLibrary: members.has(asset.assetId),
            }),
          };
        });
        const carriedChoice = carried && choices[candidates.indexOf(carried)];
        const selected =
          carriedChoice && choices.find((entry) => entry.choice === carriedChoice.choice);
        if (selected && carried && selected !== carriedChoice)
          grant.choices.set(selected.choice, assets[choices.indexOf(selected)]!.assetId);
        grant.next = next;
        grant.historyCursor = results?.next;
        const destinations = grant.uploads.destinations;
        const destination =
          Array.from(destinations).find(([, entry]) => entry === folder)?.[0] ?? randomUUID();
        if (!history && (!folder || folders.some((entry) => entry.id === folder)))
          destinations.set(destination, folder);
        return {
          page: grant.page,
          session: grant.uploads.session,
          destination: history ? "" : destination,
          items: choices.slice(0, assets.length),
          folders,
          next,
          ...(results && { canvases: results.canvases }),
          ...(selected && !selected.reason && { selected }),
        } as ProjectValues[Method];
      }
      case "filingLibraryUpload": {
        const {
          session,
          destination,
          channelId,
          channelRevision,
          name,
          bytes,
          uploadId = randomUUID(),
        } = request as ProjectRequest<"filingLibraryUpload">;
        const grant = this.filingSession(id, session),
          uploads = grant.uploads;
        if (
          grant.channel !== channelId ||
          grant.revision !== channelRevision ||
          !uploads.destinations.has(destination)
        )
          throw new ProjectError("VALIDATION_FAILED", "上传目标与渠道不一致");
        if (uploads.active.has(uploadId) || uploads.active.size >= projectImportConcurrency)
          throw new ProjectError("PROJECT_CONFLICT", "图片正在上传，请稍后再试");
        const control = new AbortController(),
          signal = AbortSignal.any([control.signal, uploads.abort.signal]);
        uploads.active.set(uploadId, control);
        try {
          const { registry } = await this.settings();
          signal.throwIfAborted();
          registry.checkFilingLibrary(channelId, channelRevision);
          const asset = await this.library.importFilingImage(
            name,
            bytes,
            uploads.destinations.get(destination),
            signal,
          );
          this.libraryChanged();
          this.filingSession(id, session);
          registry.checkFilingLibrary(channelId, channelRevision);
          const receipt = randomUUID();
          uploads.receipts.set(receipt, asset.assetId);
          return { receipt } as ProjectValues[Method];
        } finally {
          uploads.active.delete(uploadId);
        }
      }
      case "filingLibraryUploaded": {
        const { page, channelId, channelRevision, receipt } =
          request as ProjectRequest<"filingLibraryUploaded">;
        const grant = this.filingPageGrant(id, page),
          assetId = grant.uploads.receipts.get(receipt);
        if (!assetId || grant.channel !== channelId || grant.revision !== channelRevision)
          throw new ProjectError("VALIDATION_FAILED", "无法选择已上传的图片");
        const { registry } = await this.settings();
        const asset = await this.library.filingSelection(assetId);
        if (!asset) throw new ProjectError("ASSET_NOT_FOUND", "图片已移除");
        const origins = await this.library.filingOrigins([asset]),
          folders = await this.library.listFolders();
        this.filingPageGrant(id, page);
        registry.checkFilingLibrary(channelId, channelRevision);
        const reason = registry
          .projectFilings(this.library.projectId, [asset], channelId, origins)
          .get(assetId)?.filingHumanName
          ? "已在真人库"
          : undefined;
        const choice = filingChoice(grant, assetId);
        grant.uploads.receipts.delete(receipt);
        return {
          item: { choice, name: asset.displayName, reason },
          folders,
        } as ProjectValues[Method];
      }
      case "filingLibraryCancelUpload": {
        const { session, uploadId } = request as ProjectRequest<"filingLibraryCancelUpload">;
        const control = this.filingSession(id, session).uploads.active.get(uploadId);
        control?.abort();
        return { cancelled: !!control } as ProjectValues[Method];
      }
      case "filingLibraryEnroll": {
        const { page, choice, channelId, channelRevision, name, humanId } =
          request as ProjectRequest<"filingLibraryEnroll">;
        const grant = this.filingPageGrant(id, page),
          item = grant.choices.get(choice);
        if (!item || grant.channel !== channelId || grant.revision !== channelRevision)
          throw new ProjectError("VALIDATION_FAILED", "图片选择与渠道不一致");
        try {
          const { registry } = await this.settings();
          registry.checkFilingLibrary(channelId, channelRevision);
          const { asset, bytes, origin } = await this.filingImage(item);
          this.filingPageGrant(id, page);
          const result = await registry.enrollProjectImage(
            {
              id: channelId,
              expectedRevision: channelRevision,
              name,
              humanId,
              libraryOrigin: origin,
            },
            item.startsWith("history:") ? origin.project : this.library.projectId,
            asset,
            bytes,
            grant.abort.signal,
          );
          return { status: result[0]!.status } as ProjectValues[Method];
        } catch (error) {
          if (error instanceof ProviderError) return { error: error.code } as ProjectValues[Method];
          throw error;
        }
      }
      case "enrollImage": {
        const { projectHandle, assetId, channelId, channelRevision, name, humanId } =
          request as ProjectRequest<"enrollImage">;
        const store = this.coordinator.getStore(id, projectHandle);
        const asset = store.snapshot.assets[assetId];
        if (
          asset?.availability !== "ready" ||
          asset.mediaType !== "image" ||
          asset.sizeBytes > 10 * 1024 * 1024
        )
          throw new ProjectError("ASSET_TYPE_UNSUPPORTED", "请选择 10 MiB 以内的可用图片");
        const { handle } = await this.assetFiles.inspect(store, asset, true);
        try {
          const bytes = Buffer.alloc(asset.sizeBytes);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== asset.sizeBytes)
            throw new ProjectError("ASSET_READ_FAILED", "图片读取失败");
          const { registry } = await this.settings();
          const libraryOrigin =
            typeof asset.metadata.libraryItemId === "string"
              ? (await this.library.filingOrigins([asset])).get(assetId)
              : undefined;
          const result = await registry.enrollProjectImage(
            { id: channelId, expectedRevision: channelRevision, name, humanId, libraryOrigin },
            store.projectId,
            asset,
            bytes,
            mediaSignal,
          );
          return { status: result[0]!.status } as ProjectValues[Method];
        } catch (error) {
          if (error instanceof ProviderError) return { error: error.code } as ProjectValues[Method];
          throw error;
        } finally {
          await handle.close();
        }
      }
      case "attachOfficialVoice":
      case "attachFiledImage":
      case "attachImage": {
        const { projectHandle, operationId } = request as ProjectRequest<"attachImage">;
        const store = this.coordinator.getStore(id, projectHandle);
        let { name, bytes } = request as ProjectRequest<"attachImage">;
        let filing: { scope: string; image: string; name: string } | undefined;
        let officialUrl: string | undefined;
        if (method === "attachOfficialVoice") {
          const { file } = request as ProjectRequest<"attachOfficialVoice">;
          const voice = officialVoices.find(
            (item) => item.url === `https://img.vbing.site/official-voices/${file}`,
          );
          if (!voice) throw new ProjectError("ASSET_NOT_FOUND", "音色未收录");
          const state = store.snapshot;
          const existing = Object.values(state.assets).find(
            (asset) => asset.availability === "ready" && asset.metadata.officialVoice === voice.url,
          );
          if (existing && (await this.assetFiles.available(store, existing)))
            return { asset: existing, revision: state.revision } as ProjectValues[Method];
          officialUrl = voice.url;
          const directory = app.isPackaged
            ? "out/renderer/official-voices"
            : "src/renderer/public/official-voices";
          bytes = new Uint8Array(
            await readFile(join(app.getAppPath(), directory, file), { signal: mediaSignal }),
          );
          name = `${voice.name.replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 170)}${extname(file)}`;
        }
        if (method === "attachFiledImage") {
          const { channelId, channelRevision, imageId } =
            request as ProjectRequest<"attachFiledImage">;
          const { registry } = await this.settings();
          const input = { id: channelId, expectedRevision: channelRevision, assetId: imageId };
          filing = registry.filingImageIdentity(input);
          const state = store.snapshot;
          const existing = Object.values(state.assets).find(
            (asset) =>
              asset.availability === "ready" &&
              asset.metadata.filingScope === filing?.scope &&
              asset.metadata.filingImage === imageId,
          );
          if (existing)
            return { asset: existing, revision: state.revision } as ProjectValues[Method];
          const blob = await registry.filingPreview(input);
          if (!blob) throw new ProjectError("ASSET_READ_FAILED", "无法取得真人图片，请稍后重试");
          filing = registry.filingImageIdentity(input);
          const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[
            blob.type
          ];
          if (!extension) throw new ProjectError("ASSET_TYPE_UNSUPPORTED", "图片格式暂不支持");
          name = `${filing.name
            .replace(/[^\p{L}\p{N} ._-]/gu, "_")
            .replace(/\.(png|jpe?g|webp)$/i, "")
            .slice(0, 180)}.${extension}`;
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
        if (
          (!officialUrl && !/\.(png|jpe?g|webp)$/i.test(name)) ||
          /[/\\]/u.test(name) ||
          Array.from(name).some((char) => char.charCodeAt(0) < 32)
        )
          throw new ProjectError("ASSET_TYPE_UNSUPPORTED", "请选择 PNG、JPEG 或 WebP 图片");
        const source = join(store.directory, "tmp", `${randomUUID()}.attachment`);
        const handle = await open(source, "wx+", 0o600);
        let staged: StagedAsset | undefined;
        try {
          await handle.writeFile(bytes, { signal: mediaSignal });
          staged = await this.assetService.stage(store, handle, name, operationId, {
            signal: mediaSignal,
          });
          if (officialUrl) staged.asset.metadata.officialVoice = officialUrl;
          if (filing && method === "attachFiledImage")
            Object.assign(staged.asset.metadata, {
              filingScope: filing.scope,
              filingImage: filing.image,
              filingChannel: (request as ProjectRequest<"attachFiledImage">).channelId,
            });
          const requestHash = contentHash({
            kind: officialUrl ? "official-voice" : "agent-image",
            ...(officialUrl && { officialUrl }),
            ...(filing && { filing }),
            name,
            sha256: staged.asset.sha256,
          });
          const previous = store.replayAssetImport(operationId, requestHash);
          if (previous) return previous as ProjectValues[Method];
          await this.assetService.publishBlob(store, staged, mediaSignal);
          return (await store.commitAsset({
            operationId,
            expectedRevision: store.snapshot.revision,
            requestHash,
            asset: staged.asset,
            signal: mediaSignal,
          })) as ProjectValues[Method];
        } finally {
          await handle.close();
          await rm(source, { force: true });
          if (staged) await this.assetService.discard(staged);
        }
      }
      case "attachDirectorTake": {
        const input = request as ProjectRequest<"attachDirectorTake">;
        return (await attachDirectorTake(
          this.coordinator.getStore(id, input.projectHandle),
          this.assetService,
          input,
          mediaSignal,
        )) as ProjectValues[Method];
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
      case "retryCharacterImage":
      case "recheckJob":
      case "drama":
      case "estimateDramaScripts":
      case "estimateDramaBreakdown":
      case "estimateDramaStoryboard":
      case "estimateDramaContinuation":
      case "previewDramaSource":
      case "canvasAgent": {
        const handle = String(input.projectHandle);
        if (this.closing.has(handle)) throw new ProjectError("PROJECT_CLOSED", "项目正在关闭");
        return this.coordinator.withStore(id, handle, async (store) => {
          switch (method) {
            case "estimateDramaContinuation": {
              const doc = dramaDocument(store.snapshot);
              if (!doc) throw new ProjectError("DRAMA_STEP_NOT_READY", "未创建短剧");
              return (
                await quoteDramaContinuation(
                  doc,
                  (request as ProjectRequest<"estimateDramaContinuation">).rangeEnd,
                  (
                    await this.settings()
                  ).registry,
                  store.directory,
                )
              ).estimate as ProjectValues[Method];
            }
            case "estimateDramaStoryboard": {
              const { episodeNo, maxSeconds, videoModel, previewClear } =
                request as ProjectRequest<"estimateDramaStoryboard">;
              const state = store.snapshot,
                doc = dramaDocument(state);
              if (!doc) throw new ProjectError("DRAMA_STEP_NOT_READY", "未创建短剧");
              const clearHash = previewClear ? storyboardClearHash(doc, episodeNo) : undefined;
              const preview = previewClear
                ? {
                    ...doc,
                    segments: doc.segments?.filter((segment) => segment.episode_no !== episodeNo),
                  }
                : doc;
              const { estimate } = await estimateDramaJob(
                preview,
                {
                  step: "storyboard",
                  episodes: [episodeNo],
                  max_seconds: maxSeconds,
                  ...(videoModel && { video_model: videoModel }),
                },
                (await this.settings()).registry,
                state,
              );
              return {
                credits: estimate,
                ...(clearHash && { clearHash }),
              } as ProjectValues[Method];
            }
            case "estimateDramaBreakdown":
            case "estimateDramaScripts": {
              const { episodes } = request as ProjectRequest<"estimateDramaScripts">;
              const state = store.snapshot,
                doc = dramaDocument(state);
              if (!doc || (method === "estimateDramaScripts" && !doc.planning))
                throw new ProjectError("DRAMA_STEP_NOT_READY", "请先生成分集");
              return (
                await estimateDramaJob(
                  doc,
                  {
                    step:
                      method === "estimateDramaScripts"
                        ? "scripts"
                        : (request as ProjectRequest<"estimateDramaBreakdown">).promptsOnly
                          ? "asset_prompts"
                          : "breakdown",
                    episodes,
                  },
                  (
                    await this.settings()
                  ).registry,
                  state,
                )
              ).estimate as ProjectValues[Method];
            }
            case "previewDramaSource": {
              const input = request as ProjectRequest<"previewDramaSource">;
              if (input.preflightOnly) {
                if (
                  input.sourceToken ||
                  (input.fileBytes !== undefined) === (input.script !== undefined)
                )
                  throw new ProjectError("VALIDATION_FAILED", "请选择文件或粘贴原文");
                let script = input.script;
                if (input.fileBytes && input.filename) {
                  const output = await new Promise<string>((resolve, reject) => {
                    const proc = execFile(
                      this.providerRunner,
                      ["drama-source", input.filename!],
                      { timeout: 15000, maxBuffer: 32 * 1024 * 1024, signal: mediaSignal },
                      (error, stdout) => (error ? reject(error) : resolve(stdout)),
                    );
                    proc.stdin!.on("error", reject);
                    proc.stdin!.end(input.fileBytes);
                  });
                  const result = JSON.parse(output);
                  if (!result.ok) throw new ProjectError("VALIDATION_FAILED", result.code);
                  script = result.result;
                }
                if (!script) throw new ProjectError("VALIDATION_FAILED", "预检须提供原文");
                const parsed = preflightDramaSource(script, input.sourceKind);
                const { registry } = await this.settings();
                const guess =
                  !input.sourceKind && parsed.kindGuess === "unknown"
                    ? await registry.dramaGuessKind(
                        parsed.source.text,
                        input.textModel,
                        mediaSignal,
                      )
                    : undefined;
                const sourceKind =
                  input.sourceKind ??
                  guess?.kind ??
                  (parsed.kindGuess === "script" ? "script" : "novel");
                const estimated = await estimateDramaSource(
                  { ...input, script, sourceKind },
                  registry,
                ).catch((error: unknown) => {
                  if (!(error instanceof ProjectError || error instanceof ProviderError))
                    throw error;
                  return {
                    credits: 0,
                    priceUnavailable: true,
                    estimateProblem: error.message,
                    kindSignals: parsed.kindSignals,
                    kindGuess: parsed.kindGuess,
                    issues: parsed.issues,
                    chars: parsed.source.chars,
                    kind: parsed.source.kind,
                    units: parsed.units.length,
                  };
                });
                const sourceToken = this.dramaDrafts.save(
                  store.projectId,
                  input.filename ?? "source.txt",
                  parsed.source,
                );
                return {
                  ...estimated,
                  sourceToken,
                  ...(guess && {
                    kindGuess: guess.kind,
                    kindSignals: `AI 判断为${guess.kind === "script" ? "剧本" : "小说"}${guess.reason ? `（${guess.reason}）` : ""}；规则统计：${parsed.kindSignals}`,
                  }),
                } as ProjectValues[Method];
              }
              if (
                !input.sourceToken ||
                input.script !== undefined ||
                input.fileBytes !== undefined ||
                input.filename !== undefined
              )
                throw new ProjectError("VALIDATION_FAILED", "重新估价须使用预检草稿");
              if (dramaDocument(store.snapshot)?.source?.draftToken === input.sourceToken)
                return expiredDramaSource();
              const draft = this.dramaDrafts.read(store.projectId, input.sourceToken);
              return {
                ...(await estimateDramaSource(
                  { ...input, script: draft.text },
                  (
                    await this.settings()
                  ).registry,
                )),
                chars: draft.chars,
              } as ProjectValues[Method];
            }
            case "drama": {
              const {
                create,
                addSegment,
                addEpisode,
                saveScript,
                editField,
                compose,
                deleteEpisode,
                chooseTake,
                setSegmentSeconds,
                setSegmentPrompt,
                reorderSegments,
                deleteSegment,
                adaptSegment,
                boardSettings,
                planningAction,
                writeScripts,
                repairPrompts,
                breakdown,
                cancelBreakdown,
                storyboard,
                cancelStoryboard,
                cancelJob,
                extendPlanning,
              } = request as ProjectRequest<"drama">;
              if (
                [
                  create,
                  addSegment,
                  addEpisode,
                  saveScript,
                  editField,
                  compose,
                  deleteEpisode,
                  chooseTake,
                  setSegmentSeconds,
                  setSegmentPrompt,
                  reorderSegments,
                  deleteSegment,
                  adaptSegment,
                  boardSettings,
                  planningAction,
                  writeScripts,
                  repairPrompts,
                  breakdown,
                  cancelBreakdown,
                  storyboard,
                  cancelStoryboard,
                  cancelJob,
                  extendPlanning,
                ].filter(Boolean).length > 1
              )
                throw new ProjectError("VALIDATION_FAILED", "一次只能执行一个短剧操作");
              if (editField)
                return (await editDramaField(store, editField)) as ProjectValues[Method];
              if (compose) {
                const job = await submitApprovedDramaJob(
                  store,
                  (await this.settings()).registry,
                  "workspace",
                  `workspace:${compose.operationId}`,
                  {
                    args: { step: "compose", episodes: [compose.episodeNo] },
                    estimate: 0,
                    episodeOrder: compose.episodeOrder,
                  },
                );
                if (job.status === "queued") this.canvasAgent.startDramaAssetJob(store, job.id);
                return dramaDocument(store.snapshot) as ProjectValues[Method];
              }
              if (cancelJob || cancelBreakdown || cancelStoryboard) {
                await this.canvasAgent.cancelStudioJob(
                  store,
                  cancelJob ?? cancelBreakdown ?? cancelStoryboard!,
                  cancelJob ? undefined : cancelBreakdown ? "breakdown" : "storyboard",
                );
                return dramaDocument(store.snapshot) as ProjectValues[Method];
              }
              if (deleteEpisode)
                return (await deleteDramaEpisode(store, deleteEpisode)) as ProjectValues[Method];
              if (extendPlanning) {
                const doc = await extendDramaPlanning(
                  store,
                  (await this.settings()).registry,
                  extendPlanning.rangeEnd,
                  extendPlanning.previousEnd,
                );
                this.canvasAgent.startPlanning(store);
                return doc as ProjectValues[Method];
              }
              const production = storyboard ?? repairPrompts ?? breakdown ?? writeScripts;
              if (production) {
                const args =
                  "episodeNo" in production
                    ? {
                        step: "storyboard" as const,
                        episodes: [production.episodeNo],
                        max_seconds: production.maxSeconds,
                        ...(production.videoModel && { video_model: production.videoModel }),
                      }
                    : {
                        step: repairPrompts
                          ? ("asset_prompts" as const)
                          : breakdown
                            ? ("breakdown" as const)
                            : ("scripts" as const),
                        episodes: production.episodes,
                      };
                const job = await submitApprovedDramaJob(
                  store,
                  (await this.settings()).registry,
                  "workspace",
                  `workspace:${production.operationId}`,
                  {
                    args,
                    estimate: production.estimate,
                    ...(production.episodeOrder && { episodeOrder: production.episodeOrder }),
                    ...(storyboard?.clearHash && { clearHash: storyboard.clearHash }),
                    ...(storyboard?.batch && { batch: true }),
                  },
                );
                if (job.status === "queued") this.canvasAgent.startDramaAssetJob(store, job.id);
                return dramaDocument(store.snapshot) as ProjectValues[Method];
              }
              if (planningAction) {
                const doc = await controlDramaPlanning(store, planningAction);
                if (planningAction !== "pause") this.canvasAgent.startPlanning(store);
                return doc as ProjectValues[Method];
              }
              if (boardSettings) {
                const { registry } = await this.settings();
                const list = registry.list();
                return (await updateDramaBoardSettings(
                  store,
                  boardSettings,
                  dramaImageModels(list),
                  dramaAgentModels(list.providers),
                  () => registry.dramaPromptLibrary({ action: "list" }).entries,
                  (step, name) => this.skills.dramaSnapshot(step, name),
                )) as ProjectValues[Method];
              }
              if (chooseTake)
                return (await chooseDramaTake(store, chooseTake)) as ProjectValues[Method];
              if (setSegmentSeconds)
                return (await setDramaSegmentSeconds(
                  store,
                  setSegmentSeconds,
                )) as ProjectValues[Method];
              if (setSegmentPrompt)
                return (await setDramaSegmentPrompt(
                  store,
                  setSegmentPrompt,
                )) as ProjectValues[Method];
              if (reorderSegments)
                return (await reorderDramaSegments(
                  store,
                  reorderSegments,
                )) as ProjectValues[Method];
              if (deleteSegment)
                return (await deleteDramaSegment(store, deleteSegment)) as ProjectValues[Method];
              if (adaptSegment)
                return (await adaptDramaSegment(
                  store,
                  (
                    await this.settings()
                  ).registry,
                  adaptSegment,
                  mediaSignal ?? new AbortController().signal,
                )) as ProjectValues[Method];
              if (create) {
                if (dramaDocument(store.snapshot)?.source?.draftToken === create.sourceToken)
                  return expiredDramaSource();
                const draft = this.dramaDrafts.read(store.projectId, create.sourceToken);
                const source = { ...create, script: draft.text };
                const { registry } = await this.settings();
                const { model } = await quoteDramaSource(source, registry);
                const list = registry.list();
                const media = canvasAgentMediaModels(list);
                const images = media
                  .filter((entry) => entry.kind === "image")
                  .map(({ provider }) => ({
                    id: provider.id,
                    fields: dramaImageFields(provider, list.plugins),
                  }));
                const document = await createDrama(
                  store,
                  source,
                  images,
                  media
                    .filter(
                      (entry) =>
                        entry.kind === "video" &&
                        !dramaVideoModelIssue(entry.provider, list.plugins),
                    )
                    .map((entry) => entry.provider),
                  () => registry.dramaPromptLibrary({ action: "list" }).entries,
                  (step, name) => this.skills.dramaSnapshot(step, name),
                  model,
                  () => {
                    const { chars, filename, sha256 } = this.dramaDrafts.read(
                      store.projectId,
                      create.sourceToken,
                    );
                    return { chars, filename, sha256, draftToken: create.sourceToken };
                  },
                );
                this.dramaDrafts.remove(store.projectId, create.sourceToken);
                this.canvasAgent.startPlanning(store);
                return document as ProjectValues[Method];
              }
              return (
                saveScript
                  ? await saveDramaScript(store, saveScript)
                  : addEpisode
                    ? await addDramaEpisode(store, addEpisode)
                    : addSegment
                      ? await addDramaSegment(store, addSegment)
                      : dramaDocument(store.snapshot)
              ) as ProjectValues[Method];
            }
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
            case "retryCharacterImage": {
              const { jobId, operationId, expectedCanvasRevision } =
                request as ProjectRequest<"retryCharacterImage">;
              return (await this.generation.retryCharacterImage(
                store,
                jobId,
                operationId,
                expectedCanvasRevision,
              )) as ProjectValues[Method];
            }
            case "recheckJob":
              return (await this.generation.recheck(
                store,
                String(input.jobId),
              )) as ProjectValues[Method];
            case "canvasAgent": {
              const { action, mode } = request as ProjectRequest<"canvasAgent">;
              if (mode === "drama" && !dramaDocument(store.snapshot))
                throw new ProjectError("AGENT_SCOPE_DENIED", "当前项目没有短剧");
              const { agent, observeSession } = await this.settings();
              const result = await agent.runCanvas(this.canvasAgent.key(store), action, mode);
              if (action.method === "state")
                observeSession(window.webContents.id, mode ?? "canvas", action.sessionId);
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
        const { canvasSeed } = request as ProjectRequest<"create">;
        const media = canvasSeed?.media;
        const source = media?.projectHandle
          ? this.coordinator.getStore(id, media.projectHandle)
          : undefined;
        const session = await this.coordinator.create(
          id,
          input.directoryToken as string,
          input.operationId as string,
          input.name as string,
          input.projectKind as "canvas" | "drama" | undefined,
          canvasSeed && {
            identity: contentHash(canvasSeed),
            data: {
              operations: canvasSeed.operations,
              loadAssets: async (directory) => {
                if (!media) return {};
                const originals = source?.snapshot.assets;
                const copies: Record<string, AssetRecord> = {};
                for (const assetId of media.assetIds) {
                  const original = originals
                    ? originals[assetId]
                    : await this.library.filingSelection(assetId);
                  if (original?.availability !== "ready")
                    throw new ProjectError("ASSET_NOT_FOUND", "副本引用的素材不可用");
                  const asset = {
                    ...original,
                    availability: "ready" as const,
                    importMode: "copy" as const,
                    storage: { kind: "blob" as const, hash: original.sha256 },
                  };
                  const temporary = join(directory, "tmp", `${randomUUID()}.asset`);
                  await this.assetFiles.materialize(source ?? this.library, original, temporary);
                  try {
                    const file = await open(temporary, readOnly);
                    try {
                      await verifyContent(file, asset);
                      await file.sync();
                    } finally {
                      await file.close();
                    }
                    await this.assetService.publishBlob({ directory }, { asset, temporary });
                  } finally {
                    await rm(temporary, { force: true });
                  }
                  copies[assetId] = asset;
                }
                return copies;
              },
            },
          },
        );
        const project = this.coordinator.getSession(id, session.projectHandle);
        this.startProjectWork(id, session.projectHandle);
        const directory = await this.directoryForHandle(id, session.projectHandle);
        await this.recordRecent({ ...project, directory });
        return session as ProjectValues[Method];
      }
      case "open": {
        const result = await this.coordinator.open(
          id,
          input.directoryToken as string,
          "open",
          input.allowReadOnly === true,
        );
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
          projects: this.recents.map(({ directory, ...entry }) => {
            const live = [...this.projectOwners.values()].find(
              (item) => item.owner === id && item.store.directory === directory,
            );
            return { ...entry, activity: live && this.activity(live.store) };
          }),
        } as ProjectValues[Method];
      case "openRecent": {
        await this.loadRecents();
        const recent = this.recents.find((entry) => entry.recentEntryId === input.recentEntryId);
        if (!recent) throw new ProjectError("PROJECT_PATH_DENIED", "最近项目入口已失效");
        const directoryToken = await this.coordinator.authorizeRecent(id, recent.directory);
        const result = await this.coordinator.open(
          id,
          directoryToken,
          "open",
          input.allowReadOnly === true,
        );
        if (result.disposition === "opened") {
          this.startProjectWork(id, result.session.projectHandle);
          await this.recordRecent({ ...result.session, directory: recent.directory });
        }
        return result as ProjectValues[Method];
      }
      case "removeRecent":
        await this.loadRecents();
        if (
          [...this.projectOwners.values()].some(
            ({ store }) =>
              store.directory ===
                this.recents.find((entry) => entry.recentEntryId === input.recentEntryId)
                  ?.directory && this.activity(store),
          )
        )
          throw new ProjectError("PROJECT_CONFLICT", "请等待项目任务结束后再移除记录");
        this.recents = this.recents.filter((entry) => entry.recentEntryId !== input.recentEntryId);
        await this.persistRecents();
        await this.forgetRecentHistory(input.recentEntryId as string);
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
        const session = this.coordinator.getSession(id, projectHandle);
        this.closing.add(projectHandle);
        try {
          await this.stopImports(id, projectHandle);
          if (input.keepWorking && session.projectKind === "drama") {
            await this.coordinator.park(id, projectHandle);
            this.scheduleRelease();
          } else {
            await this.stopProjectWork(projectHandle);
            await this.coordinator.close(id, projectHandle);
          }
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
      case "beginClipboardFile": {
        const { projectHandle, name, kind, size } = request as ProjectRequest<"beginClipboardFile">;
        if (hasAsciiControl(name) || /[\\/]/.test(name) || name === "." || name === "..")
          throw new ProjectError("ASSET_READ_FAILED", "无效的媒体文件名");
        return this.coordinator.withStore(id, projectHandle, async (store) => {
          const held = [
            ...this.fileGrants.values(),
            ...Array.from(this.imports.values(), (job) => job.grant),
          ];
          if (
            size > { image: 20, video: 200, audio: 50 }[kind] * 1024 * 1024 ||
            this.fileGrants.size >= 32 ||
            held.reduce((total, grant) => total + (grant?.clipboard?.size ?? 0), size) >
              600 * 1024 * 1024
          )
            throw new ProjectError("ASSET_SIZE_LIMIT", "剪贴板文件过大或当前导入过多");
          const directory = join(store.directory, "tmp");
          if (!(await lstat(directory)).isDirectory())
            throw new ProjectError("PROJECT_PATH_DENIED", "项目临时目录无效");
          const path = join(directory, `${randomUUID()}.clip`),
            handle = await open(path, "wx+", 0o600);
          try {
            await rm(path);
            if (this.windows.get(id) !== window || this.closing.has(projectHandle))
              throw new ProjectError("PROJECT_CLOSED", "项目正在关闭");
            const fileToken = randomUUID();
            this.putFileGrant(fileToken, {
              clipboard: { size, received: 0, kind },
              owner: id,
              projectHandle,
              path: "",
              displayName: name,
              handle,
              expiresAt: Date.now() + 600_000,
            });
            return { fileToken, displayName: name } as ProjectValues[Method];
          } catch (error) {
            await handle.close();
            throw error;
          }
        });
      }
      case "appendClipboardFile": {
        const { projectHandle, fileToken, offset, bytes } =
          request as ProjectRequest<"appendClipboardFile">;
        return this.coordinator.withStore(id, projectHandle, async () => {
          const grant = this.fileGrants.get(fileToken),
            clip = grant?.clipboard;
          if (
            !grant ||
            !clip ||
            grant.owner !== id ||
            grant.projectHandle !== projectHandle ||
            grant.expiresAt <= Date.now()
          )
            throw new ProjectError("TOKEN_INVALID_OR_EXPIRED", "剪贴板文件已释放");
          if (offset !== clip.received || offset + bytes.byteLength > clip.size)
            throw new ProjectError("ASSET_READ_FAILED", "剪贴板分块不连续");
          let written = 0;
          while (written < bytes.byteLength) {
            const result = await grant.handle.write(
              bytes,
              written,
              bytes.byteLength - written,
              offset + written,
            );
            if (!result.bytesWritten)
              throw new ProjectError("ASSET_STORAGE_FAILED", "无法写入剪贴板文件");
            written += result.bytesWritten;
          }
          clip.received += written;
          return { received: clip.received } as ProjectValues[Method];
        });
      }
      case "droppedMedia":
      case "selectMedia": {
        const projectHandle = input.projectHandle as string;
        this.coordinator.getSession(id, projectHandle);
        const testFiles = process.env.LINK_STUDIO_TEST_MEDIA_FILES?.split("\n").filter(Boolean);
        const selected =
          method === "droppedMedia"
            ? { canceled: false, filePaths: input.paths as string[] }
            : testFiles
              ? {
                  canceled: false,
                  filePaths: input.multiSelect ? testFiles : testFiles.slice(0, 1),
                }
              : await dialog.showOpenDialog(window, {
                  properties: input.multiSelect ? ["openFile", "multiSelections"] : ["openFile"],
                  filters: [
                    input.mediaType
                      ? mediaFilters[input.mediaType as keyof typeof mediaFilters]
                      : {
                          name: "媒体文件",
                          extensions: Object.values(mediaFilters).flatMap(
                            (filter) => filter.extensions,
                          ),
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
            grant.clipboard ||
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
        const images = assets.filter((asset) => asset.mediaType === "image");
        const origins = await this.library.filingOrigins(
          images.filter((asset) => typeof asset.metadata.libraryItemId === "string"),
        );
        const filings = images.length
          ? (await this.settings()).registry.projectFilings(
              store.projectId,
              images,
              (request as ProjectRequest<"listAssets">).filingChannelId,
              origins,
            )
          : undefined;
        for (const asset of assets) {
          const available = await this.assetFiles.previewMetadata(store, asset);
          const {
            filingImage,
            filingScope,
            filingChannel,
            filingSourceChannel,
            filingHumanName,
            filingEnabled,
            ...metadata
          } = available ?? asset.metadata;
          result.push({
            ...asset,
            metadata: { ...metadata, ...filings?.get(asset.assetId) },
            availability: available ? "ready" : "missing",
          });
        }
        return {
          assets: result,
        } as ProjectValues[Method];
      }
      case "saveAssetCopy": {
        const input = request as ProjectRequest<"saveAssetCopy">;
        const saveCopy = async (store: MediaLocation, asset?: AssetRecord) => {
          if (!asset || asset.availability !== "ready")
            throw new ProjectError("ASSET_NOT_FOUND", "素材不可用");
          const save = await dialog.showSaveDialog(window, {
            title: "下载原文件",
            defaultPath: basename(asset.displayName),
            properties: ["showOverwriteConfirmation"],
          });
          if (save.canceled || !save.filePath) return { saved: false } as ProjectValues[Method];
          const target = save.filePath;
          const previous = await lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
          const temporary = join(dirname(target), `.link-studio-copy-${randomUUID()}`);
          try {
            await this.assetFiles.materialize(store, asset, temporary);
            const installed = await installExportTarget(
              temporary,
              target,
              previous
                ? {
                    exists: true,
                    dev: previous.dev,
                    ino: previous.ino,
                    size: previous.size,
                    mtimeMs: previous.mtimeMs,
                    ctimeMs: previous.ctimeMs,
                  }
                : { exists: false },
            );
            await installed.finalize();
            return { saved: true } as ProjectValues[Method];
          } finally {
            await rm(temporary, { force: true });
          }
        };
        if ("library" in input) {
          const media = await this.globalMedia(input.library, input.assetId);
          if (!media) throw new ProjectError("ASSET_NOT_FOUND", "素材不可用");
          return saveCopy(media.location, media.asset);
        }
        return this.coordinator.withStore(id, input.projectHandle, (store) =>
          saveCopy(store, store.snapshot.assets[input.assetId]),
        );
      }
      case "copyAssetImage": {
        const { projectHandle, assetId } = request as ProjectRequest<"copyAssetImage">;
        const store = this.coordinator.getStore(id, projectHandle),
          asset = store.snapshot.assets[assetId];
        if (!asset) throw new ProjectError("ASSET_NOT_FOUND", "图片素材不可用");
        const bytes = await this.canvasMedia.readClipboardImage(
          store,
          asset,
          mediaSignal ?? new AbortController().signal,
        );
        const image = imagePreviewBlob(bytes);
        if (image.type !== asset.mimeType)
          throw new ProjectError("ASSET_TYPE_UNSUPPORTED", "图片格式不符");
        this.coordinator.getSession(id, projectHandle);
        await clipboard.write([new ClipboardItem({ [image.type]: image })]);
        return { copied: true } as ProjectValues[Method];
      }
      case "readAudioForWaveform": {
        const input = request as ProjectRequest<"readAudioForWaveform">;
        if ("library" in input) {
          const media = await this.globalMedia(input.library, input.assetId);
          if (!media) throw new ProjectError("ASSET_NOT_FOUND", "音频素材不可用");
          const value: ProjectValues["readAudioForWaveform"] = {
            bytes: await this.canvasMedia.readAudioForWaveform(media.location, media.asset),
          };
          return value as ProjectValues[Method];
        }
        const { projectHandle, assetId } = input;
        const store = this.coordinator.getStore(id, projectHandle);
        const asset = store.snapshot.assets[assetId];
        if (!asset) throw new ProjectError("ASSET_NOT_FOUND", "音频素材不可用");
        const bytes = await this.canvasMedia.readAudioForWaveform(store, asset);
        this.coordinator.getSession(id, projectHandle);
        const value: ProjectValues["readAudioForWaveform"] = { bytes };
        return value as ProjectValues[Method];
      }
      case "cancelGlobalImport": {
        const { operationId } = request as ProjectRequest<"cancelGlobalImport">;
        const control = this.globalImports.get(id)?.get(operationId);
        control?.abort();
        return { cancelled: !!control } as ProjectValues[Method];
      }
      case "dropGlobalAsset": {
        const { path, operationId, folder } = request as ProjectRequest<"dropGlobalAsset">;
        const tasks = this.globalImports.get(id) ?? new Map<string, AbortController>();
        if (tasks.has(operationId) || tasks.size >= 4)
          throw new ProjectError("PROJECT_IN_USE", "导入队列已满");
        const control = new AbortController();
        this.globalImports.set(id, tasks);
        tasks.set(operationId, control);
        try {
          const handle = await open(path, readOnly);
          try {
            let previous = -1;
            await this.library.importFile(
              handle,
              sanitizeFileName(basename(path)),
              folder,
              control.signal,
              (copied, total) => {
                const percent = Math.floor((copied * 100) / total);
                if (percent !== previous && !window.isDestroyed())
                  window.webContents.send(
                    "link-studio:library:importProgress",
                    operationId,
                    percent,
                  );
                previous = percent;
              },
            );
            this.libraryChanged();
          } finally {
            await handle.close();
          }
        } finally {
          tasks.delete(operationId);
        }
        return { imported: true } as ProjectValues[Method];
      }
      case "importGlobalAsset": {
        const input = request as ProjectRequest<"importGlobalAsset">;
        const paths = (
          await dialog.showOpenDialog(window, {
            properties: ["openFile", "multiSelections"],
            filters: Object.values(mediaFilters),
          })
        ).filePaths;
        for (const path of paths) {
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await this.library.importFile(handle, sanitizeFileName(basename(path)), input.folder);
            this.libraryChanged();
          } finally {
            await handle.close();
          }
        }
        return { imported: paths.length > 0 } as ProjectValues[Method];
      }
      case "globalLibrary": {
        const page = await this.library.list(
          "",
          (request as ProjectRequest<"globalLibrary">).before,
        );
        const images = page.items
          .map(({ asset }) => asset)
          .filter((asset) => asset.mediaType === "image");
        if (images.length) {
          const { registry } = await this.settings();
          const origins = await this.library.filingOrigins(images);
          for (const asset of images) delete asset.metadata.filingHumanName;
          for (const channel of registry
            .channelList()
            .filter((ch) => ch.filing?.enabled && ch.hasFilingKeys)) {
            const owners = registry.projectFilings(
              this.library.projectId,
              images,
              channel.id,
              origins,
            );
            for (const asset of images) {
              const name = owners.get(asset.assetId)?.filingHumanName;
              if (name) asset.metadata.filingHumanName = name;
            }
          }
        }
        return page as ProjectValues[Method];
      }
      case "globalHistory": {
        const { filter, search, before, media, oldest } =
          request as ProjectRequest<"globalHistory">;
        await this.loadRecents();
        const { canvases, items, next } = await this.filingHistory.page(
          filter,
          search,
          before,
          media,
          oldest,
        );
        const members = await this.library.filingMembership(items);
        return {
          canvases,
          next,
          items: items.map(({ asset, prompt, model, canvasId }) => ({
            model,
            canvasId,
            createdAt: asset.createdAt,
            bytes: asset.sizeBytes,
            aspect: Number(asset.metadata.width) / Number(asset.metadata.height) || 0,
            durationMs: Number(asset.metadata.durationMs) || 0,
            id: asset.assetId.slice(8),
            name: asset.displayName,
            prompt,
            saved: members.has(asset.assetId),
          })),
        } as ProjectValues[Method];
      }
      case "collectHistory": {
        const { id: entryId, folderId } = request as ProjectRequest<"collectHistory">;
        const item = await this.filingHistory.lookup(`history:${entryId}`);
        if (!item) throw new ProjectError("ASSET_NOT_FOUND", "生成记录已失效");
        await this.library.registerSource(
          item.canvas,
          {
            ...item.asset,
            assetId: item.origin.asset,
          },
          folderId,
        );
        this.libraryChanged();
        return { saved: true } as ProjectValues[Method];
      }
      case "listLibrary": {
        const { projectHandle, before, filingChannelId } = request as ProjectRequest<"listLibrary">;
        const project = this.coordinator.getStore(id, projectHandle).projectId;
        const page = await this.library.list(project, before);
        if (filingChannelId) {
          const images = page.items
            .map((item) => item.asset)
            .filter((asset) => asset.mediaType === "image");
          const owners = (await this.settings()).registry.projectFilings(
            project,
            images,
            filingChannelId,
            await this.library.filingOrigins(images),
          );
          for (const { asset } of page.items) {
            const name = owners.get(asset.assetId)?.filingHumanName;
            if (name) asset.metadata.filingHumanName = name;
          }
        }
        return page as ProjectValues[Method];
      }
      case "listLibraryFolders": {
        const { projectHandle } = request as ProjectRequest<"listLibraryFolders">;
        if (projectHandle) this.coordinator.getSession(id, projectHandle);
        return (await this.library.listFolders()) as ProjectValues[Method];
      }
      case "registerLibrary": {
        const { projectHandle, assetId, folderId } = request as ProjectRequest<"registerLibrary">;
        const value = await this.coordinator.withStore(id, projectHandle, (store) =>
          this.library.register(store, assetId, folderId),
        );
        this.libraryChanged();
        return value as ProjectValues[Method];
      }
      case "createLibraryFolder": {
        const { projectHandle, name } = request as ProjectRequest<"createLibraryFolder">;
        if (projectHandle) this.coordinator.getSession(id, projectHandle);
        const value = await this.library.createFolder(name);
        this.libraryChanged();
        return value as ProjectValues[Method];
      }
      case "renameLibraryFolder": {
        const { projectHandle, folderId, name } = request as ProjectRequest<"renameLibraryFolder">;
        if (projectHandle) this.coordinator.getSession(id, projectHandle);
        await this.library.renameFolder(folderId, name);
        this.libraryChanged();
        return { updated: true } as ProjectValues[Method];
      }
      case "deleteLibraryFolder": {
        const { projectHandle, folderId } = request as ProjectRequest<"deleteLibraryFolder">;
        if (projectHandle) this.coordinator.getSession(id, projectHandle);
        const removed = await this.library.deleteFolder(folderId);
        this.libraryChanged();
        return { removed } as ProjectValues[Method];
      }
      case "moveLibraryItem": {
        const { projectHandle, itemId, folderId } = request as ProjectRequest<"moveLibraryItem">;
        if (projectHandle) this.coordinator.getSession(id, projectHandle);
        await this.library.moveItem(itemId, folderId);
        this.libraryChanged();
        return { updated: true } as ProjectValues[Method];
      }
      case "removeLibraryItem": {
        const { projectHandle, itemId } = request as ProjectRequest<"removeLibraryItem">;
        if (projectHandle) this.coordinator.getSession(id, projectHandle);
        await this.library.removeItem(itemId);
        this.libraryChanged();
        return { updated: true } as ProjectValues[Method];
      }
      case "attachLibrary": {
        const { projectHandle, itemId, operationId } = request as ProjectRequest<"attachLibrary">;
        return (await this.coordinator.withStore(id, projectHandle, (store) =>
          this.library.attach(store, itemId, operationId, mediaSignal),
        )) as ProjectValues[Method];
      }
      case "captureCanvasClipboard": {
        const { projectHandle, assetIds } = request as ProjectRequest<"captureCanvasClipboard">;
        return this.clipboardMedia.capture(
          id,
          this.coordinator.getStore(id, projectHandle),
          assetIds,
        ) as ProjectValues[Method];
      }
      case "pasteCanvasClipboard": {
        const { projectHandle, token } = request as ProjectRequest<"pasteCanvasClipboard">;
        return (await this.coordinator.withStore(id, projectHandle, (store) =>
          this.clipboardMedia.paste(id, token, store, mediaSignal),
        )) as ProjectValues[Method];
      }
      case "getAssetPreview": {
        const { projectHandle, assetId, variant, library } =
          request as ProjectRequest<"getAssetPreview">;
        const store = this.coordinator.getStore(id, projectHandle);
        const asset = library ? await this.library.get(assetId) : store.snapshot.assets[assetId];
        if (!asset || asset.availability === "deleted")
          throw new ProjectError("ASSET_NOT_FOUND", "素材不可用");
        const location = library ? this.library : store;
        const { handle, stamp } = await this.assetFiles.inspect(location, asset, true);
        await handle.close();
        this.coordinator.getSession(id, projectHandle);
        if (variant === "poster" || variant === "thumb") {
          const url = await this.canvasMedia.poster(location, asset, variant);
          this.coordinator.getSession(id, projectHandle);
          return { url, mimeType: "image/png" } as ProjectValues[Method];
        }
        for (const [token, grant] of this.previews) {
          if (grant.expiresAt <= Date.now()) {
            this.previews.delete(token);
          } else if (
            grant.owner === id &&
            grant.assetId === assetId &&
            !!grant.library === !!library &&
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
          library,
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
        const digest = contentHash({ kind: "canvas-frame-at-time-v2", assetId, timeMs });
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

  private claimFileGrant(
    owner: number,
    projectHandle: string,
    token: string,
    allowClipboard = false,
  ) {
    if (this.closing.has(projectHandle)) throw new ProjectError("PROJECT_CLOSED", "项目正在关闭");
    const grant = this.fileGrants.get(token);
    if (
      !grant ||
      (grant.clipboard && (!allowClipboard || grant.clipboard.size !== grant.clipboard.received)) ||
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
      ...(input.forLibrary && { forLibrary: true }),
      ...(input.forCanvasUpload && { forCanvasUpload: true }),
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
        .length >= projectImportConcurrency
    )
      throw new ProjectError("ASSET_SIZE_LIMIT", "请先完成现有导入");
    const job: ImportJob = {
      id: randomUUID(),
      owner,
      projectHandle,
      requestHash,
      operationId,
      mode: importMode,
      forLibrary: input.forLibrary,
      forCanvasUpload: input.forCanvasUpload,
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
    if (!prior)
      job.grant = this.claimFileGrant(
        owner,
        projectHandle,
        fileToken,
        !!input.forCanvasUpload && !input.forLibrary && importMode === "copy",
      );
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
      if (grant.clipboard && grant.clipboard.kind !== job.staged.asset.mediaType)
        throw new ProjectError("ASSET_TYPE_UNSUPPORTED", "剪贴板媒体种类与文件内容不一致");
      if (job.forLibrary) job.staged.asset.metadata.libraryUpload = true;
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
    let retryToken: string | undefined;
    if (
      job.forCanvasUpload &&
      !job.abort.signal.aborted &&
      job.grant &&
      !job.grant.clipboard &&
      job.grant.expiresAt > Date.now() &&
      this.imports.has(job.id) &&
      this.windows.has(job.owner) &&
      !this.closing.has(job.projectHandle) &&
      this.fileGrants.size < 32
    ) {
      retryToken = randomUUID();
      this.putFileGrant(retryToken, job.grant);
      job.grant = undefined;
    }
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
            ...(retryToken && { retryToken }),
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

  private async recordRecent(session: {
    projectId: string;
    name: string;
    directory: string;
    projectKind?: "canvas" | "drama";
  }) {
    await this.loadRecents();
    const canonical = await import("node:fs/promises").then(({ realpath }) =>
      realpath(session.directory),
    );
    const existing = this.recents.find((entry) => entry.directory === canonical);
    const entry: RecentEntry = {
      recentEntryId: existing?.recentEntryId ?? randomUUID(),
      projectId: session.projectId,
      displayName: session.name,
      projectKind: session.projectKind ?? existing?.projectKind,
      displayPath: canonical,
      directory: canonical,
      lastOpenedAt: new Date().toISOString(),
    };
    const previous = this.recents;
    const busyDirectories = new Set(
      [...this.projectOwners.values()]
        .filter(({ store }) => this.activity(store))
        .map(({ store }) => store.directory),
    );
    this.recents = [entry, ...this.recents.filter((item) => item.directory !== canonical)].filter(
      (item, index) => index < 30 || busyDirectories.has(item.directory),
    );
    await this.persistRecents();
    for (const prior of previous)
      if (!this.recents.some((item) => item.recentEntryId === prior.recentEntryId))
        await this.forgetRecentHistory(prior.recentEntryId);
    const store = [...this.projectOwners.values()].find(
      (item) => item.store.directory === canonical && item.store.projectId === entry.projectId,
    )?.store;
    if (store)
      await this.filingHistory
        .observe(store, entry)
        .catch(() => store.warnings.push("生成历史索引不可用，重新打开项目后重建"));
  }

  private async forgetRecentHistory(id: string) {
    try {
      await this.filingHistory.forget(id);
    } catch {
      console.warn("最近项目的访问权限已移除，生成历史缓存未清理");
    }
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

  async recentProjectLocations() {
    await this.loadRecents();
    return this.recents.map(({ projectId, directory }) => ({ projectId, directory }));
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
