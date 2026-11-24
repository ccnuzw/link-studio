import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("删除渠道前迁移，部分失败可重试，名称确认后删除", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-migration-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const target = await page.evaluate(async () => {
      const api = window.desktop.settings;
      const channels = [];
      for (const name of ["迁出", "迁入"]) {
        const result = await api.channelSave({
          expectedRevision: 0,
          approve: true,
          fields: {
            name,
            endpoint: "https://example.invalid",
            enabled: true,
            allowLocal: false,
            sort: channels.length,
            headers: [],
          },
        });
        if (!result.ok) throw Error(result.code);
        const imported = await api.modelImport({
          id: result.value.id,
          expectedRevision: result.value.revision,
          models: name === "迁出" ? ["movable", "duplicate"] : ["duplicate"],
        });
        if (!imported.ok) throw Error(imported.code);
        channels.push(result.value);
      }
      const catalog = await api.list({});
      if (!catalog.ok) throw Error(catalog.code);
      const plugin = catalog.value.plugins.find((item) => item.key === "openai");
      if (!plugin) throw Error("缺少测试协议");
      const source = channels[0]!;
      const saved = await api.modelSave({
        channelId: source.id,
        channelRevision: source.revision,
        expectedRevision: 0,
        upstreamModel: "json-model",
        pluginHash: plugin.hash,
        config: { kind: "text", name: "JSON 迁移", description: "", sort: 0 },
        settings: {},
        enabled: false,
      });
      if (!saved.ok) throw Error(saved.code);
      return channels[1]!.id;
    });
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: /^JSON 迁移/ }).click();
    const editor = page.getByRole("dialog", { name: "编辑模型" });
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    const field = editor.getByLabel("配置 JSON", { exact: true });
    const document = JSON.parse(await field.inputValue());
    document.channels[0].channel = target;
    await field.fill(JSON.stringify(document));
    await editor.getByRole("button", { name: "保存模型" }).click();
    await expect(editor).toBeHidden();
    const afterJson = await page.evaluate(() => window.desktop.settings.list({}));
    if (!afterJson.ok) throw Error(afterJson.code);
    expect(afterJson.value.providers.find((entry) => entry.model === "json-model")).toMatchObject({
      channelId: target,
      config: { name: "JSON 迁移" },
    });
    await page.locator(".channel-more summary").click();
    await page
      .getByRole("region", { name: "渠道详情" })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    const blocked = page.getByRole("dialog", { name: "暂时不能删除「迁出」" });
    const destination = blocked.getByRole("combobox", { name: "迁移到的渠道" });
    await expect(destination).toContainText("迁入");
    await destination.press("Enter");
    await expect(blocked.getByRole("option", { name: /迁入/ })).toBeVisible();
    await destination.press("Enter");
    await expect(blocked.getByRole("listbox")).toBeHidden();
    await blocked.getByRole("button", { name: "迁移", exact: true }).click();
    await expect(blocked.getByRole("alert")).toContainText("duplicate");
    await expect(blocked.getByRole("alert")).not.toContainText("已把");
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: "已把 1 个模型迁到「迁入」" }),
    ).toBeVisible();
    await expect(blocked.getByRole("link", { name: "movable" })).toHaveCount(0);
    await page.evaluate(async (target) => {
      const api = window.desktop.settings;
      const list = await api.list({});
      if (!list.ok) throw Error(list.code);
      const duplicate = list.value.providers.find(
        (model) => model.channelId === target && model.model === "duplicate",
      );
      if (
        !duplicate ||
        !list.value.providers.some(
          (model) => model.channelId === target && model.model === "movable",
        )
      )
        throw Error("迁移结果错误");
      const removed = await api.modelRemove({
        id: duplicate.id,
        expectedRevision: duplicate.revision,
      });
      if (!removed.ok) throw Error(removed.code);
    }, target);
    await blocked.getByRole("button", { name: "迁移", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "删除渠道？「迁出」" });
    const remove = confirm.getByRole("button", { name: "删除", exact: true });
    await expect(remove).toBeDisabled();
    await confirm.getByLabel("输入名称确认删除").fill(" 迁出 ");
    await page.evaluate(async () => {
      const api = window.desktop.settings,
        listing = await api.channelList({});
      if (!listing.ok) throw Error(listing.code);
      const source = listing.value.find((item) => item.name === "迁出")!;
      const imported = await api.modelImport({
        id: source.id,
        expectedRevision: source.revision,
        models: ["new-reference"],
      });
      if (!imported.ok) throw Error(imported.code);
    });
    await remove.click();
    await expect(blocked.getByRole("link", { name: "new-reference" })).toBeVisible();
    await expect(blocked.getByRole("alert")).toContainText("请先删除渠道中的模型");
    await blocked.getByRole("button", { name: "迁移", exact: true }).click();
    await expect(confirm.getByLabel("输入名称确认删除")).toHaveValue(" 迁出 ");
    await remove.click();
    await expect(confirm).toBeHidden();
    const list = await page.evaluate(() => window.desktop.settings.list({}));
    if (!list.ok) throw Error(list.code);
    const remaining = await page.evaluate(() => window.desktop.settings.channelList({}));
    if (!remaining.ok) throw Error(remaining.code);
    expect(remaining.value.map((channel) => channel.id)).toEqual([target]);
    expect(list.value.providers.map((model) => model.channelId)).toEqual([
      target,
      target,
      target,
      target,
    ]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
