import type {
  AppInfo,
  DesktopAPI,
  DesktopResult,
  ProjectExportProgress,
  ProjectMethod,
  ProjectRequest,
  ProjectValues,
  SettingsAPI,
  SettingsInput,
  SettingsMethod,
  SkillResult,
  SkillsInput,
  SkillsMethod,
  SkillsValues,
} from "@link-studio/core";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const projectChannels: Record<ProjectMethod, string> = {
  canvasAgent: "link-studio:canvas-agent:action",
  listJobs: "link-studio:jobs:list",
  submitJob: "link-studio:jobs:submit",
  submitJobs: "link-studio:jobs:submitBatch",
  cancelJob: "link-studio:jobs:cancel",
  recheckJob: "link-studio:jobs:recheck",
  selectProject: "link-studio:dialogs:selectProject",
  selectProjectParent: "link-studio:dialogs:selectProjectParent",
  create: "link-studio:projects:create",
  open: "link-studio:projects:open",
  listRecent: "link-studio:projects:listRecent",
  openRecent: "link-studio:projects:openRecent",
  removeRecent: "link-studio:projects:removeRecent",
  getState: "link-studio:projects:getState",
  getCanvas: "link-studio:canvas:get",
  rename: "link-studio:projects:rename",
  flush: "link-studio:projects:flush",
  close: "link-studio:projects:close",
  selectMedia: "link-studio:dialogs:selectMedia",
  importAsset: "link-studio:assets:import",
  startImport: "link-studio:assets:startImport",
  getImport: "link-studio:assets:getImport",
  cancelImport: "link-studio:assets:cancelImport",
  commitImport: "link-studio:assets:commitImport",
  getAssetPreview: "link-studio:assets:getPreview",
  inspectAsset: "link-studio:assets:inspect",
  trimAsset: "link-studio:assets:trim",
  splitAsset: "link-studio:assets:split",
  annotateAsset: "link-studio:assets:annotate",
  exportComposition: "link-studio:composition:export",
  saveDirectorPreview: "link-studio:director:savePreview",
  cancelMediaTool: "link-studio:assets:cancelMediaTool",
  relocateAsset: "link-studio:assets:relocate",
  applyCanvasOperations: "link-studio:canvas:applyOperations",
  discardMedia: "link-studio:assets:discardMedia",
  listAssets: "link-studio:assets:list",
  removeAsset: "link-studio:assets:remove",
};

const settingsChannels: Record<SettingsMethod, string> = {
  list: "link-studio:settings:list",
  channelList: "link-studio:settings:channelList",
  channelSave: "link-studio:settings:channelSave",
  channelKeys: "link-studio:settings:channelKeys",
  channelRemove: "link-studio:settings:channelRemove",
  channelReorder: "link-studio:settings:channelReorder",
  channelCatalog: "link-studio:settings:channelCatalog",
  modelSave: "link-studio:settings:modelSave",
  modelImport: "link-studio:settings:modelImport",
  modelToggle: "link-studio:settings:modelToggle",
  modelReorder: "link-studio:settings:modelReorder",
  modelRemove: "link-studio:settings:modelRemove",
  draft: "link-studio:settings:draft",
  pluginCheck: "link-studio:settings:pluginCheck",
  pluginToggle: "link-studio:settings:pluginToggle",
  pluginRemove: "link-studio:settings:pluginRemove",
  pluginUpgrade: "link-studio:settings:pluginUpgrade",
  catalog: "link-studio:settings:catalog",
  catalogDraft: "link-studio:settings:catalogDraft",
  addModels: "link-studio:settings:addModels",
  save: "link-studio:settings:save",
  disable: "link-studio:settings:disable",
  test: "link-studio:settings:test",
  modelTrial: "link-studio:settings:modelTrial",
  agentTestConnection: "link-studio:settings:agentTestConnection",
  agentList: "link-studio:settings:agentList",
  agentCreate: "link-studio:settings:agentCreate",
  agentState: "link-studio:settings:agentState",
  agentSend: "link-studio:settings:agentSend",
  agentStop: "link-studio:settings:agentStop",
  agentContinue: "link-studio:settings:agentContinue",
  agentConfigureSecret: "link-studio:settings:agentConfigureSecret",
  agentDecide: "link-studio:settings:agentDecide",
};

async function invokeProject<Method extends ProjectMethod>(
  method: Method,
  input: Omit<ProjectRequest<Method>, "requestId">,
) {
  return ipcRenderer.invoke(projectChannels[method], {
    ...input,
    requestId: crypto.randomUUID(),
  }) as Promise<import("@link-studio/core").ProjectResult<ProjectValues[Method]>>;
}

async function invokeSkill<Method extends SkillsMethod>(
  method: Method,
  input: SkillsInput<Method>,
): Promise<SkillResult<SkillsValues[Method]>> {
  try {
    return await ipcRenderer.invoke(`link-studio:skills:${method}`, input);
  } catch {
    return { ok: false, message: "暂时无法连接本地技能库。" };
  }
}

