import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, type Page, test } from "@playwright/test";

async function chooseFilter(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("协议升降版保留兼容设置、补默认值并列出丢弃字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-protocol-version-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "模型设置" }).waitFor();
    await page.evaluate(async () => {
      const api = window.desktop.settings;
      const catalog = await api.list({});
      if (!catalog.ok) throw Error(catalog.code);
      const builtin = catalog.value.plugins.find((entry) => entry.key === "openai")!;
      const source =
        builtin.source +
        `\nObject.assign(module.exports.meta, {key:'version-test',name:'版本夹具',version:'1.0.0'}); module.exports.meta.channelSettings.flag={type:'boolean',label:'兼容模式'};`;
      const old = await api.pluginUpload({ source });
      const latest = await api.pluginUpload({
        source:
          source +
          `\nmodule.exports.meta.version='2.0.0'; module.exports.meta.channelSettings.extra={type:'number',label:'额外数量',default:7};`,
      });
      if (!old.ok || !latest.ok) throw Error("版本夹具登记失败");
      const created = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "版本测试",
          endpoint: "https://fixture.invalid",
          enabled: true,
          allowLocal: false,
          headers: [],
          sort: 0,
        },
      });
      if (!created.ok) throw Error(created.code);
      const imported = await api.modelImport({
        id: created.value.id,
        expectedRevision: created.value.revision,
        models: ["version-model"],
      });
      if (!imported.ok) throw Error(imported.code);
    });
    await page.getByRole("button", { name: "模型设置" }).click();
    const open = page.getByRole("button", { name: /^version-model/ });
    await open.click();
    const editor = page.getByRole("dialog", { name: "编辑模型" });
    await editor.getByRole("button", { name: "文本", exact: true }).click();
    await editor.getByLabel("搜索协议").fill("VERSION-TEST");
    await editor.getByRole("radio", { name: /^版本夹具/ }).click();
    const version = editor.getByLabel("协议版本");
    const prefix = editor.locator('[data-field="setting-pathPrefix"]');
    const extra = editor.locator('[data-field="setting-extra"]');
    const flag = editor.getByRole("switch", { name: "兼容模式" });
    await expect(flag).not.toBeChecked();
    await flag.press("Space");
    await expect(flag).toBeChecked();
    await expect(version).toHaveText("v2.0.0（最新）", { useInnerText: true });
    await prefix.fill("/custom");
    await extra.fill("99");
    await chooseFilter(page, "协议版本", "v1.0.0");
    await expect(prefix).toHaveValue("/custom");
    await expect(extra).toHaveCount(0);
    await expect(flag).toBeChecked();
    await expect(editor.getByText("新版本不再声明协议设置项：extra，已丢弃")).toBeVisible();
    await version.press("Enter");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(extra).toHaveValue("7");
    await expect(prefix).toHaveValue("/custom");
    const optional = editor.locator('[data-field="setting-api"]');
    const required = editor.locator('[data-field="setting-as"]');
    await chooseFilter(page, "接口", "（不设置）");
    await chooseFilter(page, "参考图传输格式", "请选择");
    await expect(optional).toHaveAttribute("aria-invalid", "false");
    await expect(required).toHaveAttribute("aria-invalid", "true");
    await expect(
      editor.getByRole("alert").filter({ hasText: "请填写参考图传输格式" }),
    ).toBeVisible();
    await chooseFilter(page, "参考图传输格式", "url");
    await expect(optional).toHaveText("（不设置）", { useInnerText: true });
    await editor.getByRole("button", { name: "保存模型" }).click();
    await expect(editor).toBeHidden();
    await open.click();
    await expect(version).toHaveText("v2.0.0（最新）", { useInnerText: true });
    await expect(prefix).toHaveValue("/custom");
    await expect(extra).toHaveValue("7");
    await expect(optional).toHaveText("responses", { useInnerText: true });
    await expect(flag).toBeChecked();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("协议鉴权变化：升级失败后手动取消或授权，试跑只使用批准的凭证位置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-auth-upgrade-"));
  const calls: { bearer: boolean; header: boolean }[] = [];
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === "POST" && request.url === "/v1/responses") {
      calls.push({
        bearer: request.headers.authorization === "Bearer fixture-upgrade-key",
        header: request.headers["x-version-key"] === "fixture-upgrade-key",
      });
      response
        .setHeader("content-type", "application/json")
        .end(
          JSON.stringify({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
          }),
        );
    } else response.writeHead(404).end();
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("回环服务不可用");
    const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    app = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env,
    });
    const page = await app.firstWindow();
    const fixture = await page.evaluate(async (port) => {
      const api = window.desktop.settings;
      const list = await api.list({});
      if (!list.ok) throw Error(list.code);
      const source =
        list.value.plugins.find((plugin) => plugin.key === "openai")!.source +
        "\nObject.assign(module.exports.meta,{key:'reauth',name:'授权对照',version:'1.0.0'});";
      const first = await api.draft({ source });
      if (!first.ok) throw Error(first.code);
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-upgrade-key",
        fields: {
          name: "本机授权渠道",
          endpoint: `http://127.0.0.1:${port}`,
          enabled: true,
          allowLocal: true,
          sort: 0,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      const saved = await api.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        pluginHash: first.value.hash,
        enabled: true,
        upstreamModel: "audit-model",
        settings: {},
        config: { kind: "text", name: "鉴权验收", sort: 0, description: "" },
      });
      if (!saved.ok) throw Error(saved.code);
      const next = await api.draft({
        source:
          source +
          "\nmodule.exports.meta.version='2.0.0';module.exports.meta.auth={type:'header',name:'X-Version-Key'};",
      });
      if (!next.ok) throw Error(next.code);
      return {
        id: saved.value.id,
        revision: saved.value.revision,
        first: first.value.hash,
        next: next.value.hash,
      };
    }, address.port);
    const upgrade = await page.evaluate(() =>
      window.desktop.settings.pluginUpgradeAll({ key: "reauth", approve: true }),
    );
    expect(upgrade).toMatchObject({
      ok: true,
      value: { upgraded: 0, failed: [{ id: fixture.id, code: "PLUGIN_UPGRADE_INCOMPATIBLE" }] },
    });
    const binding = () =>
      page.evaluate(async (id) => {
        const list = await window.desktop.settings.list({});
        if (!list.ok) throw Error(list.code);
        return list.value.providers.find((entry) => entry.id === id);
      }, fixture.id);
    const trial = (revision: number) =>
      page.evaluate(
        ({ id, revision }) =>
          window.desktop.settings.modelTrial({
            id,
            expectedRevision: revision,
            dry: false,
            prompt: "样例",
            params: {},
          }),
        { id: fixture.id, revision },
      );
    expect(await trial(fixture.revision)).toMatchObject({
      ok: true,
      value: { status: "succeeded" },
    });
    await page.getByRole("button", { name: "模型设置" }).click();
    await page.getByRole("button", { name: /^鉴权验收/ }).click();
    const editor = page.getByRole("dialog", { name: "编辑模型" });
    await chooseFilter(page, "协议版本", "v2.0.0（最新）");
    const save = editor.getByRole("button", { name: "保存模型" });
    const confirmation = page.getByRole("dialog", { name: "确认操作" });
    const browserWindow = await app.browserWindow(page);
    for (const [width, height] of [
      [1280, 800],
      [1024, 700],
    ] as const) {
      await browserWindow.evaluate((win, [width, height]) => win.setContentSize(width, height), [
        width,
        height,
      ] as const);
      await save.click();
      await expect(confirmation).toContainText("reauth@2.0.0");
      await expect(confirmation).toContainText("请求头（X-Version-Key）");
      await expect(confirmation).not.toContainText("fixture-upgrade-key");
      if (width === 1280) {
        await confirmation.getByRole("button", { name: "取消" }).click();
        await expect(editor).toBeVisible();
        expect(await binding()).toMatchObject({
          pluginHash: fixture.first,
          revision: fixture.revision,
        });
      } else await confirmation.getByRole("button", { name: "确认", exact: true }).click();
    }
    await expect(editor).toBeHidden();
    expect(await binding()).toMatchObject({
      pluginHash: fixture.next,
      revision: fixture.revision + 1,
    });
    expect(calls).toEqual([{ bearer: true, header: false }]);
    expect(await trial(fixture.revision + 1)).toMatchObject({
      ok: true,
      value: { status: "succeeded" },
    });
    expect(calls).toEqual([
      { bearer: true, header: false },
      { bearer: false, header: true },
    ]);
  } finally {
    await app?.close();
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("批量删除最后两个模型，列表刷新为空时结果仍可读", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-last-batch-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "模型设置" }).waitFor();
    await page.evaluate(async () => {
      const api = window.desktop.settings;
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "本地测试",
          endpoint: "https://fixture.invalid",
          allowLocal: false,
          sort: 10,
          enabled: true,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      const added = await api.modelImport({
        id: channel.value.id,
        expectedRevision: channel.value.revision,
        models: ["first-model", "last-model"],
      });
      if (!added.ok) throw Error(added.code);
    });
    await page.getByRole("button", { name: "模型设置" }).click();
    await page.getByRole("checkbox", { name: "选择本页模型" }).check();
    await page.getByRole("button", { name: "批量删除", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "删除 2 个模型？" })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(page.getByRole("region", { name: "渠道模型空状态" })).toBeVisible();
    const result = page.getByRole("dialog", { name: "批量删除完成" });
    await expect(result).toContainText("成功 2 项，跳过 0 项，失败 0 项。");
    await expect(result.getByRole("status")).toContainText("first-model、last-model");
    await result.getByRole("button", { name: "知道了" }).press("Enter");
    await expect(result).not.toBeVisible();
    const saved = await page.evaluate(() => window.desktop.settings.list({}));
    expect(saved.ok && saved.value.providers.length).toBe(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("渠道模型首次加载、失败重试及无 Key 空状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-model-list-load-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "模型设置" }).waitFor();
    const saved = await page.evaluate(() =>
      window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "空渠道",
          endpoint: "https://fixture.invalid",
          allowLocal: false,
          sort: 10,
          enabled: true,
          headers: [],
          running: 4,
        },
      }),
    );
    if (!saved.ok) throw Error(saved.code);
    await page.clock.install();
    await app.evaluate(({ ipcMain }, savedChannel) => {
      const channel = savedChannel.id;
      const channels = "link-studio:settings:channelList";
      ipcMain.removeHandler(channels);
      let firstChannel = true;
      ipcMain.handle(channels, async () => {
        if (!firstChannel) return { ok: true, value: [savedChannel] };
        firstChannel = false;
        await new Promise((resolve) => ipcMain.once("finish-channel-list-load", resolve));
        return { ok: false, code: "SETTINGS_ACTION_FAILED" };
      });
      const name = "link-studio:settings:list";
      const load = "link-studio:settings:channelLoads";
      ipcMain.removeHandler(load);
      let calls = 0;
      ipcMain.handle(load, () => {
        calls++;
        return calls === 2
          ? { ok: false, code: "SETTINGS_ACTION_FAILED" }
          : {
              ok: true,
              value: [{ channel, running: calls === 1 ? 2 : 1, waiting: calls === 1 ? 3 : 0 }],
            };
      });
      ipcMain.removeHandler(name);
      let first = true;
      ipcMain.handle(name, async () => {
        if (!first) return { ok: true, value: { providers: [], plugins: [] } };
        first = false;
        await new Promise((resolve) => ipcMain.once("finish-model-list-load", resolve));
        return { ok: false, code: "SETTINGS_ACTION_FAILED" };
      });
    }, saved.value);
    await page.getByRole("button", { name: "模型设置" }).click();
    await expect(page.getByLabel("渠道列表加载中").locator(":scope > div")).toHaveCount(3);
    await expect(page.getByLabel("渠道详情加载中").locator(":scope > div")).toHaveCount(2);
    await app.evaluate(({ ipcMain }) => ipcMain.emit("finish-channel-list-load"));
    const failedChannels = page.getByRole("region", { name: "渠道模型管理" }).getByRole("alert");
    await expect(failedChannels).toContainText("渠道清单加载失败");
    await failedChannels.getByRole("button", { name: "重试" }).click();
    const table = page.getByRole("table", { name: "渠道模型" });
    await expect(table.getByLabel("加载中")).toHaveCount(4);
    await expect(page.getByRole("navigation", { name: "模型列表分页" })).toHaveCount(0);
    await page.getByRole("button", { name: "新增模型", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "新建模型" });
    const kinds = editor
      .getByRole("group", { name: "模型能力" })
      .getByRole("button", { disabled: true });
    await expect(kinds).toHaveCount(5);
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    await editor
      .getByRole("textbox", { name: "配置 JSON" })
      .fill(
        JSON.stringify({
          config: { kind: "image", name: "测试模型", sort: 100, description: "" },
          settings: {},
          pluginHash: "",
        }),
      );
    await editor.getByRole("button", { name: "回到表单" }).click();
    await expect(editor.getByRole("status", { name: "协议列表加载中" })).toBeVisible();
    await app.evaluate(({ ipcMain }) => ipcMain.emit("finish-model-list-load"));
    await expect(editor.getByRole("alert").filter({ hasText: "协议列表加载失败" })).toContainText(
      "刷新页面后再试。",
    );
    await expect(kinds).toHaveCount(5);
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "放弃修改", exact: true })
      .click();
    await expect(table.getByRole("alert")).toHaveText("加载失败");
    await table.getByRole("button", { name: "重试" }).click();
    await expect(page.getByRole("region", { name: "渠道模型空状态" })).toContainText(
      "未设置 API Key，拉取前请先设置",
    );
    await expect(table).toHaveCount(0);
    await page.getByRole("button", { name: "新增模型", exact: true }).first().click();
    await expect(
      editor.getByRole("group", { name: "模型能力" }).getByRole("button", { disabled: false }),
    ).toHaveCount(5);
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByTitle("每 15 秒刷新")).toHaveText("生成中 2/4 · 排队 3");
    await page.clock.fastForward(15000);
    await expect(page.getByTitle("负载刷新失败，显示的是旧数据")).toHaveText(
      "生成中 2/4 · 排队 3（旧数据）",
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByTitle("每 15 秒刷新")).toHaveText("生成中 1/4 · 排队 0");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("拉取时关闭不会串单，导入失败保留选择并可重试", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-pull-retry-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const saved = await page.evaluate(() =>
      window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "拉取测试",
          endpoint: "https://unused.invalid",
          allowLocal: false,
          sort: 0,
          enabled: true,
          headers: [],
        },
      }),
    );
    expect(saved.ok).toBe(true);
    await app.evaluate(({ ipcMain }) => {
      let attempt = 0,
        requests = 0;
      const catalog = "link-studio:settings:channelCatalog",
        submit = "link-studio:settings:modelImport";
      ipcMain.removeHandler(catalog);
      ipcMain.removeHandler(submit);
      ipcMain.handle(catalog, async () => {
        if (++attempt === 1) {
          await new Promise((resolve) => ipcMain.once("finish-old-pull", resolve));
          return { ok: false, code: "PROVIDER_CATALOG_UNSUPPORTED" };
        }
        return {
          ok: true,
          value: {
            models: [
              { id: "first", exists: true },
              { id: "second", exists: false },
              { id: "third", exists: false },
            ],
          },
        };
      });
      ipcMain.handle(submit, async (_event, input) => {
        if (input.models.join(",") !== "first,third") throw Error("勾选清单错误");
        if (++requests === 1) {
          await new Promise((resolve) => ipcMain.once("fail-import", resolve));
          return { ok: false, code: "SETTINGS_REVISION_CONFLICT" };
        }
        return { ok: true, value: { added: 1, prefixed: 1 } };
      });
    });
    await page.getByRole("button", { name: "模型设置" }).click();
    const open = () =>
      page
        .getByRole("region", { name: "渠道模型空状态" })
        .getByRole("button", { name: "拉取模型", exact: true })
        .click();
    const dialog = page.getByRole("dialog", { name: "选择要导入的模型" });
    await open();
    await expect(dialog.getByRole("status")).toHaveText("正在拉取模型…");
    await expect
      .poll(() => app.evaluate(({ ipcMain }) => ipcMain.listenerCount("finish-old-pull")))
      .toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await open();
    const second = dialog.getByRole("checkbox", { name: "second", exact: true }),
      confirm = dialog.getByRole("button", { name: "确认导入" });
    await expect(second).toBeChecked();
    await app.evaluate(({ ipcMain }) => ipcMain.emit("finish-old-pull"));
    await second.press("Space");
    await confirm.press("Enter");
    await expect(confirm).toBeDisabled();
    await expect(confirm.locator("svg")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await app.evaluate(({ ipcMain }) => ipcMain.emit("fail-import"));
    await expect(dialog.getByRole("alert")).toContainText("配置已更新");
    await expect(second).not.toBeChecked();
    await confirm.press("Space");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("已导入 1 个待配置模型（1 个 key 与其他模型冲突，已加渠道前缀）", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("渠道表单在首次保存后逐字段报错，修正后保留授权并忽略空白请求头", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-channel-validation-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "模型设置" }).click();
    await page
      .getByRole("complementary", { name: "模型渠道列表" })
      .getByRole("button", { name: "新增渠道" })
      .click();
    const editor = page.getByRole("dialog", { name: "新增渠道" });
    const name = editor.getByPlaceholder("例如：OpenAI 官方渠道");
    const url = editor.getByPlaceholder("https://api.example.com");
    const save = editor.getByRole("button", { name: "保存", exact: true });
    await expect(editor.getByRole("alert")).toHaveCount(0);
    await save.click();
    await expect(name).toHaveAccessibleDescription("请填写渠道名称");
    await expect(url).toHaveAccessibleDescription("请填写 Base URL");
    await name.fill("🌱".repeat(129));
    await expect(name).toHaveAccessibleDescription("渠道名称不能超过 128 个字");
    await name.fill("🌱".repeat(128));
    await expect(name).toHaveAttribute("aria-invalid", "false");
    for (const [input, message] of [
      ["file:///tmp/sample", "Base URL 只能是 http 或 https"],
      ["https://fixture.invalid?", "Base URL 不能带查询参数或片段"],
      ["https://fixture.invalid/#", "Base URL 不能带查询参数或片段"],
      ["https://name@fixture.invalid", "Base URL 不能包含用户名或密码"],
    ]) {
      await url.fill(input!);
      await expect(url).toHaveAccessibleDescription(message!);
    }
    await url.fill("https://fixture.invalid");
    await editor.getByRole("button", { name: "添加 User-Agent" }).click();
    await editor.getByRole("button", { name: "添加请求头" }).click();
    const header = editor.getByRole("textbox", { name: "请求头 2 名称" });
    await header.fill("user-agent");
    await expect(header).toHaveAccessibleDescription("请求头 user-agent 重复（名称不区分大小写）");
    await header.fill("Authorization");
    await expect(header).toHaveAccessibleDescription("请求头 Authorization 不能设置");
    await header.fill("");
    await expect(header).toHaveAttribute("aria-invalid", "false");
    const concurrency = editor.getByRole("spinbutton", { name: /最大同时请求数/ });
    await concurrency.fill("0.5");
    await expect(concurrency).toHaveAccessibleDescription("最大同时请求数必须是整数");
    await concurrency.fill("3");
    await editor.getByRole("spinbutton", { name: /每秒请求数/ }).fill("0.5");
    await save.click();
    await expect(editor.getByRole("alert")).toHaveText("请先确认使用此服务端点");
    await editor.getByLabel("确认使用此服务端点").check();
    await save.click();
    await expect(editor).toHaveCount(0);
    const list = await page.evaluate(() => window.desktop.settings.channelList({}));
    expect(list).toMatchObject({
      ok: true,
      value: [
        {
          revision: 1,
          name: "🌱".repeat(128),
          rps: 0.5,
          concurrent: 3,
          headers: [{ name: "user-agent" }],
        },
      ],
    });
    await page.getByRole("button", { name: "编辑渠道", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑渠道" });
    await edit.getByRole("button", { name: "添加请求头" }).click();
    await edit.getByRole("button", { name: "保存", exact: true }).click();
    await expect(edit).toHaveCount(0);
    expect(await page.evaluate(() => window.desktop.settings.channelList({}))).toMatchObject({
      ok: true,
      value: [{ revision: 1 }],
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("渠道授权按实际端点和本机网络范围判断，等价地址不清除双凭证", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-channel-approval-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const seeded = await page.evaluate(() =>
      window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-first",
        secretKey: "fixture-second",
        fields: {
          name: "授权范围",
          endpoint: "https://fixture.invalid/api",
          enabled: true,
          allowLocal: false,
          sort: 0,
          headers: [],
        },
      }),
    );
    expect(seeded.ok).toBe(true);
    const list = () => page.evaluate(() => window.desktop.settings.channelList({}));
    await page.getByRole("button", { name: "模型设置" }).click();
    const open = page.getByRole("button", { name: "编辑渠道", exact: true });
    await open.click();
    const editor = page.getByRole("dialog", { name: "编辑渠道" });
    const url = editor.getByLabel("Base URL");
    const approve = editor.getByRole("checkbox", { name: /确认.*原有 Key/ });
    const save = editor.getByRole("button", { name: "保存", exact: true });
    await url.fill("https://FIXTURE.invalid:443/api/");
    await expect(approve).toHaveCount(0);
    await save.click();
    await expect(editor).toHaveCount(0);
    expect(await list()).toMatchObject({
      ok: true,
      value: [{ revision: 1, hasSecret: true, hasSecretKey: true }],
    });
    await open.click();
    await url.fill("https://fixture.invalid/other");
    await approve.check();
    await editor.getByLabel("允许本机或内网端点").check();
    await expect(approve).not.toBeChecked();
    await save.click();
    await expect(editor.getByRole("alert")).toBeVisible();
    expect(await list()).toMatchObject({
      ok: true,
      value: [{ revision: 1, hasSecret: true, hasSecretKey: true }],
    });
    await url.fill("https://fixture.invalid/api");
    await approve.check();
    await save.click();
    await expect(editor).toHaveCount(0);
    expect(await list()).toMatchObject({
      ok: true,
      value: [
        {
          revision: 2,
          endpoint: "https://fixture.invalid/api",
          allowLocal: true,
          hasSecret: false,
          hasSecretKey: false,
        },
      ],
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("方舟配置与备案凭证分步保存，第二步失败后原窗只重试凭证", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-filing-key-retry-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const seeded = await page.evaluate(() =>
      window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "备案测试",
          endpoint: "https://ark.ap-southeast.bytepluses.com",
          enabled: true,
          allowLocal: false,
          sort: 0,
          headers: [],
        },
      }),
    );
    expect(seeded.ok).toBe(true);
    await page.getByRole("button", { name: "模型设置" }).click();
    await page.getByRole("button", { name: "编辑渠道", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑渠道" });
    await editor.getByRole("switch", { name: "虚拟人像库" }).press("Space");
    await expect(editor.getByText("ap-southeast-1", { exact: true })).toBeVisible();
    const access = editor.getByLabel("Access Key", { exact: true });
    const secret = editor.getByLabel("Secret Key", { exact: true });
    await access.fill("fixture-access");
    const save = editor.getByRole("button", { name: "保存", exact: true });
    await save.click();
    await expect(access).toHaveAccessibleDescription("Access Key 和 Secret Key 要一起填写");
    await expect(editor.getByLabel(/素材组 ID/)).toHaveAccessibleDescription(
      "启用虚拟人像库时必须填写素材组 ID",
    );
    await editor.getByLabel(/素材组 ID/).fill("sample");
    await secret.fill("fixture-secret");
    const fixture = new DatabaseSync(join(directory, "settings", "settings.sqlite"));
    try {
      fixture.exec(
        "CREATE TRIGGER deny_filing BEFORE INSERT ON channel_filing_keys BEGIN SELECT RAISE(ABORT,'fixture'); END",
      );
      await save.click();
      await expect(editor.getByRole("alert")).toContainText("渠道配置已保存，但备案凭证未保存");
      const list = () => page.evaluate(() => window.desktop.settings.channelList({}));
      expect(await list()).toMatchObject({
        ok: true,
        value: [
          { revision: 2, hasFilingKeys: false, filing: { enabled: true, groupId: "sample" } },
        ],
      });
      fixture.exec("DROP TRIGGER deny_filing");
      await save.click();
      await expect(editor).toHaveCount(0);
      expect(await list()).toMatchObject({
        ok: true,
        value: [{ revision: 3, hasFilingKeys: true }],
      });
      await page.getByRole("button", { name: "编辑渠道", exact: true }).click();
      await expect(access).toHaveValue("");
      await expect(secret).toHaveAttribute("placeholder", "留空不改");
      await expect(editor.getByText("已配置", { exact: true })).toBeVisible();
    } finally {
      fixture.close();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("新增渠道部分凭证失败不重复创建，设置 Key 可补写，原样保存编辑不产生新版本", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-create-keys-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "模型设置" }).click();
    await page
      .getByRole("complementary", { name: "模型渠道列表" })
      .getByRole("button", { name: "新增渠道" })
      .click();
    const fixture = new DatabaseSync(join(directory, "settings", "settings.sqlite"));
    try {
      fixture.exec(
        "CREATE TRIGGER deny_secondary BEFORE INSERT ON provider_secret_keys BEGIN SELECT RAISE(ABORT,'fixture'); END",
      );
      const editor = page.getByRole("dialog", { name: "新增渠道" });
      await editor.getByLabel("渠道名称").fill("独立写入");
      await editor.getByLabel("Base URL").fill("https://fixture.invalid");
      await editor.getByPlaceholder("API Key", { exact: true }).fill("fixture-first");
      await editor.getByPlaceholder("Secret Key", { exact: true }).fill("fixture-second");
      await editor.getByLabel("确认使用此服务端点").check();
      await editor.getByRole("button", { name: "保存", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(
        page.getByText("渠道已创建，但 Secret Key 没有设置成功，请重新设置 Key", { exact: true }),
      ).toBeVisible();
      const list = () =>
        page.evaluate(async () => {
          const result = await window.desktop.settings.channelList({});
          return result.ok ? result.value : [];
        });
      expect(await list()).toMatchObject([
        { name: "独立写入", revision: 2, hasSecret: true, hasSecretKey: false },
      ]);
      fixture.exec("DROP TRIGGER deny_secondary");
      await page.getByRole("button", { name: "设置 Key", exact: true }).click();
      const keys = page.getByRole("dialog", { name: /的 Key/ });
      await keys.getByLabel("Secret Key（可选）").fill("fixture-retry");
      await keys.getByRole("button", { name: "保存", exact: true }).click();
      await expect(keys).toHaveCount(0);
      await page.getByRole("button", { name: "编辑渠道", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "编辑渠道" });
      await edit.getByRole("button", { name: "保存", exact: true }).click();
      await expect(edit).toHaveCount(0);
      expect(await list()).toMatchObject([
        { name: "独立写入", revision: 3, hasSecret: true, hasSecretKey: true },
      ]);
    } finally {
      fixture.close();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("新建渠道、拉取模型、保存能力与参数并试跑", async () => {
  const testInfo = test.info();
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "link-studio-channels-"));
  const requests: { path?: string; authorization?: string; label?: string; body: string }[] = [];
  let emptyCatalog = false;
  let largeCatalog = false;
  let failTrial = false;
  let releaseFailure: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      label: String(request.headers["x-fixture"]),
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models")
      response.end(
        JSON.stringify({
          data: emptyCatalog
            ? []
            : [
                { id: "gpt-fixture" },
                { id: "whisper-fixture" },
                { id: "pending-fixture" },
                ...(largeCatalog
                  ? Array.from({ length: 498 }, (_, index) => ({ id: `large-${index}` }))
                  : []),
              ],
        }),
      );
    else if (request.url === "/v1/responses" && failTrial) {
      await new Promise<void>((resolve) => {
        releaseFailure = resolve;
        response.on("close", resolve);
      });
      response
        .writeHead(503)
        .end(
          JSON.stringify({
            error: {
              code: "upstream_busy",
              message: "Fixture unavailable",
              api_key: "channel-fixture-key",
            },
            details: Array.from({ length: 20 }, () => ({ type: "retry" })),
          }),
        );
    } else if (request.url === "/v1/responses")
      response.end(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
        }),
      );
    else if (request.url === "/agent/v3/chat/completions") {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Agent OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    } else response.writeHead(404).end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const launch = () =>
    electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ["."] }), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 700));
    await page.getByRole("button", { name: "模型设置" }).click();
    await page
      .getByRole("complementary", { name: "模型渠道列表" })
      .getByRole("button", { name: "新增渠道", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "新增渠道" });
    const enabledSwitch = editor.getByRole("switch", { name: "启用", exact: true });
    await expect(enabledSwitch).toBeChecked();
    await enabledSwitch.press("Space");
    await expect(enabledSwitch).not.toBeChecked();
    await enabledSwitch.press("Space");
    await editor.getByLabel("渠道名称").fill("创作服务");
    await editor.getByLabel("Base URL").fill(`http://127.0.0.1:${address.port}`);
    await editor.getByLabel("允许本机或内网端点").check();
    await editor.getByRole("button", { name: "添加请求头", exact: true }).click();
    await editor.getByLabel("请求头 1 名称").fill("x-fixture");
    await editor.getByLabel("请求头 1 值").fill("channel-fixture-header");
    await editor.getByLabel("最大同时请求数").fill("1");
    await editor.getByLabel("确认使用此服务端点").check();
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    const emptyChannelPanel = page.getByRole("region", { name: "渠道模型空状态" });
    await expect(emptyChannelPanel.getByText("未设置 API Key，拉取前请先设置")).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "搜索渠道模型" })).toHaveCount(0);
    await emptyChannelPanel.getByRole("button", { name: "新增模型" }).click();
    await page
      .getByRole("dialog", { name: "新建模型" })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await emptyChannelPanel.getByRole("button", { name: "拉取模型", exact: true }).click();
    const missingKey = page.getByRole("dialog", { name: "选择要导入的模型" });
    await expect(missingKey.getByRole("alert")).toBeVisible();
    await missingKey.getByRole("button", { name: "重试" }).click();
    await expect(missingKey.getByRole("alert")).toBeVisible();
    await missingKey.getByRole("button", { name: "关闭", exact: true }).last().click();
    await page.getByRole("button", { name: "设置 Key", exact: true }).click();
    const keys = page.getByRole("dialog", { name: /的 Key/ });
    await keys.getByLabel("API Key", { exact: true }).fill("channel-fixture-key");
    await keys.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("API Key 已配置", { exact: true })).toBeVisible();
    await expect(emptyChannelPanel.getByText("未设置 API Key，拉取前请先设置")).toHaveCount(0);
    await emptyChannelPanel.getByRole("button", { name: "拉取模型", exact: true }).click();
    const pull = page.getByRole("dialog", { name: "选择要导入的模型" });
    await expect(pull.getByRole("checkbox", { name: "gpt-fixture" })).toBeChecked();
    await expect(pull.getByRole("checkbox", { name: "whisper-fixture" })).toBeChecked();
    await pull.getByRole("searchbox").fill("whisper");
    await pull.getByRole("button", { name: "取消全选" }).click();
    await pull.getByRole("searchbox").clear();
    await page.screenshot({ path: testInfo.outputPath("model-pull.png") });
    await pull.getByRole("button", { name: "确认导入" }).click();
    const pending = page.getByRole("row", { name: /gpt-fixture/ });
    await expect(pending.getByText("待配置", { exact: true })).toHaveCount(3);
    await expect(pending.getByRole("switch")).toBeDisabled();
    await expect(page.getByRole("row", { name: /whisper-fixture/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("model-pending.png") });
    await pending.getByText("还没有选择能力").click();
    await expect(page.getByRole("dialog", { name: "编辑模型" })).toBeHidden();
    await pending.getByRole("button", { name: /^gpt-fixture/ }).click();
    const model = page.getByRole("dialog", { name: "编辑模型" });
    await expect(model.getByText("选择模型能力", { exact: true })).toBeVisible();
    await expect(model.locator(".model-protocol-list")).toHaveCount(0);
    await expect(model.getByRole("button", { name: "测试模型" })).toBeDisabled();
    await expect(model.getByRole("button", { name: "测试模型" })).toHaveAttribute(
      "title",
      "还没有选择模型能力，先选择能力和协议并保存",
    );
    await expect(model.locator("label.settings-switch")).toHaveAttribute(
      "title",
      "还没有选择模型能力",
    );
    await expect(model.locator("footer").getByRole("button", { name: "配置 JSON" })).toHaveCount(0);
    await model.locator("footer > .model-disabled-reason").press("Tab");
    await expect(
      model
        .locator(".model-disabled-reason")
        .filter({ has: page.getByRole("button", { name: "测试模型" }) }),
    ).toBeFocused();
    await expect(model.getByRole("tooltip")).toHaveText(
      "还没有选择模型能力，先选择能力和协议并保存",
    );
    await model.getByLabel("展示名称").fill("剧本助手模型");
    await expect(model.getByRole("button", { name: "测试模型" })).toHaveAttribute(
      "title",
      "有未保存的修改，先保存",
    );
    const tag = model.getByLabel("展示标签", { exact: true });
    await tag.fill("快速");
    await tag.press("Enter");
    await tag.fill("快速");
    await tag.press(",");
    await expect(model.getByRole("button", { name: "删除标签 快速" })).toHaveCount(1);
    await model.locator(".model-tag-list > span").click({ position: { x: 8, y: 12 } });
    await expect(model.getByRole("button", { name: "删除标签 快速" })).toBeVisible();
    await tag.press("Backspace");
    await expect(model.getByRole("button", { name: "删除标签 快速" })).toHaveCount(0);
    await tag.fill("推理");
    await tag.press("Tab");
    await expect(model.locator(".model-preview").getByText("推理", { exact: true })).toBeVisible();
    const logo = model.getByRole("button", { name: /^模型 Logo/ });
    const logoSearch = model.getByRole("textbox", { name: "搜索厂商" });
    await expect(logoSearch).toBeHidden();
    await logo.click();
    await expect(logoSearch).toBeFocused();
    await logoSearch.fill("找不到的厂商");
    await expect(model.getByText("没有匹配的厂商")).toBeVisible();
    await logoSearch.press("Escape");
    await expect(logoSearch).toBeHidden();
    await expect(model).toBeVisible();
    await logo.press("Enter");
    await expect(logoSearch).toHaveValue("");
    await expect(model.locator(".model-logo-grid button")).toHaveCount(40);
    await logoSearch.fill("通义");
    await model.getByRole("button", { name: "通义千问", exact: true }).click();
    await expect(logo).toBeFocused();
    await expect(logo).toHaveAccessibleName("模型 Logo 通义千问");
    await logo.press("Enter");
    await expect(logoSearch).toHaveValue("通义");
    await expect(model.getByRole("button", { name: "通义千问", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await logoSearch.press("Escape");
    await expect(logo).toBeFocused();
    const previewLogo = model.locator(".model-preview [data-vendor='qwen'] img");
    await expect(previewLogo).toHaveJSProperty("naturalWidth", 24);
    const protocolList = model.locator(".model-protocol-list");
    const protocolCards = protocolList.getByRole("radio");
    const textCard = protocolList.getByRole("radio", { name: /^OpenAI/ });
    await model.getByRole("button", { name: "文本", exact: true }).click();
    await expect(textCard).toBeVisible();
    const textCardHeight = await textCard.evaluate((card) => card.getBoundingClientRect().height);
    for (const kind of ["图片", "视频"]) {
      await model.getByRole("button", { name: kind, exact: true }).click();
      await page
        .getByRole("alertdialog", { name: `改成${kind}模型？` })
        .getByRole("button", { name: "确认修改" })
        .click();
      await expect(model.getByText("未选择协议", { exact: true })).toBeVisible();
      await expect(protocolCards.first()).toBeVisible();
      const layout = await protocolList.evaluate(
        (list, height) => ({
          horizontalOverflow: list.scrollWidth > list.clientWidth,
          malformedCards: Array.from(list.querySelectorAll("button"))
            .filter(
              (card) =>
                card.getBoundingClientRect().height !== height ||
                card.scrollHeight > card.clientHeight,
            )
            .map((card) => card.querySelector("strong")?.textContent),
        }),
        textCardHeight,
      );
      expect(layout, `${kind}的调用协议卡片`).toEqual({
        horizontalOverflow: false,
        malformedCards: [],
      });
      await model.locator(".model-protocol-grid").screenshot({
        path: testInfo.outputPath(`protocol-${kind}.png`),
      });
      await protocolCards.last().click();
      await expect(protocolCards.last()).toBeChecked();
    }
    await model.getByRole("button", { name: "文本", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "改成文本模型？" })
      .getByRole("button", { name: "确认修改" })
      .click();
    await model.getByRole("radio", { name: /^OpenAI/ }).click();
    await expect(model.getByLabel("协议版本", { exact: true })).toBeVisible();
    await expect(model.getByLabel("确认使用此插件版本与渠道端点")).toHaveCount(0);
    await expect(model.getByRole("button", { name: "保存模型" })).toBeEnabled();
    await model.getByLabel("展示名称").focus();
    await page.screenshot({ path: testInfo.outputPath("model-editor-basic.png") });
    await model.getByRole("tab", { name: "能力与参数" }).click();
    await model.getByLabel("固定系统提示").fill("只回复 OK。");
    await model.getByRole("spinbutton", { name: "最大输出", exact: true }).fill("256");
    await model.getByLabel("字数上限").fill("1200");
    const deadline = model.getByRole("textbox", { name: "自定义超时" });
    await deadline.fill("24h1s");
    await model.getByRole("button", { name: "保存模型" }).click();
    await expect(deadline).toBeFocused();
    await deadline.fill("1h30m0.5s");
    await model.getByLabel("预览提示词").fill("预览草稿");
    await page.screenshot({ path: testInfo.outputPath("model-editor.png") });
    await model.getByRole("tab", { name: "积分定价", exact: true }).click();
    await expect(model.getByRole("button", { name: "Token", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(model.getByRole("button", { name: "按秒", exact: true })).toBeDisabled();
    await model.getByRole("button", { name: "按次", exact: true }).click();
    await expect(model.getByRole("button", { name: "按规格定价" })).toBeDisabled();
    await model.getByLabel("默认价格", { exact: true }).fill("17");
    await expect(model.getByLabel("创作端预览")).toContainText("17");
    await model.getByRole("button", { name: "配置 JSON" }).click();
    const jsonEditor = model.getByLabel("配置 JSON", { exact: true });
    const valid = await jsonEditor.inputValue();
    const readVersions = () =>
      page.evaluate(async () => {
        const catalog = await window.desktop.settings.list({});
        if (!catalog.ok) throw Error(catalog.code);
        return catalog.value.providers.map(({ id, revision }) => [id, revision]);
      });
    const versionsBeforeDraft = await readVersions();
    expect(JSON.parse(valid).key).toBe("gpt-fixture");
    expect(JSON.parse(valid).channels[0]).toMatchObject({ upstream_model: "gpt-fixture" });
    for (const raw of ["null", "[]", "17", '"正文"']) {
      await jsonEditor.fill(raw);
      await expect(jsonEditor).toHaveAttribute("aria-invalid", "false");
      await expect(model.getByText("JSON 语法正确", { exact: true })).toBeVisible();
      await model.getByRole("button", { name: "回到表单" }).press("Enter");
      await expect(
        model.getByRole("alert").getByText("正文必须是 JSON 对象，才能切回表单。", { exact: true }),
      ).toBeVisible();
      await expect(jsonEditor).toHaveValue(raw);
    }
    const extended = {
      ...JSON.parse(valid),
      key: "different-model",
      label: "来自 JSON 的名称",
      config: { custom: "保留此键" },
    };
    const extensionText = JSON.stringify(extended);
    await jsonEditor.fill(extensionText);
    await model.getByRole("button", { name: "回到表单" }).press("Enter");
    await model.getByRole("tab", { name: "基本信息" }).click();
    await expect(model.getByLabel("展示名称")).toHaveValue(extended.label);
    await model.getByLabel("展示名称").fill("表单改名");
    await model.getByRole("tab", { name: "积分定价" }).click();
    await model.getByRole("button", { name: "保存模型" }).press("Enter");
    await expect(jsonEditor).toBeVisible();
    await expect(model.getByRole("button", { name: /模型配置错误.*config/ })).toBeVisible();
    const rebased = JSON.parse(await jsonEditor.inputValue());
    expect(rebased).toEqual({ ...extended, label: "表单改名" });
    expect(Object.keys(rebased)).toEqual(Object.keys(extended));
    expect(await readVersions()).toEqual(versionsBeforeDraft);
    const withoutKey = JSON.parse(valid);
    delete withoutKey.key;
    await jsonEditor.fill(JSON.stringify(withoutKey));
    await model.getByRole("button", { name: "保存模型" }).click();
    await expect(
      model.locator("[data-sonner-toast]").filter({ hasText: "正文里缺少 key" }),
    ).toContainText("必须填写");
    await expect(jsonEditor).toHaveValue(JSON.stringify(withoutKey));
    const missingChannel = JSON.parse(valid);
    missingChannel.channels[0].channel = "missing-channel";
    await jsonEditor.fill(JSON.stringify(missingChannel));
    await expect(model.getByRole("button", { name: /未找到指定的渠道/ })).toBeVisible();
    expect(JSON.parse(valid).pricing.unit).toBe(17);
    expect(JSON.parse(valid).deadline).toBe("5400.5s");
    expect(JSON.parse(valid).channels[0].protocol.plugin).toBe("openai");
    await jsonEditor.fill("{");
    await model.getByRole("button", { name: "保存模型" }).press("Enter");
    await expect(
      model.locator("[data-sonner-toast]").filter({ hasText: "JSON 格式错误，无法保存" }),
    ).toBeVisible();
    await expect(jsonEditor).toHaveValue("{");
    await model.getByRole("button", { name: /第 1 行/ }).click();
    await expect(jsonEditor).toBeFocused();
    await jsonEditor.fill('{\n  "label": trux\n}');
    await model.getByRole("button", { name: "回到表单" }).press("Enter");
    await expect(model.getByRole("alert").filter({ hasText: "无法切回表单" })).toContainText(
      "第 2 行 第 12 列",
    );
    await model.getByRole("button", { name: "格式化" }).click();
    await expect(
      model.locator("[data-sonner-toast]").filter({ hasText: "无法格式化" }),
    ).toBeVisible();
    await expect(model.getByRole("alert").filter({ hasText: "无法切回表单" })).toContainText(
      "第 2 行 第 12 列",
    );
    await model.getByRole("button", { name: /第 2 行 第 12 列/ }).click();
    expect(
      await jsonEditor.evaluate((field: HTMLTextAreaElement) =>
        field.value.slice(field.selectionStart, field.selectionEnd),
      ),
    ).toBe("t");
    const invalidTier = JSON.parse(valid);
    invalidTier.pricing.tiers = [
      { on: true, unit: 17, when: {} },
      { on: true, unit: "invalid", when: {} },
    ];
    const invalidText = JSON.stringify(invalidTier, null, 2);
    await jsonEditor.fill(invalidText);
    await model.getByRole("button", { name: /tiers\/1\/unit/ }).click();
    expect(await jsonEditor.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(
      invalidText.lastIndexOf('"unit": "invalid"'),
    );
    const staleTier = JSON.parse(valid);
    const invalidProtocol = JSON.parse(valid);
    invalidProtocol.channels[0].protocol.settings.api = "invalid-api-option";
    await jsonEditor.fill(JSON.stringify(invalidProtocol));
    await model.getByRole("button", { name: "保存模型" }).click();
    await expect(jsonEditor).toBeFocused();
    expect(
      await jsonEditor.evaluate((field: HTMLTextAreaElement) =>
        field.value.slice(field.selectionStart, field.selectionEnd),
      ),
    ).toBe('"api"');
    await model.getByRole("button", { name: "回到表单" }).click();
    await model.getByRole("button", { name: "保存模型" }).click();
    await expect(model.locator('[data-field="setting-api"]')).toBeFocused();
    await expect(model.locator('[data-field="setting-api"]')).toHaveAccessibleDescription(
      "请选择有效的接口",
    );
    await model.getByRole("button", { name: "配置 JSON" }).click();
    staleTier.pricing.tiers = [{ on: true, unit: 17, when: { fps: 24 } }];
    await jsonEditor.fill(JSON.stringify(staleTier));
    await model.getByRole("button", { name: "保存模型" }).click();
    await expect(jsonEditor).toBeFocused();
    expect(
      await jsonEditor.evaluate((field: HTMLTextAreaElement) =>
        field.value.slice(field.selectionStart, field.selectionEnd),
      ),
    ).toBe('"when"');
    await model.getByRole("button", { name: "回到表单" }).click();
    await model.getByRole("button", { name: "保存模型" }).click();
    await expect(model.locator('[data-field="tier-0"]')).toBeFocused();
    await expect(
      model.locator('[data-field="tier-0"]').getByText(/fps.*已不能作为规格维度/),
    ).toBeVisible();
    await model.getByRole("button", { name: "移除条件" }).press("Enter");
    await expect(
      model.locator('[data-field="tier-0"]').getByText(/fps.*已不能作为规格维度/),
    ).toHaveCount(0);
    await model.getByRole("button", { name: "配置 JSON" }).click();
    await jsonEditor.fill(valid);
    await model.getByRole("button", { name: "格式化" }).click();
    await model.getByRole("button", { name: "回到表单" }).click();
    await model.getByRole("tab", { name: "基本信息" }).click();
    await expect(model.getByRole("button", { name: "测试模型" })).toBeDisabled();
    await expect(model.getByRole("switch", { name: "模型上线" })).toBeDisabled();
    await model.getByRole("button", { name: "保存模型" }).click();
    await expect(model).toBeHidden();
    await page.getByRole("button", { name: /^剧本助手模型/ }).click();
    await model.getByRole("tab", { name: "能力与参数" }).click();
    await model.getByLabel("预览提示词").fill("预览草稿");
    await model.getByRole("button", { name: "测试模型" }).click();
    const trial = page.getByRole("dialog", { name: "测试 剧本助手模型" });
    await expect(trial.getByLabel("测试提示词")).toHaveValue("预览草稿");
    await trial.getByLabel("测试提示词").fill("");
    await expect(trial.locator("header [data-vendor='qwen'] img").first()).toHaveJSProperty(
      "naturalWidth",
      24,
    );
    await trial.getByRole("button", { name: "开始测试" }).click();
    await expect(trial.getByLabel("测试提示词")).toBeFocused();
    await expect(trial.getByRole("alert")).toHaveText("请填写提示词");
    await trial.getByLabel("测试提示词").fill("测试试跑提示词");
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(
      trial
        .getByRole("tabpanel", { name: "请求描述" })
        .locator("pre")
        .filter({ hasText: "/v1/responses" }),
    ).toBeVisible();
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.every((request) => request.path === "/v1/models")).toBe(true);
    await trial.getByRole("button", { name: "开始测试" }).click();
    await expect(trial.getByRole("tab", { name: "追踪" })).toHaveAttribute("aria-selected", "true");
    await trial.getByRole("button", { name: /parseSubmitResponse/ }).click();
    await expect(trial.getByRole("region", { name: "输入", exact: true })).toBeVisible();
    await expect(trial.getByRole("region", { name: "输出", exact: true })).toContainText(
      "succeeded",
    );
    await trial.getByRole("tab", { name: "追踪" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(trial.getByRole("tabpanel", { name: "请求描述" })).toBeVisible();
    await expect(
      trial
        .getByRole("tabpanel", { name: "请求描述" })
        .locator("pre")
        .filter({ hasText: "/v1/responses" }),
    ).toBeVisible();
    await trial.getByRole("tab", { name: "结果", exact: true }).click();
    await expect(trial.getByRole("status")).toContainText("succeeded");
    await trial.getByRole("tab", { name: "日志" }).click();
    const log = trial.getByRole("tabpanel", { name: "日志" });
    await expect(log.getByText("modelTrial", { exact: true })).toHaveCount(2);
    await expect(log.getByText("channelSave", { exact: true })).toHaveCount(0);
    await log.getByRole("switch", { name: "只看当前模型" }).uncheck();
    await expect(log.getByText("channelSave", { exact: true }).first()).toBeVisible();
    await expect(log).not.toContainText("channel-fixture-key");
    await log.getByRole("button", { name: "清空" }).click();
    await expect(log.getByText("还没有请求")).toBeVisible();
    await expect(log.getByRole("button", { name: "清空" })).toBeDisabled();
    await trial.getByRole("tab", { name: "结果", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("model-trial.png") });
    await trial.getByRole("button", { name: "关闭", exact: true }).click();
    const published = model.getByRole("switch", { name: "模型上线" });
    await published.click();
    await expect(published).toBeChecked();
    await model.getByRole("tab", { name: "基本信息" }).click();
    await model.getByLabel("展示名称").fill("未保存草稿");
    await published.click();
    await expect(published).not.toBeChecked();
    await expect(model.getByLabel("展示名称")).toHaveValue("未保存草稿");
    await expect(model.getByRole("switch", { name: "模型上线" })).toBeDisabled();
    await model.getByLabel("展示名称").fill("剧本助手模型");
    await published.click();
    await expect(published).toBeChecked();
    await model.getByRole("button", { name: "取消", exact: true }).click();
    await expect(model).toBeHidden();
    expect(requests[0]?.path).toBe("/v1/models");
    for (const request of requests)
      expect(request).toMatchObject({
        authorization: "Bearer channel-fixture-key",
        label: "channel-fixture-header",
      });
    const submissions = requests.filter((request) => request.path !== "/v1/models");
    expect(submissions.map((request) => request.path)).toEqual(["/v1/responses"]);
    expect(JSON.parse(submissions[0]!.body)).toMatchObject({
      model: "gpt-fixture",
      instructions: "只回复 OK。",
      max_output_tokens: 256,
    });
    failTrial = true;
    await page.getByRole("button", { name: "测试 剧本助手模型", exact: true }).click();
    await trial.getByLabel("测试提示词").fill("diagnostic-fixture-input");
    await trial.getByRole("button", { name: "开始测试" }).click();
    await trial.getByRole("tab", { name: "追踪" }).click();
    await expect(trial.getByRole("tabpanel", { name: "追踪" })).toContainText("等待响应", {
      timeout: 10000,
    });
    const submittedRequests = requests.length;
    await trial.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(trial.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(trial.getByRole("tabpanel", { name: "追踪" })).toContainText("等待响应");
    expect(requests.length).toBe(submittedRequests);
    releaseFailure?.();
    await expect(trial.getByRole("tab", { name: "追踪" })).toHaveAttribute("aria-selected", "true");
    await expect(trial.getByRole("button", { name: "复制修复信息" })).toBeVisible();
    await expect(trial.getByRole("button", { name: /http · 失败.*503/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await trial.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(trial.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(trial.getByRole("tabpanel", { name: "追踪" })).toContainText("503");
    expect(requests.length).toBe(submittedRequests);
    const responseBody = trial.getByRole("region", { name: "响应体" });
    await expect(responseBody).toContainText("upstream_busy");
    await responseBody.getByRole("button", { name: /展开全部/ }).click();
    await expect(responseBody).toContainText("[已隐藏]");
    await expect(responseBody).not.toContainText("channel-fixture-key");
    await responseBody.getByRole("button", { name: "收起" }).click();
    await expect(trial.getByRole("region", { name: "请求头" })).toContainText("[已隐藏]");
    await expect(trial.getByRole("region", { name: "请求体" })).toContainText("model");
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.body.dataset.repairReport = text;
          },
        },
      }),
    );
    await trial.getByRole("button", { name: "复制全部（JSON）" }).click();
    const traceCopy = await page.locator("body").getAttribute("data-repair-report");
    expect(traceCopy).toContain("upstream_busy");
    expect(traceCopy).not.toContain("channel-fixture-key");
    expect(traceCopy).not.toContain("diagnostic-fixture-input");
    await trial.getByRole("tab", { name: "结果", exact: true }).click();
    await expect(trial.getByRole("heading", { name: /试跑任务 #[0-9a-f-]{36}$/ })).toBeVisible();
    await expect(trial.getByRole("alert").filter({ hasText: "测试失败" })).toContainText(
      "复制修复信息",
    );
    await trial.getByRole("button", { name: "复制修复信息" }).click();
    const report = await page.locator("body").getAttribute("data-repair-report");
    await expect(
      trial.getByRole("alert").getByRole("button", { name: "已复制", exact: true }),
    ).toBeVisible();
    await expect(
      trial.getByRole("alert").getByRole("button", { name: "复制修复信息" }),
    ).toBeVisible();
    expect(report).toContain("插件：openai v");
    expect(report).toContain("503");
    expect(report).not.toContain("channel-fixture-key");
    expect(report).not.toContain("diagnostic-fixture-input");
    await trial.getByRole("button", { name: "关闭", exact: true }).click();
    failTrial = false;
    const names = page
      .getByRole("table", { name: "渠道模型" })
      .locator(".channel-model-name strong");
    await expect(names).toHaveText(["剧本助手模型", "pending-fixture"]);
    const versionsBeforeDrag = await readVersions();
    await page
      .getByRole("button", { name: "排序 pending-fixture" })
      .dragTo(page.getByRole("row", { name: /剧本助手模型/ }), {
        targetPosition: { x: 90, y: 10 },
      });
    await expect(names).toHaveText(["剧本助手模型", "pending-fixture"]);
    expect(await readVersions()).toEqual(versionsBeforeDrag);
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    await restored.getByRole("button", { name: "模型设置" }).click();
    await expect(restored.locator(".channel-model-name strong")).toHaveText([
      "剧本助手模型",
      "pending-fixture",
    ]);
    const restoredPending = restored.getByRole("row", { name: /pending-fixture/ });
    await expect(restoredPending.getByText("待配置", { exact: true })).toHaveCount(3);
    await expect(
      restoredPending.getByRole("button", { name: "测试 pending-fixture" }),
    ).toBeDisabled();
    const modelSwitch = restored.getByRole("switch", { name: "剧本助手模型 上线" });
    await expect(modelSwitch).toBeChecked();
    await modelSwitch.click();
    await expect(modelSwitch).not.toBeChecked();
    await expect(restored.getByRole("dialog", { name: "编辑模型" })).toBeHidden();
    await modelSwitch.press("Space");
    await expect(modelSwitch).toBeChecked();
    const restoredRow = restored.getByRole("button", { name: /^剧本助手模型/ });
    await expect(restoredRow.locator("[data-vendor='qwen'] img")).toHaveJSProperty(
      "naturalWidth",
      24,
    );
    await restoredRow.click();
    const restoredEditor = restored.getByRole("dialog", { name: "编辑模型" });
    await expect(restoredEditor.getByRole("button", { name: "模型 Logo 通义千问" })).toBeVisible();
    await expect(restoredEditor.getByRole("button", { name: "删除标签 推理" })).toBeVisible();
    await restoredEditor.getByRole("button", { name: "取消", exact: true }).click();
    largeCatalog = true;
    await restored.getByRole("button", { name: "拉取模型", exact: true }).click();
    const secondPull = restored.getByRole("dialog", { name: "选择要导入的模型" });
    await expect(secondPull.getByRole("checkbox", { name: /gpt-fixture.*已存在/ })).toBeChecked();
    await secondPull.getByRole("button", { name: "确认导入" }).click();
    await expect(secondPull.getByRole("alert")).toHaveText("单次最多导入 500 个模型，请分批导入");
    await secondPull.getByRole("searchbox").fill("large-");
    await secondPull.getByRole("button", { name: "取消全选" }).click();
    await secondPull.getByRole("button", { name: "确认导入" }).click();
    await expect(secondPull).toBeHidden();
    largeCatalog = false;
    await restored.getByRole("button", { name: "拉取模型", exact: true }).click();
    await secondPull.getByRole("checkbox", { name: /whisper-fixture.*已存在/ }).waitFor();
    await secondPull.getByRole("button", { name: "取消", exact: true }).click();
    emptyCatalog = true;
    await restored.getByRole("button", { name: "拉取模型", exact: true }).click();
    await expect(secondPull.getByText("上游没有返回模型")).toBeVisible();
    await secondPull.getByRole("button", { name: "手动新增模型" }).click();
    const blankEditor = restored.getByRole("dialog", { name: "新建模型" });
    const sort = blankEditor.getByRole("spinbutton", { name: "排序", exact: true });
    await expect(sort).toHaveValue("100");
    await sort.fill("");
    await expect(sort).toHaveValue("0");
    await blankEditor.getByRole("tab", { name: "能力与参数" }).click();
    await expect(blankEditor.getByText("暂无生成参数")).toBeVisible();
    await expect(blankEditor.getByText("未配置 capabilities")).toBeVisible();
    await expect(blankEditor.getByRole("heading", { name: "上下文能力" })).toHaveCount(0);
    await blankEditor.getByRole("tab", { name: "积分定价", exact: true }).click();
    await blankEditor.getByRole("button", { name: "保存模型" }).click();
    await expect(blankEditor.getByLabel("展示名称", { exact: true })).toBeFocused();
    await blankEditor.getByLabel("展示名称", { exact: true }).fill("不保存的样例");
    await blankEditor.getByRole("button", { name: "取消", exact: true }).click();
    const discard = restored.getByRole("alertdialog", { name: "放弃未保存的修改？" });
    await expect(discard).toHaveAccessibleDescription("未保存的修改会丢失。");
    await discard.getByRole("button", { name: "取消", exact: true }).press("Escape");
    await expect(blankEditor.getByLabel("展示名称", { exact: true })).toHaveValue("不保存的样例");
    await blankEditor.getByLabel("展示名称", { exact: true }).fill("");
    await blankEditor.getByRole("button", { name: "配置 JSON" }).click();
    await blankEditor.getByRole("button", { name: "格式化" }).press("Enter");
    await expect(blankEditor.getByText("JSON 语法正确")).toBeVisible();
    await blankEditor.getByRole("button", { name: "回到表单" }).press("Enter");
    await blankEditor.getByRole("button", { name: "保存模型" }).click();
    await expect(blankEditor.getByLabel("展示名称", { exact: true })).toBeFocused();
    await blankEditor.getByRole("button", { name: "配置 JSON" }).click();
    await blankEditor.getByLabel("配置 JSON", { exact: true }).fill("{");
    await blankEditor.getByRole("button", { name: "取消", exact: true }).click();
    await discard.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(blankEditor).toBeHidden();
    emptyCatalog = false;
    const detail = restored.getByRole("region", { name: "渠道详情" });
    const disableChannel = detail.getByRole("button", { name: "停用", exact: true });
    const enableChannel = detail.getByRole("button", { name: "启用", exact: true });
    const disableConfirm = restored.getByRole("alertdialog", { name: "停用渠道？" });
    await disableChannel.click();
    await disableConfirm.press("Escape");
    await expect(disableChannel).toBeFocused();
    await disableChannel.click();
    const concurrentSave = await restored.evaluate(async () => {
      const api = window.desktop.settings;
      const result = await api.channelList({});
      const current = result.ok && result.value.find((entry) => entry.name === "创作服务");
      if (!current) throw Error("找不到渠道");
      return api.channelSave({
        id: current.id,
        expectedRevision: current.revision,
        approve: false,
        fields: {
          name: current.name,
          endpoint: current.endpoint,
          allowLocal: current.allowLocal,
          enabled: true,
          sort: current.sort,
          headers: current.headers.map(({ name }) => ({ name, value: "" })),
          concurrent: 2,
        },
      });
    });
    expect(concurrentSave.ok).toBe(true);
    await disableConfirm.getByRole("button", { name: "停用", exact: true }).click();
    await expect(disableConfirm.getByRole("alert")).toContainText("配置已更新");
    await disableConfirm.getByRole("button", { name: "停用", exact: true }).click();
    await expect(enableChannel).toBeVisible();
    await expect(detail.getByText("限流 rps 不限 · 并发 2 · 同时生成 不限")).toBeVisible();
    await expect(
      restored.getByText("渠道已停用，模型在画布中不可见", { exact: true }),
    ).toBeVisible();
    await restored.getByRole("button", { name: "编辑渠道", exact: true }).click();
    const channelEditor = restored.getByRole("dialog", { name: "编辑渠道" });
    await expect(channelEditor.getByPlaceholder("API Key", { exact: true })).toHaveCount(0);
    await expect(
      channelEditor.locator("input[type=password][autocomplete=new-password]"),
    ).toHaveCount(0);
    await channelEditor.getByLabel("渠道名称").fill("不该保存");
    await channelEditor.press("Escape");
    await discard.getByRole("button", { name: "取消" }).click();
    await expect(channelEditor.getByLabel("渠道名称")).toHaveValue("不该保存");
    await channelEditor.getByRole("button", { name: "取消" }).click();
    await discard.getByRole("button", { name: "放弃修改" }).click();
    await restored.getByRole("button", { name: "编辑渠道", exact: true }).click();
    await expect(channelEditor.getByLabel("渠道名称")).toHaveValue("创作服务");
    await channelEditor.getByRole("switch", { name: "启用", exact: true }).press("Space");
    await channelEditor.getByRole("button", { name: "保存", exact: true }).click();
    await disableChannel.click();
    await disableConfirm.getByRole("button", { name: "停用", exact: true }).click();
    await expect(
      restored.getByRole("table", { name: "渠道模型" }).getByText("不可用", { exact: true }),
    ).toBeVisible();
    await restored.getByRole("button", { name: "新增渠道", exact: true }).click();
    const targetEditor = restored.getByRole("dialog", { name: "新增渠道" });
    await targetEditor.getByLabel("渠道名称").fill("备用服务");
    await targetEditor.getByLabel("Base URL").fill(`http://127.0.0.1:${address.port}`);
    await targetEditor.getByLabel("允许本机或内网端点").check();
    await targetEditor.getByLabel("确认使用此服务端点").check();
    await targetEditor.getByRole("button", { name: "保存", exact: true }).click();
    const channelNav = restored.getByRole("navigation", { name: "选择渠道" });
    const channelCard = (name: string) =>
      channelNav.getByRole("group", { name: `渠道 ${name}`, exact: true });
    const grip = (name: string) =>
      channelNav.getByRole("button", { name: `排序 ${name}`, exact: true });
    const assertOrder = async (names: string[]) =>
      expect(channelNav.locator(".channel-item strong")).toHaveText(names);
    await assertOrder(["创作服务", "备用服务"]);
    await grip("备用服务").click();
    await channelNav.getByRole("button", { name: "上移", exact: true }).click();
    await assertOrder(["备用服务", "创作服务"]);
    await grip("创作服务").dragTo(channelCard("备用服务"), { targetPosition: { x: 88, y: 13 } });
    await assertOrder(["创作服务", "备用服务"]);
    await channelNav.getByRole("button", { name: /^备用服务/ }).click();
    await restored.getByRole("searchbox", { name: "搜索渠道", exact: true }).fill("服务");
    await expect(grip("创作服务")).toBeEnabled();
    await restored.getByRole("searchbox", { name: "搜索渠道", exact: true }).fill("创作");
    await expect(grip("创作服务")).toHaveCount(0);
    await restored.getByRole("searchbox", { name: "搜索渠道", exact: true }).clear();
    await grip("备用服务").dragTo(channelCard("创作服务"), { targetPosition: { x: 88, y: 13 } });
    await assertOrder(["备用服务", "创作服务"]);
    await expect(channelNav.getByRole("button", { name: /^备用服务/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await channelNav.getByRole("button", { name: /^创作服务/ }).click();
    await enableChannel.click();
    await restored.getByRole("checkbox", { name: "选择 剧本助手模型" }).check();
    await expect(restored.getByRole("button", { name: "迁移渠道", exact: true })).toHaveCount(0);
    const bulkTools = restored.getByRole("toolbar", { name: "已选 1 个模型的批量操作" });
    const clearSelection = bulkTools.getByRole("button", { name: "清除选择" });
    await clearSelection.focus();
    await clearSelection.press("ArrowLeft");
    await expect(bulkTools.getByRole("button", { name: "批量删除" })).toBeFocused();
    await restored.keyboard.press("Home");
    await expect(clearSelection).toBeFocused();
    await restored.keyboard.press("Escape");
    await expect(bulkTools).toBeHidden();
    await expect(restored.getByRole("button", { name: "Provider 设置", exact: true })).toHaveCount(
      0,
    );
    await chooseFilter(restored, "按模型状态筛选", "在线");
    await chooseFilter(restored, "按模型能力筛选", "待配置");
    await expect(restored.getByRole("row", { name: /剧本助手模型/ })).toHaveCount(0);
    await expect(restoredPending).toBeVisible();
    await chooseFilter(restored, "按模型状态筛选", "全部状态");
    await chooseFilter(restored, "按模型能力筛选", "文本");
    await expect(restoredPending).toHaveCount(0);
    await chooseFilter(restored, "按模型能力筛选", "全部能力");
    await restored.getByRole("searchbox", { name: "搜索渠道模型" }).fill("没有这个标签");
    await expect(restored.getByRole("cell", { name: "没有匹配的模型" })).toBeVisible();
    await expect(restored.getByRole("navigation", { name: "模型列表分页" })).toBeVisible();
    await restored.getByRole("button", { name: "清空搜索", exact: true }).click();
    for (const keyword of ["推理", "qwen", "OpenAI"]) {
      await restored.getByRole("searchbox", { name: "搜索渠道模型" }).fill(keyword);
      await expect(restored.locator(".channel-model-name strong")).toHaveText(["剧本助手模型"]);
      await restored.getByRole("button", { name: "清空搜索", exact: true }).click();
      await expect(restoredPending).toBeVisible();
    }
    await restored.screenshot({ path: testInfo.outputPath("model-channels.png") });
    const imported = await restored.evaluate(async () => {
      const api = window.desktop.settings;
      const result = await api.channelList({});
      const channel = result.ok ? result.value.find(({ name }) => name === "创作服务") : undefined;
      if (!channel) throw new Error("缺少创作服务渠道");
      return api.modelImport({
        id: channel.id,
        expectedRevision: channel.revision,
        models: Array.from({ length: 21 }, (_, index) => `page-model-${index}`),
      });
    });
    expect(imported.ok).toBe(true);
    await app.close();
    app = await launch();
    const finalPage = await app.firstWindow();
    await finalPage.getByRole("button", { name: "模型设置" }).click();
    const finalNav = finalPage.getByRole("navigation", { name: "选择渠道" });
    await expect(finalNav.locator(".channel-item strong")).toHaveText(["备用服务", "创作服务"]);
    await finalNav.getByRole("button", { name: /^创作服务/ }).click();
    const table = finalPage.getByRole("table", { name: "渠道模型" });
    const pagination = finalPage.getByRole("navigation", { name: "模型列表分页" });
    await expect(table.getByRole("row")).toHaveCount(21);
    await table.getByLabel("选择 pending-fixture", { exact: true }).check();
    await pagination.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(pagination.getByText("第 2 / 2 页")).toBeVisible();
    await expect(finalPage.getByRole("button", { name: "批量删除", exact: true })).toHaveCount(0);
    await expect(table.getByRole("row")).toHaveCount(5);
    await chooseFilter(finalPage, "模型每页条数", "10");
    await expect(pagination.getByText("第 1 / 3 页")).toBeVisible();
    await pagination.getByRole("button", { name: "最后一页" }).click();
    await expect(pagination.getByText("第 3 / 3 页")).toBeVisible();
    const finalNames = table.locator(".channel-model-name strong");
    await expect(finalNames).toHaveText([
      "page-model-17",
      "page-model-18",
      "page-model-19",
      "page-model-20",
    ]);
    await table.getByRole("button", { name: "排序 page-model-20", exact: true }).press("ArrowUp");
    await expect(finalNames).toHaveText([
      "page-model-17",
      "page-model-18",
      "page-model-20",
      "page-model-19",
    ]);
    await pagination.getByRole("button", { name: "第一页" }).click();
    const firstPageModels = Array.from({ length: 7 }, (_, index) => `page-model-${index}`);
    await expect(finalNames).toHaveText([
      "剧本助手模型",
      "pending-fixture",
      "whisper-fixture",
      ...firstPageModels,
    ]);
    await chooseFilter(finalPage, "按模型能力筛选", "待配置");
    await table
      .getByRole("button", { name: "排序 pending-fixture", exact: true })
      .press("ArrowDown");
    await expect(finalNames.first()).toHaveText("whisper-fixture");
    await chooseFilter(finalPage, "按模型能力筛选", "全部能力");
    await expect(finalNames).toHaveText([
      "剧本助手模型",
      "whisper-fixture",
      "pending-fixture",
      ...firstPageModels,
    ]);

    await finalPage.getByRole("button", { name: /^剧本助手模型/ }).click();
    const agentEditor = finalPage.getByRole("dialog", { name: "编辑模型" });
    await agentEditor.getByRole("button", { name: "取消", exact: true }).click();
    await table.getByLabel("选择 剧本助手模型", { exact: true }).check();
    await finalPage.getByRole("button", { name: "批量修改", exact: true }).click();
    const editBatch = finalPage.getByRole("dialog", { name: "批量修改 1 个模型" });
    const apply = editBatch.getByRole("button", { name: "应用到 1 个模型" });
    await expect(apply).toBeDisabled();
    const priceCheck = editBatch.getByRole("checkbox", { name: "默认价格" });
    await priceCheck.check();
    await expect(editBatch.getByRole("alert")).toHaveText("请填写大于 0 的整数");
    await editBatch.getByRole("textbox", { name: "默认价格" }).fill("1000001");
    await expect(editBatch.getByRole("alert")).toHaveText("默认价格不可超过 100 万积分");
    await expect(apply).toBeDisabled();
    await editBatch.getByRole("textbox", { name: "默认价格" }).fill("999");
    await priceCheck.uncheck();
    await editBatch.getByRole("checkbox", { name: "任务时限" }).check();
    await editBatch.getByRole("textbox", { name: "任务时限" }).fill("1h5m");
    await apply.click();
    const editResult = finalPage.getByRole("dialog", { name: "批量修改完成" });
    await expect(editResult.getByText("gpt-fixture", { exact: true })).toBeVisible();
    await editResult.getByRole("button", { name: "知道了" }).click();
    const clearFinalSelection = finalPage
      .getByRole("toolbar")
      .getByRole("button", { name: "清除选择" });
    await expect(table.getByLabel("选择 剧本助手模型", { exact: true })).toBeChecked();
    await expect(table.getByLabel("选择本页模型")).toHaveJSProperty("indeterminate", true);
    await clearFinalSelection.click();
    const patched = await finalPage.evaluate(async () => {
      const result = await window.desktop.settings.list({});
      return (
        result.ok && result.value.providers.find(({ model }) => model === "gpt-fixture")?.config
      );
    });
    expect(patched).toMatchObject({ timeoutSeconds: 3900, pricing: { input: 17 } });
    await table.getByLabel("选择 pending-fixture", { exact: true }).check();
    await finalPage.getByRole("button", { name: "批量设置能力与协议" }).click();
    const protocolBatch = finalPage.getByRole("dialog", {
      name: "批量设置能力与协议 · 已选 1 个模型",
    });
    const applyProtocol = protocolBatch.getByRole("button", { name: "应用到 1 个模型" });
    await expect(applyProtocol).toBeDisabled();
    await protocolBatch.getByRole("button", { name: "文本", exact: true }).click();
    await expect(applyProtocol).toBeDisabled();
    await protocolBatch.getByRole("radio", { name: /^OpenAI/ }).click();
    await protocolBatch.getByRole("button", { name: "图片", exact: true }).click();
    await expect(protocolBatch.getByRole("status")).toHaveText("已选协议不支持图片，请重新选择");
    await expect(applyProtocol).toBeDisabled();
    await protocolBatch.getByRole("radio", { name: /^OpenAI · 图片/ }).click();
    await protocolBatch.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(protocolBatch.getByRole("status")).toHaveText(
      "Agent 模型不需要选择协议，已清空已选协议",
    );
    await expect(applyProtocol).toBeEnabled();
    await protocolBatch.getByRole("button", { name: "文本", exact: true }).click();
    await expect(protocolBatch.getByRole("status")).toHaveCount(0);
    await protocolBatch.getByRole("radio", { name: /^OpenAI/ }).click();
    const pinned = await protocolBatch.getByLabel("协议版本").innerText();
    await chooseFilter(finalPage, "接口", "（不设置）");
    await chooseFilter(finalPage, "参考图传输格式", "请选择");
    await expect(applyProtocol).toBeDisabled();
    await chooseFilter(finalPage, "参考图传输格式", "url");
    await expect(applyProtocol).toBeEnabled();
    await applyProtocol.click();
    const protocolResult = finalPage.getByRole("dialog", { name: "批量设置能力与协议完成" });
    await expect(protocolResult.getByText("成功 1 项，跳过 0 项，失败 0 项。")).toBeVisible();
    await protocolResult.getByRole("button", { name: "知道了" }).click();
    await expect(table.getByLabel("选择 pending-fixture", { exact: true })).toBeChecked();
    await clearFinalSelection.click();
    await table.getByRole("button", { name: /^pending-fixture/ }).click();
    await expect(agentEditor.getByLabel("协议版本")).toHaveText(pinned, { useInnerText: true });
    await agentEditor.getByRole("button", { name: "配置 JSON" }).click();
    expect(
      JSON.parse(await agentEditor.getByRole("textbox", { name: "配置 JSON" }).inputValue()),
    ).toMatchObject({
      deadline: "300s",
      capabilities: { prompt: { max_length: 20000 }, context: { window: 128000, output: 8192 } },
      pricing: { billing: "token", token: { in: 2, out: 8 } },
    });
    await agentEditor.getByRole("button", { name: "取消", exact: true }).click();
    await table.getByLabel("选择 page-model-0", { exact: true }).check();
    await table.getByLabel("选择 page-model-1", { exact: true }).check();
    await table.getByLabel("选择 剧本助手模型", { exact: true }).check();
    await finalPage.getByRole("button", { name: "批量删除", exact: true }).click();
    const conflict = await finalPage.evaluate(async () => {
      const api = window.desktop.settings;
      const listing = await api.list({});
      if (!listing.ok) throw Error(listing.code);
      const stale = listing.value.providers.find((model) => model.model === "page-model-1")!;
      return api.modelRemove({ id: stale.id, expectedRevision: stale.revision });
    });
    expect(conflict.ok).toBe(true);
    await finalPage
      .getByRole("alertdialog", { name: "删除 3 个模型？" })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    const batch = finalPage.getByRole("dialog", { name: "批量删除完成" });
    await expect(batch.getByText("成功 1 项，跳过 1 项，失败 1 项。")).toBeVisible();
    await expect(batch.getByRole("alert")).toContainText(
      "page-model-1：配置已更新，请重新载入后再保存。",
    );
    await expect(batch.getByText("gpt-fixture：还在上线，先下线再删除")).toBeVisible();
    await expect(batch.getByText("page-model-0", { exact: true })).toBeVisible();
    const acknowledge = batch.getByRole("button", { name: "知道了" });
    await expect(acknowledge).toBeFocused();
    await finalPage.keyboard.press("Tab");
    await expect(batch.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await finalPage.keyboard.press("Shift+Tab");
    await expect(acknowledge).toBeFocused();
    await finalPage.keyboard.press("Enter");
    await expect(batch).toBeHidden();
    await expect(table.getByLabel("选择 page-model-0", { exact: true })).toHaveCount(0);
    await expect(table.getByLabel("选择 page-model-1", { exact: true })).toHaveCount(0);
    await expect(finalPage.getByRole("toolbar", { name: "已选 1 个模型的批量操作" })).toBeVisible();
    await expect(table.getByLabel("选择 剧本助手模型", { exact: true })).toBeChecked();
    await clearFinalSelection.click();
    const destination = await finalPage.evaluate(async () => {
      const api = window.desktop.settings;
      const listing = await api.channelList({});
      const target = listing.ok && listing.value.find((channel) => channel.name === "备用服务");
      if (!target) throw Error("缺少备用服务");
      const imported = await api.modelImport({
        id: target.id,
        expectedRevision: target.revision,
        models: ["page-model-3"],
      });
      if (!imported.ok) throw Error(imported.code);
      return target.id;
    });
    for (const index of [4, 3, 2])
      await table.getByLabel(`选择 page-model-${index}`, { exact: true }).check();
    await finalPage.getByRole("button", { name: "批量修改", exact: true }).click();
    const migrate = finalPage.getByRole("dialog", { name: "批量修改 3 个模型" });
    await migrate.getByRole("checkbox", { name: "所属渠道" }).check();
    const destinationSelect = migrate.getByRole("combobox", { name: "所属渠道" });
    const applyEdit = migrate.getByRole("button", { name: "应用到 3 个模型" });
    await expect(destinationSelect).toHaveAccessibleDescription("请选择渠道");
    await expect(applyEdit).toBeDisabled();
    await destinationSelect.press("ArrowDown");
    const destinationList = migrate.getByRole("listbox");
    await expect(destinationList).toBeVisible();
    await finalPage.keyboard.press("Escape");
    await expect(destinationList).toHaveCount(0);
    await expect(destinationSelect).toBeFocused();
    await destinationSelect.click();
    await destinationList.getByRole("option", { name: "备用服务" }).click();
    await expect(destinationSelect).toHaveAccessibleDescription("新渠道需已启用并设置 Key");
    await migrate.getByRole("checkbox", { name: "所属渠道" }).uncheck();
    await expect(applyEdit).toBeDisabled();
    await migrate.getByRole("checkbox", { name: "所属渠道" }).check();
    await expect(destinationSelect).toContainText("备用服务");
    await migrate.getByRole("checkbox", { name: "任务时限" }).check();
    await migrate.getByRole("textbox", { name: "任务时限" }).fill("90s");
    await migrate.getByRole("checkbox", { name: "默认价格" }).check();
    await migrate.getByRole("textbox", { name: "默认价格" }).fill("21");
    await migrate.getByRole("button", { name: "应用到 3 个模型" }).click();
    await expect(editResult.getByText("成功 0 项，跳过 3 项，失败 0 项。")).toBeVisible();
    await expect(editResult.getByRole("listitem").filter({ hasText: "没有统一价格" })).toHaveCount(
      3,
    );
    await editResult.getByRole("button", { name: "知道了" }).click();
    await expect(finalPage.getByRole("toolbar", { name: "已选 3 个模型的批量操作" })).toBeVisible();
    await finalPage.getByRole("button", { name: "批量修改", exact: true }).click();
    await migrate.getByRole("checkbox", { name: "所属渠道" }).check();
    await migrate.getByRole("checkbox", { name: "任务时限" }).check();
    await destinationSelect.click();
    await destinationList.getByRole("option", { name: "备用服务" }).click();
    await expect(applyEdit).toBeEnabled();
    await destinationSelect.click();
    await destinationList.getByRole("option", { name: "选择渠道" }).click();
    await expect(applyEdit).toBeDisabled();
    await destinationSelect.click();
    await destinationList.getByRole("option", { name: "备用服务" }).click();
    await migrate.getByRole("textbox", { name: "任务时限" }).fill("90s");
    await migrate.getByRole("button", { name: "应用到 3 个模型" }).click();
    await expect(editResult.getByText("成功 0 项，跳过 2 项，失败 1 项。")).toBeVisible();
    await expect(editResult.getByRole("status").getByRole("listitem")).toHaveText([
      "page-model-4：已保存，但有 3 个问题，上线前要处理",
      "page-model-2：已保存，但有 3 个问题，上线前要处理",
    ]);
    await expect(editResult.getByRole("alert")).toContainText(
      "page-model-3：此模型已添加到当前 Provider。",
    );
    await editResult.getByRole("button", { name: "知道了" }).click();
    await expect(table.getByLabel("选择 page-model-3", { exact: true })).toBeChecked();
    await expect(table.getByLabel("选择 page-model-4", { exact: true })).toHaveCount(0);
    await clearFinalSelection.click();
    const moves = await finalPage.evaluate(async (id) => {
      const listed = await window.desktop.settings.list({});
      if (!listed.ok) throw Error(listed.code);
      return listed.value.providers
        .filter((model) => ["page-model-4", "page-model-3", "page-model-2"].includes(model.model))
        .map((model) => [
          model.channelId === id,
          model.model,
          model.pending,
          !!model.config,
          model.pendingDeadlineSeconds ?? null,
        ]);
    }, destination);
    expect(moves).toHaveLength(4);
    expect(moves).toEqual(
      expect.arrayContaining([
        [true, "page-model-4", true, false, 90],
        [true, "page-model-2", true, false, 90],
        [false, "page-model-3", true, false, null],
        [true, "page-model-3", true, false, null],
      ]),
    );
    await finalNav.getByRole("button", { name: /^备用服务/ }).click();
    await table.getByLabel("选择 page-model-4", { exact: true }).check();
    await finalPage.getByRole("button", { name: "批量设置能力与协议" }).click();
    await protocolBatch.getByRole("button", { name: "文本", exact: true }).click();
    await protocolBatch.getByRole("radio", { name: /^OpenAI/ }).click();
    await applyProtocol.click();
    await expect(protocolResult.getByText("成功 1 项，跳过 0 项，失败 0 项。")).toBeVisible();
    await protocolResult.getByRole("button", { name: "知道了" }).click();
    await table.getByRole("button", { name: /^page-model-4/ }).click();
    await agentEditor.getByRole("button", { name: "配置 JSON" }).click();
    expect(
      JSON.parse(await agentEditor.getByRole("textbox", { name: "配置 JSON" }).inputValue()),
    ).toMatchObject({ kind: "text", deadline: "90s" });
    await agentEditor.getByRole("button", { name: "取消", exact: true }).click();
    await finalPage.getByRole("button", { name: "批量设置能力与协议" }).click();
    await protocolBatch.getByRole("button", { name: "图片", exact: true }).click();
    await protocolBatch.getByRole("radio", { name: /^OpenAI · 图片/ }).click();
    await applyProtocol.click();
    await expect(protocolResult.getByText("成功 0 项，跳过 1 项，失败 0 项。")).toBeVisible();
    await expect(protocolResult.getByRole("listitem")).toHaveText(
      "page-model-4：已保存，但有 1 个问题，上线前要处理",
    );
    await protocolResult.getByRole("button", { name: "知道了" }).click();
    await expect(table.getByRole("row", { name: /page-model-4/ })).toContainText(
      "上线前要处理：只有文本、Agent 模型按 Token 计费",
    );
    await finalNav.getByRole("button", { name: /^创作服务/ }).click();
    await finalPage.getByRole("button", { name: /^剧本助手模型/ }).click();
    await agentEditor.getByRole("button", { name: "Agent", exact: true }).click();
    const kindConfirm = finalPage.getByRole("alertdialog", { name: /改成.+模型？/ });
    await expect(kindConfirm).toHaveAccessibleDescription(
      "能力、参数和定价将重置为默认值，不兼容的协议会被清空。",
    );
    await kindConfirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(agentEditor.getByRole("button", { name: "文本", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await agentEditor.getByRole("button", { name: "Agent", exact: true }).click();
    await kindConfirm.getByRole("button", { name: "确认修改", exact: true }).click();
    await expect(agentEditor.getByText("宿主网关", { exact: true })).toHaveCount(0);
    await expect(agentEditor.getByLabel("协议版本")).toHaveCount(0);
    await expect(agentEditor.locator(".model-protocol-list")).toHaveCount(0);
    await agentEditor.getByRole("tab", { name: "能力与参数" }).click();
    await expect(
      agentEditor.getByRole("spinbutton", { name: "最大输出", exact: true }),
    ).toHaveValue("8192");
    await expect(
      agentEditor.getByRole("spinbutton", { name: "上下文窗口", exact: true }),
    ).toHaveValue("200000");
    await agentEditor.getByRole("tab", { name: "基本信息" }).click();
    await agentEditor.getByRole("button", { name: "文本", exact: true }).click();
    await kindConfirm.getByRole("button", { name: "确认修改", exact: true }).click();
    await expect(agentEditor.getByText("未选择协议", { exact: true })).toBeVisible();
    await expect(agentEditor.getByRole("button", { name: "测试模型" })).toBeDisabled();
    await agentEditor.getByRole("tab", { name: "能力与参数" }).click();
    await expect(agentEditor.getByLabel("固定系统提示")).toHaveValue("");
    await agentEditor.getByRole("tab", { name: "基本信息" }).click();
    await agentEditor.getByRole("button", { name: "Agent", exact: true }).click();
    await kindConfirm.getByRole("button", { name: "确认修改", exact: true }).click();
    await expect(agentEditor.getByLabel("接口路径前缀")).toHaveValue("");
    await expect(agentEditor.getByLabel("创作端预览")).toContainText("按 Token");
    await agentEditor.getByLabel("接口路径前缀").fill("/agent/v3");
    await expect(agentEditor.getByRole("combobox", { name: "接口格式" })).toContainText(
      "OpenAI 兼容",
    );
    await agentEditor.getByRole("button", { name: "配置 JSON" }).click();
    const agentJson = agentEditor.getByRole("textbox", { name: "配置 JSON" });
    expect(JSON.parse(await agentJson.inputValue())).toMatchObject({
      deadline: "3900s",
      pricing: { billing: "token", token: { in: 3, out: 15 } },
      capabilities: { vision: true },
    });
    await agentJson.fill(
      JSON.stringify({
        ...JSON.parse(await agentJson.inputValue()),
        deadline: "30m",
        idle_timeout: "45s",
      }),
    );
    await agentEditor.getByRole("button", { name: "保存模型" }).click();
    await expect(agentEditor).toBeHidden();
    const agentRow = table.getByRole("row", { name: /剧本助手模型/ });
    await expect(agentRow.getByText("宿主网关", { exact: true })).toBeVisible();
    await finalPage.evaluate(async () => {
      const api = window.desktop.settings;
      const list = await api.list({});
      if (!list.ok) throw Error(list.code);
      const agent = list.value.providers.find((entry) => entry.config?.name === "剧本助手模型");
      const adapter = list.value.plugins.find((entry) => entry.key === "openai");
      if (!adapter || agent?.pluginHash !== "") throw Error("渠道 Agent 仍固定插件");
      const disabled = await api.pluginToggle({ hash: adapter.hash, enabled: false });
      if (!disabled.ok) throw Error(disabled.code);
    });
    await agentRow.getByRole("button", { name: /^剧本助手模型/ }).click();
    const onlineSwitch = agentEditor.getByRole("switch", { name: "模型上线" });
    const onlineLabel = agentEditor.locator(
      'label.settings-switch:has(input[aria-label="模型上线"])',
    );
    await expect(onlineSwitch).toBeChecked();
    await onlineLabel.click();
    await expect(onlineSwitch).not.toBeChecked();
    await expect(onlineSwitch).toBeEnabled();
    await onlineLabel.click();
    await expect(onlineSwitch).toBeChecked();
    await expect(agentEditor.getByLabel("接口路径前缀")).toHaveValue("/agent/v3");
    await agentEditor.getByRole("button", { name: "配置 JSON" }).click();
    expect(JSON.parse(await agentJson.inputValue())).toMatchObject({
      deadline: "1800s",
      idle_timeout: "45s",
    });
    await agentEditor.getByRole("button", { name: "回到表单" }).click();
    const agentTrialButton = agentEditor.getByRole("button", { name: "测试模型" });
    await expect(agentTrialButton).toBeDisabled();
    await expect(agentTrialButton).toHaveAttribute("title", "Agent 模型暂不支持试跑");
    await agentEditor.getByRole("tab", { name: "基本信息" }).click();
    const gatewayFormat = agentEditor.getByRole("combobox", { name: "接口格式" });
    await gatewayFormat.click();
    await expect(agentEditor.getByRole("option")).toHaveCount(2);
    await agentEditor.getByRole("option", { name: "Gemini 原生" }).click();
    await expect(agentEditor.getByLabel("接口路径前缀")).toHaveCount(0);
    await agentEditor.getByRole("tab", { name: "能力与参数" }).click();
    await agentEditor.getByRole("button", { name: "看视频", exact: true }).click();
    await agentEditor.getByRole("button", { name: "保存模型" }).click();
    await expect(agentEditor).toBeHidden();
    await agentRow.getByRole("checkbox").check();
    await finalPage.getByRole("button", { name: "批量设置能力与协议" }).click();
    await protocolBatch.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(protocolBatch.locator(".model-protocol-list")).toHaveCount(0);
    await applyProtocol.click();
    await expect(protocolResult.getByText("成功 1 项，跳过 0 项，失败 0 项。")).toBeVisible();
    await protocolResult.getByRole("button", { name: "知道了" }).click();
    await clearFinalSelection.click();
    await agentRow.getByRole("button", { name: /^剧本助手模型/ }).click();
    await expect(gatewayFormat).toContainText("Gemini 原生");
    await agentEditor.getByRole("button", { name: "配置 JSON" }).click();
    const geminiChannel = JSON.parse(await agentJson.inputValue()).channels[0];
    expect(JSON.parse(await agentJson.inputValue()).capabilities.video).toBe(true);
    expect(geminiChannel.api_format).toBe("gemini");
    expect(geminiChannel).not.toHaveProperty("path_prefix");
    await agentEditor.getByRole("button", { name: "回到表单" }).click();
    await gatewayFormat.click();
    await agentEditor.getByRole("option", { name: "OpenAI 兼容" }).click();
    await expect(
      agentEditor.getByText("接口格式改成 OpenAI 兼容后，「看视频」已关闭"),
    ).toBeVisible();
    await agentEditor.getByRole("tab", { name: "能力与参数" }).click();
    const videoCapability = agentEditor.getByRole("button", { name: "看视频", exact: true });
    await expect(videoCapability).toHaveAttribute("aria-pressed", "false");
    await expect(videoCapability).toBeDisabled();
    await agentEditor.getByRole("button", { name: "保存模型" }).click();
    await agentRow.getByRole("button", { name: /^剧本助手模型/ }).click();
    await expect(gatewayFormat).toContainText("OpenAI 兼容");
    await agentEditor.getByRole("button", { name: "关闭弹窗" }).click();
    await expect(agentRow.getByRole("button", { name: "测试 剧本助手模型" })).toBeDisabled();
    const singleDelete = agentRow.getByRole("button", { name: "删除 剧本助手模型" });
    await singleDelete.click();
    const blocker = finalPage.getByRole("dialog", { name: "暂时不能删除「剧本助手模型」" });
    await blocker.getByRole("button", { name: "关闭", exact: true }).click();
    await singleDelete.click();
    await blocker.getByRole("button", { name: "下架并删除" }).click();
    await expect(agentRow).toHaveCount(0);
    await finalPage.getByRole("button", { name: "适配器管理", exact: true }).click();
    await finalPage.getByRole("searchbox", { name: "搜索插件" }).fill("openai");
    await finalPage.getByRole("switch", { name: "启用插件 OpenAI", exact: true }).click();
    await expect(
      finalPage.getByRole("switch", { name: "停用插件 OpenAI", exact: true }),
    ).toBeChecked();
    await finalPage.getByRole("button", { name: "返回模型渠道", exact: true }).click();
    await finalNav.getByRole("button", { name: /^创作服务/ }).click();
    await finalPage
      .locator(".channel-model-heading")
      .getByRole("button", { name: "新增模型", exact: true })
      .click();
    const importDialog = finalPage.getByRole("dialog", { name: "新建模型" });
    await importDialog.getByRole("button", { name: "配置 JSON" }).click();
    const importedText = importDialog.getByRole("textbox", { name: "配置 JSON" });
    const blankBody = JSON.parse(await importedText.inputValue());
    const refOff = { on: false, max: 0, max_mb: 0 };
    const textBody = {
      ...blankBody,
      label: "原版文本模板",
      kind: "text",
      sort: 0,
      deadline: "5m",
      channels: [
        {
          ...blankBody.channels[0],
          upstream_model: "template-fixture",
          protocol: { plugin: "openai", settings: { api: "responses" } },
        },
      ],
      capabilities: {
        refs: { image: refOff, audio: refOff, video: refOff },
        prompt: { max_length: 20000 },
        params: {},
        context: { window: 128000, output: 8192 },
      },
      pricing: { billing: "token", token: { in: 3, out: 15 } },
    };
    await importedText.fill(
      JSON.stringify(
        {
          ...textBody,
          channels: [
            { ...textBody.channels[0], protocol: { plugin: "openai", version: "999.0.0" } },
          ],
        },
        null,
        2,
      ),
    );
    await importDialog.getByRole("button", { name: /未找到匹配该能力的插件版本/ }).click();
    expect(
      await importedText.evaluate((input: HTMLTextAreaElement) =>
        input.value.slice(input.selectionStart, input.selectionStart + 9),
      ),
    ).toBe('"version"');
    await importedText.fill(JSON.stringify(textBody, null, 2));
    await importDialog.getByRole("button", { name: "保存模型" }).click();
    await expect(importDialog).toBeHidden();
    await finalPage.getByRole("button", { name: /^原版文本模板/ }).click();
    await agentEditor.getByRole("button", { name: "配置 JSON" }).click();
    const restoredBody = JSON.parse(
      await agentEditor.getByRole("textbox", { name: "配置 JSON" }).inputValue(),
    );
    expect(restoredBody.channels[0].protocol.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(restoredBody.pricing).toEqual(textBody.pricing);
    expect(restoredBody.capabilities.context).toEqual(textBody.capabilities.context);
    await agentEditor.getByRole("button", { name: "测试模型" }).click();
    const templateTrial = finalPage.getByRole("dialog", { name: "测试 原版文本模板" });
    await templateTrial.getByLabel("测试提示词").fill("词".repeat(20000));
    await templateTrial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(templateTrial.getByRole("tabpanel", { name: "请求描述" })).toContainText(
      "/v1/responses",
    );
    await templateTrial.getByRole("button", { name: "关闭", exact: true }).click();
    const editJson = agentEditor.getByRole("textbox", { name: "配置 JSON" });
    await editJson.fill(
      JSON.stringify({ ...restoredBody, pricing: { billing: "token", pending: true } }),
    );
    await agentEditor.getByRole("button", { name: "保存模型" }).click();
    await finalPage.getByRole("button", { name: /^原版文本模板/ }).click();
    await expect(agentEditor.getByRole("switch", { name: "模型上线" })).toBeDisabled();
    await expect(agentEditor.getByLabel("创作端预览")).toContainText("待定价");
    await agentEditor.getByRole("button", { name: "配置 JSON" }).click();
    expect(JSON.parse(await editJson.inputValue()).pricing).toEqual({
      billing: "token",
      pending: true,
    });
    await agentEditor.getByRole("button", { name: "测试模型" }).click();
    await expect(
      templateTrial.getByRole("button", { name: "开始测试", exact: true }),
    ).toBeEnabled();
    await templateTrial.getByRole("button", { name: "关闭", exact: true }).click();
    await agentEditor.getByRole("button", { name: "回到表单" }).click();
    await agentEditor.getByRole("tab", { name: "积分定价" }).click();
    await expect(agentEditor.getByLabel("输入价", { exact: true })).toHaveValue("");
    const costSwitch = agentEditor.getByRole("switch", { name: "积分成本", exact: true });
    await costSwitch.press("Space");
    await expect(agentEditor.getByLabel("输入成本", { exact: true })).toHaveValue("");
    await expect(agentEditor.getByLabel("输出成本", { exact: true })).toHaveValue("");
    await agentEditor.getByLabel("输入价", { exact: true }).fill("2000");
    await agentEditor.getByLabel("输出价", { exact: true }).fill("3000");
    await agentEditor.getByRole("button", { name: "保存模型" }).click();
    await expect(agentEditor.locator('[data-field="pricing"]')).toBeFocused();
    const missingCost = agentEditor.getByText("按 Token 计费的成本需要输入价与输出价", {
      exact: true,
    });
    await expect(missingCost.first()).toBeVisible();
    await agentEditor.getByLabel("输入成本", { exact: true }).fill("3000");
    await expect(missingCost).toHaveCount(0);
    await expect(agentEditor.getByLabel("输出成本", { exact: true })).toHaveValue("0");
    await agentEditor.getByLabel("输出成本", { exact: true }).fill("1500");
    await expect(agentEditor.getByText("利润率 -50%", { exact: true })).toHaveAttribute(
      "data-tone",
      "danger",
    );
    await expect(agentEditor.getByText("利润率 50%", { exact: true })).toHaveAttribute(
      "data-tone",
      "success",
    );
    await expect(agentEditor.getByLabel("创作端预览")).toContainText("最多冻结 27 积分");
    await agentEditor.getByRole("button", { name: "保存模型" }).click();
    await finalPage.getByRole("button", { name: /^原版文本模板/ }).click();
    await expect(agentEditor.getByRole("switch", { name: "模型上线" })).toBeEnabled();
    await agentEditor.getByRole("button", { name: "配置 JSON" }).click();
    expect(JSON.parse(await editJson.inputValue()).pricing).toEqual({
      billing: "token",
      token: { in: 2000, out: 3000 },
      cost: { on: true, token: { in: 3000, out: 1500 } },
    });
    await agentEditor.getByRole("button", { name: "回到表单" }).click();
    await agentEditor.getByRole("tab", { name: "积分定价" }).click();
    await costSwitch.press("Space");
    await expect(agentEditor.getByLabel("输出成本", { exact: true })).toHaveCount(0);
    await expect(agentEditor.getByLabel("创作端预览")).toContainText("最多冻结 27 积分");
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
