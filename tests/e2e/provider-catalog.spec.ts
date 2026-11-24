import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { ProjectStore } from "../../src/main/project/store";
import { SettingsRegistry } from "../../src/main/settings/registry";

test("插件目录区分首次读取、可重试的故障和无插件，空态可打开上传", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-plugin-loading-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "应用设置" })).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      const name = "link-studio:settings:list";
      ipcMain.removeHandler(name);
      let initial = true;
      ipcMain.handle(name, async () => {
        if (!initial) return { ok: true, value: { plugins: [], providers: [] } };
        initial = false;
        await new Promise((resolve) => ipcMain.once("finish-catalog-load", resolve));
        return { ok: false, code: "SETTINGS_ACTION_FAILED" };
      });
    });
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "适配器管理" }).click();
    const catalog = page.getByRole("region", { name: "插件目录" });
    await expect(catalog.getByLabel("加载中")).toHaveCount(3);
    await expect(catalog.getByLabel("每页条数")).toHaveCount(0);
    await app.evaluate(({ ipcMain }) => ipcMain.emit("finish-catalog-load"));
    await expect(catalog.getByRole("alert")).toHaveText("加载失败");
    await catalog.getByRole("button", { name: "重试" }).click();
    await expect(catalog.getByText("还没有插件")).toBeVisible();
    await page.getByRole("button", { name: "上传插件", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "上传插件" });
    const field = upload.getByLabel("选择插件文件");
    const submit = upload.getByRole("button", { name: "上传", exact: true });
    await expect(upload).toBeVisible();
    for (const [name, size, message] of [
      ["empty.JS", 0, "文件是空的"],
      ["not-js.txt", 1, "插件必须是 .js 文件"],
      ["large.js", 524289, "文件 512.0KB，超过 512KB 上限"],
    ] as const) {
      await field.setInputFiles({
        name,
        buffer: Buffer.alloc(size),
        mimeType: "application/octet-stream",
      });
      await expect(upload.getByRole("alert")).toHaveText(message);
      await expect(submit).toBeDisabled();
    }
    await app.evaluate(({ ipcMain }) => {
      const method = "link-studio:settings:pluginUpload";
      ipcMain.removeHandler(method);
      let attempts = 0;
      ipcMain.handle(method, (_event, { source }) => {
        if (source.length !== 524288) throw Error("文件大小不符");
        attempts++;
        if (attempts === 1) return { ok: false, code: "PLUGIN_RUNNER_CRASHED" };
        if (attempts === 2)
          return {
            ok: false,
            code: "PLUGIN_SCRIPT_ERROR",
            issues: [{ path: "", message: "测试脚本有误" }],
          };
        if (attempts === 5)
          return { ok: false, code: "PLUGIN_SCRIPT_ERROR", issues: "invalid-list" };
        return {
          ok: false,
          code: "PLUGIN_VERSION_DUPLICATE",
          issues: [
            { path: "meta", message: "代码完全相同" },
            ...(attempts === 3 ? [{ path: "meta.name", message: "名称无效" }] : []),
          ],
        };
      });
    });
    await field.setInputFiles({
      name: "boundary.JS",
      buffer: Buffer.alloc(524288, 32),
      mimeType: "text/javascript",
    });
    await expect(upload.getByRole("alert")).toHaveCount(0);
    await submit.click();
    await expect(upload.getByRole("alert")).toHaveText("插件运行器暂时不可用稍后重试");
    await expect(upload.getByRole("button", { name: "复制修复信息" })).toHaveCount(0);
    await submit.click();
    await expect(upload.getByRole("alert")).toContainText("（整个文件）测试脚本有误");
    await expect(upload.getByRole("button", { name: "复制修复信息" })).toBeVisible();
    await expect(upload.getByRole("button", { name: "复制路径" })).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      });
      document.execCommand = () => false;
    });
    await upload.getByRole("button", { name: "复制修复信息" }).click();
    await expect(upload.getByRole("status")).toContainText("无法写入剪贴板");
    await page.evaluate(() => {
      document.execCommand = () => true;
    });
    await upload.getByRole("button", { name: "复制修复信息" }).click();
    await expect(upload.getByRole("button", { name: "已复制" })).toBeFocused();
    await expect(upload.getByRole("status")).toHaveCount(0);
    await submit.click();
    await expect(upload.getByRole("alert")).toContainText("2 个问题");
    await expect(upload.getByRole("button", { name: "复制修复信息" })).toBeVisible();
    await submit.click();
    await expect(upload.getByRole("alert")).toContainText("1 个问题");
    await expect(upload.getByRole("button", { name: "复制修复信息" })).toHaveCount(0);
    await submit.press("Enter");
    await expect(upload.getByRole("alert")).toHaveText("预检未通过");
    await expect(upload.getByRole("button", { name: "复制修复信息" })).toHaveCount(0);
    await expect(submit).toBeEnabled();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("插件详情读取不锁页签；忽略前一插件迟到的错误，当前插件消失则返回目录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-plugin-detail-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "适配器管理" }).click();
    const opened = await page.evaluate(() =>
      window.desktop.settings.pluginDetail({ key: "kling" }),
    );
    if (!opened.ok) throw Error(opened.code);
    expect(opened.value.every((entry) => entry.key === "kling")).toBe(true);
    await app.evaluate(({ ipcMain }, versions) => {
      const method = "link-studio:settings:pluginDetail";
      ipcMain.removeHandler(method);
      let fail = false;
      ipcMain.handle(method, async (_event, { key }) => {
        if (key === "kling") return { ok: true, value: versions };
        if (!fail) {
          fail = true;
          await new Promise((resolve) => ipcMain.once("release-plugin-detail", resolve));
        }
        return { ok: false, code: "PLUGIN_VERSION_MISSING" };
      });
    }, opened.value);
    const search = page.getByRole("searchbox", { name: "搜索插件" });
    await search.fill("openai");
    const open = page.getByRole("button", { name: "查看 OpenAI", exact: true });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "OpenAI", exact: true });
    await expect(dialog.getByRole("status", { name: "插件详情加载中" })).toBeVisible();
    await dialog.getByRole("tab", { name: /版本历史/ }).click();
    await expect(dialog.locator("[aria-busy=true]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(open).toBeFocused();
    await search.fill("kling");
    await page.getByRole("button", { name: "查看 可灵 Kling", exact: true }).click();
    await app.evaluate(({ ipcMain }) => ipcMain.emit("release-plugin-detail"));
    await expect(
      page
        .getByRole("dialog", { name: "可灵 Kling", exact: true })
        .getByText("协议设置项", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await search.fill("openai");
    await open.click();
    await expect(page.getByRole("alert")).toHaveText("插件 openai 不存在");
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("版本详情的计数与历史引用独立读取，列表失败或过期不撤销引用保护", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-history-pins-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const source = await readFile("resources/provider-plugins/openai.js", "utf8");
    const upload = await page.evaluate(
      (source) => window.desktop.settings.pluginUpload({ source }),
      `${source}\nmodule.exports.meta.key='history-pins';`,
    );
    if (!upload.ok) throw Error(upload.code);
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "适配器管理" }).click();
    const pins = await page.evaluate(async () => {
      const api = window.desktop.settings,
        list = await api.list({});
      if (!list.ok) throw Error(list.code);
      const plugin = list.value.plugins.find((entry) => entry.key === "history-pins")!;
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "历史引用",
          endpoint: "https://example.invalid",
          enabled: true,
          allowLocal: false,
          sort: 0,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      for (let index = 9; index >= 0; index--) {
        const saved = await api.modelSave({
          expectedRevision: 0,
          channelId: channel.value.id,
          channelRevision: channel.value.revision,
          enabled: false,
          settings: {},
          pluginHash: plugin.hash,
          upstreamModel: `p-${index}`,
          config: { name: `历史样例 ${index}`, description: "", kind: "text", sort: index },
        });
        if (!saved.ok) throw Error(saved.code);
      }
      const result = await api.pluginPinnedModels({ key: plugin.key });
      if (!result.ok) throw Error(result.code);
      return result.value;
    });
    await app.evaluate(({ ipcMain }, pins) => {
      const method = "link-studio:settings:pluginPinnedModels";
      ipcMain.removeHandler(method);
      let reads = 0;
      ipcMain.on("history-pin-count", (event) => (event.returnValue = reads));
      ipcMain.handle(method, async () => {
        const read = ++reads;
        if (read === 1) return { ok: false, code: "SETTINGS_ACTION_FAILED" };
        if (read === 2) {
          await new Promise((resolve) => ipcMain.once("release-history-pins", resolve));
          return { ok: true, value: [{ ...pins[0], name: "已过期名单" }] };
        }
        return { ok: true, value: pins };
      });
    }, pins);
    const reads = () =>
      app.evaluate(({ ipcMain }) => {
        const event = { returnValue: 0 };
        ipcMain.emit("history-pin-count", event);
        return event.returnValue;
      });
    await page.getByRole("searchbox", { name: "搜索插件" }).fill("history-pins");
    await page
      .getByRole("row")
      .filter({ hasText: "history-pins" })
      .getByRole("button", { name: "查看 OpenAI", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "OpenAI", exact: true }),
      overview = dialog.getByRole("tab", { name: "概览" }),
      history = dialog.getByRole("tab", { name: /版本历史/ });
    await expect(dialog.getByText("插件信息", { exact: true })).toBeVisible();
    expect(await reads()).toBe(0);
    await history.click();
    await expect(dialog.getByText("10 个模型固定在此版本", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "插件通知" })
        .locator('[data-sonner-toast][data-type="error"]'),
    ).toBeVisible();
    await expect(dialog.getByRole("link")).toHaveCount(0);
    await expect(dialog.getByText("等 10 个")).toHaveCount(0);
    await expect(
      dialog.getByText("10 个模型固定在此版本，先把它们升级或改用别的协议"),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: /删除/ })).toHaveCount(0);
    const fingerprint = dialog.getByRole("button", { name: "复制完整 sha256" });
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw Error("denied");
          },
        },
      });
      document.execCommand = () => false;
    });
    await fingerprint.click();
    await expect(fingerprint).toBeFocused();
    await expect(fingerprint.locator(".lucide-copy")).toBeVisible();
    await expect(page.getByText("无法复制指纹。")).toHaveCount(0);
    await page.evaluate(() => {
      document.execCommand = () => true;
    });
    await fingerprint.press("Enter");
    await expect(fingerprint.locator(".lucide-check")).toBeVisible();
    await overview.click();
    await history.click();
    await expect.poll(reads).toBe(2);
    await overview.click();
    await history.click();
    await expect(dialog.getByRole("link")).toHaveText(pins.slice(0, 8).map((item) => item.name));
    await app.evaluate(({ ipcMain }) => ipcMain.emit("release-history-pins"));
    await expect(dialog.getByText("等 10 个")).toBeVisible();
    await expect(dialog.getByText("已过期名单")).toHaveCount(0);
    await page.evaluate(async (id) => {
      const api = window.desktop.settings,
        list = await api.list({});
      if (!list.ok) throw Error(list.code);
      const removed = await api.modelRemove({
        id,
        expectedRevision: list.value.providers.find((item) => item.id === id)!.revision,
      });
      if (!removed.ok) throw Error(removed.code);
    }, pins[6]!.id);
    await dialog.getByRole("link", { name: "历史样例 6" }).click();
    await expect(page.getByRole("region", { name: "插件通知" })).toContainText(
      "未找到可打开的渠道模型",
    );
    await dialog.getByRole("link", { name: "历史样例 7" }).press("Enter");
    await expect(page.getByRole("dialog", { name: "编辑模型" })).toContainText("p-7");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agent 插件可登记和编辑，但不提供生成或离线执行能力", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-agent-plugin-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "适配器管理" }).click();
    await page.getByRole("button", { name: "上传插件", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "上传插件" });
    const source =
      "module.exports={meta:{apiVersion:1,version:'1.0.0',key:'agent-fixture',name:'Agent fixture',auth:{type:'none'},endpoints:{agent:{mode:'sync'}}},buildSubmitRequest(){},parseSubmitResponse(){}}";
    await upload.getByLabel("选择插件文件").setInputFiles({
      name: "agent.js",
      mimeType: "text/javascript",
      buffer: Buffer.from(source),
    });
    await upload.getByRole("button", { name: "上传", exact: true }).click();
    await expect(upload.getByRole("status")).toContainText("已登记 agent-fixture@1.0.0");
    await upload.getByRole("button", { name: "完成" }).click();
    const catalog = page.getByRole("region", { name: "插件目录" });
    await catalog.getByRole("searchbox", { name: "搜索插件" }).fill("agent-fixture");
    await expect(catalog.getByRole("group", { name: "按能力筛选" }).getByRole("button")).toHaveText(
      ["全部", "文本", "图片", "视频", "音频"],
    );
    const row = catalog.getByRole("row").filter({ hasText: "agent-fixture" });
    await expect(row.getByText("Agent", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "查看 Agent fixture" }).click();
    const detail = page.getByRole("dialog", { name: "Agent fixture", exact: true });
    await expect(detail.getByText("不支持", { exact: true })).toHaveCount(4);
    await detail.getByRole("tab", { name: /版本历史/ }).click();
    await expect(
      detail.locator(".adapter-history-card").getByText("—", { exact: true }),
    ).toBeVisible();
    await detail.getByText("v1.0.0", { exact: true }).click();
    await expect(detail.getByRole("tab", { name: /版本历史/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await detail.getByLabel("关闭适配器详情").click();
    await page.getByRole("button", { name: "插件草稿", exact: true }).click();
    const base = page.getByLabel("基于已上传版本编辑");
    await expect(base.locator("option")).toHaveText([
      "选择版本，或直接编写新插件",
      "agent-fixture · v1.0.0",
    ]);
    await base.selectOption({ label: "agent-fixture · v1.0.0" });
    await page.getByText("离线样例检查", { exact: true }).click();
    await page.getByRole("button", { name: "运行离线检查" }).click();
    await expect(page.getByText("Agent 走原生网关，不执行插件钩子", { exact: true })).toBeVisible();
    await page.getByLabel("适配器源码").fill(source.replace("1.0.0", "1.0.1"));
    await page.getByRole("button", { name: "校验并保存版本" }).click();
    await expect(
      page.getByText("已校验并保存版本。Agent 走原生网关，不作为模型调用协议。"),
    ).toBeVisible();
    await expect(detail.getByText("v1.0.1", { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("启动清理撤包内置插件，已被任务固定的保留到任务结束后下次启动", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-prune-release-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const launch = () =>
    electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ["."] }), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const seed = await SettingsRegistry.open(
      join(directory, "settings"),
      "resources/provider-plugins",
      "out/provider-runtime/runner",
      { encrypt: Buffer.from, decrypt: (value) => Buffer.from(value).toString() },
    );
    const store = await ProjectStore.create(directory, "升级前的工程");
    const projectId = store.projectId;
    try {
      const source = seed.agentPlugin("openai").code;
      for (const [key, origin] of [
        ["removed-unused", "builtin"],
        ["removed-pinned", "builtin"],
        ["removed-upload", "manual"],
      ] as const) {
        const plugin = await seed.draft(
          `${source}\nObject.assign(module.exports.meta,{key:'${key}',name:'${key}'});`,
          origin,
        );
        if (key === "removed-pinned") {
          const id = randomUUID();
          await store.updateGeneration((state) => {
            state.jobs[id] = {
              version: 1,
              id,
              pluginHash: plugin.hash,
              status: "running",
              input: {
                providerId: randomUUID(),
                expectedProviderRevision: 1,
                expectedCanvasRevision: 1,
                nodeId: "sample",
                prompt: "sample",
                referenceAssetIds: [],
              },
            };
            return { changed: true, result: null };
          });
        }
      }
      await mkdir(join(directory, "projects"), { recursive: true });
      await writeFile(
        join(directory, "projects", "recent.json"),
        JSON.stringify([
          {
            recentEntryId: randomUUID(),
            projectId,
            directory: store.directory,
            displayName: store.name,
            lastOpenedAt: new Date().toISOString(),
          },
        ]),
      );
    } finally {
      await store.close();
      seed.close();
    }
    for (const remaining of [2, 1]) {
      app = await launch();
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "应用设置" }).click();
      await page.getByRole("button", { name: "适配器管理" }).click();
      await page.getByRole("searchbox", { name: "搜索插件" }).fill("removed-");
      const rows = page
        .getByRole("region", { name: "插件目录" })
        .getByRole("row")
        .filter({ hasText: "removed-" });
      await expect(rows).toHaveCount(remaining);
      await expect(rows.filter({ hasText: "removed-unused" })).toHaveCount(0);
      await expect(rows.filter({ hasText: "removed-upload" })).toHaveCount(1);
      if (remaining === 2) {
        await rows
          .filter({ hasText: "removed-pinned" })
          .getByRole("button", { name: "removed-pinned 的更多操作" })
          .click();
        await page.getByRole("menuitem", { name: "删除插件" }).click();
        const modal = page.getByRole("dialog", { name: "暂时不能删除「removed-pinned」" });
        await expect(modal).toContainText("内置插件不能删除，只能停用");
        await expect(modal).toContainText("1 个进行中的任务在用这个插件");
      }
      await app.close();
      app = undefined;
      if (remaining === 2) {
        const registry = await SettingsRegistry.open(
          join(directory, "settings"),
          "resources/provider-plugins",
          "out/provider-runtime/runner",
          { encrypt: Buffer.from, decrypt: (value) => Buffer.from(value).toString() },
        );
        try {
          registry.reconcileJobPins(projectId, []);
        } finally {
          registry.close();
        }
      }
    }
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("删除插件首次预检可重试，写入冲突后保留输入和两类独立错误", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-plugin-check-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const source = await readFile("resources/provider-plugins/openai.js", "utf8");
    const saved = await page.evaluate(
      (source) => window.desktop.settings.draft({ source }),
      source + "\nmodule.exports.meta.key='retry-delete';",
    );
    if (!saved.ok) throw Error(saved.code);
    await app.evaluate(({ ipcMain }) => {
      const method = "link-studio:settings:pluginDeleteCheck";
      ipcMain.removeHandler(method);
      let reads = 0;
      ipcMain.handle(method, async () => {
        reads++;
        if (reads === 1 || reads === 3) {
          await new Promise((resolve) => ipcMain.once("release-delete-check", resolve));
          return { ok: false, code: "SETTINGS_ACTION_FAILED" };
        }
        return { ok: true, value: { builtin: false, models: [], jobs: reads > 2 ? 1 : 0 } };
      });
    });
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "适配器管理" }).click();
    await page.getByRole("searchbox", { name: "搜索插件" }).fill("retry-delete");
    await page
      .getByRole("row")
      .filter({ hasText: "retry-delete" })
      .getByRole("button", { name: "OpenAI 的更多操作" })
      .click();
    await page.getByRole("menuitem", { name: "删除插件" }).click();
    const modal = page.getByRole("dialog"),
      remove = modal.getByRole("button", { name: "删除", exact: true }),
      retry = modal.getByRole("button", { name: "重试" });
    await expect(modal.getByRole("status", { name: "正在检查引用" })).toBeVisible();
    await expect(remove).toBeDisabled();
    await app.evaluate(({ ipcMain }) => ipcMain.emit("release-delete-check"));
    await expect(modal.getByRole("alert")).toContainText("没能检查引用情况");
    await retry.click();
    const input = modal.getByLabel("输入名称确认删除");
    await input.fill("retry-delete");
    const database = new DatabaseSync(join(directory, "settings", "settings.sqlite"));
    try {
      database
        .prepare("INSERT INTO plugin_job_pins VALUES (?,?,?)")
        .run("check-project", "check-job", saved.value.hash);
    } finally {
      database.close();
    }
    await remove.click();
    const conflict = "插件 retry-delete 被 0 个模型、1 个进行中的任务使用，无法删除";
    await expect(modal.getByRole("alert")).toHaveText(conflict);
    await expect(modal.getByRole("status", { name: "正在检查引用" })).toHaveCount(0);
    await expect(input).toHaveValue("retry-delete");
    await expect(remove).toBeEnabled();
    await app.evaluate(({ ipcMain }) => ipcMain.emit("release-delete-check"));
    await expect(modal.getByRole("alert")).toHaveText(["没能检查引用情况重试", conflict]);
    await retry.click();
    await expect(modal).toContainText("1 个进行中的任务在用这个插件");
    await expect(remove).toHaveCount(0);
    await expect(input).toHaveCount(0);
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(modal).toBeHidden();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("升级弹窗保留预览，确认与重试各自重新选择版本和全部当前绑定", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-plugin-live-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const source = await readFile("resources/provider-plugins/openai.js", "utf8");
    const release = (version: string, image = false) =>
      page.evaluate(
        async (source) => {
          const response = await window.desktop.settings.draft({ source });
          if (!response.ok) throw Error(response.code);
          return response.value.hash;
        },
        `${source}\nObject.assign(module.exports.meta,{version:'${version}',key:'fixture-live',name:'实时升级'});${image ? "module.exports.meta.endpoints={image:module.exports.meta.endpoints.text};" : ""}`,
      );
    const first = await release("1.0.0");
    const channel = await page.evaluate(async () => {
      const response = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture",
        fields: {
          name: "实时渠道",
          endpoint: "https://example.invalid",
          enabled: true,
          sort: 1,
          headers: [],
          allowLocal: false,
        },
      });
      if (!response.ok) throw Error(response.code);
      return response.value;
    });
    const bind = (name: string, enabled: boolean, hash = first, revision = channel.revision) =>
      page.evaluate(
        async ({ channelId, revision, hash, name, enabled }) => {
          const response = await window.desktop.settings.modelSave({
            channelId,
            channelRevision: revision,
            expectedRevision: 0,
            approve: true,
            upstreamModel: name,
            pluginHash: hash,
            enabled,
            settings: {},
            config: { kind: "text", name, sort: 0, description: "" },
          });
          if (!response.ok) throw Error(response.code);
        },
        { channelId: channel.id, revision, hash, name, enabled },
      );
    const keys = (revision: number, clear: boolean) =>
      page.evaluate(
        async ({ id, revision, clear }) => {
          const response = await window.desktop.settings.channelKeys({
            id,
            expectedRevision: revision,
            ...(clear ? { clearSecret: true } : { secret: "fixture" }),
          });
          if (!response.ok) throw Error(response.code);
          return response.value.revision;
        },
        { id: channel.id, revision, clear },
      );
    await bind("initial", true);
    const preview = await release("2.0.0");
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "适配器管理" }).click();
    await page.getByRole("searchbox", { name: "搜索插件" }).fill("fixture-live");
    const upgradeButton = page.getByRole("button", { name: "升级模型 实时升级", exact: true });
    await upgradeButton.hover();
    await expect(upgradeButton).toHaveCSS("cursor", "pointer");
    const notices = page.getByRole("region", { name: "插件通知" });
    await page.evaluate(async () => {
      const api = window.desktop.settings;
      const list = await api.list({});
      const model = list.ok && list.value.providers.find((entry) => entry.model === "initial");
      if (!model) throw Error("Missing initial model");
      const offline = await api.modelToggle({
        id: model.id,
        expectedRevision: model.revision,
        enabled: false,
      });
      if (!offline.ok) throw Error(offline.code);
      const removed = await api.modelRemove({
        id: model.id,
        expectedRevision: offline.value.revision,
      });
      if (!removed.ok) throw Error(removed.code);
    });
    await upgradeButton.click();
    await expect(notices.getByText("没有固定在旧版本上的模型")).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await bind("initial", true);
    await bind("before-open", false);
    await upgradeButton.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toHaveAccessibleName("把 2 个模型升级到 v2.0.0？");
    const previewList = dialog.getByRole("list", { name: "要升级的模型" });
    await expect(previewList.getByRole("listitem").first()).toContainText("before-open");
    await bind("after-open", false, preview);
    const third = await release("3.0.0");
    const cleared = await keys(channel.revision, true);
    await expect(previewList.getByRole("listitem")).toHaveCount(2);
    await dialog.getByRole("button", { name: "全部升级" }).click();
    await expect(
      dialog.getByRole("list", { name: "升级失败的模型" }).getByRole("listitem"),
    ).toContainText("initial");
    await expect(dialog).toContainText("已升级 2 个，失败项保持原样");
    const bindings = () =>
      page.evaluate(async () => {
        const response = await window.desktop.settings.list({});
        if (!response.ok) throw Error(response.code);
        return Object.fromEntries(
          response.value.providers.map((model) => [model.model, model.pluginHash]),
        );
      });
    expect(await bindings()).toEqual({ initial: first, "before-open": third, "after-open": third });
    const restored = await keys(cleared, false);
    await bind("before-retry", false, first, restored);
    const fourth = await release("4.0.0");
    await dialog.getByRole("button", { name: "重试失败项" }).click();
    await expect(dialog).toBeHidden();
    await expect(notices.getByText("4 个模型已升级到 v4.0.0")).toBeVisible();
    await expect(notices.getByText("4 个模型已升级到 v4.0.0")).toBeHidden({ timeout: 7000 });
    expect(await bindings()).toEqual({
      initial: fourth,
      "before-open": fourth,
      "after-open": fourth,
      "before-retry": fourth,
    });
    const fifth = await release("5.0.0", true);
    await page.reload();
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "适配器管理" }).click();
    await page.getByRole("searchbox", { name: "搜索插件" }).fill("fixture-live");
    await upgradeButton.click();
    await dialog.getByRole("button", { name: "全部升级" }).click();
    await expect(dialog).toContainText("已升级 3 个，失败项保持原样");
    await expect(dialog.getByRole("list", { name: "升级失败的模型" })).toContainText(
      "协议 fixture-live@5.0.0 不支持 text 类型的模型",
    );
    expect(await bindings()).toEqual({
      initial: fourth,
      "before-open": fifth,
      "after-open": fifth,
      "before-retry": fifth,
    });
    await dialog.getByRole("button", { name: "取消" }).click();
    await bind("stale-detail", false, first, restored);
    await page.reload();
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "适配器管理" }).click();
    await page.getByRole("searchbox", { name: "搜索插件" }).fill("fixture-live");
    await app.evaluate(({ ipcMain }) => {
      const method = "link-studio:settings:pluginUpgradeOptions";
      ipcMain.removeHandler(method);
      ipcMain.handle(method, () => ({ ok: false, code: "SETTINGS_ACTION_FAILED" }));
    });
    await upgradeButton.click();
    await expect(notices.locator('[data-type="error"]')).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect((await bindings())["stale-detail"]).toBe(first);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    const seed = await SettingsRegistry.open(
      join(directory, "settings"),
      "resources/provider-plugins",
      "out/provider-runtime/runner",
      { encrypt: Buffer.from, decrypt: (value) => Buffer.from(value).toString() },
    );
    try {
      await seed.draft(
        seed.agentPlugin("openai").code + "\nmodule.exports.meta.version='1.2.0';",
        "builtin",
      );
    } finally {
      seed.close();
    }
    app = await launch();
    const page = await app.firstWindow();
    const openai = await page.evaluate(async (endpoint) => {
      const api = window.desktop.settings;
      const list = await api.list({});
      const plugin = list.ok
        ? list.value.plugins.find(({ key, version }) => key === "openai" && version === "1.2.0")
        : undefined;
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
    await page.getByRole("button", { name: "应用设置" }).click();
    await expect(page.getByRole("switch", { name: "beta-chat 上线" })).toBeChecked();

    const windowHandle = await app.browserWindow(page);
    await windowHandle.evaluate((browserWindow) => browserWindow.setSize(1024, 700));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024);
    await page.getByRole("button", { name: "适配器管理", exact: true }).click();
    const catalog = page.getByRole("region", { name: "插件目录" });
    const table = catalog.getByRole("table", { name: "Provider 插件" });
    await expect(table.getByRole("row")).toHaveCount(21);
    const noUpgrade = table.getByTitle("没有固定在旧版本上的模型", { exact: true }).first();
    await expect(noUpgrade).toBeDisabled();
    await noUpgrade.hover();
    await expect(noUpgrade).toHaveCSS("cursor", "default");
    await catalog.getByRole("button", { name: "最后一页" }).click();
    await expect(catalog.getByRole("button", { name: "下一页" })).toBeDisabled();
    await catalog.getByRole("button", { name: "第 1 页", exact: true }).click();
    const sizeSelect = catalog.getByRole("combobox", { name: "每页条数" });
    await sizeSelect.click();
    await expect(page.getByRole("option", { name: "20", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("listbox")).toBeInViewport();
    await page.getByRole("option", { name: "10", exact: true }).click();
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
    await expect(catalog.getByText("没有匹配的插件")).toBeVisible();
    await catalog.getByRole("button", { name: "重置" }).click();
    await page.getByRole("button", { name: "上传插件", exact: true }).click();
    {
      const upload = page.getByRole("dialog", { name: "上传插件" });
      const badOptions = openai.source.replace(
        'options: ["responses", "chat_completions"]',
        "options: []",
      );
      expect(badOptions).not.toBe(openai.source);
      const fileInput = upload.getByLabel("选择插件文件");
      const submitUpload = upload.getByRole("button", { name: "上传", exact: true });
      await fileInput.setInputFiles({
        name: "bad-encoding.js",
        buffer: Buffer.alloc(200 * 1024, 0xff),
        mimeType: "text/javascript",
      });
      await submitUpload.click();
      await expect(upload.getByRole("alert")).toHaveText("文件超过 512KB 上限");
      await expect(submitUpload).toBeDisabled();
      await expect(upload.getByRole("button", { name: "复制修复信息" })).toHaveCount(0);
      await fileInput.evaluate((input: HTMLInputElement) => {
        input.addEventListener(
          "change",
          () => {
            const file = input.files![0]!;
            const read = file.text.bind(file);
            file.text = async () => {
              await new Promise<void>((resolve) =>
                document.addEventListener("finish-test-read", () => resolve(), { once: true }),
              );
              return read();
            };
          },
          { once: true, capture: true },
        );
      });
      await fileInput.setInputFiles({
        name: "delayed.js",
        mimeType: "text/javascript",
        buffer: Buffer.from(
          `${openai.source}\nObject.assign(module.exports.meta, {key:'fixture-delayed', name:'Delayed fixture'});`,
        ),
      });
      await submitUpload.click();
      await expect(upload.getByRole("status")).toHaveText("预检中…");
      await upload.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("button", { name: "上传插件", exact: true }).click();
      await page.evaluate(() => document.dispatchEvent(new Event("finish-test-read")));
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const listing = await window.desktop.settings.list({});
            return (
              listing.ok && listing.value.plugins.some((plugin) => plugin.key === "fixture-delayed")
            );
          }),
        )
        .toBe(true);
      await expect(submitUpload).toBeDisabled();
      await expect(upload.getByRole("status")).toHaveCount(0);
      await fileInput.setInputFiles({
        name: "broken.js",
        mimeType: "text/javascript",
        buffer: Buffer.from(`${badOptions}\nmodule.exports.meta.name = '';`),
      });
      await submitUpload.click();
      await expect(upload.getByRole("alert")).toContainText("meta.channelSettings.api.options");
      await expect(upload.getByRole("alert")).toContainText("预检未通过：3 个问题");
      await expect(upload.getByRole("alert")).toContainText("meta.channelSettings.api.default");
      await expect(upload.getByRole("alert")).toContainText("meta.name");
      await expect(upload.getByRole("button", { name: "复制路径" })).toHaveCount(3);
      await expect(upload.locator(".upload-error li code")).toHaveText([
        "meta.channelSettings.api.default",
        "meta.channelSettings.api.options",
        "meta.name",
      ]);
      const pathCopies = upload.getByRole("button", { name: "复制路径" });
      await pathCopies.nth(0).click();
      await pathCopies.nth(1).click();
      await expect(upload.locator(".upload-error li .lucide-check")).toHaveCount(2);
      await upload.getByRole("button", { name: "复制修复信息" }).click();
      await expect(upload.getByRole("button", { name: "已复制" })).toBeVisible();
      await fileInput.setInputFiles({
        name: "reserved.js",
        mimeType: "text/javascript",
        buffer: Buffer.from(openai.source),
      });
      await expect(upload.getByRole("alert")).toHaveCount(0);
      await submitUpload.click();
      await expect(upload.getByRole("alert")).toContainText("meta.key");
      await upload.getByRole("button", { name: "取消" }).click();
    }
    await search.fill("kling");
    await table.getByRole("button", { name: "查看 可灵 Kling", exact: true }).click();
    const signedDetails = page.getByRole("dialog", { name: "可灵 Kling", exact: true });
    await expect(
      signedDetails.getByText("插件自行签名（该协议会读取渠道的 API Key 与 Secret Key 自行签名）"),
    ).toBeVisible();
    await expect(
      signedDetails.getByText("提交 15 秒后开始，每 10 秒一次，最长间隔 30 秒"),
    ).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(signedDetails).toBeHidden();
    await search.fill("openai");
    const openDetails = table.getByRole("button", { name: "查看 OpenAI", exact: true });
    await openDetails.click();
    const details = page.getByRole("dialog", { name: "OpenAI", exact: true });
    await expect(details.getByRole("heading", { name: "能力与请求" })).toBeVisible();
    await expect(details.getByRole("heading", { name: "协议设置项" })).toBeVisible();
    await expect(details.getByRole("tab", { name: /版本历史/ })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("plugin-overview.png") });
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(openDetails).toBeFocused();
    await openDetails.click();
    const historyTab = details.getByRole("tab", { name: /版本历史/ });
    await historyTab.click();
    await expect(details.getByText("2 个模型固定在此版本", { exact: true })).toBeVisible();
    await expect(details.locator("footer")).toHaveCount(0);
    await details.getByLabel("关闭适配器详情").click();
    const enabledSwitch = catalog.getByRole("switch", { name: "停用插件 OpenAI", exact: true });
    await enabledSwitch.click();
    const confirmation = page.getByRole("alertdialog", { name: "停用插件「OpenAI」？" });
    await expect(confirmation).toContainText(
      "2 个模型（其中 2 个在线） 在用此插件，停用后不可用，进行中的任务不受影响。",
    );
    await page.mouse.click(5, 5);
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "取消" }).click();
    await openDetails.click();
    await historyTab.click();
    const oldVersion = details.getByText(`v${openai.version}`, { exact: true });
    await expect(details.getByRole("button", { name: /编辑草稿/ })).toHaveCount(0);
    const rejected = await page.evaluate(
      (source) => window.desktop.settings.draft({ source: source + "\n" }),
      openai.source,
    );
    expect(rejected).toMatchObject({ ok: false, code: "PLUGIN_BUILTIN_KEY_RESERVED" });
    const versions = await page.evaluate(() => window.desktop.settings.list({}));
    if (!versions.ok) throw new Error(versions.code);
    const latestRelease = versions.value.plugins.find(
      ({ key, origin, version }) =>
        key === openai.key && origin === "builtin" && version !== openai.version,
    );
    if (!latestRelease) throw new Error("Missing current OpenAI release");
    const latestVersion = details.getByText(`v${latestRelease.version}`, { exact: true });
    await expect(latestVersion.locator("xpath=ancestor::li")).toContainText("最新");
    await expect(details.locator(".adapter-release-version")).toHaveText([
      `v${openai.version}`,
      `v${latestRelease.version}`,
    ]);
    await expect(oldVersion.locator("xpath=ancestor::li").getByText("最新")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("plugin-history.png") });
    await details.getByLabel("关闭适配器详情").click();
    await enabledSwitch.click();
    await confirmation.getByRole("button", { name: "停用", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "插件通知" }).getByText("插件「OpenAI」已停用"),
    ).toBeVisible();
    const disabledSwitch = catalog.getByRole("switch", { name: "启用插件 OpenAI", exact: true });
    await expect(disabledSwitch).not.toBeChecked();
    await catalog.getByRole("button", { name: "升级模型 OpenAI", exact: true }).click();
    const disabledUpgrade = page.getByRole("alertdialog", {
      name: `把 2 个模型升级到 v${latestRelease.version}？`,
    });
    await page.mouse.click(12, 12);
    await expect(disabledUpgrade).toBeVisible();
    await disabledUpgrade.getByRole("button", { name: "全部升级" }).click();
    await expect(disabledUpgrade.getByRole("alert")).toHaveText("插件已停用");
    await expect(
      disabledUpgrade.getByRole("list", { name: "要升级的模型" }).getByRole("listitem"),
    ).toHaveCount(2);
    await expect(disabledUpgrade.getByRole("button", { name: "重试失败项" })).toHaveCount(0);
    await disabledUpgrade.getByRole("button", { name: "取消" }).click();
    await disabledSwitch.click();
    await expect(enabledSwitch).toBeChecked();
    await openDetails.click();
    await details.getByRole("tab", { name: /版本历史/ }).click();
    await expect(oldVersion).toBeVisible();
    await expect(details.locator("header p")).toContainText(`· v${latestRelease.version}`);
    await expect(details.locator("header .adapter-badge")).toHaveText("内置");
    await page
      .getByRole("button", { name: `升级全部 2 个模型到 v${latestRelease.version}` })
      .click();
    const upgrade = page.getByRole("alertdialog", {
      name: `把 2 个模型升级到 v${latestRelease.version}？`,
    });
    const targets = upgrade.getByRole("list", { name: "要升级的模型" });
    for (const name of ["alpha-chat", "beta-chat"]) {
      const row = targets.getByRole("listitem").filter({ hasText: name });
      await expect(row).toContainText("测试渠道");
      await expect(row).toContainText(`v${openai.version} → v${latestRelease.version}`);
    }
    await upgrade.getByRole("button", { name: "取消" }).click();
    await expect(details.getByText("2 个模型固定在此版本", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await search.fill("");
    const statusSelect = catalog.getByRole("combobox", { name: "按状态筛选" });
    await statusSelect.click();
    await expect(page.getByRole("option", { name: "全部状态" })).toBeVisible();
    await page.getByRole("option", { name: "全部状态" }).focus();
    await page.keyboard.press("Escape");
    await expect(statusSelect).toHaveAttribute("aria-expanded", "false");
    await expect(statusSelect).toBeFocused();
    await expect(statusSelect).toContainText("全部状态");
    await statusSelect.press("ArrowDown");
    await page.getByRole("option", { name: "有旧版模型" }).click();
    const sourceSelect = catalog.getByRole("combobox", { name: "按来源筛选" });
    await sourceSelect.click();
    await page.getByRole("option", { name: "内置", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(openDetails).toBeVisible();
    await page.getByRole("button", { name: "升级模型 OpenAI", exact: true }).click();
    await expect(upgrade).toBeVisible();
    await expect(details).toBeHidden();
    await upgrade.getByRole("button", { name: "取消" }).click();
    await openDetails.click();
    await historyTab.click();
    await page
      .getByRole("button", { name: `升级全部 2 个模型到 v${latestRelease.version}` })
      .click();
    await page.evaluate(async () => {
      const api = window.desktop.settings;
      const data = await api.list({});
      const model = data.ok && data.value.providers.find(({ model }) => model === "alpha-chat");
      if (!model) throw new Error("Missing alpha-chat");
      const result = await api.modelToggle({
        id: model.id,
        expectedRevision: model.revision,
        enabled: false,
      });
      if (!result.ok) throw new Error(result.code);
      const channels = await api.channelList({});
      const channel = channels.ok && channels.value.find((entry) => entry.id === model.channelId);
      if (!channel) throw new Error("Missing channel");
      const cleared = await api.channelKeys({
        id: channel.id,
        expectedRevision: channel.revision,
        clearSecret: true,
      });
      if (!cleared.ok) throw new Error(cleared.code);
    });
    await upgrade.getByRole("button", { name: "全部升级" }).click();
    const failed = page.getByRole("alertdialog", { name: "1 个模型升级失败" });
    await expect(failed).toContainText("已升级 1 个");
    const failures = failed.getByRole("list", { name: "升级失败的模型" }).getByRole("listitem");
    await expect(failures).toHaveCount(1);
    await expect(failures).toContainText("beta-chat");
    await expect(failures).toContainText("的 Key 尚未设置，请联系超级管理员设置后再试");
    await page.evaluate(async () => {
      const api = window.desktop.settings;
      const channels = await api.channelList({});
      const channel = channels.ok && channels.value.find((entry) => entry.name === "测试渠道");
      if (!channel) throw new Error("Missing channel");
      const restored = await api.channelKeys({
        id: channel.id,
        expectedRevision: channel.revision,
        secret: "catalog-fixture-secret",
      });
      if (!restored.ok) throw new Error(restored.code);
    });
    await failed.getByRole("button", { name: "重试失败项" }).click();
    await expect(failed).toBeHidden();
    await expect(
      page
        .getByRole("region", { name: "插件通知" })
        .getByText(`1 个模型已升级到 v${latestRelease.version}`)
        .first(),
    ).toBeVisible();
    await expect(oldVersion.locator("xpath=ancestor::li").getByText("无模型使用")).toBeVisible();
    await historyTab.click();
    await expect(
      latestVersion
        .locator("xpath=ancestor::li")
        .getByText("2 个模型固定在此版本", { exact: true }),
    ).toBeVisible();
    await expect(latestVersion.locator("xpath=ancestor::li")).toContainText("内置版本不能删除");
    await expect(latestVersion.locator("xpath=ancestor::li")).not.toContainText("可升级到");
    await expect(
      details.getByRole("button", { name: `删除 ${latestRelease.version}`, exact: true }),
    ).toHaveCount(0);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: "应用设置" }).click();
    const restored = await reopened.evaluate(() => window.desktop.settings.list({}));
    if (!restored.ok) throw new Error(restored.code);
    expect(latestRelease.registeredAt).toBeTruthy();
    expect(
      restored.value.plugins.find(({ hash }) => hash === latestRelease.hash)?.registeredAt,
    ).toBe(latestRelease.registeredAt);
    expect(restored.value.providers.map(({ pluginHash }) => pluginHash)).toEqual([
      latestRelease.hash,
      latestRelease.hash,
    ]);
    const online = reopened.getByRole("switch", { name: "beta-chat 上线" });
    await online.click();
    await expect(online).not.toBeChecked();
    await reopened.getByRole("button", { name: "适配器管理", exact: true }).click();
    await reopened.getByRole("searchbox", { name: "搜索插件" }).fill("openai");
    await reopened.getByRole("button", { name: "查看 OpenAI", exact: true }).click();
    await reopened.getByRole("tab", { name: /版本历史/ }).click();
    await expect(reopened.getByText("2 个模型固定在此版本", { exact: true })).toBeVisible();
    await reopened
      .getByRole("dialog")
      .getByRole("link", { name: "beta-chat", exact: true })
      .click();
    await expect(reopened.getByRole("dialog")).toContainText("beta-chat");
    await reopened.getByRole("button", { name: "关闭弹窗" }).click();
    const keyButton = reopened.getByRole("button", { name: "设置 Key", exact: true });
    await keyButton.click();
    const keyDialog = reopened.getByRole("dialog", { name: /的 Key/ });
    const secondary = keyDialog.getByLabel("Secret Key（可选）");
    await keyDialog.getByLabel("API Key", { exact: true }).fill("fixture-refreshed-key");
    await secondary.evaluate((field: HTMLInputElement) => {
      field.value = "invalid\0credential";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await keyDialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(keyDialog.getByRole("alert")).toContainText(
      "API Key 已保存，但 Secret Key 没有保存成功",
    );
    await expect(secondary).toHaveValue("");
    await secondary.fill("fixture-secondary-key");
    await keyDialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(reopened.getByText("Secret Key 已设置", { exact: true })).toBeVisible();
    await keyButton.click();
    await expect(secondary).toHaveValue("");
    const clearSecondary = keyDialog.getByLabel("清除已设置的 Secret Key");
    await clearSecondary.check();
    await secondary.fill("fixture-replacement");
    await expect(clearSecondary).toBeChecked();
    await expect(clearSecondary).toBeDisabled();
    await secondary.fill("");
    await expect(clearSecondary).toBeEnabled();
    await expect(clearSecondary).toBeChecked();
    await keyDialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(reopened.getByText("Secret Key 未设置（可选）", { exact: true })).toBeVisible();
    await reopened.getByRole("button", { name: "适配器管理", exact: true }).click();
    const launchUpload = reopened.getByRole("button", { name: "上传插件", exact: true });
    await launchUpload.click();
    const upload = reopened.getByRole("dialog", { name: "上传插件" });
    const choose = (name: string, source: string) =>
      upload
        .getByLabel("选择插件文件")
        .setInputFiles({ name, mimeType: "text/javascript", buffer: Buffer.from(source) });
    const submit = upload.getByRole("button", { name: "上传", exact: true });
    await choose("invalid.txt", "text");
    await expect(submit).toBeDisabled();
    await choose("builtin.js", openai.source);
    await submit.click();
    await expect(upload.getByRole("alert")).toContainText("内置插件");
    const sourceFile = `${latestRelease.source}\nmodule.exports.meta.key='fixture-upload';`;
    const dropZone = upload.locator(".upload-drop");
    const transfer = await reopened.evaluateHandle((contents) => {
      const files = new DataTransfer();
      files.items.add(new File([contents], "protocol.js", { type: "text/javascript" }));
      files.items.add(new File(["ignored"], "second.txt"));
      return files;
    }, sourceFile);
    await dropZone.dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(dropZone).toHaveAttribute("data-dragging", "true");
    await dropZone.dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await expect(dropZone).toHaveAttribute("data-dragging", "false");
    await expect(dropZone).toContainText("protocol.js");
    await expect(upload.getByRole("alert")).toHaveCount(0);
    await submit.click();
    await expect(upload.getByRole("status")).toContainText("预检通过，已登记 fixture-upload@1.2.1");
    await upload.getByRole("button", { name: "完成" }).click();
    await launchUpload.click();
    await choose("protocol.js", sourceFile);
    await submit.click();
    await expect(upload.getByRole("alert")).toContainText("代码与 v1.2.1 完全相同，没有产生新版本");
    await expect(upload.getByRole("button", { name: "复制修复信息" })).toHaveCount(0);
    const cappedSource = `${sourceFile}\nObject.assign(module.exports.meta,{key:'version-cap',name:'版本上限夹具',vendor:'version-cap',version:'1.0.18446744073709551615'});`;
    const capped = await reopened.evaluate(
      (source) => window.desktop.settings.pluginUpload({ source }),
      cappedSource,
    );
    expect(capped.ok).toBe(true);
    await choose("cap.js", `${cappedSource}\nvoid 0;`);
    await submit.click();
    await expect(upload.getByRole("alert")).toContainText(
      '无法自动决定版本号：版本号 "1.0.18446744073709551615" 的补丁位已经到上限，无法递增',
    );
    await expect(
      upload.getByRole("alert").getByText("meta.version", { exact: true }),
    ).toBeVisible();
    await expect(upload.getByRole("button", { name: "复制修复信息" })).toBeEnabled();
    await choose("protocol.js", `${sourceFile}\n// second`);
    await submit.click();
    await expect(upload.getByRole("status", { name: "版本调整" })).toContainText(
      "已自动登记为 v1.2.2",
    );
    await upload.getByRole("button", { name: "下一步：去模型渠道" }).click();
    await expect(keyButton).toBeVisible();
    await reopened.getByRole("button", { name: "适配器管理", exact: true }).click();
    const filter = reopened.getByRole("searchbox", { name: "搜索插件" });
    await filter.fill("fixture-upload");
    const more = reopened.getByLabel("OpenAI 的更多操作");
    await expect(more).toHaveCount(1);
    await expect(
      reopened.getByRole("table").getByRole("row").filter({ hasText: "fixture-upload" }),
    ).toHaveCount(1);
    const before = await reopened.evaluate(async () => {
      const api = window.desktop.settings;
      const listing = await api.list({});
      if (!listing.ok) throw Error(listing.code);
      const latest = listing.value.plugins.find(
        (entry) => entry.key === "fixture-upload" && entry.version === "1.2.2",
      )!;
      return api.pluginUpload({ source: latest.source + "\n// transient history test" });
    });
    if (!before.ok) throw Error(before.code);
    await reopened
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: /^返回/ })
      .click();
    await reopened.getByRole("button", { name: "应用设置" }).click();
    await reopened.getByRole("button", { name: "适配器管理", exact: true }).click();
    await filter.fill("fixture-upload");
    await expect(more).toHaveCount(1);
    await reopened
      .getByRole("row")
      .filter({ hasText: "fixture-upload" })
      .getByRole("button", { name: "查看 OpenAI", exact: true })
      .click();
    const history = reopened.getByRole("dialog", { name: "OpenAI", exact: true });
    await history.getByRole("tab", { name: /版本历史/ }).click();
    await expect(history.locator("header .adapter-badge")).toHaveText("已上传");
    const fingerprints = history.getByRole("button", { name: "复制完整 sha256" });
    await fingerprints.nth(0).click();
    await fingerprints.nth(1).click();
    await expect(history.locator(".adapter-history .lucide-check")).toHaveCount(2);
    await expect(history.locator(".adapter-history .lucide-check")).toHaveCount(0);
    const versionDelete = history.getByRole("button", { name: "删除 1.2.3", exact: true });
    await versionDelete.click();
    const versionConfirm = reopened.getByRole("alertdialog", { name: "删除插件版本？" });
    await expect(versionConfirm).toContainText("OpenAI v1.2.3");
    await reopened.mouse.click(2, 2);
    await expect(versionConfirm).toBeVisible();
    await versionConfirm.getByRole("button", { name: "取消" }).click();
    await expect(versionDelete).toBeFocused();
    await versionDelete.click();
    const database = new DatabaseSync(join(directory, "settings", "settings.sqlite"));
    try {
      database
        .prepare("INSERT INTO plugin_job_pins VALUES (?,?,?)")
        .run("race-project", "race-job", before.value.plugin.hash);
      await versionConfirm.getByRole("button", { name: "删除", exact: true }).click();
      const conflict = "版本 fixture-upload@1.2.3 被 0 个模型、1 个进行中的任务使用，无法删除";
      await expect(versionConfirm.getByRole("alert")).toHaveText(conflict);
      await expect(
        reopened.getByRole("region", { name: "插件通知" }).getByText(conflict),
      ).toBeVisible();
      const failedDelete = await reopened.evaluate(async (hash) => {
        const current = await window.desktop.settings.list({});
        return current.ok && current.value.plugins.some((plugin) => plugin.hash === hash);
      }, before.value.plugin.hash);
      expect(failedDelete).toBe(true);
      database
        .prepare("DELETE FROM plugin_job_pins WHERE project=? AND job=?")
        .run("race-project", "race-job");
    } finally {
      database.close();
    }
    await versionConfirm.getByRole("button", { name: "删除", exact: true }).click();
    await expect(versionDelete).toHaveCount(0);
    await expect(history.getByText("已移除版本")).toHaveCount(0);
    await expect(history.getByRole("button", { name: "删除 1.2.2", exact: true })).toBeVisible();
    await history.getByLabel("关闭适配器详情").click();
    await more.click();
    await expect(reopened.getByRole("menuitem", { name: "删除插件" })).toBeVisible();
    await reopened.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await more.press("ArrowDown");
    await reopened.getByRole("menuitem", { name: "删除插件" }).press("Enter");
    const removePlugin = reopened.getByRole("dialog", { name: "删除插件？「OpenAI」" });
    await removePlugin.getByLabel("输入名称确认删除").fill("OpenAI");
    const deleteAction = removePlugin.getByRole("button", { name: "删除", exact: true });
    await expect(deleteAction).toBeDisabled();
    await removePlugin.getByLabel("输入名称确认删除").fill(" fixture-upload ");
    const concurrentRemoval = await reopened.evaluate(async () => {
      const api = window.desktop.settings;
      const current = await api.pluginDetail({ key: "fixture-upload" });
      if (!current.ok) throw Error(current.code);
      const previous = current.value.find((version) => version.version === "1.2.2");
      if (!previous) throw Error("缺少预检时显示的版本");
      return api.pluginRemove({ hash: previous.hash, allVersions: false });
    });
    expect(concurrentRemoval.ok).toBe(true);
    await deleteAction.click();
    await expect(removePlugin).toBeHidden();
    await expect(
      reopened.getByRole("region", { name: "插件通知" }).getByText("已删除插件「OpenAI」"),
    ).toBeVisible();
    const remaining = await reopened.evaluate(() => window.desktop.settings.list({}));
    if (!remaining.ok) throw Error(remaining.code);
    expect(remaining.value.plugins.filter((entry) => entry.key === "fixture-upload")).toHaveLength(
      0,
    );
    await filter.fill("openai");
    await more.click();
    await reopened.getByRole("menuitem", { name: "删除插件", exact: true }).click();
    const pinned = reopened.getByRole("dialog", { name: "暂时不能删除「OpenAI」" });
    await expect(pinned).toContainText("内置插件不能删除，只能停用");
    await expect(pinned).toContainText("2 个模型在用这个插件");
    await pinned.getByRole("link", { name: "beta-chat", exact: true }).press("Enter");
    await expect(reopened.getByRole("dialog", { name: "编辑模型" })).toContainText("beta-chat");
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
