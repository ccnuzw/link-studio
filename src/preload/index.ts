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
  drama: "link-studio:drama:document",
  estimateDramaScripts: "link-studio:drama:estimate-scripts",
  estimateDramaBreakdown: "link-studio:drama:estimate-breakdown",
  estimateDramaStoryboard: "link-studio:drama:estimate-storyboard",
  estimateDramaContinuation: "link-studio:drama:estimate-continuation",
  previewDramaSource: "link-studio:drama:preview-source",
  canvasAgent: "link-studio:canvas-agent:action",
  listJobs: "link-studio:jobs:list",
  submitJob: "link-studio:jobs:submit",
  submitJobs: "link-studio:jobs:submitBatch",
  cancelJob: "link-studio:jobs:cancel",
  retryCharacterImage: "link-studio:jobs:retry-character-image",
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
  droppedMedia: "link-studio:dialogs:droppedMedia",
  beginClipboardFile: "link-studio:assets:beginClipboardFile",
  appendClipboardFile: "link-studio:assets:appendClipboardFile",
  importAsset: "link-studio:assets:import",
  startImport: "link-studio:assets:startImport",
  attachImage: "link-studio:assets:attachImage",
  attachFiledImage: "link-studio:assets:attachFiledImage",
  enrollImage: "link-studio:assets:enrollImage",
  filingLibraryPage: "link-studio:library:filingPage",
  filingLibraryClose: "link-studio:library:filingClose",
  filingLibraryEnroll: "link-studio:library:filingEnroll",
  filingLibraryUpload: "link-studio:library:filingUpload",
  filingLibraryUploaded: "link-studio:library:filingUploaded",
  filingLibraryCancelUpload: "link-studio:library:filingCancelUpload",
  filingLibraryMore: "link-studio:library:filingMore",
  getImport: "link-studio:assets:getImport",
  cancelImport: "link-studio:assets:cancelImport",
  commitImport: "link-studio:assets:commitImport",
  getAssetPreview: "link-studio:assets:getPreview",
  captureCanvasClipboard: "link-studio:canvas:captureClipboard",
  pasteCanvasClipboard: "link-studio:canvas:pasteClipboard",
  readAudioForWaveform: "link-studio:assets:readAudioForWaveform",
  copyAssetImage: "link-studio:assets:copyImage",
  saveAssetCopy: "link-studio:assets:saveCopy",
  inspectAsset: "link-studio:assets:inspect",
  trimAsset: "link-studio:assets:trim",
  splitAsset: "link-studio:assets:split",
  annotateAsset: "link-studio:assets:annotate",
  exportComposition: "link-studio:composition:export",
  attachDirectorTake: "link-studio:director:attachTake",
  cancelMediaTool: "link-studio:assets:cancelMediaTool",
  relocateAsset: "link-studio:assets:relocate",
  applyCanvasOperations: "link-studio:canvas:applyOperations",
  discardMedia: "link-studio:assets:discardMedia",
  listAssets: "link-studio:assets:list",
  listLibrary: "link-studio:library:list",
  globalHistory: "link-studio:library:globalHistory",
  collectHistory: "link-studio:library:collectHistory",
  globalLibrary: "link-studio:library:globalList",
  importGlobalAsset: "link-studio:library:importGlobalAsset",
  dropGlobalAsset: "link-studio:library:dropGlobalAsset",
  cancelGlobalImport: "link-studio:library:cancelGlobalImport",
  registerLibrary: "link-studio:library:register",
  attachOfficialVoice: "link-studio:assets:attachOfficialVoice",
  attachLibrary: "link-studio:library:attach",
  createLibraryFolder: "link-studio:library:createFolder",
  listLibraryFolders: "link-studio:library:listFolders",
  renameLibraryFolder: "link-studio:library:renameFolder",
  deleteLibraryFolder: "link-studio:library:deleteFolder",
  moveLibraryItem: "link-studio:library:moveItem",
  removeLibraryItem: "link-studio:library:removeItem",
  removeAsset: "link-studio:assets:remove",
};

