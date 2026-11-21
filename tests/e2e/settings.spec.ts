import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { expectAssistantContrast, expectAssistantPicker } from "./assistant-theme";

async function seedAssistantModel(
  page: Page,
  options: { endpoint: string; label: string; model: string; api: string; secret: string },
) {
  return page.evaluate(async ({ endpoint, label, model, api, secret }) => {
    const settings = window.desktop.settings;
    const list = await settings.list({});
    const plugin = list.ok ? list.value.plugins.find(({ key }) => key === "openai") : undefined;
    if (!plugin) throw new Error("Missing OpenAI adapter");
    const saved = await settings.save({
      expectedRevision: 0,
      pluginHash: plugin.hash,
      approve: true,
      secret,
      fields: { label, model, endpoint, allowLocal: true, agentEnabled: true, channel: { api } },
    });
    if (!saved.ok) throw new Error(saved.code);
    return saved.value;
  }, options);
}

test("设置助手审批、试跑与重启恢复", async () => {
  test.setTimeout(50_000);
  const directory = await mkdtemp(join(tmpdir(), "link-studio-settings-e2e-"));
  const credential = "fixture-settings-credential";
  let propose: object | undefined;
  let action: { name: string; args: object } | undefined;
  let streaming = 0;
  let trials = 0;
  let authenticated = true;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    authenticated &&= request.headers.authorization === `Bearer ${credential}`;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (!body.stream) {
      trials++;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
      return;
    }
    streaming++;
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (propose || action) {
      const call = action ?? { name: "admin_propose_changes", args: { value: propose } };
      action = undefined;
      propose = undefined;
      response.write(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "fixture-change",
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }),
      );
      response.end(`${chunk({}, "tool_calls")}data: [DONE]\n\n`);
      return;
    }
    response.write(chunk({ role: "assistant", content: "设置检查" }));
    setTimeout(
      () => response.end(`${chunk({ content: "完成" })}${chunk({}, "stop")}data: [DONE]\n\n`),
      500,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const launch = () =>
    electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ["."] }), env });
  try {
    const first = await launch();
    try {
      const page = await first.firstWindow();
      const profile = await seedAssistantModel(page, {
        endpoint: `http://127.0.0.1:${address.port}`,
        label: "本地验收模型",
        model: "fixture-model",
        api: "chat_completions",
        secret: credential,
      });
      await page.getByRole("button", { name: "模型设置" }).click();
      expect(profile?.hasSecret).toBe(true);
      expect(JSON.stringify(profile)).not.toContain(credential);
      propose = {
        providerId: profile?.id,
        expectedRevision: profile?.revision,
        changes: [
          { field: "label", value: "通过审批的新名称" },
          { field: "model", value: "跳过的模型" },
        ],
      };
      await page.getByRole("button", { name: "设置助手" }).click();
      const assistant = page.getByRole("complementary", { name: "小灵设置助手" });
      await expect(assistant.getByRole("combobox", { name: "对话模型" })).toHaveText(
        "fixture-model · 本地验收模型",
      );
      const composer = assistant.getByRole("textbox", { name: "消息", exact: true });
      const session = assistant.getByRole("combobox", { name: "会话" });
      await expect(session).toBeEnabled();
      await expectAssistantPicker(session);
      await expectAssistantContrast(session.locator("option:disabled"));
      await expectAssistantContrast(composer, "::placeholder");
      const send = assistant.getByRole("button", { name: "发送", exact: true });
      await expect(send).toBeDisabled();
      await expectAssistantContrast(send);
      await composer.fill("请提出名称和模型变更。");
      await expectAssistantContrast(send);
      await composer.press("Shift+Enter");
      await expect(composer).toHaveValue("请提出名称和模型变更。\n");
      await composer.press("Enter");
      await expect(page.getByRole("heading", { name: "配置变更单" })).toBeVisible({
        timeout: 15000,
      });
      await expectAssistantContrast(assistant.getByRole("heading", { name: "配置变更单" }));
      await expectAssistantContrast(assistant.getByText(/基线修订/));
      await expectAssistantContrast(
        assistant.getByRole("log").getByText("请提出名称和模型变更。", { exact: true }),
      );
      await page.getByRole("checkbox", { name: /通过审批的新名称/ }).check();
      await page.getByRole("button", { name: "应用所选" }).click();
      await expect(page.getByText("已应用 1 项，跳过 1 项")).toBeVisible();
      const latest = await page.evaluate(async () => {
        const result = await window.desktop.settings.list({});
        return result.ok ? result.value.providers[0] : undefined;
      });
      expect(latest).toMatchObject({ label: "通过审批的新名称", model: "fixture-model" });
      action = {
        name: "admin_test_run",
        args: { id: latest?.id, expectedRevision: latest?.revision },
      };
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("请申请试跑。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toBeVisible();
      expect(trials).toBe(0);
    } finally {
      await first.close();
    }
    const reopened = await launch();
    try {
      const page = await reopened.firstWindow();
      await page.getByRole("button", { name: "模型设置" }).click();
      await page.getByRole("button", { name: "设置助手" }).click();
      await expect(
        page.getByRole("log").getByText("请提出名称和模型变更。", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toBeVisible();
      const assistant = page.getByRole("complementary", { name: "小灵设置助手" });
      const composer = assistant.getByRole("textbox", { name: "消息", exact: true });
      await expect(assistant.getByRole("status")).toHaveText("等待你的审批");
      await composer.fill("记下这条插话。");
      await assistant.getByRole("button", { name: "新对话" }).click();
      await expect(composer).toHaveValue("");
      await expect(assistant.getByRole("status")).toHaveText("另一个会话正在运行");
      await composer.fill("这个会话的独立草稿");
      await expect(assistant.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
      await assistant.getByRole("button", { name: "返回运行中的会话" }).click();
      await expect(composer).toHaveValue("记下这条插话。");
      await page.getByRole("button", { name: "插话", exact: true }).click();
      await expect(page.getByText("记下这条插话。", { exact: true })).toBeVisible();
      expect(trials).toBe(0);
      await page.getByRole("button", { name: "同意试跑" }).click();
      await expect(page.getByText("助手试跑成功", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      const latest = await page.evaluate(async () => {
        const result = await window.desktop.settings.list({});
        return result.ok ? result.value.providers[0] : undefined;
      });
      action = {
        name: "admin_request_secret",
        args: { id: latest?.id, expectedRevision: latest?.revision },
      };
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("请申请更新凭证。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page.getByLabel("新凭证（不会发送给小灵）").fill(credential);
      await page.getByRole("button", { name: "保存凭证", exact: true }).click();
      await expect(page.getByRole("log").getByText("凭证已保存", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      action = {
        name: "admin_test_run",
        args: { id: latest?.id, expectedRevision: (latest?.revision ?? 0) + 1 },
      };
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("再申请一次。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toBeVisible();
      await page.getByRole("button", { name: "停止", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toHaveCount(0);
      await expect(page.getByText("已停止", { exact: true })).toBeVisible();
    } finally {
      await reopened.close();
    }
    expect(authenticated).toBe(true);
    expect(trials).toBe(1);
    expect(streaming).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(requests)).not.toContain(credential);
    const sqlite = await readFile(join(directory, "settings", "settings.sqlite"));
    expect(sqlite.includes(Buffer.from(credential))).toBe(false);
    const agentHistory = await readFile(join(directory, "settings", "agent.sqlite"));
    expect(agentHistory.includes(Buffer.from(credential))).toBe(false);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Responses 配置、无工具探测和设置小灵的只读工具调用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-responses-e2e-"));
  const calls: { path?: string; body: Record<string, unknown> }[] = [];
  let finishReply = () => {};
  const replyGate = new Promise<void>((resolve) => {
    finishReply = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ path: request.url, body });
    const frame = (type: string, fields: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
    const reply = (item: object, delta: string, deltaType: string) =>
      frame("response.output_item.added", { output_index: 0, item }) +
      frame(deltaType, { output_index: 0, content_index: 0, delta }) +
      frame("response.output_item.done", { output_index: 0, item }) +
      frame("response.completed", { response: { status: "completed", output: [item] } });
    const text = Array.isArray(body.tools) && body.tools.length ? "Responses 工具检查完成" : "OK";
    const content = [{ type: "output_text", text }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (text !== "OK" && !JSON.stringify(body.input).includes("function_call_output")) {
      response.end(
        reply(
          {
            type: "function_call",
            id: "fc_query",
            call_id: "call_query",
            name: "admin_query",
            arguments: "{}",
          },
          "",
          "response.function_call_arguments.delta",
        ),
      );
    } else {
      if (text !== "OK") {
        response.flushHeaders();
        await replyGate;
      }
      response.end(
        reply({ type: "message", id: "msg_reply", content }, text, "response.output_text.delta"),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  try {
    const app = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env,
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1024, 700),
      );
      const profile = await seedAssistantModel(page, {
        endpoint: `http://127.0.0.1:${address.port}`,
        label: "Responses 模型",
        model: "fixture-responses",
        api: "responses",
        secret: "fixture-responses-credential",
      });
      const probe = await page.evaluate(
        ({ id, revision }) =>
          window.desktop.settings.agentTestConnection({ id, expectedRevision: revision }),
        profile,
      );
      expect(probe.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.path).toBe("/v1/responses");
      expect(calls[0]?.body).toMatchObject({
        model: "fixture-responses",
        store: false,
        stream: true,
        max_output_tokens: 64,
      });
      expect(calls[0]?.body.tools ?? []).toEqual([]);
      await page.getByRole("button", { name: "模型设置" }).click();
      await page.getByRole("button", { name: "设置助手" }).click();
      const composer = page.getByRole("textbox", { name: "消息", exact: true });
      await expect(
        page.getByRole("complementary", { name: "小灵设置助手" }).getByRole("status"),
      ).toHaveText("就绪");
      const longDraft = `查看当前配置。\n${"需要核对的配置项\n".repeat(80)}待确认`;
      await composer.fill(longDraft);
      await composer.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      await composer.press("Shift+Enter");
      await expect(composer).toHaveValue(`${longDraft}\n`);
      expect(calls).toHaveLength(1);
      await composer.press("Enter");
      const log = page.getByRole("log", { name: "对话与活动" });
      await expect(log.getByText(/待确认/)).toBeVisible();
      await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBeGreaterThan(30);
      await log.focus();
      await log.press("Home");
      const latest = page.getByRole("button", { name: "回到最新" });
      await expect(latest).toBeVisible();
      finishReply();
      await expect(page.getByText("Responses 工具检查完成", { exact: true })).toBeVisible({
        timeout: 15000,
      });
      expect(await log.evaluate((element) => element.scrollTop)).toBeLessThan(32);
      await latest.click();
      await expect(latest).toHaveCount(0);
      expect(
        await log.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      ).toBeLessThan(4);
      expect(
        calls.some(({ body }) => JSON.stringify(body.input).includes("function_call_output")),
      ).toBe(true);
    } finally {
      finishReply();
      await app.close();
    }
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
