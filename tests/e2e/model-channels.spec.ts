import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("新建渠道、拉取模型、保存能力与参数并试跑", async () => {
  const testInfo = test.info();
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "link-studio-channels-"));
  const requests: { path?: string; authorization?: string; label?: string; body: string }[] = [];
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
          data: [{ id: "gpt-fixture" }, { id: "whisper-fixture" }, { id: "pending-fixture" }],
        }),
      );
    else if (request.url === "/v1/responses")
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
    await page.getByRole("button", { name: "新增渠道", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "新增渠道" });
    await editor.getByRole("button", { name: "停用渠道", exact: true }).press("Space");
    await editor.getByRole("button", { name: "启用渠道", exact: true }).click();
    await editor.getByLabel("渠道名称").fill("创作服务");
    await editor.getByLabel("Base URL").fill(`http://127.0.0.1:${address.port}`);
    await editor.getByLabel("允许本机或内网端点").check();
    await editor.getByRole("button", { name: "添加请求头", exact: true }).click();
    await editor.getByLabel("请求头名称 1").fill("x-fixture");
    await editor.getByLabel("请求头值 1").fill("channel-fixture-header");
    await editor.getByLabel("最大同时请求数").fill("1");
    await editor.getByLabel("确认使用此服务端点").check();
    await editor.getByRole("button", { name: "保存渠道" }).click();
    await page.getByRole("button", { name: "设置 Key", exact: true }).click();
    const keys = page.getByRole("dialog", { name: /的 Key/ });
    await keys.getByLabel("API Key", { exact: true }).fill("channel-fixture-key");
    await keys.getByRole("button", { name: "保存 Key" }).click();
    await expect(page.getByText("API Key 已配置", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "拉取模型", exact: true }).click();
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
    const model = page.getByRole("dialog", { name: "编辑模型" });
    await expect(model.getByText("未选择协议", { exact: true })).toBeVisible();
    await expect(model.getByRole("button", { name: "测试模型" })).toBeDisabled();
    await model.getByLabel("展示名称").fill("剧本助手模型");
    const logo = model.getByRole("button", { name: /^模型 Logo/ });
    const logoSearch = model.getByRole("searchbox", { name: "搜索厂商" });
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
    const previewLogo = model.locator(".model-preview [data-vendor='qwen'] img");
    await expect(previewLogo).toHaveJSProperty("naturalWidth", 24);
    const protocolList = model.locator(".model-protocol-list");
    const protocolCards = protocolList.getByRole("button");
    const textCard = protocolList.getByRole("button", { name: /^OpenAI/ });
    await model.getByRole("button", { name: "文本", exact: true }).click();
    await expect(textCard).toBeVisible();
    const textCardHeight = await textCard.evaluate((card) => card.getBoundingClientRect().height);
    for (const kind of ["图片", "视频"]) {
      await model.getByRole("button", { name: kind, exact: true }).click();
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
      await expect(protocolCards.last()).toHaveAttribute("aria-pressed", "true");
    }
    await model.getByRole("button", { name: "文本", exact: true }).click();
    await model.getByRole("button", { name: /^OpenAI/ }).click();
    await expect(model.getByLabel("协议版本", { exact: true })).toBeVisible();
    await expect(model.getByLabel("确认使用此插件版本与渠道端点")).toHaveCount(0);
    await expect(model.getByRole("button", { name: "保存模型" })).toBeEnabled();
    await model.getByLabel("展示名称").focus();
    await page.screenshot({ path: testInfo.outputPath("model-editor-basic.png") });
    await model.getByRole("button", { name: "能力与参数" }).click();
    await model.getByLabel("固定系统提示").fill("只回复 OK。");
    await model.getByLabel("最大输出（Token）").fill("64");
    await model.getByLabel("字数上限").fill("1200");
    await page.screenshot({ path: testInfo.outputPath("model-editor.png") });
    await model.getByRole("button", { name: "测试模型" }).click();
    const trial = page.getByRole("dialog", { name: "测试 剧本助手模型" });
    await expect(trial.locator("[data-vendor='qwen'] img")).toHaveJSProperty("naturalWidth", 24);
    await trial.getByLabel("测试提示词").fill("测试试跑提示词");
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(trial.getByText(/POST .*\/v1\/responses/)).toBeVisible();
    expect(requests).toHaveLength(1);
    await trial.getByRole("button", { name: "开始测试" }).click();
    await expect(trial.getByText("模型测试成功。", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("model-trial.png") });
    await trial.getByRole("button", { name: "关闭", exact: true }).click();
    await model.getByRole("switch", { name: "模型上线" }).check();
    await model.getByRole("button", { name: "保存模型" }).click();
    await expect(model).toBeHidden();
    expect(
      requests.map(({ path, authorization, label }) => ({ path, authorization, label })),
    ).toEqual([
      {
        path: "/v1/models",
        authorization: "Bearer channel-fixture-key",
        label: "channel-fixture-header",
      },
      {
        path: "/v1/responses",
        authorization: "Bearer channel-fixture-key",
        label: "channel-fixture-header",
      },
    ]);
    expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({
      model: "gpt-fixture",
      instructions: "只回复 OK。",
      max_output_tokens: 64,
    });
    const names = page
      .getByRole("table", { name: "渠道模型" })
      .locator(".channel-model-name strong");
    await expect(names).toHaveText(["剧本助手模型", "pending-fixture"]);
    await page
      .getByRole("button", { name: "排序 pending-fixture" })
      .dragTo(page.getByRole("row", { name: /剧本助手模型/ }), {
        targetPosition: { x: 90, y: 10 },
      });
    await expect(names).toHaveText(["pending-fixture", "剧本助手模型"]);
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    await restored.getByRole("button", { name: "模型设置" }).click();
    await expect(restored.locator(".channel-model-name strong")).toHaveText([
      "pending-fixture",
      "剧本助手模型",
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
    await restoredEditor.getByRole("button", { name: "取消", exact: true }).click();
    await restored.getByRole("button", { name: "拉取模型", exact: true }).click();
    const secondPull = restored.getByRole("dialog", { name: "选择要导入的模型" });
    await expect(secondPull.getByRole("checkbox", { name: /gpt-fixture.*已存在/ })).toBeChecked();
    await secondPull.getByRole("button", { name: "取消", exact: true }).click();
    const disableChannel = restored.getByRole("button", { name: "停用渠道", exact: true });
    const enableChannel = restored.getByRole("button", { name: "启用渠道", exact: true });
    await disableChannel.click();
    await expect(enableChannel).toBeVisible();
    await restored.getByRole("button", { name: "编辑渠道", exact: true }).click();
    const channelEditor = restored.getByRole("dialog", { name: "编辑渠道" });
    await channelEditor.getByRole("button", { name: "启用渠道", exact: true }).click();
    await channelEditor.getByRole("button", { name: "保存渠道" }).click();
    await disableChannel.click();
    await expect(
      restored.getByRole("table", { name: "渠道模型" }).getByText("不可用", { exact: true }),
    ).toBeVisible();
    await restored.getByRole("button", { name: "新增渠道", exact: true }).click();
    const targetEditor = restored.getByRole("dialog", { name: "新增渠道" });
    await targetEditor.getByLabel("渠道名称").fill("备用服务");
    await targetEditor.getByLabel("Base URL").fill(`http://127.0.0.1:${address.port}`);
    await targetEditor.getByLabel("允许本机或内网端点").check();
    await targetEditor.getByLabel("确认使用此服务端点").check();
    await targetEditor.getByRole("button", { name: "保存渠道" }).click();
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
    await expect(grip("创作服务")).toBeDisabled();
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
    await restored.getByRole("button", { name: "取消选择", exact: true }).click();
    await expect(restored.getByRole("button", { name: "Provider 设置", exact: true })).toHaveCount(
      0,
    );
    await restored.getByRole("combobox", { name: "按模型状态筛选" }).selectOption("pending");
    await expect(restored.getByRole("row", { name: /剧本助手模型/ })).toHaveCount(0);
    await expect(restoredPending).toBeVisible();
    await restored.getByRole("combobox", { name: "按模型状态筛选" }).selectOption("");
    await restored.getByRole("combobox", { name: "按模型能力筛选" }).selectOption("text");
    await expect(restoredPending).toHaveCount(0);
    await restored.getByRole("combobox", { name: "按模型能力筛选" }).selectOption("");
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
    await pagination.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(pagination.getByText("第 2 / 2 页")).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(4);
    await finalPage.getByRole("combobox", { name: "模型每页条数" }).selectOption("10");
    await expect(pagination.getByText("第 1 / 3 页")).toBeVisible();
    await pagination.getByRole("button", { name: "最后一页" }).click();
    await expect(pagination.getByText("第 3 / 3 页")).toBeVisible();
    const finalNames = table.locator(".channel-model-name strong");
    await expect(finalNames).toHaveText(["page-model-18", "page-model-19", "page-model-20"]);
    await table.getByRole("button", { name: "排序 page-model-20", exact: true }).press("ArrowUp");
    await expect(finalNames).toHaveText(["page-model-18", "page-model-20", "page-model-19"]);
    await pagination.getByRole("button", { name: "第一页" }).click();
    const firstPageModels = Array.from({ length: 8 }, (_, index) => `page-model-${index}`);
    await expect(finalNames).toHaveText(["pending-fixture", "剧本助手模型", ...firstPageModels]);
    await finalPage.getByRole("combobox", { name: "按模型状态筛选" }).selectOption("pending");
    await table
      .getByRole("button", { name: "排序 pending-fixture", exact: true })
      .press("ArrowDown");
    await expect(finalNames.first()).toHaveText("page-model-0");
    await finalPage.getByRole("combobox", { name: "按模型状态筛选" }).selectOption("");
    await expect(finalNames).toHaveText([
      "page-model-0",
      "剧本助手模型",
      "pending-fixture",
      ...firstPageModels.slice(1),
    ]);

    await finalPage.getByRole("button", { name: /^剧本助手模型/ }).click();
    const agentEditor = finalPage.getByRole("dialog", { name: "编辑模型" });
    await agentEditor.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(agentEditor.getByText("宿主网关", { exact: true })).toBeVisible();
    await expect(agentEditor.getByLabel("协议版本")).toHaveCount(0);
    await expect(agentEditor.locator(".model-protocol-list")).toHaveCount(0);
    await agentEditor.getByRole("button", { name: "能力与参数" }).click();
    await expect(agentEditor.getByLabel("最大输出（Token）")).toHaveValue("");
    await agentEditor.getByRole("button", { name: "基本信息" }).click();
    await agentEditor.getByRole("button", { name: "文本", exact: true }).click();
    await expect(agentEditor.getByText("未选择协议", { exact: true })).toBeVisible();
    await expect(agentEditor.getByRole("button", { name: "测试模型" })).toBeDisabled();
    await agentEditor.getByRole("button", { name: "能力与参数" }).click();
    await expect(agentEditor.getByLabel("固定系统提示")).toHaveValue("");
    await agentEditor.getByRole("button", { name: "基本信息" }).click();
    await agentEditor.getByRole("button", { name: "Agent", exact: true }).click();
    await agentEditor.getByLabel("接口路径前缀").fill("/agent/v3");
    await expect(agentEditor.getByLabel("接口格式")).toHaveValue("chat_completions");
    await agentEditor.getByRole("button", { name: "保存模型" }).click();
    await expect(agentEditor).toBeHidden();
    const agentRow = table.getByRole("row", { name: /剧本助手模型/ });
    await expect(agentRow.getByText("宿主网关", { exact: true })).toBeVisible();
    await agentRow.getByRole("button", { name: /^剧本助手模型/ }).click();
    await expect(agentEditor.getByLabel("接口路径前缀")).toHaveValue("/agent/v3");
    await agentEditor.getByRole("button", { name: "测试模型" }).click();
    const agentTrial = finalPage.getByRole("dialog", { name: "测试 剧本助手模型" });
    await agentTrial.getByLabel("测试提示词").fill("测试 Agent 流式请求");
    await agentTrial.getByRole("button", { name: "开始测试" }).click();
    await expect(agentTrial.getByText("模型测试成功。", { exact: true })).toBeVisible();
    expect(requests.at(-1)).toMatchObject({
      path: "/agent/v3/chat/completions",
      authorization: "Bearer channel-fixture-key",
      label: "channel-fixture-header",
    });
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
