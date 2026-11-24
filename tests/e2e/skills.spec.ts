import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { expectDraft } from "./assistant-theme";
import { createCanvasProject } from "./workspace-actions";

test("技能导入需要确认，重启后可筛选和管理已保存版本", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-skills-e2e-"));
  const source = join(directory, "SKILL.md");
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: join(directory, "profile"),
    LINK_STUDIO_TEST_PROJECT_PARENT: directory,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const launch = () =>
    electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ["."] }), env });
  const openSkills = async (app: Awaited<ReturnType<typeof launch>>) => {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("button", { name: "技能管理" }).click();
    return page;
  };
  try {
    await writeFile(
      source,
      "---\nname: shot-list\ntitle: 镜头清单\ndescription: 整理镜头\n---\n# 镜头顺序\n",
    );
    const first = await launch();
    try {
      await first.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, source);
      const page = await openSkills(first);
      await expect(page.getByText("没有符合条件的技能")).toBeVisible();
      await page.getByRole("button", { name: "环节技能" }).click();
      const methods = page.getByRole("dialog", { name: "环节技能" });
      await expect(methods.getByLabel("环节", { exact: true }).locator("option")).toHaveCount(4);
      await expect(methods.getByRole("button", { name: "试跑候选方法" })).toBeDisabled();
      await methods.getByRole("button", { name: "关闭", exact: true }).last().click();
      await page.keyboard.press("/");
      await expect(page.getByRole("searchbox")).toBeFocused();
      await page.getByRole("button", { name: "导入技能" }).click();
      const modal = page.getByRole("dialog", { name: "导入技能" });
      await modal.getByRole("button", { name: "选择 SKILL.md" }).click();
      await expect(modal.getByText("# 镜头顺序", { exact: false })).toBeVisible();
      await modal.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByText("没有符合条件的技能")).toBeVisible();

      const session = await page.context().newCDPSession(page);
      const drop = { x: 180, y: 235, data: { items: [], files: [source], dragOperationsMask: 1 } };
      await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...drop });
      await session.send("Input.dispatchDragEvent", { type: "dragOver", ...drop });
      await session.send("Input.dispatchDragEvent", { type: "drop", ...drop });
      await expect(modal.getByText("新技能 · v1")).toBeVisible();
      await modal.getByRole("checkbox", { name: "画布 Agent" }).check();
      await modal.getByRole("button", { name: "确认导入" }).click();
      await expect(page.getByRole("status")).toContainText("已导入「镜头清单」v1");
    } finally {
      await first.close();
    }

    const canvas = await launch();
    try {
      const page = await canvas.firstWindow();
      await createCanvasProject(page);
      await page.getByRole("button", { name: "打开小灵" }).click();
      const panel = page.getByRole("region", { name: "画布小灵" });
      const editor = panel.getByLabel("画布消息");
      await page.setViewportSize({ width: 700, height: 800 });
      const trigger = panel.getByRole("button", { name: "插入技能" });
      await editor.fill("请整理");
      await editor.evaluate((element) => {
        element.focus();
        window.getSelection()!.collapse(element.querySelector("p")!.firstChild, 1);
      });
      await expect.poll(() => editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(1);
      await trigger.click();
      const picker = page.getByRole("dialog", { name: "插入技能" });
      await expect(picker.getByRole("tab", { name: "收藏" })).toBeDisabled();
      await expect(picker.getByRole("tab", { name: "我的" })).toBeDisabled();
      const search = picker.getByRole("textbox", { name: "搜索技能" });
      await search.fill("不存在");
      await expect(picker.getByText("没有找到匹配的技能")).toBeVisible();
      for (const query of ["SHOT-LIST", "整理镜头", "镜头清单"]) {
        await search.fill(query);
        await expect(picker.getByRole("button", { name: /镜头清单/ })).toBeVisible();
      }
      const anchor = await trigger.boundingBox(),
        popup = await picker.boundingBox();
      if (!anchor || !popup) throw new Error("技能弹层或按钮未显示");
      await expect
        .poll(async () => {
          const [currentAnchor, currentPopup] = await Promise.all([
            trigger.boundingBox(),
            picker.boundingBox(),
          ]);
          if (!currentAnchor || !currentPopup) return Infinity;
          return Math.abs(currentAnchor.y - currentPopup.y - currentPopup.height - 8);
        })
        .toBeLessThan(1);
      expect(popup.width).toBe(372);
      await page.screenshot({
        path: test.info().outputPath("skill-menu.png"),
        clip: {
          x: Math.max(0, popup.x - 12),
          y: popup.y - 12,
          width: popup.width + 16,
          height: anchor.y + anchor.height - popup.y + 24,
        },
      });
      await picker.getByRole("button", { name: /镜头清单/ }).click();
      await expect(picker).toHaveCount(0);
      await expectDraft(editor, "请@镜头清单 整理");
      await expect(editor).toBeFocused();
      await editor.press("X");
      await expectDraft(editor, "请@镜头清单 X整理");
      await editor.fill("/镜头");
      const menu = panel.locator(".assistant-inline-menu");
      await expect(menu).toBeVisible();
      const firstLine = await menu.boundingBox();
      if (!firstLine) throw new Error("技能菜单未显示");
      await editor.fill("上一行\n使用 /镜头");
      await expect.poll(async () => (await menu.boundingBox())?.y).toBeGreaterThan(firstLine.y);
      const nextLine = await menu.boundingBox();
      if (!nextLine) throw new Error("换行后技能菜单未显示");
      expect(nextLine.x + nextLine.width).toBeLessThanOrEqual(692);
      await expect(editor).toBeFocused();
      await editor.fill("使用 /镜头");
      await expect(panel.getByRole("option", { name: /镜头清单/ })).toBeVisible();
      await editor.press("Enter");
      await expectDraft(editor, "使用 @镜头清单 ");
      const inlineSkill = panel.locator(".agent-editor-chip[data-kind=skill]");
      await expect(inlineSkill).toHaveText("镜头清单");
      await expect(editor).toBeFocused();
      await editor.press("Backspace");
      await editor.press("Backspace");
      await expect(inlineSkill).toHaveCount(0);
      await expectDraft(editor, "使用 ");
      await editor.fill("https://example.com");
      await expect(panel.getByRole("listbox", { name: "插入技能" })).toHaveCount(0);
    } finally {
      await canvas.close();
    }

    const second = await launch();
    try {
      const page = await openSkills(second);
      await page.getByRole("button", { name: "画布 Agent", exact: true }).click();
      await expect(page.getByRole("row", { name: /镜头清单/ })).toBeVisible();
      await page.getByRole("searchbox").fill("不存在");
      await expect(page.getByText("没有符合条件的技能")).toBeVisible();
      await page.getByRole("searchbox").fill("整理镜头");
      await page.getByRole("row", { name: /镜头清单/ }).click();
      const detail = page.getByRole("dialog", { name: "技能详情" });
      await expect(detail.getByText("生效版本 · v1")).toBeVisible();
      await detail.getByRole("textbox", { name: "显示名称" }).fill("拍摄清单");
      await detail.getByRole("button", { name: "保存设置" }).click();
      await expect(detail.getByRole("status")).toContainText("设置已保存");
      await expect(detail.getByRole("button", { name: "删除技能" })).toBeDisabled();
      await detail.getByRole("checkbox", { name: "画布 Agent" }).uncheck();
      await detail.getByRole("button", { name: "保存设置" }).click();
      await detail.getByRole("button", { name: "删除技能" }).click();
      await detail.getByRole("button", { name: "确认删除" }).click();
      await expect(page.getByRole("status")).toContainText("已删除「拍摄清单」");
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("同模型对照试跑经确认后才能绑定，通过的结果可追溯", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-method-e2e-")),
    source = join(root, "SKILL.md");
  const facts = await readFile(
      "packages/provider-runtime/runner/marketing/samples/perfume_facts.json",
      "utf8",
    ),
    requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(body);
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: facts }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("服务不可用");
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: join(root, "profile") };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    await writeFile(
      source,
      "---\nname: facts-helper\ndescription: 商品事实\n---\n检查商品锚点 E2E",
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    }, source);
    const page = await app.firstWindow();
    await page.evaluate(async (port) => {
      const api = window.desktop.settings,
        channel = await api.channelSave({
          expectedRevision: 0,
          approve: true,
          secret: "fixture-key",
          fields: {
            name: "本机模拟",
            endpoint: `http://127.0.0.1:${port}`,
            allowLocal: true,
            enabled: true,
            sort: 0,
            headers: [],
          },
        });
      if (!channel.ok) throw Error(channel.code);
      const model = await api.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        upstreamModel: "fixture",
        config: {
          name: "本机视觉模型",
          kind: "agent",
          description: "",
          sort: 1,
          vision: true,
          timeoutSeconds: 10,
          agentDeadlineSeconds: 10,
        },
        settings: { api: "chat_completions" },
        enabled: true,
      });
      if (!model.ok) throw Error(model.code);
      const skills = window.desktop.skills,
        picked = await skills.pick({ kind: "markdown" });
      if (!picked.ok || !picked.value?.id) throw Error("预检失败");
      const saved = await skills.confirm({ id: picked.value.id, scopes: ["agent"], enabled: true });
      if (!saved.ok) throw Error(saved.message);
    }, address.port);
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("button", { name: "技能管理" }).click();
    await page.getByRole("button", { name: "环节技能" }).click();
    const dialog = page.getByRole("dialog", { name: "环节技能" });
    await dialog.getByRole("combobox", { name: /候选方法/ }).selectOption("facts-helper@1");
    await dialog.getByRole("checkbox", { name: /当前生效方法对比/ }).check();
    await dialog.getByRole("button", { name: "试跑候选方法" }).click();
    await expect(dialog.getByRole("alert")).toContainText("取消");
    expect(requests).toHaveLength(0);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await dialog.getByRole("button", { name: "试跑候选方法" }).click();
    await expect(dialog.getByRole("status")).toContainText("试跑通过");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("检查商品锚点 E2E");
    expect(requests[1]).not.toContain("检查商品锚点 E2E");
    await dialog
      .locator(".skill-confirm")
      .filter({ hasText: "候选 · facts-helper@1" })
      .getByRole("button", { name: "按此次试跑设为生效" })
      .click();
    await expect(dialog.getByText("当前生效：facts-helper@1")).toBeVisible();
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
