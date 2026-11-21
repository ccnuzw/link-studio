import { Value } from "@sinclair/typebox/value";
import { type BrowserWindow, ipcMain, safeStorage } from "electron";
import {
  type SettingsInput,
  type SettingsMethod,
  settingsRequests,
} from "../../../packages/link-studio-core/src/settings-api.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import { isTrustedDocument } from "../security.ts";
import { SettingsAgent } from "./agent.ts";
import { runModelTrial } from "./model-trial.ts";
import { SettingsRegistry } from "./registry.ts";

function storage<Result>(action: () => Result) {
  try {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error();
    return action();
  } catch {
    throw new ProviderError("PROVIDER_SECRET_STORE_UNAVAILABLE");
  }
}

export class SettingsIpc {
  private readonly windows = new Map<number, string>();
  private services?: Promise<{ registry: SettingsRegistry; agent: SettingsAgent }>;

  open() {
    this.services ??= SettingsRegistry.open(this.directory, this.pluginDirectory, this.runnerPath, {
      encrypt: (secret) => storage(() => safeStorage.encryptString(secret)),
      decrypt: (ciphertext) => storage(() => safeStorage.decryptString(Buffer.from(ciphertext))),
    })
      .then((registry) => ({
        registry,
        agent: new SettingsAgent(registry, this.directory, this.workerPath, this.canvas),
      }))
      .catch((error: unknown) => {
        this.services = undefined;
        throw error;
      });
    return this.services;
  }

  constructor(
    private readonly directory: string,
    private readonly pluginDirectory: string,
    private readonly runnerPath: string,
    private readonly workerPath: string,
    private readonly canvas?: (command: string, args: unknown) => Promise<unknown>,
  ) {
    for (const method of Object.keys(settingsRequests) as SettingsMethod[]) {
      ipcMain.handle(`link-studio:settings:${method}`, async (event, input: unknown) => {
        const trusted = this.windows.get(event.sender.id);
        if (
          !trusted ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          !isTrustedDocument(event.senderFrame.url, trusted) ||
          !Value.Check(settingsRequests[method], input)
        )
          return { ok: false, code: "SETTINGS_REQUEST_DENIED" };
        try {
          const { registry, agent } = await this.open();
          const value = await this.dispatch(registry, agent, method, input);
          return { ok: true, value };
        } catch (error) {
          const code =
            error instanceof ProviderError
              ? error.code
              : error &&
                  typeof error === "object" &&
                  "code" in error &&
                  typeof error.code === "string" &&
                  /^(?:AGENT|SETTINGS|PROVIDER)_[A-Z_]+$/.test(error.code)
                ? error.code
                : "SETTINGS_ACTION_FAILED";
          return { ok: false, code };
        }
      });
    }
  }

  private dispatch(
    registry: SettingsRegistry,
    agent: SettingsAgent,
    method: SettingsMethod,
    input: unknown,
  ) {
    switch (method) {
      case "list":
        return registry.list();
      case "channelList":
        return registry.channelList();
      case "channelSave":
        return registry.channelSave(input as SettingsInput<"channelSave">);
      case "channelKeys":
        return registry.channelKeys(input as SettingsInput<"channelKeys">);
      case "channelRemove":
        return registry.channelRemove(input as SettingsInput<"channelRemove">);
      case "channelReorder":
        return registry.channelReorder(input as SettingsInput<"channelReorder">);
      case "channelCatalog":
        return registry.channelCatalog(input as SettingsInput<"channelCatalog">);
      case "modelSave":
        return registry.modelSave(input as SettingsInput<"modelSave">);
      case "modelImport":
        return registry.modelImport(input as SettingsInput<"modelImport">);
      case "modelToggle":
        return registry.modelToggle(input as SettingsInput<"modelToggle">);
      case "modelReorder":
        return registry.modelReorder(input as SettingsInput<"modelReorder">);
      case "modelRemove":
        return registry.modelRemove(input as SettingsInput<"modelRemove">);
      case "draft":
        return registry.draft((input as SettingsInput<"draft">).source);
      case "pluginCheck":
        return registry.pluginCheck(input as SettingsInput<"pluginCheck">);
      case "pluginToggle":
        return registry.pluginToggle(input as SettingsInput<"pluginToggle">);
      case "pluginRemove":
        return registry.pluginRemove(input as SettingsInput<"pluginRemove">);
      case "pluginUpgrade":
        return registry.pluginUpgrade(input as SettingsInput<"pluginUpgrade">);
      case "catalog":
        return registry.catalog(input as SettingsInput<"catalog">);
      case "catalogDraft":
        return registry.catalogDraft(input as SettingsInput<"catalogDraft">);
      case "addModels":
        return registry.addModels(input as SettingsInput<"addModels">);
      case "save":
        return registry.save(input as SettingsInput<"save">);
      case "disable":
        return registry.disable(input as SettingsInput<"disable">);
      case "test":
        return registry.test(input as SettingsInput<"test">);
      case "modelTrial":
        return runModelTrial(registry, input as SettingsInput<"modelTrial">);
      case "agentTestConnection":
        return agent.testConnection(input as SettingsInput<"agentTestConnection">);
      default:
        return agent.run(method, input as SettingsInput<typeof method>);
    }
  }

  registerWindow(window: BrowserWindow, document: string) {
    const id = window.webContents.id;
    this.windows.set(id, document);
    window.once("closed", () => this.windows.delete(id));
  }
}
