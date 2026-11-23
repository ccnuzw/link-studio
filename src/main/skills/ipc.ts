import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { type SkillsInput, type SkillsMethod, skillsRequests } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain } from "electron";
import { isTrustedDocument } from "../security";
import type { SettingsRegistry } from "../settings/registry";
import { readSkillPackage, SkillError } from "./intake";
import { SkillLibrary } from "./library";

export class SkillsIpc {
  private readonly windows = new Map<number, string>();
  private readonly importing = new Set<number>();
  private library?: SkillLibrary;
  private readonly trials = new Map<number, AbortController>();
  private readonly runningSteps = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly registry: () => Promise<SettingsRegistry>,
  ) {
    for (const method of Object.keys(skillsRequests) as SkillsMethod[]) {
      ipcMain.handle(`link-studio:skills:${method}`, async (event, input: unknown) => {
        const document = this.windows.get(event.sender.id);
        if (
          !document ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          !isTrustedDocument(event.senderFrame.url, document) ||
          !Value.Check(skillsRequests[method], input)
        )
          return { ok: false, message: "技能操作请求无效。" };
        try {
          this.library ??= new SkillLibrary(this.directory);
          return { ok: true, value: await this.dispatch(this.library, event, method, input) };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof SkillError ? error.message : "技能操作失败，请重试。",
          };
        }
      });
    }
  }

  registerWindow(window: BrowserWindow, document: string) {
    const owner = window.webContents.id;
    this.windows.set(owner, document);
    window.once("closed", () => {
      this.windows.delete(owner);
      this.trials.get(owner)?.abort();
      this.library?.discard(owner);
    });
  }

  private async inspect(
    library: SkillLibrary,
    event: IpcMainInvokeEvent,
    pick: () => Promise<string | undefined>,
  ) {
    const owner = event.sender.id;
    if (this.importing.has(owner)) throw new SkillError("正在预检另一个技能包。");
    this.importing.add(owner);
    try {
      const path = await pick();
      if (!path) return null;
      library.discard(owner);
      const pkg = await readSkillPackage(path).catch((error: unknown) => {
        if (error instanceof SkillError) throw error;
        throw new SkillError("无法读取技能包，请检查文件权限或重新选择。");
      });
      if (!this.windows.has(owner)) return null;
      return library.stage(owner, pkg);
    } finally {
      this.importing.delete(owner);
    }
  }

  private async dispatch(
    library: SkillLibrary,
    event: IpcMainInvokeEvent,
    method: SkillsMethod,
    input: unknown,
  ) {
    const owner = event.sender.id;
    switch (method) {
      case "steps": {
        const registry = await this.registry(),
          catalog = await registry.methodProtocols();
        return {
          ...catalog,
          models: registry.methodModels(),
          trials: library.stepHistory(),
          bindings: Object.fromEntries(
            catalog.protocols.map(({ key }) => {
              const { candidate, fallback } = library.resolveMethod(key);
              return [key, { candidate, fallback, ...library.methodTelemetry(key) }];
            }),
          ),
        };
      }
      case "bind":
        return library.bind(input as SkillsInput<"bind">);
      case "trial": {
        if (this.trials.has(owner)) throw new SkillError("请等待本次试跑结束。");
        const trial = input as SkillsInput<"trial">,
          controller = new AbortController();
        if (this.runningSteps.has(trial.step)) throw new SkillError("该环节已有试跑进行中。");
        this.runningSteps.add(trial.step);
        this.trials.set(owner, controller);
        try {
          const registry = await this.registry(),
            model = registry
              .methodModels()
              .find((entry) => entry.id === trial.model && entry.revision === trial.revision);
          if (!model) throw new SkillError("模型不可用或配置已变更。");
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) throw new SkillError("窗口已关闭。");
          const confirm = await dialog.showMessageBox(window, {
            type: "question",
            message: `使用 ${model.label} 试跑 ${trial.step}？`,
            detail: `将发送样例素材与${trial.compare ? "候选和当前生效方法" : "候选方法"}给所选模型。包含不合格输出的重写，最多 ${trial.compare ? 4 : 2} 次生成，可能产生模型费用。`,
            buttons: ["取消", "确认试跑"],
            cancelId: 0,
            defaultId: 0,
          });
          if (confirm.response !== 1) throw new SkillError("已取消试跑，未调用模型。");
          controller.signal.throwIfAborted();
          const { step, sample, candidate } = trial;
          const runs = [{ candidate, ...library.method(candidate), baseline: false }];
          const comparison = trial.compare ? randomUUID() : undefined;
          if (comparison) {
            const current = library.resolveMethod(step);
            runs.push({
              ...current,
              candidate: current.fallback ? { source: "builtin" } : current.candidate,
              baseline: true,
            });
          }
          const rows = [];
          for (const { identity, method, candidate, baseline } of runs) {
            controller.signal.throwIfAborted();
            let outcome: { passed: boolean; preview: string; issues: string[] };
            try {
              outcome = await registry.methodTrial(trial, method, controller.signal);
            } catch (error) {
              outcome = {
                passed: false,
                preview: "",
                issues: [
                  registry
                    .redactor()
                    .redact(error instanceof Error ? error.message : "试跑失败")
                    .slice(0, 512),
                ],
              };
            }
            rows.push(
              library.recordTrial(
                {
                  step,
                  sample,
                  candidate,
                  comparison,
                  baseline,
                  model: model.id,
                  passed: outcome.passed,
                  preview: outcome.preview,
                  issues: outcome.issues,
                },
                identity,
              ),
            );
          }
          return rows[0];
        } finally {
          this.trials.delete(owner);
          this.runningSteps.delete(trial.step);
        }
      }
      case "list":
        return library.list();
      case "pick":
        return this.inspect(library, event, async () => {
          const { kind } = input as SkillsInput<"pick">;
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) return;
          const result = await dialog.showOpenDialog(window, {
            title:
              kind === "folder"
                ? "选择技能文件夹"
                : kind === "zip"
                  ? "选择技能 ZIP"
                  : "选择 SKILL.md",
            properties: [kind === "folder" ? "openDirectory" : "openFile"],
            filters:
              kind === "folder"
                ? undefined
                : [
                    {
                      name: kind === "zip" ? "ZIP" : "Markdown",
                      extensions: [kind === "zip" ? "zip" : "md"],
                    },
                  ],
          });
          return result.canceled ? undefined : result.filePaths[0];
        });
      case "drop":
        return this.inspect(library, event, async () => (input as SkillsInput<"drop">).path);
      case "discard":
        return library.discard(owner, (input as SkillsInput<"discard">).id);
      case "confirm":
        return library.confirm(owner, input as SkillsInput<"confirm">);
      case "update":
        return library.update(input as SkillsInput<"update">);
      case "activate":
        return library.activate(input as SkillsInput<"activate">);
      case "exportZip": {
        const version = input as SkillsInput<"exportZip">;
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return false;
        const saved = await dialog.showSaveDialog(window, {
          defaultPath: `${version.name}-v${version.version}.zip`,
          filters: [{ name: "技能包", extensions: ["zip"] }],
        });
        if (saved.canceled || !saved.filePath) return false;
        await writeFile(saved.filePath, library.exportZip(version));
        return true;
      }
      case "removeVersion":
        return library.removeVersion(input as SkillsInput<"removeVersion">);
      case "remove":
        return library.remove(input as SkillsInput<"remove">);
      case "preview":
        return library.preview(owner, input as SkillsInput<"preview">);
    }
  }
}
