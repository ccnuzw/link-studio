import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("上下文识别不覆盖手填值，媒体能力只在确认时应用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-model-limits-"));
  let finish: (() => void) | undefined;
  const requests: { url?: string; key?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, key: request.headers.authorization });
    const reply = () =>
      response.setHeader("content-type", "application/json").end(
        JSON.stringify({
          data: [
            {
              id: "gemini-2.5-pro",
              max_input_tokens: 320000,
              context_length: 70_000,
              top_provider: { max_completion_tokens: 40000 },
              max_tokens: 3000,
            },
          ],
        }),
      );
    if (requests.length === 1) finish = reply;
    else reply();
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("需要回环服务");
    const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    app = await electron.launch({
      ...(executablePath ? { executablePath } : { args: ["."] }),
      env,
    });
    const page = await app.firstWindow();
    const id = await page.evaluate(async (port) => {
      const api = window.desktop.settings;
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "context-fixture",
        fields: {
          name: "规格渠道",
          enabled: true,
          allowLocal: true,
          endpoint: `http://127.0.0.1:${port}/v1beta`,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      const model = await api.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        upstreamModel: "gemini-2.5-pro",
        enabled: false,
        settings: { api: "chat_completions" },
        config: { kind: "agent", name: "规格模型", sort: 1, description: "" },
      });
      if (!model.ok) throw Error(model.code);
      return model.value.id;
    }, address.port);
    await page.getByRole("button", { name: "应用设置" }).click();
    const open = () => page.getByRole("button", { name: "规格模型", exact: true }).click();
    await open();
    const dialog = page.getByRole("dialog", { name: "编辑模型" }),
      params = dialog.getByRole("tab", { name: "能力与参数" });
    const windowField = dialog.getByRole("spinbutton", { name: "上下文窗口" }),
      output = dialog.getByRole("spinbutton", { name: "最大输出" });
    const apply = dialog.getByRole("button", { name: "应用识别值" }),
      vision = dialog.getByRole("button", { name: "能看图", exact: true }),
      video = dialog.getByRole("button", { name: "看视频", exact: true });
    await params.click();
    await expect(dialog.getByText("正在识别上下文规格…")).toBeVisible();
    await expect.poll(() => requests.length).toBe(1);
    await windowField.fill("88000");
    finish!();
    await expect(dialog.getByText(/渠道上游返回：上下文 320,000 · 最大输出 40,000/)).toBeVisible();
    await expect(windowField).toHaveValue("88000");
    await expect(output).toHaveValue("0");
    await expect(vision).toHaveAttribute("aria-pressed", "false");
    await expect(video).toBeDisabled();
    await expect(dialog.getByText("OpenAI 兼容格式下「看视频」不会被应用")).toBeVisible();
    await apply.press("Enter");
    await expect(windowField).toHaveValue("320000");
    await expect(output).toHaveValue("40000");
    await expect(vision).toHaveAttribute("aria-pressed", "true");
    await expect(video).toHaveAttribute("aria-pressed", "false");
    await expect(apply).toHaveCount(0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "放弃未保存的修改？" })
      .getByRole("button", { name: /放弃修改/ })
      .click();
    await open();
    await params.click();
    await expect(windowField).toHaveValue("320000");
    await expect(output).toHaveValue("40000");
    await expect(vision).toHaveAttribute("aria-pressed", "false");
    await dialog.getByRole("tab", { name: "基本信息" }).click();
    await dialog.getByRole("combobox", { name: "接口格式" }).click();
    await dialog.getByRole("option", { name: "Gemini 原生" }).click();
    await params.click();
    await apply.press("Space");
    await expect(video).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "保存模型" }).click();
    await expect(dialog).toBeHidden();
    await open();
    await dialog.getByRole("button", { name: "配置 JSON" }).click();
    const raw = JSON.parse(await dialog.getByRole("textbox", { name: "配置 JSON" }).inputValue());
    expect(raw).toMatchObject({
      key: id,
      capabilities: { vision: true, video: true, context: { window: 320000, output: 40000 } },
    });
    expect(
      requests.every(
        (request) => request.url === "/v1beta/models" && request.key === "Bearer context-fixture",
      ),
    ).toBe(true);
  } finally {
    await app?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
