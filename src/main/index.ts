import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_INFO_CHANNEL, type AppInfo } from "@link-studio/core";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { getAppInfo } from "./app-info";
import { isTrustedDocument } from "./security";

const mainDirectory = fileURLToPath(new URL(".", import.meta.url));
const iconPath = app.isPackaged
  ? join(process.resourcesPath, "icons/icon.png")
  : join(mainDirectory, "../../resources/icons/icon.png");
let mainWindow: BrowserWindow | null = null;

app.setName("灵可");
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
    backgroundColor: "#15191f",
    show: false,
    webPreferences: {
      preload: join(mainDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isTrustedDocument(destination, rendererUrl)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
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
    ipcMain.removeHandler(APP_INFO_CHANNEL);
  });
  window.loadURL(rendererUrl).catch(() => {
    console.error("桌面工作区加载失败");
    app.quit();
  });
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(iconPath);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
