import type { AppInfo, DesktopAPI, DesktopResult } from "@link-studio/core";
import { contextBridge, ipcRenderer } from "electron";

const desktop: DesktopAPI = {
  app: {
    async getInfo(): Promise<DesktopResult<AppInfo>> {
      try {
        return await ipcRenderer.invoke("link-studio:app:get-info", {
          requestId: crypto.randomUUID(),
        });
      } catch {
        return { ok: false, error: { code: "INTERNAL", message: "无法读取桌面运行环境" } };
      }
    },
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);
