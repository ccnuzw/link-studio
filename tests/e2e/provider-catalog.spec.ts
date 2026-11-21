import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("渠道模型引用与适配器版本管理", async () => {
  const testInfo = test.info();
  const directory = await mkdtemp(join(tmpdir(), "link-studio-catalog-"));
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ["."] }), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    const openai = await page.evaluate(async (endpoint) => {
      const api = window.desktop.settings;
      const list = await api.list({});
      const plugin = list.ok ? list.value.plugins.find(({ key }) => key === "openai") : undefined;
      if (!plugin) throw new Error("Missing OpenAI adapter");
      const created = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "测试渠道",
          endpoint,
          allowLocal: true,
          enabled: true,
          sort: 100,
          headers: [],
        },
      });
      if (!created.ok) throw new Error(created.code);
      const keys = await api.channelKeys({
        id: created.value.id,
        expectedRevision: created.value.revision,
        secret: "catalog-fixture-secret",
      });
      if (!keys.ok) throw new Error(keys.code);
      for (const model of ["alpha-chat", "beta-chat"]) {
        const saved = await api.modelSave({
          expectedRevision: 0,
          channelId: keys.value.id,
          channelRevision: keys.value.revision,
          pluginHash: plugin.hash,
          upstreamModel: model,
          enabled: true,
          approve: true,
          settings: {},
          config: { name: model, kind: "text", sort: 100, description: "" },
        });
        if (!saved.ok) throw new Error(saved.code);
      }
      return plugin;
    }, `http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "模型设置" }).click();
    await expect(page.getByRole("switch", { name: "beta-chat 上线" })).toBeChecked();

    const windowHandle = await app.browserWindow(page);
    await windowHandle.evaluate((browserWindow) => browserWindow.setSize(1024, 700));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024);
    await page.getByRole("button", { name: "适配器管理", exact: true }).click();
    const catalog = page.getByRole("region", { name: "插件目录" });
    const table = catalog.getByRole("table", { name: "Provider 插件" });
    await expect(table.getByRole("row")).toHaveCount(11);
    await expect
      .poll(() =>
        table.evaluate((element) => {
          const scroller = element.parentElement;
          return scroller != null && scroller.scrollWidth <= scroller.clientWidth;
        }),
      )
      .toBe(true);
    await expect(catalog.getByRole("switch").first()).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("plugin-catalog.png") });
    await catalog.getByRole("button", { name: "图片", exact: true }).click();
    await expect(table.getByRole("button", { name: "查看 OpenAI", exact: true })).toHaveCount(0);
    await catalog.getByRole("button", { name: "全部", exact: true }).click();
    await catalog.getByRole("button", { name: "下一页" }).click();
    await expect(catalog.getByRole("button", { name: "上一页" })).toBeEnabled();
    const search = catalog.getByRole("searchbox", { name: "搜索插件" });
    await search.fill("not-a-plugin");
    await expect(catalog.getByText("没有符合条件的插件")).toBeVisible();
    await catalog.getByRole("button", { name: "清除筛选" }).click();
    await search.fill("openai");
    const openDetails = table.getByRole("button", { name: "查看 OpenAI", exact: true });
    await openDetails.click();
    const details = page.getByRole("dialog", { name: "OpenAI", exact: true });
    await expect(details.getByRole("heading", { name: "能力与请求" })).toBeVisible();
    await expect(details.getByRole("heading", { name: "协议设置项" })).toBeVisible();
    await expect(details.getByRole("button", { name: "基于此版本编辑" })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("plugin-overview.png") });
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(openDetails).toBeFocused();
    await openDetails.click();
    const modelTab = details.getByRole("button", { name: /引用与升级/ });
    const historyTab = details.getByRole("button", { name: /版本历史/ });
    await modelTab.click();
    await expect(page.getByRole("heading", { name: "引用模型（2）" })).toBeVisible();
    await expect(page.getByRole("button", { name: "停用适配器" })).toBeDisabled();
    await page.getByRole("button", { name: "基于此版本编辑" }).click();
    const source = page.getByLabel("适配器源码");
    await source.fill(`${await source.inputValue()}\n// catalog adapter fixture`);
    await page.getByText("离线样例检查", { exact: true }).click();
    await page.getByRole("button", { name: "运行离线检查" }).click();
    await expect(page.getByText("样例检查通过")).toBeVisible();
    await page.getByRole("button", { name: "校验并保存版本" }).click();
    await expect(page.getByText("已校验并保存版本，可在模型的调用协议中选择。")).toBeVisible();
    const versions = await page.evaluate(() => window.desktop.settings.list({}));
    if (!versions.ok) throw new Error(versions.code);
    const imported = versions.value.plugins.find(
      ({ key, origin }) => key === openai.key && origin === "manual",
    );
    if (!imported) throw new Error("Missing imported adapter");
    const builtinVersion = details.getByRole("button", {
      name: `选择版本 v${openai.version}`,
      exact: true,
    });
    const manualVersion = details.getByRole("button", {
      name: `选择版本 v${imported.version}`,
      exact: true,
    });
    await expect(manualVersion).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: testInfo.outputPath("plugin-history.png") });
    await page.getByRole("button", { name: "停用适配器" }).click();
    await expect(page.getByRole("button", { name: "启用适配器" })).toBeVisible();
    await page.getByRole("button", { name: "启用适配器" }).click();
    await builtinVersion.click();
    await modelTab.click();
    await page.getByLabel("批量升级至").selectOption(imported.hash);
    await page.getByRole("button", { name: "确认升级 2 个模型" }).click();
    await expect(page.getByText("已升级 2 个模型，失败 0 个。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "引用模型（0）" })).toBeVisible();
    await historyTab.click();
    await manualVersion.click();
    await modelTab.click();
    await expect(page.getByRole("heading", { name: "引用模型（2）" })).toBeVisible();
    await expect(page.getByRole("button", { name: "移除版本" })).toBeDisabled();
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: "模型设置" }).click();
    const restored = await reopened.evaluate(() => window.desktop.settings.list({}));
    if (!restored.ok) throw new Error(restored.code);
    expect(restored.value.providers.map(({ pluginHash }) => pluginHash)).toEqual([
      imported.hash,
      imported.hash,
    ]);
    const online = reopened.getByRole("switch", { name: "beta-chat 上线" });
    await online.click();
    await expect(online).not.toBeChecked();
    await reopened.getByRole("button", { name: "适配器管理", exact: true }).click();
    await reopened.getByRole("searchbox", { name: "搜索插件" }).fill("openai");
    await reopened.getByRole("button", { name: "查看 OpenAI", exact: true }).click();
    await reopened.getByRole("button", { name: /引用与升级/ }).click();
    await expect(reopened.getByRole("heading", { name: "引用模型（2）" })).toBeVisible();
    await reopened.getByLabel("批量升级至").selectOption(openai.hash);
    await reopened.getByRole("button", { name: "确认升级 2 个模型" }).click();
    await expect(reopened.getByRole("heading", { name: "引用模型（0）" })).toBeVisible();
    await reopened.getByRole("button", { name: "移除版本" }).click();
    await reopened.getByRole("button", { name: "确认移除" }).click();
    await expect(reopened.getByText("已移除版本")).toBeVisible();
    await reopened.getByRole("button", { name: "关闭适配器详情" }).click();
    await reopened.getByRole("button", { name: "返回模型渠道" }).click();
    const keyButton = reopened.getByRole("button", { name: "设置 Key", exact: true });
    await keyButton.click();
    const keyDialog = reopened.getByRole("dialog", { name: /的 Key/ });
    const secondary = keyDialog.getByLabel("Secret Key（可选）");
    await secondary.fill("fixture-secondary-key");
    await keyDialog.getByRole("button", { name: "保存 Key" }).click();
    await expect(reopened.getByText("Secret Key 已配置", { exact: true })).toBeVisible();
    await keyButton.click();
    await expect(secondary).toHaveValue("");
    await keyDialog.getByLabel("移除 Secret Key").check();
    await keyDialog.getByRole("button", { name: "保存 Key" }).click();
    await expect(reopened.getByText("Secret Key 未配置", { exact: true })).toBeVisible();
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
