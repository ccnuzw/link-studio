import { Value } from "@sinclair/typebox/value";
import {
  type BrowserWindow,
  ipcMain,
  Notification,
  nativeTheme,
  safeStorage,
  webContents,
} from "electron";
import {
  type SettingsInput,
  type SettingsMethod,
  type SettingsValues,
  settingsRequests,
} from "../../../packages/link-studio-core/src/settings-api.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import { isTrustedDocument } from "../security.ts";
import { SettingsAgent } from "./agent.ts";
import { runModelTrial, type TrialCheckpoint } from "./model-trial.ts";
import { SettingsRegistry } from "./registry.ts";
import { TrialMediaStore } from "./trial-media.ts";
import { uploadTrialReference } from "./trial-reference-upload.ts";

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
  readonly trialMedia = new TrialMediaStore();
  private readonly windows = new Map<number, string>();
  private readonly observedSessions = new Map<number, Map<string, string>>();

  private observeSession = (owner: number, scope: string, id: string) => {
    if (!this.windows.has(owner)) return;
    const sessions = this.observedSessions.get(owner) ?? new Map<string, string>();
    sessions.set(scope, id);
    this.observedSessions.set(owner, sessions);
  };

  private notifySession = (id: string) => {
    for (const [owner, sessions] of this.observedSessions) {
      if (![...sessions.values()].includes(id)) continue;
      const content = webContents.fromId(owner);
      const trusted = this.windows.get(owner);
      if (
        content &&
        !content.isDestroyed() &&
        trusted &&
        isTrustedDocument(content.getURL(), trusted)
      )
        content.send("link-studio:agent:changed", id);
    }
  };
  private readonly trials = new Map<string, NonNullable<SettingsValues["modelTrialProgress"]>>();
  private services?: Promise<{
    registry: SettingsRegistry;
    agent: SettingsAgent;
    observeSession: SettingsIpc["observeSession"];
  }>;

  open() {
    this.services ??= SettingsRegistry.open(
      this.directory,
      this.pluginDirectory,
      this.runnerPath,
      {
        encrypt: (secret) => storage(() => safeStorage.encryptString(secret)),
        decrypt: (ciphertext) => storage(() => safeStorage.decryptString(Buffer.from(ciphertext))),
      },
      undefined,
      this.recentProjects,
    )
      .then((registry) => ({
        registry,
        agent: new SettingsAgent(
          registry,
          this.directory,
          this.workerPath,
          this.canvas,
          this.notifySession,
        ),
        observeSession: this.observeSession,
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
    private readonly recentProjects?: () => Promise<
      readonly { projectId: string; directory: string }[]
    >,
  ) {
    ipcMain.handle("link-studio:trial:upload-reference", async (event, input) => {
      const trusted = this.windows.get(event.sender.id);
      if (
        !trusted ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        !isTrustedDocument(event.senderFrame.url, trusted) ||
        typeof input?.path !== "string" ||
        input.path.length > 4096 ||
        typeof input.mime !== "string" ||
        !Number.isSafeInteger(input.maximum)
      )
        return { ok: false };
      const endpoint = process.env.LINK_STUDIO_TRIAL_ASSET_ENDPOINT;
      if (!endpoint) return { ok: true };
      const controller = new AbortController();
      const abort = () => controller.abort();
      event.sender.once("destroyed", abort);
      try {
        const url = await uploadTrialReference(
          input.path,
          input.mime,
          input.maximum,
          endpoint,
          process.env.LINK_STUDIO_TRIAL_ASSET_TOKEN,
          controller.signal,
        );
        return { ok: true, url };
      } catch {
        return { ok: false };
      } finally {
        event.sender.removeListener("destroyed", abort);
      }
    });
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
          const value = await this.dispatch(registry, agent, method, input, event.sender.id);
          if (method === "agentState")
            this.observeSession(
              event.sender.id,
              "settings",
              (input as SettingsInput<"agentState">).sessionId,
            );
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
          return {
            ok: false,
            code,
            ...((method === "pluginUpload" ||
              (method === "pluginRemove" &&
                ["PLUGIN_REFERENCED", "PLUGIN_JOB_REFERENCED", "PLUGIN_VERSION_MISSING"].includes(
                  code,
                ))) &&
              error instanceof ProviderError &&
              error.issues && { issues: error.issues }),
          };
        }
      });
    }
  }

  private dispatch(
    registry: SettingsRegistry,
    agent: SettingsAgent,
    method: SettingsMethod,
    input: unknown,
    senderId: number,
  ) {
    switch (method) {
      case "list":
        return registry.list();
      case "agentPreferences":
        return registry.agentPreferences(input as SettingsInput<"agentPreferences">);
      case "dramaPromptLibrary":
        return registry.dramaPromptLibrary(input as SettingsInput<"dramaPromptLibrary">);
      case "agentNoticePermission":
        if (!Notification.isSupported()) return { permission: "denied" };
        return registry.agentNoticePermission(input as SettingsInput<"agentNoticePermission">);
      case "agentLayout":
        return registry.agentLayout(input as SettingsInput<"agentLayout">);
      case "canvasView": {
        const preferences = registry.canvasView(input as SettingsInput<"canvasView">);
        if (nativeTheme.themeSource !== preferences.theme)
          nativeTheme.themeSource = preferences.theme;
        return preferences;
      }
      case "channelList":
        return registry.channelList();
      case "channelLoads":
        return registry.channelLoads();
      case "filingAssets":
        return registry.filingAssets(input as SettingsInput<"filingAssets">);
      case "filingStorage":
        return registry.filingStorage();
      case "filingStorageSave":
        return registry.saveFilingStorage(input as SettingsInput<"filingStorageSave">);
      case "filingPreview":
        return registry
          .filingPreview(input as SettingsInput<"filingPreview">)
          .then((blob) =>
            blob && this.windows.has(senderId) ? this.trialMedia.grant(senderId, blob) : null,
          );
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
      case "modelDraftRead":
        return registry.modelDraftRead(input as SettingsInput<"modelDraftRead">);
      case "modelLimits":
        return registry.modelLimits(input as SettingsInput<"modelLimits">);
      case "modelImport":
        return registry.modelImport(input as SettingsInput<"modelImport">);
      case "modelToggle":
        return registry.modelToggle(input as SettingsInput<"modelToggle">);
      case "modelReorder":
        return registry.modelReorder(input as SettingsInput<"modelReorder">);
      case "modelRemove":
        return registry.modelRemove(input as SettingsInput<"modelRemove">);
      case "modelMove":
        return registry.modelMove(input as SettingsInput<"modelMove">);
      case "modelPendingEdit":
        return registry.modelPendingEdit(input as SettingsInput<"modelPendingEdit">);
      case "draft":
        return registry.draft((input as SettingsInput<"draft">).source);
      case "pluginUpload":
        return registry.pluginUpload((input as SettingsInput<"pluginUpload">).source);
      case "pluginDetail":
        return registry.pluginDetail(input as SettingsInput<"pluginDetail">);
      case "pluginPinnedModels":
        return registry.pluginPinnedModels(input as SettingsInput<"pluginPinnedModels">);
      case "pluginDeleteCheck":
        return registry.pluginDeleteCheck(input as SettingsInput<"pluginDeleteCheck">);
      case "pluginUpgradeOptions":
        return registry.pluginUpgradeOptions(input as SettingsInput<"pluginUpgradeOptions">);
      case "pluginCheck":
        return registry.pluginCheck(input as SettingsInput<"pluginCheck">);
      case "pluginToggle":
        return registry.pluginToggle(input as SettingsInput<"pluginToggle">);
      case "pluginRemove":
        return registry.pluginRemove(input as SettingsInput<"pluginRemove">);
      case "pluginUpgrade":
        return registry.pluginUpgrade(input as SettingsInput<"pluginUpgrade">);
      case "pluginUpgradeAll":
        return registry.pluginUpgradeAll(input as SettingsInput<"pluginUpgradeAll">);
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
      case "modelTrialProgress":
        return (
          this.trials.get((input as SettingsInput<"modelTrialProgress">).runId) ??
          registry.trialProgress((input as SettingsInput<"modelTrialProgress">).runId)
        );
      case "modelTrialTrace": {
        const trial = input as SettingsInput<"modelTrialTrace">;
        return registry.trialTrace(trial.id, trial.expectedRevision, trial.runId);
      }
      case "modelTrialResult": {
        const trial = input as SettingsInput<"modelTrialResult">;
        const latest = registry.trialLatest(trial.id, trial.expectedRevision, trial.runId);
        if (!latest) return null;
        if (latest.result) {
          for (const output of latest.result.outputs) {
            if (!output.previewUrl) continue;
            const blob = registry.trialOutput(latest.runId, output.previewUrl);
            output.previewUrl = blob && this.trialMedia.grant(senderId, blob);
          }
        } else if (!this.trials.has(latest.runId)) {
          const checkpoint = registry.trialCheckpoint(latest.runId);
          if (checkpoint) {
            void this.executeTrial(
              registry,
              { ...trial, runId: latest.runId, params: {}, prompt: "", dry: false },
              senderId,
              checkpoint,
            ).catch(() => undefined);
          } else {
            latest.result = {
              status: "unknown",
              error: "PROVIDER_OUTCOME_UNKNOWN",
              trace: latest.progress?.trace ?? [],
              outputs: [],
              logs: [],
            };
            registry.trialSaveResult(latest.runId, latest.result);
          }
        }
        return latest;
      }
      case "modelTrial": {
        const trial = input as SettingsInput<"modelTrial">;
        const grant = (blob: Blob) => {
          if (!this.windows.has(senderId)) throw new ProviderError("SETTINGS_REQUEST_DENIED");
          return this.trialMedia.grant(senderId, blob);
        };
        if (!trial.runId || trial.dry) return runModelTrial(registry, trial, grant);
        registry.trialStart(trial.runId, trial.id, trial.expectedRevision);
        return this.executeTrial(registry, { ...trial, runId: trial.runId }, senderId);
      }
      case "agentTestConnection":
        return agent.testConnection(input as SettingsInput<"agentTestConnection">);
      default:
        return agent.run(method, input as SettingsInput<typeof method>);
    }
  }

  private async executeTrial(
    registry: SettingsRegistry,
    trial: SettingsInput<"modelTrial"> & { runId: string },
    senderId: number,
    checkpoint?: TrialCheckpoint,
  ) {
    const runId = trial.runId;
    const initial = registry.trialProgress(runId) ?? { phase: "submit", trace: [] };
    this.trials.set(runId, initial);
    try {
      const result = await runModelTrial(
        registry,
        trial,
        async (blob) => {
          const token = this.trialMedia.grant(senderId, blob);
          await registry.storeTrialOutput(runId, token, blob);
          return token;
        },
        (progress) => {
          this.trials.set(runId, progress);
          registry.trialSaveProgress(runId, progress);
        },
        {
          checkpoint,
          progress: initial,
          save: (value) => registry.saveTrialCheckpoint(runId, value),
        },
      );
      registry.trialSaveResult(runId, result);
      return result;
    } catch (error) {
      registry.trialSaveResult(runId, {
        status: checkpoint ? "unknown" : "failed",
        error: error instanceof ProviderError ? error.code : "PROVIDER_TEST_FAILED",
        trace: initial.trace,
        outputs: [],
        logs: [],
      });
      throw error;
    } finally {
      this.trials.delete(runId);
    }
  }

  registerWindow(window: BrowserWindow, document: string) {
    const id = window.webContents.id;
    this.windows.set(id, document);
    window.once("closed", () => {
      this.windows.delete(id);
      this.observedSessions.delete(id);
      this.trialMedia.close(id);
    });
  }
}
