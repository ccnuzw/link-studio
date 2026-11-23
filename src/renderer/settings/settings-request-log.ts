import type { SettingsAPI, SettingsInput, SettingsMethod, SettingsValues } from "@link-studio/core";

type Entry = {
  key: number;
  method: SettingsMethod;
  modelId?: string;
  time: number;
  elapsed: number;
  result: string;
};
let entries: Entry[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
export const getSettingsLog = () => entries;
export function subscribeSettingsLog(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function clearSettingsLog() {
  entries = [];
  for (const listener of listeners) listener();
}

function loggedMethod<Method extends SettingsMethod>(method: Method) {
  return async (input: SettingsInput<Method>) => {
    const time = Date.now();
    let result = "SETTINGS_ACTION_FAILED";
    let modelId =
      method.startsWith("model") && "id" in input && typeof input.id === "string"
        ? input.id
        : undefined;
    try {
      const invoke = window.desktop.settings[method] as (
        input: SettingsInput<Method>,
      ) => Promise<{ ok: true; value: SettingsValues[Method] } | { ok: false; code: string }>;
      const response = await invoke(input);
      result = response.ok ? "成功" : response.code;
      if (response.ok && method === "modelSave")
        modelId = (response.value as SettingsValues["modelSave"]).id;
      if (response.ok && method === "modelTrial")
        result = (response.value as SettingsValues["modelTrial"]).status;
      return response;
    } finally {
      entries = [
        { key: ++sequence, method, modelId, time, elapsed: Date.now() - time, result },
        ...entries,
      ].slice(0, 200);
      for (const listener of listeners) listener();
    }
  };
}

const methods = [
  "list",
  "channelList",
  "filingAssets",
  "channelSave",
  "channelKeys",
  "channelRemove",
  "channelReorder",
  "channelCatalog",
  "modelSave",
  "modelDraftRead",
  "modelImport",
  "modelToggle",
  "modelReorder",
  "modelRemove",
  "modelMove",
  "modelPendingEdit",
  "modelTrial",
  "draft",
  "pluginUpload",
  "pluginDetail",
  "pluginPinnedModels",
  "pluginDeleteCheck",
  "pluginUpgradeOptions",
  "pluginCheck",
  "pluginToggle",
  "pluginRemove",
  "pluginUpgrade",
  "pluginUpgradeAll",
] as const satisfies readonly SettingsMethod[];
export const settingsRequests = Object.fromEntries(
  methods.map((method) => [method, loggedMethod(method)]),
) as Pick<SettingsAPI, (typeof methods)[number]>;