const desktop: DesktopAPI = {
  skills: {
    list: (input) => invokeSkill("list", input),
    pick: (input) => invokeSkill("pick", input),
    drop: async (file) => {
      try {
        const path = webUtils.getPathForFile(file);
        if (path) return await invokeSkill("drop", { path });
      } catch {}
      return { ok: false, message: "无法读取拖入的文件，请使用导入对话框选择。" };
    },
    discard: (input) => invokeSkill("discard", input),
    confirm: (input) => invokeSkill("confirm", input),
    update: (input) => invokeSkill("update", input),
    activate: (input) => invokeSkill("activate", input),
    removeVersion: (input) => invokeSkill("removeVersion", input),
    remove: (input) => invokeSkill("remove", input),
    preview: (input) => invokeSkill("preview", input),
  },
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
  dialogs: {
    selectProject: () => invokeProject("selectProject", {}),
    selectProjectParent: () => invokeProject("selectProjectParent", {}),
    selectMedia: (input) => invokeProject("selectMedia", input),
  },
  projects: {
    canvasAgent: (input) => invokeProject("canvasAgent", input),
    listJobs: (input) => invokeProject("listJobs", input),
    submitJob: (input) => invokeProject("submitJob", input),
    submitJobs: (input) => invokeProject("submitJobs", input),
    cancelJob: (input) => invokeProject("cancelJob", input),
    recheckJob: (input) => invokeProject("recheckJob", input),
    create: (input) => invokeProject("create", input),
    open: (input) => invokeProject("open", input),
    listRecent: () => invokeProject("listRecent", {}),
    openRecent: (input) => invokeProject("openRecent", input),
    removeRecent: (input) => invokeProject("removeRecent", input),
    getState: (input) => invokeProject("getState", input),
    getCanvas: (input) => invokeProject("getCanvas", input),
    rename: (input) => invokeProject("rename", input),
    flush: (input) => invokeProject("flush", input),
    close: (input) => invokeProject("close", input),
    importAsset: (input) => invokeProject("importAsset", input),
    startImport: (input) => invokeProject("startImport", input),
    getImport: (input) => invokeProject("getImport", input),
    cancelImport: (input) => invokeProject("cancelImport", input),
    commitImport: (input) => invokeProject("commitImport", input),
    getAssetPreview: (input) => invokeProject("getAssetPreview", input),
    inspectAsset: (input) => invokeProject("inspectAsset", input),
    trimAsset: (input) => invokeProject("trimAsset", input),
    splitAsset: (input) => invokeProject("splitAsset", input),
    annotateAsset: (input) => invokeProject("annotateAsset", input),
    exportComposition: (input) => invokeProject("exportComposition", input),
    saveDirectorPreview: (input) => invokeProject("saveDirectorPreview", input),
    cancelMediaTool: (input) => invokeProject("cancelMediaTool", input),
    relocateAsset: (input) => invokeProject("relocateAsset", input),
    applyCanvasOperations: (input) => invokeProject("applyCanvasOperations", input),
    discardMedia: (input) => invokeProject("discardMedia", input),
    listAssets: (input) => invokeProject("listAssets", input),
    removeAsset: (input) => invokeProject("removeAsset", input),
  },
  projectEvents: {
    onExportProgress: (listener: (event: ProjectExportProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: ProjectExportProgress) =>
        listener(value);
      ipcRenderer.on("link-studio:composition:progress", handler);
      return () => ipcRenderer.removeListener("link-studio:composition:progress", handler);
    },
  },
  canvasWindow: {
    setPending: (pending) => ipcRenderer.send("link-studio:canvas:pending", pending),
    onSaveBeforeClose: (save) => {
      const listener = async () => {
        let saved = false;
        try {
          saved = await save();
        } catch {
          saved = false;
        } finally {
          ipcRenderer.send("link-studio:canvas:closeResult", saved);
        }
      };
      ipcRenderer.on("link-studio:canvas:saveBeforeClose", listener);
      return () => ipcRenderer.removeListener("link-studio:canvas:saveBeforeClose", listener);
    },
  },
  settings: {
    channelList: (input) => invokeSettings("channelList", input),
    channelSave: (input) => invokeSettings("channelSave", input),
    channelKeys: (input) => invokeSettings("channelKeys", input),
    channelRemove: (input) => invokeSettings("channelRemove", input),
    channelReorder: (input) => invokeSettings("channelReorder", input),
    channelCatalog: (input) => invokeSettings("channelCatalog", input),
    modelSave: (input) => invokeSettings("modelSave", input),
    modelImport: (input) => invokeSettings("modelImport", input),
    modelToggle: (input) => invokeSettings("modelToggle", input),
    modelReorder: (input) => invokeSettings("modelReorder", input),
    modelRemove: (input) => invokeSettings("modelRemove", input),
    list: (input) => invokeSettings("list", input),
    draft: (input) => invokeSettings("draft", input),
    pluginCheck: (input) => invokeSettings("pluginCheck", input),
    pluginToggle: (input) => invokeSettings("pluginToggle", input),
    pluginRemove: (input) => invokeSettings("pluginRemove", input),
    pluginUpgrade: (input) => invokeSettings("pluginUpgrade", input),
    catalog: (input) => invokeSettings("catalog", input),
    catalogDraft: (input) => invokeSettings("catalogDraft", input),
    addModels: (input) => invokeSettings("addModels", input),
    save: (input) => invokeSettings("save", input),
    disable: (input) => invokeSettings("disable", input),
    test: (input) => invokeSettings("test", input),
    modelTrial: (input) => invokeSettings("modelTrial", input),
    agentTestConnection: (input) => invokeSettings("agentTestConnection", input),
    agentList: (input) => invokeSettings("agentList", input),
    agentCreate: (input) => invokeSettings("agentCreate", input),
    agentState: (input) => invokeSettings("agentState", input),
    agentSend: (input) => invokeSettings("agentSend", input),
    agentStop: (input) => invokeSettings("agentStop", input),
    agentContinue: (input) => invokeSettings("agentContinue", input),
    agentConfigureSecret: (input) => invokeSettings("agentConfigureSecret", input),
    agentDecide: (input) => invokeSettings("agentDecide", input),
  },
};

function invokeSettings<Method extends SettingsMethod>(
  method: Method,
  input: SettingsInput<Method>,
) {
  return ipcRenderer.invoke(settingsChannels[method], input) as ReturnType<SettingsAPI[Method]>;
}

contextBridge.exposeInMainWorld("desktop", desktop);
