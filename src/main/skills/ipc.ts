import { type SkillsInput, type SkillsMethod, skillsRequests } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain } from "electron";
import { isTrustedDocument } from "../security";
import { readSkillPackage, SkillError } from "./intake";
import { SkillLibrary } from "./library";

export class SkillsIpc {
  private readonly windows = new Map<number, string>();
  private readonly importing = new Set<number>();
  private library?: SkillLibrary;

  constructor(private readonly directory: string) {
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

  private dispatch(
    library: SkillLibrary,
    event: IpcMainInvokeEvent,
    method: SkillsMethod,
    input: unknown,
  ) {
    const owner = event.sender.id;
    switch (method) {
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
      case "removeVersion":
        return library.removeVersion(input as SkillsInput<"removeVersion">);
      case "remove":
        return library.remove(input as SkillsInput<"remove">);
      case "preview":
        return library.preview(owner, input as SkillsInput<"preview">);
    }
  }
}
