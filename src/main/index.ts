import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  APP_INFO_CHANNEL,
  type AppInfo,
  OPEN_SOURCE_CHANNEL,
  sourceWebUrl,
} from "@link-studio/core";
import { app, BrowserWindow, ipcMain, nativeTheme, protocol, shell } from "electron";
import { getAppInfo } from "./app-info";
import { ProjectIpc } from "./project/ipc";
import { isTrustedDocument } from "./security";
import { SettingsIpc } from "./settings/ipc";
import { SettingsRegistry } from "./settings/registry";
import { SkillsIpc } from "./skills/ipc";

const mainDirectory = fileURLToPath(new URL(".", import.meta.url));
const iconPath = app.isPackaged
  ? join(process.resourcesPath, "icons/icon.png")
  : join(mainDirectory, "../../resources/icons/icon.png");
let mainWindow: BrowserWindow | null = null;
let projectIpc: ProjectIpc;
let settingsIpc: SettingsIpc;
let skillsIpc: SkillsIpc;

app.setName("灵可");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "link-media",
    privileges: { standard: true, secure: true, stream: true, corsEnabled: true },
  },
]);
if (process.env.LINK_STUDIO_TEST_USER_DATA) {
  app.setPath("userData", process.env.LINK_STUDIO_TEST_USER_DATA);
}

function createWindow() {
  const rendererFile = join(mainDirectory, "../renderer/index.html");
  const rendererUrl = !app.isPackaged
    ? process.env.ELECTRON_RENDERER_URL || pathToFileURL(rendererFile).href
    : pathToFileURL(rendererFile).href;

  const window = new BrowserWindow({
    title: "灵可 · Link Studio",
    icon: iconPath,
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#15191f" : "#ffffff",
    show: false,
    webPreferences: {
      preload: join(mainDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      partition: `workspace-${randomUUID()}`,
    },
  });
  mainWindow = window;
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  projectIpc.registerWindow(window, rendererUrl);
  settingsIpc.registerWindow(window, rendererUrl);
  skillsIpc.registerWindow(window, rendererUrl);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isTrustedDocument(destination, rendererUrl)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  ipcMain.removeHandler(OPEN_SOURCE_CHANNEL);
  ipcMain.handle(OPEN_SOURCE_CHANNEL, async (event, raw: unknown) => {
    const url = sourceWebUrl(raw);
    if (
      !url ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedDocument(event.senderFrame?.url ?? "", rendererUrl)
    )
      return false;
    return shell.openExternal(url).then(
      () => true,
      () => false,
    );
  });
  ipcMain.removeHandler(APP_INFO_CHANNEL);
  ipcMain.handle(APP_INFO_CHANNEL, (event, request: unknown) => {
    const trusted =
      event.sender.id === window.webContents.id &&
      event.senderFrame === window.webContents.mainFrame &&
      isTrustedDocument(event.senderFrame?.url ?? "", rendererUrl);
    const info: AppInfo = {
      productName: "灵可",
      agentName: "小灵",
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
    };
    return getAppInfo(request, trusted, info);
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    ipcMain.removeHandler(OPEN_SOURCE_CHANNEL);
    ipcMain.removeHandler(APP_INFO_CHANNEL);
  });
  window.loadURL(rendererUrl).catch(() => {
    console.error("桌面工作区加载失败");
    app.quit();
  });
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    if (mainWindow) mainWindow.focus();
    else if (app.isReady()) createWindow();
  });

if (primaryInstance)
  app.whenReady().then(() => {
    const runtimeRoot = app.isPackaged ? process.resourcesPath : join(mainDirectory, "..");
    const providerRunner = join(
      runtimeRoot,
      "provider-runtime",
      process.platform === "win32" ? "runner.exe" : "runner",
    );
    skillsIpc = new SkillsIpc(
      join(app.getPath("userData"), "skills"),
      async () => (await settingsIpc.open()).registry,
    );
    const settingsDirectory = join(app.getPath("userData"), "settings");
    nativeTheme.themeSource = SettingsRegistry.startupTheme(settingsDirectory);
    settingsIpc = new SettingsIpc(
      settingsDirectory,
      app.isPackaged
        ? join(process.resourcesPath, "provider-plugins")
        : join(mainDirectory, "../../resources/provider-plugins"),
      providerRunner,
      join(runtimeRoot, "agent-runtime/worker.mjs"),
      (command, args) => projectIpc.canvasCommand(command, args),
      () => projectIpc.recentProjectLocations(),
    );
    projectIpc = new ProjectIpc(
      app.getPath("userData"),
      join(mainDirectory, "../media"),
      () => settingsIpc.open(),
      settingsIpc.trialMedia,
      providerRunner,
    );
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(iconPath);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
