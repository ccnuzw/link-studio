import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("配置 JSON 的自定义参数可编辑、报价并按原类型传给插件", async () => {
  const root = await mkdtemp(join(tmpdir(), "custom-parameters-"));
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json").end('{"data":[]}');
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    received.push(JSON.parse(Buffer.concat(parts).toString()));
    response.setHeader("content-type", "application/json").end('{"text":"ok"}');
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少回环服务");
    const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: root };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    app = await electron.launch({
      ...(executablePath ? { executablePath } : { args: ["."] }),
      env,
    });
    let page = await app.firstWindow();
    await page.evaluate(async (port) => {
      const api = window.desktop.settings;
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-key",
        fields: {
          name: "参数样例",
          endpoint: `http://127.0.0.1:${port}`,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw new Error(channel.code);
      const plugin = await api.draft({
        source: `module.exports={meta:{key:'custom-params',name:'Inputs',apiVersion:1,auth:{type:'bearer'},endpoints:{text:{mode:'sync'}}},
        buildSubmitRequest:function(ctx){utils.log('参数检查 fixture-key '+ctx.input.prompt);return {method:'POST',path:'/render',json:ctx.input}},
        parseSubmitResponse:function(ctx,resp){return {immediate:{status:'succeeded',outputs:[{type:'text',text:resp.body.text}]}}}}`,
      });
      if (!plugin.ok) throw new Error(plugin.code);
      const model = await api.modelSave({
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        expectedRevision: 0,
        upstreamModel: "参数样例模型",
        pluginHash: plugin.value.hash,
        settings: {},
        enabled: false,
        config: { kind: "text", name: "参数样例模型", sort: 1, description: "" },
      });
      if (!model.ok) throw new Error(model.code);
    }, address.port);
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "参数样例模型", exact: true }).click();
    let editor = page.getByRole("dialog", { name: "编辑模型" });
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    let json = editor.getByRole("textbox", { name: "配置 JSON" });
    const body = JSON.parse(await json.inputValue());
    const draftText = JSON.stringify(
      {
        extension: { order: ["三", "一"] },
        ...body,
        channels: [{ ...body.channels[0], extra: 37 }],
        capabilities: { ...body.capabilities, context: { window: 8192, output: 8192 } },
      },
      null,
      4,
    );
    await json.fill(draftText);
    await editor.getByRole("button", { name: "保存模型" }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByRole("button", { name: "测试 参数样例模型" })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "参数样例模型 上线" })).toBeDisabled();
    await app.close();
    app = await electron.launch({
      ...(executablePath ? { executablePath } : { args: ["."] }),
      env,
    });
    page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      const method = "link-studio:settings:modelDraftRead";
      const handlers = (
        ipcMain as typeof ipcMain & {
          _invokeHandlers: Map<
            string,
            (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown
          >;
        }
      )._invokeHandlers;
      const read = handlers.get(method);
      if (!read) throw Error("草稿读取未注册");
      ipcMain.removeHandler(method);
      ipcMain.handle(method, () => {
        ipcMain.removeHandler(method);
        ipcMain.handle(method, read);
        return { ok: false, code: "MODEL_DRAFT_UNAVAILABLE" };
      });
    });
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "参数样例模型", exact: true }).click();
    editor = page.getByRole("dialog", { name: "编辑模型" });
    await expect(editor.getByRole("status")).toHaveText("未能读取模型配置原文。");
    await expect(editor.getByRole("button", { name: "保存模型" })).toHaveCount(0);
    await editor.getByRole("button", { name: "重试" }).press("Enter");
    await expect(editor.getByText("有未保存修改")).toHaveCount(0);
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    json = editor.getByRole("textbox", { name: "配置 JSON" });
    await expect(json).toHaveValue(draftText);
    await editor.getByRole("button", { name: "回到表单" }).click();
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByLabel("选择 参数样例模型", { exact: true }).check();
    await page.getByRole("button", { name: "批量修改", exact: true }).click();
    const batch = page.getByRole("dialog", { name: "批量修改 1 个模型" });
    await batch.getByRole("checkbox", { name: "任务时限" }).check();
    await batch.getByRole("textbox", { name: "任务时限" }).fill("3m");
    await batch.getByRole("button", { name: "应用到 1 个模型" }).click();
    const result = page.getByRole("dialog", { name: "批量修改完成" });
    await expect(result.getByText("已保存，但有 3 个问题，上线前要处理")).toBeVisible();
    await result.getByRole("button", { name: "知道了" }).click();
    await page.getByRole("button", { name: "参数样例模型", exact: true }).click();
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    expect(JSON.parse(await json.inputValue())).toEqual({
      ...JSON.parse(draftText),
      deadline: "180s",
    });
    body.capabilities = {
      ...body.capabilities,
      params: {
        fps: {
          type: "enum",
          label: "帧率",
          options: [24, 30],
          default: 24,
          open: true,
          spec: true,
        },
        passes: { type: "number", label: "遍数", min: 1, max: 5, step: 2, default: 1, open: true },
        lock: { type: "boolean", label: "锁定", default: true, open: false },
        copies: {
          type: "enum",
          label: "份数",
          options: [1, 3],
          default: 3,
          open: false,
          fanout: true,
        },
        unused: { type: "boolean", label: "待删参数", default: false, open: true },
      },
    };
    body.pricing = {
      billing: "per_call",
      unit: 3,
      tiers: [{ on: true, when: { fps: 30 }, unit: 7 }],
    };
    await json.fill(JSON.stringify(body));
    await editor.getByRole("button", { name: "回到表单" }).click();
    await editor.getByRole("tab", { name: "能力与参数" }).click();
    await expect(editor.getByText("暂无生成参数")).toHaveCount(0);
    const options = editor.locator(".model-enum-editor").first();
    await options.getByLabel("添加可选值").fill("59.94");
    await options.getByLabel("添加可选值").press("Enter");
    await options.getByLabel("设 59.94 为默认值").click();
    await options.getByLabel("删除可选值 24").click();
    await editor.getByLabel("删除参数 unused").click();
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    const fields = JSON.parse(await json.inputValue()).capabilities.params;
    expect(fields.fps).toMatchObject({ options: [30, 59.94], default: 59.94 });
    expect(fields.unused).toBeUndefined();
    await editor.getByRole("button", { name: "保存模型" }).click();
    await page.getByRole("button", { name: "测试 参数样例模型" }).click();
    const trial = page.getByRole("dialog", { name: "测试 参数样例模型" });
    await trial.getByLabel("测试提示词").fill("参数回归");
    await trial.getByRole("button", { name: "30", exact: true }).click();
    await trial.getByRole("slider").press("ArrowRight");
    await trial.getByRole("button", { name: "开始测试 · 21 积分" }).click();
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toMatchObject({ fps: 30, passes: 3, lock: true });
    expect(received[0]).not.toHaveProperty("unused");
    await trial.getByRole("button", { name: /buildSubmitRequest/ }).click();
    const logs = trial.getByRole("region", { name: "插件日志" });
    await expect(logs).toContainText("参数检查 [凭证已移除] [提示词已隐藏]");
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.body.dataset.trace = text;
          },
        },
      }),
    );
    await trial.getByRole("button", { name: "复制全部（JSON）" }).click();
    const copied = await page.locator("body").getAttribute("data-trace");
    expect(copied).toContain("参数检查");
    expect(copied).not.toMatch(/fixture-key|参数回归/);
    await app.evaluate(({ ipcMain }) => {
      const method = "link-studio:settings:modelTrialTrace";
      ipcMain.removeHandler(method);
      let reads = 0;
      ipcMain.handle(method, () =>
        ++reads === 1 ? { ok: false, code: "SETTINGS_ACTION_FAILED" } : { ok: true, value: [] },
      );
    });
    const refresh = trial.getByRole("button", { name: "刷新", exact: true });
    await refresh.click();
    const traceNotice = trial.getByRole("tabpanel", { name: "追踪" }).getByRole("status");
    await expect(traceNotice).toContainText("没能取到追踪");
    await expect(logs).toHaveCount(0);
    await trial.getByRole("tab", { name: "结果", exact: true }).click();
    await trial.getByRole("tab", { name: "追踪", exact: true }).click();
    await traceNotice.getByRole("button", { name: "刷新" }).press("Enter");
    await expect(trial.getByText("暂无追踪", { exact: true })).toBeVisible();
    await expect(trial.getByRole("button", { name: "复制全部（JSON）" })).toHaveCount(0);
    await expect(trial.getByRole("heading", { name: /追踪 · 试跑/ })).not.toContainText("共");
    await expect(trial.getByRole("tab", { name: "追踪", exact: true })).toHaveText("追踪0");
    expect(received).toHaveLength(1);
  } finally {
    await app?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