const settingsChannels: Record<SettingsMethod, string> = {
  list: "link-studio:settings:list",
  channelList: "link-studio:settings:channelList",
  channelLoads: "link-studio:settings:channelLoads",
  filingAssets: "link-studio:settings:filingAssets",
  filingStorage: "link-studio:settings:filingStorage",
  filingStorageSave: "link-studio:settings:filingStorageSave",
  filingPreview: "link-studio:settings:filingPreview",
  channelSave: "link-studio:settings:channelSave",
  channelKeys: "link-studio:settings:channelKeys",
  channelRemove: "link-studio:settings:channelRemove",
  channelReorder: "link-studio:settings:channelReorder",
  channelCatalog: "link-studio:settings:channelCatalog",
  modelSave: "link-studio:settings:modelSave",
  modelDraftRead: "link-studio:settings:modelDraftRead",
  modelLimits: "link-studio:settings:modelLimits",
  modelImport: "link-studio:settings:modelImport",
  modelToggle: "link-studio:settings:modelToggle",
  modelReorder: "link-studio:settings:modelReorder",
  modelRemove: "link-studio:settings:modelRemove",
  modelMove: "link-studio:settings:modelMove",
  modelPendingEdit: "link-studio:settings:modelPendingEdit",
  draft: "link-studio:settings:draft",
  pluginUpload: "link-studio:settings:pluginUpload",
  pluginDetail: "link-studio:settings:pluginDetail",
  pluginPinnedModels: "link-studio:settings:pluginPinnedModels",
  pluginDeleteCheck: "link-studio:settings:pluginDeleteCheck",
  pluginUpgradeOptions: "link-studio:settings:pluginUpgradeOptions",
  pluginCheck: "link-studio:settings:pluginCheck",
  pluginToggle: "link-studio:settings:pluginToggle",
  pluginRemove: "link-studio:settings:pluginRemove",
  pluginUpgrade: "link-studio:settings:pluginUpgrade",
  pluginUpgradeAll: "link-studio:settings:pluginUpgradeAll",
  catalog: "link-studio:settings:catalog",
  catalogDraft: "link-studio:settings:catalogDraft",
  addModels: "link-studio:settings:addModels",
  save: "link-studio:settings:save",
  disable: "link-studio:settings:disable",
  test: "link-studio:settings:test",
  modelTrial: "link-studio:settings:modelTrial",
  modelTrialProgress: "link-studio:settings:modelTrialProgress",
  modelTrialResult: "link-studio:settings:modelTrialResult",
  modelTrialTrace: "link-studio:settings:modelTrialTrace",
  agentTestConnection: "link-studio:settings:agentTestConnection",
  agentList: "link-studio:settings:agentList",
  agentCreate: "link-studio:settings:agentCreate",
  agentFeedback: "link-studio:settings:agentFeedback",
  agentPreferences: "link-studio:settings:agentPreferences",
  dramaPromptLibrary: "link-studio:settings:dramaPromptLibrary",
  agentNoticePermission: "link-studio:settings:agentNoticePermission",
  agentLayout: "link-studio:settings:agentLayout",
  canvasView: "link-studio:settings:canvasView",
  agentRename: "link-studio:settings:agentRename",
  agentRemove: "link-studio:settings:agentRemove",
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
    steps: (input) => invokeSkill("steps", input),
    trial: (input) => invokeSkill("trial", input),
    bind: (input) => invokeSkill("bind", input),
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
    exportZip: (input) => invokeSkill("exportZip", input),
    removeVersion: (input) => invokeSkill("removeVersion", input),
    remove: (input) => invokeSkill("remove", input),
    preview: (input) => invokeSkill("preview", input),
  },
  app: {
    openSource: (url) => ipcRenderer.invoke("link-studio:app:open-source", url),
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
    dropGlobalAsset: (file, operationId, folder) =>
      invokeProject("dropGlobalAsset", {
        path: webUtils.getPathForFile(file),
        operationId,
        ...(folder && { folder }),
      }),
    uploadTrialReference: (file, maximum) =>
      ipcRenderer.invoke("link-studio:trial:upload-reference", {
        path: webUtils.getPathForFile(file),
        mime: file.type,
        maximum,
      }),
    selectProject: () => invokeProject("selectProject", {}),
    selectProjectParent: () => invokeProject("selectProjectParent", {}),
    selectMedia: (input) => invokeProject("selectMedia", input),
    droppedMedia: (projectHandle, files) =>
      invokeProject("droppedMedia", {
        projectHandle,
        paths: files.map((file) => webUtils.getPathForFile(file)),
      }),
  },
  projects: {
    beginClipboardFile: (input) => invokeProject("beginClipboardFile", input),
    appendClipboardFile: (input) => invokeProject("appendClipboardFile", input),
    drama: (input) => invokeProject("drama", input),
    estimateDramaScripts: (input) => invokeProject("estimateDramaScripts", input),
    estimateDramaBreakdown: (input) => invokeProject("estimateDramaBreakdown", input),
    estimateDramaStoryboard: (input) => invokeProject("estimateDramaStoryboard", input),
    estimateDramaContinuation: (input) => invokeProject("estimateDramaContinuation", input),
    previewDramaSource: (input) => invokeProject("previewDramaSource", input),
    canvasAgent: (input) => invokeProject("canvasAgent", input),
    listJobs: (input) => invokeProject("listJobs", input),
    submitJob: (input) => invokeProject("submitJob", input),
    submitJobs: (input) => invokeProject("submitJobs", input),
    cancelJob: (input) => invokeProject("cancelJob", input),
    retryCharacterImage: (input) => invokeProject("retryCharacterImage", input),
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
    attachImage: (input) => invokeProject("attachImage", input),
    attachFiledImage: (input) => invokeProject("attachFiledImage", input),
    enrollImage: (input) => invokeProject("enrollImage", input),
    filingLibraryPage: (input) => invokeProject("filingLibraryPage", input),
    filingLibraryClose: (input) => invokeProject("filingLibraryClose", input),
    filingLibraryMore: (input) => invokeProject("filingLibraryMore", input),
    filingLibraryUpload: (input) => invokeProject("filingLibraryUpload", input),
    filingLibraryUploaded: (input) => invokeProject("filingLibraryUploaded", input),
    filingLibraryCancelUpload: (input) => invokeProject("filingLibraryCancelUpload", input),
    filingLibraryEnroll: (input) => invokeProject("filingLibraryEnroll", input),
    getImport: (input) => invokeProject("getImport", input),
    cancelImport: (input) => invokeProject("cancelImport", input),
    commitImport: (input) => invokeProject("commitImport", input),
    getAssetPreview: (input) => invokeProject("getAssetPreview", input),
    captureCanvasClipboard: (input) => invokeProject("captureCanvasClipboard", input),
    pasteCanvasClipboard: (input) => invokeProject("pasteCanvasClipboard", input),
    readAudioForWaveform: (input) => invokeProject("readAudioForWaveform", input),
    copyAssetImage: (input) => invokeProject("copyAssetImage", input),
    saveAssetCopy: (input) => invokeProject("saveAssetCopy", input),
    inspectAsset: (input) => invokeProject("inspectAsset", input),
    trimAsset: (input) => invokeProject("trimAsset", input),
    splitAsset: (input) => invokeProject("splitAsset", input),
    annotateAsset: (input) => invokeProject("annotateAsset", input),
    exportComposition: (input) => invokeProject("exportComposition", input),
    attachDirectorTake: (input) => invokeProject("attachDirectorTake", input),
    cancelMediaTool: (input) => invokeProject("cancelMediaTool", input),
    relocateAsset: (input) => invokeProject("relocateAsset", input),
    applyCanvasOperations: (input) => invokeProject("applyCanvasOperations", input),
    discardMedia: (input) => invokeProject("discardMedia", input),
    listAssets: (input) => invokeProject("listAssets", input),
    listLibrary: (input) => invokeProject("listLibrary", input),
    globalLibrary: (input) => invokeProject("globalLibrary", input),
    importGlobalAsset: (input) => invokeProject("importGlobalAsset", input),
    cancelGlobalImport: (input) => invokeProject("cancelGlobalImport", input),
    globalHistory: (input) => invokeProject("globalHistory", input),
    collectHistory: (input) => invokeProject("collectHistory", input),
    registerLibrary: (input) => invokeProject("registerLibrary", input),
    attachOfficialVoice: (input) => invokeProject("attachOfficialVoice", input),
    attachLibrary: (input) => invokeProject("attachLibrary", input),
    createLibraryFolder: (input) => invokeProject("createLibraryFolder", input),
    listLibraryFolders: (input) => invokeProject("listLibraryFolders", input),
    renameLibraryFolder: (input) => invokeProject("renameLibraryFolder", input),
    deleteLibraryFolder: (input) => invokeProject("deleteLibraryFolder", input),
    moveLibraryItem: (input) => invokeProject("moveLibraryItem", input),
    removeLibraryItem: (input) => invokeProject("removeLibraryItem", input),
    removeAsset: (input) => invokeProject("removeAsset", input),
  },
  projectEvents: {
    onAgentChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, id: unknown) => {
        if (typeof id === "string") listener(id);
      };
      ipcRenderer.on("link-studio:agent:changed", handler);
      return () => ipcRenderer.removeListener("link-studio:agent:changed", handler);
    },
    onGlobalImportProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, operationId: string, percent: number) =>
        listener(operationId, percent);
      ipcRenderer.on("link-studio:library:importProgress", handler);
      return () => ipcRenderer.removeListener("link-studio:library:importProgress", handler);
    },
    onLibraryChanged: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("link-studio:library:changed", handler);
      return () => ipcRenderer.removeListener("link-studio:library:changed", handler);
    },
    onExportProgress: (listener: (event: ProjectExportProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: ProjectExportProgress) =>
        listener(value);
      ipcRenderer.on("link-studio:composition:progress", handler);
      return () => ipcRenderer.removeListener("link-studio:composition:progress", handler);
    },
  },
  canvasWindow: {
    onActivateProject: (listener) => {
      const receive = (
        _event: Electron.IpcRendererEvent,
        activation: Parameters<typeof listener>[0],
      ) => listener(activation);
      ipcRenderer.on("link-studio:projects:activate", receive);
      return () => ipcRenderer.removeListener("link-studio:projects:activate", receive);
    },
    setNoticeCanvas: (handle, hidden) =>
      ipcRenderer.send("link-studio:canvas:noticeScope", handle, hidden),
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
    channelLoads: (input) => invokeSettings("channelLoads", input),
    filingAssets: (input) => invokeSettings("filingAssets", input),
    filingStorage: (input) => invokeSettings("filingStorage", input),
    filingStorageSave: (input) => invokeSettings("filingStorageSave", input),
    filingPreview: (input) => invokeSettings("filingPreview", input),
    channelSave: (input) => invokeSettings("channelSave", input),
    channelKeys: (input) => invokeSettings("channelKeys", input),
    channelRemove: (input) => invokeSettings("channelRemove", input),
    channelReorder: (input) => invokeSettings("channelReorder", input),
    channelCatalog: (input) => invokeSettings("channelCatalog", input),
    modelSave: (input) => invokeSettings("modelSave", input),
    modelDraftRead: (input) => invokeSettings("modelDraftRead", input),
    modelLimits: (input) => invokeSettings("modelLimits", input),
    modelImport: (input) => invokeSettings("modelImport", input),
    modelToggle: (input) => invokeSettings("modelToggle", input),
    modelReorder: (input) => invokeSettings("modelReorder", input),
    modelRemove: (input) => invokeSettings("modelRemove", input),
    modelMove: (input) => invokeSettings("modelMove", input),
    modelPendingEdit: (input) => invokeSettings("modelPendingEdit", input),
    list: (input) => invokeSettings("list", input),
    draft: (input) => invokeSettings("draft", input),
    pluginUpload: (input) => invokeSettings("pluginUpload", input),
    pluginDetail: (input) => invokeSettings("pluginDetail", input),
    pluginPinnedModels: (input) => invokeSettings("pluginPinnedModels", input),
    pluginDeleteCheck: (input) => invokeSettings("pluginDeleteCheck", input),
    pluginUpgradeOptions: (input) => invokeSettings("pluginUpgradeOptions", input),
    pluginCheck: (input) => invokeSettings("pluginCheck", input),
    pluginToggle: (input) => invokeSettings("pluginToggle", input),
    pluginRemove: (input) => invokeSettings("pluginRemove", input),
    pluginUpgrade: (input) => invokeSettings("pluginUpgrade", input),
    pluginUpgradeAll: (input) => invokeSettings("pluginUpgradeAll", input),
    catalog: (input) => invokeSettings("catalog", input),
    catalogDraft: (input) => invokeSettings("catalogDraft", input),
    addModels: (input) => invokeSettings("addModels", input),
    save: (input) => invokeSettings("save", input),
    disable: (input) => invokeSettings("disable", input),
    test: (input) => invokeSettings("test", input),
    modelTrial: (input) => invokeSettings("modelTrial", input),
    modelTrialProgress: (input) => invokeSettings("modelTrialProgress", input),
    modelTrialResult: (input) => invokeSettings("modelTrialResult", input),
    modelTrialTrace: (input) => invokeSettings("modelTrialTrace", input),
    agentTestConnection: (input) => invokeSettings("agentTestConnection", input),
    agentList: (input) => invokeSettings("agentList", input),
    agentCreate: (input) => invokeSettings("agentCreate", input),
    agentFeedback: (input) => invokeSettings("agentFeedback", input),
    agentPreferences: (input) => invokeSettings("agentPreferences", input),
    dramaPromptLibrary: (input) => invokeSettings("dramaPromptLibrary", input),
    agentNoticePermission: (input) => invokeSettings("agentNoticePermission", input),
    agentLayout: (input) => invokeSettings("agentLayout", input),
    canvasView: (input) => invokeSettings("canvasView", input),
    agentRename: (input) => invokeSettings("agentRename", input),
    agentRemove: (input) => invokeSettings("agentRemove", input),
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
