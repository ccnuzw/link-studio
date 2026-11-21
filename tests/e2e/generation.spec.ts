import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { expectAssistantContrast, expectAssistantPicker } from "./assistant-theme";
import { projectAction } from "./workspace-actions";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=";

test("画布连线作为视频参考，断线与文生模式不发送原图", async () => {
  test.setTimeout(55_000);
  const root = await mkdtemp(join(tmpdir(), "link-studio-linked-video-"));
  const filename = "镜头参考.png";
  const file = join(root, filename);
  const bytes = Buffer.from(png, "base64");
  const submissions: { type: string; body: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && /^\/v1\/videos\/fixture-[12]$/.test(request.url ?? "")) {
      response.end(JSON.stringify({ status: "cancelled" }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/videos") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    submissions.push({ type: request.headers["content-type"] ?? "", body: Buffer.concat(chunks) });
    response.end(JSON.stringify({ id: `fixture-${submissions.length}` }));
  });
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeFile(file, bytes);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mock endpoint");
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    const env = {
      ...process.env,
      LINK_STUDIO_TEST_USER_DATA: root,
      LINK_STUDIO_TEST_PROJECT_PARENT: root,
      LINK_STUDIO_TEST_MEDIA_FILES: file,
    };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env,
    });
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const page = await application.firstWindow();
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      if (!list.ok) throw new Error(list.code);
      const plugin = list.value.plugins.find(({ key }) => key === "sora");
      if (!plugin) throw new Error("Missing Sora adapter");
      const saved = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-video-key",
        fields: {
          label: "回环视频",
          model: "sora-2",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!saved.ok) throw new Error(saved.code);
    }, `http://127.0.0.1:${address.port}`);
    await page.getByRole("textbox", { name: "新项目名称" }).fill("连线参考验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: /^视频生成 让画面动起来/ }).click();
    const video = page.locator(".react-flow__node").filter({ hasText: "新的视频节点" });
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    await page.getByRole("button", { name: `将${filename}加入画布` }).click();
    await page.getByRole("button", { name: "关闭素材库" }).click();
    const image = page.locator(".react-flow__node").filter({ hasText: filename });
    const heading = video.locator("header strong");
    const bounds = await heading.boundingBox();
    if (!bounds) throw new Error("Missing video node");
    await page.mouse.move(bounds.x + 12, bounds.y + 6);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 370, bounds.y + 6, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByText("画布已同步到项目")).toBeVisible();
    await image
      .locator(".react-flow__handle-right")
      .dragTo(video.locator(".react-flow__handle-left"));
    const edge = page.locator(".react-flow__edge");
    await expect(edge).toHaveCount(1);
    await heading.click();
    const composer = page.getByRole("region", { name: "生成确认" });
    const reference = composer.getByText(`连线：${filename}`, { exact: true });
    const imageMode = composer.getByRole("button", { name: "图生视频", exact: true });
    const prompt = composer.getByRole("textbox", { name: "生成提示词" });
    await expect(imageMode).toHaveAttribute("aria-pressed", "true");
    await expect(reference).toBeVisible();
    await composer.getByRole("button", { name: "添加参考素材" }).click();
    const picker = page.getByRole("region", { name: "参考素材", exact: true });
    const duplicate = picker.getByRole("checkbox", { name: filename });
    await expect(duplicate).toBeChecked();
    await expect(duplicate).toBeDisabled();
    await page.keyboard.press("Escape");

    await composer.getByRole("button", { name: `断开素材连线 ${filename}` }).click();
    await expect(edge).toHaveCount(0);
    await heading.click();
    await expect(reference).toBeHidden();
    await expect(imageMode).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(edge).toHaveCount(1);
    await heading.click();
    await expect(reference).toBeVisible();
    await composer.getByRole("button", { name: "文生视频", exact: true }).click();
    await expect(reference).toBeHidden();
    await expect.poll(() => submissions.length).toBe(0);
    await prompt.fill("镜头缓慢推进");
    await imageMode.click();
    await expect(reference).toBeVisible();
    await composer.getByRole("button", { name: "确认生成" }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]?.type).toMatch(/^multipart\/form-data;/);
    expect(submissions[0]?.body.toString().match(/name="input_reference"/g)).toHaveLength(1);
    expect(submissions[0]?.body.includes(bytes)).toBe(true);

    const jobs = page.getByRole("region", { name: "生成任务中心" });
    await expect(jobs.getByText("已取消", { exact: true })).toBeVisible({ timeout: 25_000 });
    await page.getByRole("button", { name: "关闭侧栏" }).click();
    await heading.click();
    await composer.getByRole("button", { name: "文生视频", exact: true }).click();
    await composer.getByRole("button", { name: "确认生成" }).click();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions[1]?.type).toMatch(/^application\/json/);
    expect(JSON.parse(submissions[1]?.body.toString() ?? "{}")).toEqual({
      model: "sora-2",
      prompt: "镜头缓慢推进",
    });
    await expect(jobs.getByText("已取消", { exact: true })).toHaveCount(2, { timeout: 25_000 });
  } finally {
    await application?.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("S4 设置与画布小灵隔离，审批生成和结果跨重启保留", async () => {
  test.setTimeout(65_000);
  const root = await mkdtemp(join(tmpdir(), "link-studio-generation-e2e-"));
  let imageCalls = 0;
  let imageRequest: { size?: string; quality?: string; n?: number; prompt?: string } | undefined;
  let nextTool: { name: string; args: object } | undefined;
  let allowedTools: string[] = [];
  let asyncSubmits = 0;
  let asyncQueries = 0;
  let cancelCalls = 0;
  let complete = false;
  let receivedImage = false;
  let textModelSawImage = false;
  let textModelDeniedImage = false;
  let referenceRequests = 0;
  let sawGroupContext = false;
  let sawQuestionAnswers = false;
  let sawQuestionSkip = false;
  let selectedQuestionModel = "";
  let sawQuestionModel = false;
  const server = createServer(async (request, response) => {
    if (request.url === "/reference.txt") {
      referenceRequests++;
      response.writeHead(200, { "content-type": "text/plain" }).end("资料");
      return;
    }
    if (request.method === "DELETE" && request.url === "/fixture-jobs/original-task") {
      cancelCalls++;
      response.writeHead(500).end();
      return;
    }
    if (request.url === "/fixture-jobs") {
      request.resume();
      asyncSubmits++;
      response.end(JSON.stringify({ id: "original-task" }));
      return;
    }
    if (request.url === "/fixture-jobs/original-task") {
      asyncQueries++;
      response.end(JSON.stringify({ ready: complete }));
      return;
    }
    if (request.url === "/fixture-result.png") {
      response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(png, "base64"));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url?.includes("/images/")) {
      imageCalls++;
      imageRequest = payload;
      response.end(
        JSON.stringify({ data: Array.from({ length: payload.n ?? 1 }, () => ({ b64_json: png })) }),
      );
      return;
    }
    allowedTools = (payload.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    receivedImage ||= JSON.stringify(payload.messages).includes(`data:image/png;base64,${png}`);
    const serialized = JSON.stringify(payload.messages);
    sawQuestionAnswers ||=
      serialized.includes("用户回答（按问题 ID）") &&
      serialized.includes("横屏") &&
      serialized.includes("雨夜街道") &&
      serialized.includes("电影感") &&
      serialized.includes("冷色调") &&
      serialized.includes("2.5");
    sawQuestionSkip ||= serialized.includes("用户跳过了问题，未补充信息或授权。");
    sawQuestionModel ||=
      Boolean(selectedQuestionModel) &&
      serialized.includes("用户回答（按问题 ID）") &&
      serialized.includes(selectedQuestionModel);
    sawGroupContext ||= (payload.messages ?? []).some(
      (message: { role: string; content: unknown }) =>
        message.role === "tool" &&
        JSON.stringify(message.content).includes("fixture-s4-group") &&
        JSON.stringify(message.content).includes("viewport") &&
        JSON.stringify(message.content).includes("fixture-missing"),
    );
    if (payload.model === "fixture-text") {
      const messages = JSON.stringify(payload.messages);
      textModelSawImage ||= messages.includes("data:image/");
      textModelDeniedImage ||= messages.includes("AGENT_MODEL_CAPABILITY_UNSUPPORTED");
    }
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const call = nextTool;
    if (call) {
      nextTool = call.name === "canvas_get_state" ? afterRead : undefined;
      response.write(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: call.name,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }),
      );
    } else response.write(chunk({ role: "assistant", content: "画布任务已检查。" }));
    response.end(`${chunk({}, call ? "tool_calls" : "stop")}data: [DONE]\n\n`);
  }).listen(0, "127.0.0.1");
  let afterRead: typeof nextTool;
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing mock endpoint");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const environment = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: root,
    LINK_STUDIO_TEST_PROJECT_PARENT: root,
  };
  delete (environment as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env: environment,
    });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  const jobs = (page: Page) => page.getByRole("region", { name: "生成任务中心" });
  try {
    application = await launch();
    const page = await application.firstWindow();
    const profiles = await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      if (!list.ok) throw new Error(list.code);
      for (const [key, label, agentEnabled, agentVision] of [
        ["openai-image", "回环图片", false, false],
        ["openai", "回环小灵", true, true],
        ["openai", "回环文本小灵", true, false],
      ] as const) {
        const plugin = list.value.plugins.find((entry) => entry.key === key);
        if (!plugin) throw new Error(`Missing ${key}`);
        const saved = await settings.save({
          expectedRevision: 0,
          pluginHash: plugin.hash,
          approve: true,
          secret: "fixture-secret",
          fields: {
            label,
            endpoint,
            model:
              key === "openai-image" ? "gpt-image-1" : !agentVision ? "fixture-text" : "fixture",
            allowLocal: true,
            agentEnabled,
            agentVision,
            channel: agentEnabled ? { api: "chat_completions" } : {},
          },
        });
        if (!saved.ok) throw new Error(saved.code);
      }
      const fixture = await settings.draft({
        source: `module.exports = {
        meta: { apiVersion: 1, key: 'fixture-async-image', name: '回环异步图片', auth: { type: 'none' }, endpoints: { image: { mode: 'async' } }, poll: { firstDelay: 0.01, interval: 1 } },
        buildSubmitRequest: function () { return { method: 'POST', path: '/fixture-jobs', json: {} }; },
        parseSubmitResponse: function (ctx, resp) { return { providerTaskId: resp.body.id }; },
        buildQueryRequest: function (ctx) { return { method: 'GET', path: '/fixture-jobs/' + ctx.task.providerTaskId }; },
        parseQueryResponse: function (ctx, resp) { return resp.body.ready ? { status: 'succeeded', outputs: [{ type: 'url', url: ctx.channel.baseUrl + '/fixture-result.png' }] } : { status: 'running' }; },
        buildCancelRequest: function (ctx) { return { method: 'DELETE', path: '/fixture-jobs/' + ctx.task.providerTaskId }; }
      };`,
      });
      if (!fixture.ok) throw new Error(fixture.code);
      const saved = await settings.save({
        expectedRevision: 0,
        pluginHash: fixture.value.hash,
        approve: true,
        fields: {
          label: "回环异步图片",
          endpoint,
          model: "async-fixture",
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!saved.ok) throw new Error(saved.code);
      return saved.value;
    }, endpoint);
    await page.getByRole("textbox", { name: "新项目名称" }).fill("生成闭环验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: /^图片生成 从描述/ }).click();
    const imageNode = page.locator(".react-flow__node").filter({ hasText: "新的图片节点" });
    await page.mouse.click(420, 210);
    await expect(page.getByRole("region", { name: "生成确认" })).toBeHidden();
    await imageNode.locator(".node-media").click({ position: { x: 30, y: 30 } });
    await expect(page.getByRole("region", { name: "生成确认" })).toBeVisible();
    const modelTrigger = page.getByRole("button", { name: "生成模型", exact: true });
    await modelTrigger.press("Enter");
    const models = page.getByRole("region", { name: "选择生成模型" });
    await models.getByRole("button", { name: /async-fixture/ }).click();
    await expect(modelTrigger).toHaveText("async-fixture");
    await modelTrigger.click();
    await models.getByRole("button", { name: /gpt-image-1.*回环图片/ }).click();
    await expect(modelTrigger).toHaveText("gpt-image-1");
    const parametersTrigger = page.getByRole("button", { name: "生成参数", exact: true });
    await parametersTrigger.click();
    const parameters = page.getByRole("region", { name: "生成参数", exact: true });
    await parameters.getByRole("button", { name: "3:2", exact: true }).click();
    await parameters.getByRole("button", { name: "高", exact: true }).click();
    await parameters.getByRole("button", { name: "2 张", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(parameters).toBeHidden();
    await expect(parametersTrigger).toBeFocused();
    const templateTrigger = page.getByRole("button", { name: "提示词模板", exact: true });
    await templateTrigger.click();
    await page.getByRole("button", { name: /25宫格连贯分镜/ }).click();
    await expect(page.getByText("此模板需要一张参考图。")).toBeVisible();
    await page.getByRole("button", { name: "移除预设 25宫格连贯分镜" }).click();
    await page.getByRole("button", { name: "风格", exact: true }).click();
    const style = page.getByRole("button", { name: "古装偶像", exact: true });
    await expect
      .poll(() => style.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await page.screenshot({ path: "test-results/canvas-node-style-picker.png" });
    await style.click();
    await page.getByLabel("生成提示词").fill("给封面生成一张图片");
    await page.screenshot({ path: "test-results/canvas-node-generation.png" });
    await page.getByRole("button", { name: "确认生成" }).click();
    await expect(jobs(page).getByText("已完成", { exact: true })).toHaveCount(1);
    expect(imageRequest).toMatchObject({
      size: "1536x1024",
      quality: "high",
      n: 2,
      prompt: expect.stringMatching(/给封面生成一张图片\n\n古偶唯美柔光风格/),
    });
    await expect(imageNode.locator(".node-media img")).toHaveAttribute("src", /^link-media:/);
    const nodeId = await imageNode.getAttribute("data-id");
    if (!nodeId) throw new Error("Missing canvas node ID");
    const readRevision = () =>
      import("node:fs/promises").then(async ({ readdir, readFile }) => {
        const project = (await readdir(root)).find((name) => name.endsWith(".linkstudio"));
        if (!project) throw new Error("Missing workspace");
        const directory = join(root, project, "state");
        const file = (await readdir(directory)).sort().at(-1);
        if (!file) throw new Error("Missing snapshot");
        return Number(JSON.parse(await readFile(join(directory, file), "utf8")).canvas.revision);
      });
    nextTool = { name: "canvas_get_state", args: { nodeIds: [nodeId] } };
    afterRead = {
      name: "generate_media",
      args: {
        items: [
          {
            nodeId,
            providerId: profiles.id,
            expectedProviderRevision: profiles.revision,
            expectedCanvasRevision: await readRevision(),
            prompt: "生成另一版",
            referenceAssetIds: [],
          },
        ],
      },
    };
    await page.getByRole("button", { name: "打开小灵", exact: true }).click();
    const canvasAssistant = page.getByRole("region", { name: "画布小灵" });
    await expect(canvasAssistant.getByRole("button", { name: "新对话" })).toBeEnabled();
    await expectAssistantContrast(canvasAssistant.getByRole("button", { name: "新对话" }));
    await expect(canvasAssistant.getByRole("log")).toHaveCSS("color-scheme", "light");
    await expect(canvasAssistant.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    const canvasModel = canvasAssistant.getByRole("combobox", { name: "对话模型" });
    await canvasModel.selectOption({ label: "fixture · 回环小灵" });
    await expectAssistantPicker(canvasModel);
    const mediaPicker = canvasAssistant.getByRole("button", { name: "图片或视频模型" });
    await mediaPicker.press("Enter");
    const mediaModel = canvasAssistant.getByRole("combobox", { name: "默认生成模型" });
    await mediaModel.selectOption({ label: "图片 · gpt-image-1 · 回环图片" });
    await mediaModel.press("Escape");
    await canvasAssistant.getByRole("button", { name: "模型上下文" }).click();
    await expect(canvasAssistant.getByText(/暂无上下文用量/)).toBeVisible();
    await canvasAssistant.getByRole("button", { name: "模型上下文" }).press("Escape");
    await canvasAssistant.locator(".assistant-composer").screenshot({
      path: test.info().outputPath("canvas-composer.png"),
    });
    await page.getByRole("button", { name: "@ 引用选中节点" }).click();
    await expect(page.getByRole("button", { name: "移除节点引用 新的图片节点" })).toBeVisible();
    const canvasComposer = canvasAssistant.getByRole("textbox", { name: "画布消息" });
    await expectAssistantContrast(canvasComposer, "::placeholder");
    await expectAssistantContrast(canvasAssistant.getByRole("button", { name: /移除节点引用/ }));
    await canvasComposer.fill("请为这个节点生成另一版。");
    await canvasComposer.press("Shift+Enter");
    await expect(canvasComposer).toHaveValue("请为这个节点生成另一版。\n");
    await expectAssistantContrast(
      canvasAssistant.getByRole("button", { name: "发送", exact: true }),
    );
    await canvasComposer.press("Enter");
    const approval = page.getByRole("heading", { name: "生成审批" });
    await expect(approval).toBeVisible({ timeout: 15000 });
    await expect(canvasModel).toBeDisabled();
    await expectAssistantContrast(canvasModel);
    await expectAssistantContrast(approval);
    await expectAssistantContrast(canvasAssistant.locator(".generation-choice small").first());
    expect(allowedTools).not.toContain("admin_propose_changes");
    expect(allowedTools).toEqual(expect.arrayContaining(["plan_update", "show_card"]));
    expect(imageCalls).toBe(1);
    expect(asyncSubmits).toBe(0);
    await page.getByRole("textbox", { name: "画布消息" }).fill("保留先前待审批的画布任务。");
    await page.getByRole("button", { name: "插话", exact: true }).click();
    await expect(page.getByText("保留先前待审批的画布任务。", { exact: true })).toBeVisible();
    expect(asyncSubmits).toBe(0);
    await page.getByRole("region", { name: "画布小灵" }).getByRole("checkbox").check();
    await page.getByRole("button", { name: "批准所选生成" }).click();
    await expect.poll(() => asyncQueries).toBeGreaterThan(0);
    await expect(page.getByText("已提交 1 项生成任务。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "生成任务", exact: true }).click();
    await expect(jobs(page).getByText("生成中", { exact: true })).toHaveCount(1);
    await application.evaluate(({ dialog }) => {
      const choices = [0, 2, 1];
      const prompts: Electron.MessageBoxOptions[] = [];
      Reflect.set(globalThis, "s4QuitPrompts", prompts);
      dialog.showMessageBox = (async (options: Electron.MessageBoxOptions) => {
        prompts.push(options);
        return { response: choices.shift() ?? 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await application.evaluate(({ app }) => app.quit());
    const prompts = await application.evaluate(
      () => Reflect.get(globalThis, "s4QuitPrompts") as Electron.MessageBoxOptions[],
    );
    expect(prompts).toMatchObject([
      {
        message: "还有 1 项生成任务未完成",
        buttons: ["继续等待", "退出并稍后恢复", "请求取消任务"],
      },
    ]);
    expect(cancelCalls).toBe(0);
    await expect(jobs(page).getByText("生成中", { exact: true })).toBeVisible();
    await application.evaluate(({ app }) => app.quit());
    await expect.poll(() => cancelCalls).toBe(1);
    await expect(jobs(page).getByText("JOB_CANCEL_UNCONFIRMED", { exact: false })).toBeVisible();
    await expect(jobs(page).getByText("生成中", { exact: true })).toBeVisible();
    await application.close();
    const queriesBeforeRestart = asyncQueries;
    complete = true;
    application = await launch();
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^生成闭环验收/ }).click();
    await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
    await expect(reopened.getByText("生成任务已返回", { exact: true })).toHaveCount(1, {
      timeout: 20_000,
    });
    await reopened.getByRole("button", { name: "定位节点", exact: true }).click();
    await expect(reopened.locator(".react-flow__node.selected")).toHaveAttribute("data-id", nodeId);
    await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await reopened
      .getByRole("combobox", { name: "对话模型" })
      .selectOption({ label: "fixture · 回环小灵" });
    nextTool = { name: "canvas_get_state", args: { nodeIds: [nodeId] } };
    afterRead = { name: "canvas_inspect_image", args: { nodeId } };
    await reopened.getByRole("textbox", { name: "画布消息" }).fill("查看生成的图片。");
    await reopened.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => receivedImage, { timeout: 10_000 }).toBe(true);
    await reopened.getByRole("button", { name: "生成任务", exact: true }).click();
    await expect(jobs(reopened).getByText("已完成", { exact: true })).toHaveCount(2);
    expect(imageCalls).toBe(1);
    expect(asyncSubmits).toBe(1);
    expect(asyncQueries).toBeGreaterThan(queriesBeforeRestart);
    await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
    await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await reopened
      .getByRole("combobox", { name: "对话模型" })
      .selectOption({ label: "fixture-text · 回环文本小灵" });
    nextTool = { name: "canvas_get_state", args: { nodeIds: [nodeId] } };
    afterRead = { name: "canvas_inspect_image", args: { nodeId } };
    await reopened.getByRole("textbox", { name: "画布消息" }).fill("用文本模型尝试查看图片。");
    await reopened.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => textModelDeniedImage).toBe(true);
    expect(textModelSawImage).toBe(false);
    await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await reopened.getByRole("button", { name: "保存项目" }).click();
    await expect(reopened.getByText("画布已同步到项目")).toBeVisible();

    nextTool = { name: "canvas_get_state", args: { nodeIds: [nodeId] } };
    afterRead = {
      name: "generate_media",
      args: {
        items: [
          {
            nodeId,
            providerId: profiles.id,
            expectedProviderRevision: profiles.revision,
            expectedCanvasRevision: await readRevision(),
            prompt: "关闭前未审批的任务",
            referenceAssetIds: [],
          },
        ],
      },
    };
    await reopened.getByRole("textbox", { name: "画布消息" }).fill("提出一项生成任务。");
    await reopened.getByRole("button", { name: "发送", exact: true }).click();
    await expect(reopened.getByRole("heading", { name: "生成审批" })).toBeVisible();
    await projectAction(reopened, "关闭项目");
    await reopened.getByRole("button", { name: /^生成闭环验收/ }).click();
    await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
    const assistant = reopened.getByRole("region", { name: "画布小灵" });
    await expect(assistant.getByRole("status")).toHaveText("就绪");
    await expect(reopened.getByRole("heading", { name: "生成审批" })).toHaveCount(0);
    expect(asyncSubmits).toBe(1);

    nextTool = {
      name: "plan_update",
      args: { steps: [{ title: "检查生成素材", status: "done" }] },
    };
    await reopened.getByRole("textbox", { name: "画布消息" }).fill("把检查步骤放进计划。");
    await reopened.getByRole("button", { name: "发送", exact: true }).click();
    await expect(reopened.getByText("已完成 · 检查生成素材")).toBeVisible();
    await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    const ask = {
      name: "ask_user",
      args: {
        questions: [
          { id: "ratio", label: "成片用什么画幅？", options: ["横屏", "竖屏"] },
          { id: "scene", label: "画面发生在哪里？" },
          {
            id: "style",
            kind: "choice",
            label: "选择风格",
            options: ["电影感", "冷色调", "黑白"],
            multi: true,
          },
          { id: "duration", kind: "number", label: "镜头时长" },
          { id: "source", kind: "url", label: "参考链接", required: false },
        ],
      },
    };
    const send = assistant.getByRole("button", { name: "发送", exact: true });
    nextTool = ask;
    await assistant.getByLabel("画布消息").fill("先确认关键创作条件。");
    await send.click();
    const question = assistant.getByRole("form", { name: "小灵提问" });
    await expect(question).toBeVisible();
    await expect(question.getByRole("button", { name: "提交回答" })).toBeDisabled();
    await expectAssistantContrast(question.getByRole("combobox"));
    await reopened.getByRole("button", { name: "收起小灵", exact: true }).click();
    await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
    await expect(question).toBeVisible();
    await question.getByLabel("成片用什么画幅？").selectOption("横屏");
    await question.getByLabel("画面发生在哪里？").fill("雨夜街道");
    await question.getByRole("checkbox", { name: "电影感" }).check();
    await question.getByRole("checkbox", { name: "冷色调" }).check();
    await question.getByLabel("镜头时长").fill("1e999");
    await expect(question.getByText("请输入有效数字。")).toBeVisible();
    await question.getByLabel("镜头时长").fill("2.5");
    await question.getByLabel("参考链接").fill("file:///tmp/fixture");
    await expect(question.getByRole("button", { name: "提交回答" })).toBeDisabled();
    await question.getByLabel("参考链接").clear();
    await question.getByRole("button", { name: "提交回答" }).click();
    await expect(
      assistant
        .getByRole("region", { name: "小灵提问记录" })
        .getByText("画面发生在哪里？：雨夜街道"),
    ).toBeVisible();
    await expect.poll(() => sawQuestionAnswers).toBe(true);
    await expect(send).toBeVisible();
    nextTool = ask;
    await assistant.getByLabel("画布消息").fill("允许跳过这个问题。");
    await send.click();
    await question.getByRole("button", { name: "跳过提问" }).click();
    await expect(assistant.getByText("已跳过提问", { exact: true })).toBeVisible();
    await expect.poll(() => sawQuestionSkip).toBe(true);
    await expect(send).toBeVisible();
    nextTool = {
      name: "ask_user",
      args: {
        questions: [
          { id: "image-model", label: "使用哪个图片模型？", kind: "model", modelKind: "image" },
        ],
      },
    };
    await assistant.getByLabel("画布消息").fill("先选择图片模型。");
    await send.click();
    const modelQuestion = question.getByRole("combobox", { name: /使用哪个图片模型/ });
    await expect(modelQuestion).toBeVisible();
    await expectAssistantContrast(modelQuestion);
    [selectedQuestionModel = ""] = await modelQuestion.selectOption({
      label: "gpt-image-1 · 回环图片",
    });
    expect(selectedQuestionModel).toBeTruthy();
    await expect(modelQuestion).not.toContainText("回环小灵");
    await question.getByRole("button", { name: "提交回答" }).click();
    await expect(
      assistant.getByText("使用哪个图片模型？：gpt-image-1", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => sawQuestionModel).toBe(true);
    await expect(send).toBeVisible();
    expect(imageCalls).toBe(1);
    expect(asyncSubmits).toBe(1);
    const referenceSummary = assistant.getByRole("button", { name: "添加附件" });
    await expectAssistantContrast(referenceSummary);
    await referenceSummary.click();
    const webGrant = assistant.getByRole("checkbox", { name: "允许本轮联网检索" });
    await expect(webGrant).not.toBeChecked();
    const reference = assistant.getByLabel("公开文本链接");
    await expectAssistantContrast(reference, "::placeholder");
    await reference.fill(`${endpoint}/reference.txt`);
    const privatePrompt = "请检查这个画布节点，诊断不应包含这句话。";
    await assistant.getByLabel("画布消息").fill(privatePrompt);
    await assistant.getByRole("button", { name: "发送", exact: true }).click();
    await expect(assistant.getByRole("alert")).toContainText("无法读取资料");
    await expectAssistantContrast(assistant.getByRole("alert"));
    expect(referenceRequests).toBe(0);
    await assistant.getByRole("button", { name: "移除链接" }).click();
    const output = join(root, "diagnostics.json");
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path,
      })) as typeof dialog.showSaveDialog;
    }, output);
    await assistant.getByRole("button", { name: "导出运行诊断" }).click();
    await expect(
      assistant.getByRole("status").filter({ hasText: "已导出运行诊断。" }),
    ).toBeVisible();
    const diagnostic = await readFile(output, "utf8");
    expect(diagnostic).not.toContain(privatePrompt);
    expect(diagnostic).not.toContain("fixture-secret");
    expect(diagnostic).not.toContain(endpoint);
    expect(JSON.parse(diagnostic)).toMatchObject({
      schemaVersion: 1,
      events: expect.arrayContaining([
        expect.objectContaining({ type: "model.call", purpose: "main", httpStatus: 200 }),
        expect.objectContaining({ type: "model.usage" }),
        expect.objectContaining({ type: "tool.end" }),
      ]),
    });
    if (!(await webGrant.isVisible())) await referenceSummary.click();
    await webGrant.check();
    await expect(assistant.getByText("本轮联网检索", { exact: true })).toBeVisible();
    await assistant.getByLabel("画布消息").fill("本轮允许查阅公开创作资料。");
    await send.click();
    await expect
      .poll(() => allowedTools)
      .toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    await expect(assistant.getByText("本轮联网检索", { exact: true })).toHaveCount(0);
    await expect(send).toBeVisible();
    await assistant.getByLabel("画布消息").fill("下一轮仅使用画布内容。");
    await send.click();
    await expect.poll(() => allowedTools).not.toContain("web_search");
    expect(allowedTools).not.toContain("web_fetch");
    await expect(send).toBeVisible();
    nextTool = { name: "canvas_get_state", args: { nodeIds: [nodeId] } };
    afterRead = {
      name: "canvas_delete",
      args: {
        expectedCanvasRevision: await readRevision(),
        operations: [
          {
            type: "putNode",
            node: {
              id: "fixture-s4-opening",
              type: "creative",
              position: { x: 100, y: 130 },
              data: { kind: "script", label: "从一个想法开始", text: "助手修改的开场" },
            },
          },
          {
            type: "putNode",
            node: {
              id: "fixture-s4-group",
              type: "group",
              position: { x: 90, y: 380 },
              data: { label: "小灵分镜组" },
              width: 310,
              height: 200,
            },
          },
          {
            type: "putNode",
            node: {
              id: "fixture-s4-script",
              type: "creative",
              parentId: "fixture-s4-group",
              position: { x: 24, y: 40 },
              data: {
                kind: "script",
                label: "分镜草稿",
                text: "",
                storyboard: [
                  {
                    id: "shot-1",
                    scene: "夜班列车缓缓进站",
                    shot: "全景",
                    camera: "跟",
                    action: "值班员走到站台边",
                    dialogue: "请注意脚下。",
                    duration: 4,
                  },
                ],
              },
            },
          },
        ],
      },
    };
    await assistant.getByLabel("画布消息").fill("把分镜草稿整理成组。");
    await assistant.getByRole("button", { name: "发送", exact: true }).click();
    await expect(assistant.getByRole("heading", { name: "画布变更审批" })).toBeVisible();
    await expect(reopened.locator('[data-id="fixture-s4-script"]')).toHaveCount(0);
    await assistant.getByText("预览 1 个镜头", { exact: true }).click();
    await expect(assistant.getByText("夜班列车缓缓进站", { exact: true })).toBeVisible();
    await expect(assistant.getByText("全景 · 跟 · 4 秒", { exact: true })).toBeVisible();
    const operation = assistant.getByText("查看操作", { exact: true }).first();
    await operation.press("Enter");
    await expect(operation).toHaveCSS("outline-style", "solid");
    const operationDetails = assistant.locator("details[open] pre");
    await expect(operationDetails).toBeVisible();
    await expectAssistantContrast(operationDetails);
    await assistant.screenshot({ path: test.info().outputPath("canvas-approval-theme.png") });
    await operation.press("Enter");
    await assistant.getByRole("button", { name: "应用画布变更" }).click();
    await expect(reopened.locator('[data-id="fixture-s4-script"]')).toHaveCount(1);
    await assistant.getByRole("button", { name: "定位 小灵分镜组" }).click();
    await expect(reopened.locator(".react-flow__node.selected")).toHaveAttribute(
      "data-id",
      "fixture-s4-group",
    );
    await expect(reopened.getByLabel("当前缩放")).toContainText("%");
    await expect(assistant.getByText("@小灵分镜组（分组） ×", { exact: true })).toBeVisible();
    await assistant.getByRole("button", { name: "移除节点引用 小灵分镜组" }).click();
    await expect(assistant.getByRole("button", { name: "移除节点引用 小灵分镜组" })).toHaveCount(0);
    await assistant.getByRole("button", { name: "@ 引用选中节点" }).click();
    await expect(assistant.getByRole("button", { name: "移除节点引用 小灵分镜组" })).toBeVisible();
    nextTool = {
      name: "canvas_get_state",
      args: { nodeIds: ["fixture-s4-group", "fixture-missing"] },
    };
    afterRead = undefined;
    await assistant.getByLabel("画布消息").fill("检查分组及视口。");
    await assistant.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => sawGroupContext).toBe(true);
    await expect(assistant.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    const welcome = reopened.getByRole("textbox", { name: "从一个想法开始内容" });
    await expect(welcome).toHaveValue("助手修改的开场");
    await welcome.fill("人工保留的开场");
    await assistant.getByRole("button", { name: "撤销本轮画布修改" }).click();
    await expect(
      assistant.getByRole("status").filter({ hasText: "已撤销 2 项，跳过 1 项。" }),
    ).toBeVisible();
    await expect(assistant.getByText(/@小灵分镜组（已缺失）/)).toBeVisible();
    await expect(welcome).toHaveValue("人工保留的开场");
    await reopened.getByRole("button", { name: "适应视图", exact: true }).click();
    const opening = reopened
      .locator('[data-id="fixture-s4-opening"]')
      .getByText("从一个想法开始", { exact: true });
    await expect(opening).toBeInViewport();
    await opening.click();
    await assistant.getByRole("button", { name: "从引用剧本拆分镜" }).click();
    await expect(assistant.getByLabel("画布消息")).toHaveValue(/请读取我引用的剧本/);
    await assistant.getByLabel("画布消息").fill("切换面板后保留的草稿");
    await projectAction(reopened, "运行环境");
    await expect(assistant).toBeHidden();
    await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
    await expect(assistant.getByLabel("画布消息")).toHaveValue("切换面板后保留的草稿");

    const profile = await reopened.evaluate(async () => {
      const result = await window.desktop.settings.list({});
      if (!result.ok) throw new Error(result.code);
      return result.value.providers.find(({ label }) => label === "回环小灵");
    });
    if (!profile) throw new Error("Missing settings model");
    await projectAction(reopened, "模型设置");
    await reopened.getByRole("button", { name: "设置助手" }).click();
    nextTool = {
      name: "admin_propose_changes",
      args: {
        value: {
          providerId: profile.id,
          expectedRevision: profile.revision,
          changes: [
            { field: "label", value: "双入口验收模型" },
            { field: "model", value: "未选模型" },
          ],
        },
      },
    };
    await reopened
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("检查已配置模型并调整名称。");
    await reopened.getByRole("button", { name: "发送", exact: true }).click();
    await expect(reopened.getByRole("heading", { name: "配置变更单" })).toBeVisible();
    expect(allowedTools).not.toContain("generate_media");
    expect(allowedTools).not.toContain("skill_read");
    await reopened.getByRole("checkbox", { name: /双入口验收模型/ }).check();
    await reopened.getByRole("button", { name: "应用所选" }).click();
    await expect(reopened.getByText("已应用 1 项，跳过 1 项")).toBeVisible();
    const current = await reopened.evaluate(async (id) => {
      const result = await window.desktop.settings.list({});
      if (!result.ok) throw new Error(result.code);
      return result.value.providers.find((entry) => entry.id === id);
    }, profile.id);
    expect(current?.model).toBe(profile.model);
    if (!current) throw new Error("Missing approved settings model");
    nextTool = {
      name: "admin_propose_changes",
      args: {
        value: {
          providerId: current.id,
          expectedRevision: current.revision,
          changes: [{ field: "label", value: "过期建议" }],
        },
      },
    };
    await reopened.getByRole("textbox", { name: "消息", exact: true }).fill("再提出名称变更。");
    await reopened.getByRole("button", { name: "发送", exact: true }).click();
    await expect(reopened.getByRole("heading", { name: "配置变更单" })).toBeVisible();
    await reopened.evaluate(
      async ({
        id,
        revision,
        pluginHash,
        endpoint,
        model,
        allowLocal,
        agentEnabled,
        agentVision,
        channel,
      }) => {
        const saved = await window.desktop.settings.save({
          id,
          expectedRevision: revision,
          pluginHash,
          approve: false,
          fields: {
            label: "人工保留的配置",
            endpoint,
            model,
            allowLocal,
            agentEnabled,
            agentVision,
            channel,
          },
        });
        if (!saved.ok) throw new Error(saved.code);
      },
      current,
    );
    await reopened.getByRole("checkbox", { name: /过期建议/ }).check();
    await reopened.getByRole("button", { name: "应用所选" }).click();
    await expect(
      reopened.getByRole("log").getByText("配置已更新，请重新载入后再保存。"),
    ).toBeVisible();
    await expect
      .poll(() =>
        reopened.evaluate(async (id) => {
          const result = await window.desktop.settings.list({});
          return result.ok && result.value.providers.find((entry) => entry.id === id)?.label;
        }, current.id),
      )
      .toBe("人工保留的配置");
    await reopened.getByRole("button", { name: "返回工作区" }).click();
    await expect(assistant.getByText("生成任务已返回", { exact: true })).toHaveCount(1);
    await expect(assistant.getByText("检查已配置模型并调整名称。", { exact: true })).toHaveCount(0);
  } finally {
    await application?.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
