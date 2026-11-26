import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { readRenderedText } from "../../scripts/read-rendered-text.mjs";
import { addDramaSegment, dramaDocument } from "../../src/main/project/drama";
import { ProjectStore } from "../../src/main/project/store";
import { quoteVideoModel } from "../fixtures/agent-quote";
import { requireTestValue } from "../require-test-value";
import {
  chooseAssistantModel,
  expectAssistantContrast,
  expectDraft,
  expectReadableModelHover,
} from "./assistant-theme";
import { compactViewport, desktopElectron as electron } from "./desktop-window";
import {
  confirmDramaScript,
  createCanvasProject,
  createDramaProject,
  projectAction,
} from "./workspace-actions";

async function seedLegacyClips(root: string, clips: Array<[number, string]>) {
  const projects = (await readdir(root)).filter((entry) => entry.endsWith(".linkstudio"));
  expect(projects).toHaveLength(1);
  const store = await ProjectStore.open(join(root, requireTestValue(projects[0])));
  try {
    for (const [episode_no, prompt] of clips)
      await addDramaSegment(store, {
        episode_no,
        prompt,
        seconds: 5,
        revision: requireTestValue(dramaDocument(store.snapshot)).revision,
      });
  } finally {
    await store.close();
  }
}

async function pickEpisode(page: Page, no: number) {
  if (
    (await page.getByRole("tab", { name: "总览", exact: true }).getAttribute("aria-selected")) ===
    "true"
  )
    await stage(page, "剧本");
  const rail = page.getByRole("navigation", { name: "分集" }),
    rows = rail.locator(".episode-rows");
  await rows.evaluate((element, no) => {
    element.scrollTop = (no - 1) * 56;
  }, no);
  await rail.getByRole("button", { name: new RegExp(`^第 ${no} 集 ·`) }).click();
}
const stage = (page: Page, name: string) =>
  page.getByRole("tablist", { name: "制作工序" }).getByRole("tab", { name, exact: true }).click();

async function expectDraftSegment(panel: Locator, prompt: string, seconds: number) {
  const segment = panel.getByRole("listitem").filter({ hasText: prompt });
  await expect(segment.getByText(prompt, { exact: true })).toBeVisible();
  await expect(segment.getByText(`${seconds}s`, { exact: true })).toBeVisible();
}

async function checkEmptyHistory(assistant: Locator) {
  const history = assistant.getByRole("button", { name: /^历史会话，当前/ });
  await assistant.getByRole("button", { name: "新对话", exact: true }).click();
  await history.click();
  const empty = assistant.getByText("还没有会话", { exact: true });
  await expect(empty).toBeVisible();
  await history.press("Escape");
  await expect(empty).toBeHidden();
  await expect(assistant).toBeVisible();
}

async function checkSavedHistory(assistant: Locator, title: string) {
  const history = assistant.getByRole("button", { name: /^历史会话，当前/ });
  const create = assistant.getByRole("button", { name: "新对话", exact: true });
  await expect(create).toBeEnabled();
  await history.dblclick();
  const input = assistant.getByRole("textbox", { name: "会话标题" });
  await input.fill(title);
  await input.press("Enter");
  await expect(history).toHaveAccessibleName(`历史会话，当前：${title}`);
  await create.click();
  await expect(history).toHaveAccessibleName("历史会话，当前：新对话");
  await history.click();
  await expect(assistant.locator(".assistant-history-row")).toHaveCount(1);
  await expect(assistant.locator(".assistant-history-row [aria-current=true]")).toHaveCount(0);
  await assistant.getByRole("button", { name: title, exact: true }).click();
  await expect(history).toHaveAccessibleName(`历史会话，当前：${title}`);
}

async function deleteSavedHistory(assistant: Locator, title: string) {
  const history = assistant.getByRole("button", { name: /^历史会话，当前/ });
  await history.click();
  await assistant.getByRole("button", { name: `删除「${title}」`, exact: true }).click();
  await assistant.getByRole("button", { name: `确认删除「${title}」`, exact: true }).click();
  await expect(history).toHaveAccessibleName("历史会话，当前：新对话");
  await history.click();
  await expect(assistant.getByText("还没有会话", { exact: true })).toBeVisible();
  await history.press("Escape");
}

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

test("短剧：已建项目无可用模型时不显示输入框，重新启用后起步建议只填草稿", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-drama-model-state-"));
  const toolResults: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const result = body.messages.findLast((message: { role: string }) => message.role === "tool");
    if (result) toolResults.push(result.content);
    const read =
      !result &&
      body.tools?.some(
        (tool: { function: { name: string } }) => tool.function.name === "drama_read",
      );
    const delta = read
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read_last",
              type: "function",
              function: {
                name: "drama_read",
                arguments: JSON.stringify({ scope: "episode", episode_no: 202 }),
              },
            },
          ],
        }
      : { role: "assistant", content: "已核对尾声" };
    const frame = (part: object, finish: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`;
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(`${frame(delta, null) + frame({}, read ? "tool_calls" : "stop")}data: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("缺少回环端口");
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: root,
    LINK_STUDIO_TEST_PROJECT_PARENT: root,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [process.env.LINK_STUDIO_E2E_APP ?? "."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await createDramaProject(page, "停用后重开");
    await page.getByRole("button", { name: "粘贴正文" }).click();
    const script = Array.from(
      { length: 201 },
      (_, index) => `第${index + 1}集 来客\n${"有人敲门。".repeat(32)}`,
    ).join("\n");
    await page.getByLabel("粘贴正文").fill(script);
    await page.getByRole("button", { name: "开始", exact: true }).click();
    const initialSetup = page.getByRole("dialog", { name: "开拍设置" });
    await expect(initialSetup).toBeVisible();
    await expect(initialSetup.getByRole("alert")).toContainText("Agent 模型");
    await expect(initialSetup.getByRole("button", { name: "开始", exact: true })).toBeDisabled();
    await initialSetup.getByRole("button", { name: "取消" }).click();
    await expect(page.getByLabel("粘贴正文")).toHaveValue(script);
    const model = await page.evaluate(async (endpoint) => {
      const channel = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture",
        fields: {
          name: "本地助手",
          endpoint,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      const model = await window.desktop.settings.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        enabled: true,
        upstreamModel: "offline",
        settings: { api: "chat_completions" },
        config: {
          name: "空状态测试",
          kind: "agent",
          description: "",
          sort: 1,
          promptLimit: 24000,
          contextWindow: 32768,
          maxOutputTokens: 2048,
          pricing: { unit: "token", input: 1, output: 1 },
        },
      });
      if (!model.ok) throw Error(model.code);
      return model.value;
    }, `http://127.0.0.1:${address.port}`);
    const send = page.getByRole("button", { name: "开始", exact: true }),
      setup = page.getByRole("dialog", { name: "开拍设置" });
    await send.click();
    await expect(setup).toContainText("剧本一次切完 · 201 集");
    const drafts = new DatabaseSync(join(root, "projects", "drama-drafts.sqlite"));
    try {
      const tokens = () =>
        drafts
          .prepare("SELECT token FROM drafts ORDER BY token")
          .all()
          .map((row) => row.token);
      const initial = tokens();
      expect(initial).toHaveLength(1);
      await setup.getByRole("button", { name: "取消" }).click();
      await send.click();
      await expect(setup).toBeVisible();
      expect(tokens()).toEqual(initial);
      drafts.prepare("UPDATE drafts SET expires=?").run(Date.now() - 1);
      await setup.getByRole("button", { name: "开始" }).click();
      await expect(setup).not.toBeVisible();
      await expect(page.getByRole("alert")).toHaveText("文件已过期，请重新上传");
      await expect(page.getByLabel("粘贴正文")).toHaveValue(script);
      await send.click();
      await expect(setup).toBeVisible();
      expect(tokens()).toHaveLength(1);
      expect(tokens()).not.toEqual(initial);
      await confirmDramaScript(page);
      await setup.getByRole("button", { name: "开始" }).click();
      await expect(setup).not.toBeVisible();
      expect(tokens()).toEqual([]);
    } finally {
      drafts.close();
    }
    const panel = page.getByRole("complementary", { name: "短剧小灵" }),
      starter = panel.getByRole("button", { name: "把第 1 集的结尾改得更有悬念" });
    await pickEpisode(page, 201);
    await expect(
      page.getByRole("heading", { name: "第 201 集 · 第201集 来客", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "新增一集", exact: true }).click();
    const newEpisode = page.getByRole("button", { name: "第 202 集 · 新的一集", exact: true });
    await expect(newEpisode).toHaveAttribute("aria-current", "true");
    await expect(page.getByLabel("分集剧本", { exact: true })).toBeEmpty();
    const rail = page.getByRole("navigation", { name: "分集" });
    expect(await rail.getByRole("button").count()).toBeLessThan(45);
    await expect(page.getByRole("region", { name: "当前分集" })).toHaveCount(1);
    const body = page.getByLabel("分集剧本", { exact: true });
    await body.fill("尾声：灯亮了。");
    await body.press("ControlOrMeta+a");
    await page
      .getByRole("toolbar", { name: "文本格式" })
      .getByRole("button", { name: "加粗", exact: true })
      .click();
    await expect(body.locator("strong")).toHaveText("尾声：灯亮了。");
    await pickEpisode(page, 201);
    await pickEpisode(page, 202);
    await expect(body.locator("strong")).toHaveText("尾声：灯亮了。");
    const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 390, height: 844 });
    await rail.getByRole("button", { name: "人物", exact: true }).click();
    await expect(page.getByRole("heading", { name: "人物传记", exact: true })).toBeVisible();
    await rail.getByRole("button", { name: "第202集", exact: true }).click();
    await expect(body.locator("strong")).toHaveText("尾声：灯亮了。");
    await page.setViewportSize(original);
    await expect(page.locator(".drama-columns > article")).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .locator(".drama-columns")
          .evaluate((columns) => getComputedStyle(columns).gridTemplateColumns.split(" ").length),
      )
      .toBe(1);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await expect(page.getByRole("button", { name: "应用设置", exact: true })).toBeVisible();
    await projectAction(page, "模型设置");
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: /^返回/ })
      .click();
    await page.getByRole("button", { name: /^停用后重开/ }).click();
    await page.getByRole("button", { name: "小灵", exact: true }).click();
    await expect(starter).toBeVisible();
    let expectedRevision = model.revision;
    for (const enabled of [false, true]) {
      await page.getByRole("button", { name: "返回首页", exact: true }).click();
      expectedRevision = await page.evaluate(
        async (input) => {
          const result = await window.desktop.settings.modelToggle(input);
          if (!result.ok) throw Error(result.code);
          return result.value.revision;
        },
        { id: model.id, expectedRevision, enabled },
      );
      await page.getByRole("button", { name: /^停用后重开/ }).click();
      await page.getByRole("button", { name: "小灵", exact: true }).click();
      await pickEpisode(page, 202);
      await expect(page.getByRole("heading", { name: "第 202 集 · 新的一集" })).toBeVisible();
      if (!enabled) {
        await expect(panel.getByText("暂时没有可用的 Agent 模型", { exact: true })).toBeVisible();
        await expect(panel.getByText("请联系管理员发布 Agent 模型后再来。")).toBeVisible();
        await expect(panel.getByRole("textbox")).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "收起小灵" })).toBeVisible();
      } else {
        const ring = panel.getByRole("button", { name: "上下文用量 0 / 33K" });
        await ring.press("Enter");
        await expect(panel.getByText("快满时会自动压缩较早的对话，不影响继续使用")).toBeVisible();
        await ring.press("Escape");
        await starter.click();
        await expect(panel.getByRole("textbox", { name: "短剧消息" })).toBeFocused();
        await expectDraft(
          panel.getByRole("textbox", { name: "短剧消息" }),
          "把第 1 集的结尾改得更有悬念",
        );
        await panel.getByRole("button", { name: /^历史会话，当前/ }).click();
        await expect(panel.getByText("还没有会话")).toBeVisible();
        await page.keyboard.press("Escape");
        await panel.getByLabel("短剧消息").fill("核对第 202 集的剧本");
        await panel.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => toolResults.length).toBe(1);
        expect(JSON.parse(requireTestValue(toolResults[0]))).toMatchObject({
          no: 202,
          title: "新的一集",
          script_md: "**尾声：灯亮了。**",
        });
        expect(toolResults[0]).not.toContain("有人敲门。");
        await expect(
          panel
            .getByRole("log", { name: "短剧对话与活动" })
            .getByText("已核对尾声", { exact: true }),
        ).toBeVisible();
      }
    }
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("短剧：五百万码点 DOCX 建剧，仅规划首章，关闭重开后原文仍在项目内", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "link-novel-limit-"));
  const prefix = "第一章 夜雨\n门外来了信。\n第二章 长路\n",
    body = "🌙".repeat(5_000_000 - Array.from(prefix).length),
    text = prefix + body;
  const digest = createHash("sha256").update(text).digest("hex");
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const content = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    const prompt =
      typeof content === "string"
        ? content
        : content.map((part: { text?: string }) => part.text ?? "").join("\n");
    const vars = JSON.parse(prompt.split("```json\n")[1].split("\n```")[0]);
    const output = vars.batch_from
      ? JSON.stringify({
          episodes: [
            {
              title: "雨夜来信",
              synopsis: "门外来信",
              hook: "谁写的",
              cliffhanger: "信封未拆",
              unit_from: 1,
              unit_to: 1,
            },
          ],
        })
      : vars.next_episode_no
        ? "门外来了一封信。"
        : JSON.stringify({
            summary: "夜里来信",
            characters_md: "信使",
            outline_md: "一封信",
            source_kind: "novel",
          });
    calls.push(vars.batch_from ? "format" : vars.source);
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("缺少回环端口");
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: root,
    LINK_STUDIO_TEST_PROJECT_PARENT: root,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [process.env.LINK_STUDIO_E2E_APP ?? "."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async (endpoint) => {
      const channel = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture",
        fields: { name: "长稿", endpoint, allowLocal: true, enabled: true, sort: 1, headers: [] },
      });
      if (!channel.ok) throw Error(channel.code);
      for (const [index, contextWindow] of [32768, 131072].entries()) {
        const model = await window.desktop.settings.modelSave({
          expectedRevision: 0,
          channelId: channel.value.id,
          channelRevision: channel.value.revision,
          enabled: true,
          upstreamModel: `novel-${index}`,
          settings: { api: "chat_completions" },
          config: {
            name: index ? "长上下文研读" : "小说改编",
            kind: "agent",
            description: "",
            sort: index + 1,
            promptLimit: contextWindow - 2048,
            contextWindow,
            maxOutputTokens: 2048,
            pricing: { unit: "token", input: 1, output: 1 },
          },
        });
        if (!model.ok) throw Error(model.code);
      }
    }, `http://127.0.0.1:${address.port}`);
    await createDramaProject(page, "五百万字项目");
    const upload = page.locator('input[type="file"][aria-label="剧本文件"]'),
      start = page.getByRole("button", { name: "开始", exact: true });
    for (const extra of ["尾", ""]) {
      const paragraphs = (text + extra)
        .split("\n")
        .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
        .join("");
      const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
      await upload.setInputFiles({
        name: "长篇.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: Buffer.from(zipSync({ "word/document.xml": strToU8(xml) })),
      });
      await start.click();
      if (extra) await expect(page.getByRole("alert")).toContainText("原文超过 500 万字");
    }
    const setup = page.getByRole("dialog", { name: "开拍设置" });
    await expect(setup).toContainText("500 万字", { timeout: 30000 });
    await setup.getByRole("button", { name: "规划范围" }).click();
    const range = setup.getByRole("spinbutton", { name: "规划到第几章" });
    await range.fill("1");
    await range.press("Enter");
    await setup.getByRole("button", { name: "开始", exact: true }).click();
    await pickEpisode(page, 1);
    await expect(
      page.getByRole("heading", { name: "第 1 集 · 雨夜来信", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "继续规划", exact: true })).toBeVisible();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("🌙");
    expect(calls[1]).toContain("门外来了信。");
    expect(calls[1]).not.toContain("🌙");
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    const project = requireTestValue(
      (await readdir(root)).find((name) => name.endsWith(".linkstudio")),
    );
    expect(
      createHash("sha256")
        .update(await readFile(join(root, project, "assets", `drama-${digest}.txt`)))
        .digest("hex"),
    ).toBe(digest);
    await page.getByRole("button", { name: /^五百万字项目/ }).click();
    await pickEpisode(page, 1);
    await expect(
      page.getByRole("heading", { name: "第 1 集 · 雨夜来信", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "继续规划", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "继续规划" })).toContainText(/约 [\d,]+ 积分/);
    expect(calls).toHaveLength(3);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("短剧：四批规划 204 集，选取末尾四集生成并重开", async () => {
  test.setTimeout(100_000);
  const root = await mkdtemp(join(tmpdir(), "link-many-episodes-")),
    generated: number[] = [],
    batches: number[] = [];
  let release!: () => void, finish!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    second = new Promise<void>((resolve) => {
      finish = resolve;
    });
  let finishReading!: () => void;
  const reading = new Promise<void>((resolve) => {
    finishReading = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const content = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    const prompt =
      typeof content === "string"
        ? content
        : content.map((part: { text?: string }) => part.text ?? "").join("\n");
    const vars = JSON.parse(prompt.split("```json\n")[1].split("\n```")[0]);
    let output: string;
    if (vars.episode) {
      generated.push(vars.episode.no);
      if (vars.episode.no === 201) await gate;
      if (vars.episode.no === 202) await second;
      output = `为第${vars.episode.no}集写好的剧本。`;
    } else if (vars.batch_from) {
      const first = batches.length * 51 + 1;
      batches.push(vars.batch_from);
      output = JSON.stringify({
        episodes: Array.from({ length: 51 }, (_, index) => {
          const unit =
            vars.batch_from + Math.floor((index * (vars.batch_to - vars.batch_from + 1)) / 51);
          return {
            title: `长路${first + index}`,
            synopsis: "门外来信",
            hook: "谁写的",
            cliffhanger: "信封未拆",
            unit_from: unit,
            unit_to: unit,
          };
        }),
      });
    } else if (vars.next_episode_no) output = "长路上依次收到来信。";
    else {
      await reading;
      output = JSON.stringify({
        summary: "长路来信",
        characters_md: "信使",
        outline_md: "去远方",
        source_kind: "novel",
      });
    }
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("缺少回环端口");
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: root,
    LINK_STUDIO_TEST_PROJECT_PARENT: root,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [process.env.LINK_STUDIO_E2E_APP ?? "."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async (endpoint) => {
      const channel = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture",
        fields: {
          name: "长剧改编",
          endpoint,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      const model = await window.desktop.settings.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        enabled: true,
        upstreamModel: "long-series",
        settings: { api: "chat_completions" },
        config: {
          name: "长剧改编",
          kind: "agent",
          description: "",
          sort: 1,
          promptLimit: 24000,
          contextWindow: 32768,
          maxOutputTokens: 2048,
          pricing: { unit: "token", input: 1, output: 1 },
        },
      });
      if (!model.ok) throw Error(model.code);
    }, `http://127.0.0.1:${address.port}`);
    await createDramaProject(page, "长剧改编");
    await page.getByRole("button", { name: "粘贴正文" }).click();
    await page
      .getByLabel("粘贴正文")
      .fill(
        Array.from({ length: 48 }, (_, index) => `第${index + 1}章\n长路上的来信。`).join("\n"),
      );
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await page
      .getByRole("dialog", { name: "开拍设置" })
      .getByRole("button", { name: "开始", exact: true })
      .click();
    await stage(page, "片场");
    const emptyStudio = page.getByRole("region", { name: "片场引导" });
    await expect(emptyStudio.getByRole("heading")).toHaveText("还没有分集");
    await expect(emptyStudio.getByRole("button")).toHaveCount(0);
    await stage(page, "剧本");
    finishReading();
    const pill = page.locator(".drama-script-next");
    await expect(pill).toContainText("204 集还没有剧本", { timeout: 30000 });
    await expect(page.getByRole("region", { name: "小说规划" })).toBeHidden();
    expect(batches).toEqual([1, 13, 25, 37]);
    await expect(pill).toContainText(/前 200 集 约 \d+ 积分/);
    await pill.getByRole("button", { name: "生成分集剧本", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "生成分集剧本" });
    await expect(picker.getByText("已选 200 集")).toBeVisible();
    const grid = picker.locator('[data-slot="episode-grid"]');
    expect(await grid.getByRole("button").count()).toBeLessThan(60);
    await grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(grid.getByRole("button", { name: /204\.\s*长路204/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await picker.getByLabel("结束集").fill("204");
    await picker.getByRole("button", { name: "选中", exact: true }).click();
    await expect(picker.getByText("已选 204 集")).toBeVisible();
    await expect(picker.getByRole("button", { name: "一次最多 200 集" })).toBeDisabled();
    await expect(picker.locator(".script-estimate small")).toBeEmpty();
    await picker.getByRole("button", { name: "全选", exact: true }).click();
    await expect(picker.getByText("已选 200 集")).toBeVisible();
    await expect(grid.getByRole("button", { name: /204\.\s*长路204/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await picker.getByLabel("起始集").fill("5");
    await picker.getByLabel("结束集").fill("204");
    await picker.getByRole("button", { name: "选中", exact: true }).click();
    await expect(picker.getByRole("button", { name: "生成 200 集剧本" })).toBeEnabled();
    expect(generated).toEqual([]);
    await picker.getByLabel("起始集").fill("201");
    await picker.getByRole("button", { name: "选中", exact: true }).click();
    await picker.getByRole("button", { name: "生成 4 集剧本" }).click();
    await expect.poll(() => generated.length).toBe(1);
    const rail = page.getByRole("navigation", { name: "分集" }),
      confirm = page.getByRole("alertdialog");
    await rail
      .getByRole("button", { name: "第 1 集 · 长路1", exact: true })
      .click({ button: "right" });
    const disabledDelete = page.getByRole("menuitem", { name: "删除" });
    await expect(disabledDelete).toBeDisabled();
    await expect(disabledDelete).toHaveAttribute("title", "有进行中的任务：分集剧本 · 4 集");
    await page.keyboard.press("Escape");
    await pickEpisode(page, 204);
    const rings = rail.locator(".episode-progress");
    await expect(rings).toHaveCount(4);
    await expect(page.getByText("这一集正在排队", { exact: true })).toBeVisible();
    await pickEpisode(page, 201);
    await expect(page.getByText("正在生成这一集的剧本…", { exact: true })).toBeVisible();
    release();
    await expect.poll(() => generated.length).toBe(2);
    await expect(
      rail.getByRole("button", { name: "第 201 集 · 长路201" }).locator(".episode-pips i").first(),
    ).toHaveAttribute("data-state", "on");
    await pickEpisode(page, 202);
    await expect(page.getByText("正在生成这一集的剧本…", { exact: true })).toBeVisible();
    finish();
    await expect(rings).toHaveCount(0);
    await pickEpisode(page, 204);
    await expect(page.getByText("为第204集写好的剧本。", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    expect(generated).toEqual([201, 202, 203, 204]);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await page.getByRole("button", { name: /^长剧改编/ }).click();
    await pickEpisode(page, 204);
    await expect(page.getByText("为第204集写好的剧本。", { exact: true })).toBeVisible();
    await pickEpisode(page, 200);
    await expect(page.getByText("这一集还没有剧本")).toBeVisible();
    await pickEpisode(page, 201);
    await stage(page, "片场");
    await expect(page.getByRole("button", { name: "去拆解" })).toBeVisible();
    await expect(page.getByLabel("片段提示词")).toHaveCount(0);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await seedLegacyClips(root, [[201, "长路201的片段"]]);
    await page.getByRole("button", { name: /^长剧改编/ }).click();
    await pickEpisode(page, 201);
    await stage(page, "片场");
    await expectDraftSegment(
      page.getByRole("region", { name: "分镜片段编辑" }),
      "长路201的片段",
      5,
    );
    await stage(page, "剧本");
    await pickEpisode(page, 204);
    await rail
      .getByRole("button", { name: "第 201 集 · 长路201", exact: true })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await expect(confirm).toHaveAccessibleName("删除第 201 集「长路201」？");
    await expect(confirm).toContainText("它的 1 个片段也会删除，已生成的视频仍保留在素材里。");
    await expect(confirm).toContainText("第 202–204 集会依次变成第 201–203 集。");
    await confirm.getByRole("button", { name: "取消" }).click();
    await expect(rail.getByRole("button", { name: "第 204 集 · 长路204" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await rail
      .getByRole("button", { name: "第 201 集 · 长路201", exact: true })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await confirm.getByRole("button", { name: "删除", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(rail.getByRole("button", { name: "第 203 集 · 长路204" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(page.getByLabel("分集剧本", { exact: true })).toHaveText("为第204集写好的剧本。");
    await rail.getByRole("button", { name: "第 203 集 · 长路204" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await confirm.getByRole("button", { name: "删除", exact: true }).click();
    await expect(rail.getByRole("button", { name: "第 202 集 · 长路203" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await page.getByLabel("分集剧本", { exact: true }).fill("补位后只改长路203。");
    await pickEpisode(page, 201);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await page.getByRole("button", { name: /^长剧改编/ }).click();
    await pickEpisode(page, 202);
    await expect(page.getByLabel("分集剧本", { exact: true })).toHaveText("补位后只改长路203。");
  } finally {
    finishReading();
    release();
    finish();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("短剧：小说选区开拍，第二批请求中关闭项目并从第十三章恢复", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "link-novel-checkpoint-"));
  const requests: string[] = [];
  const lastBatchInputs: object[] = [];
  const planningPrompts: string[] = [],
    formatPrompts: string[] = [];
  const kindPrompts: string[] = [];
  const scriptRequests: { prompt: string; source: string; previous_ending: string }[] = [];
  let proposed = false;
  let invalidFormats = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.tools?.length) {
      const tool = !proposed;
      proposed = true;
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                id: "write_scripts",
                index: 0,
                type: "function",
                function: {
                  name: "drama_run_job",
                  arguments: JSON.stringify({
                    step: "scripts",
                    episodes: [2, 1],
                    reason: "拍摄两集夜雨来信",
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "两集任务已提交" };
      const frame = (value: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(`${frame(delta, null) + frame({}, tool ? "tool_calls" : "stop")}data: [DONE]\n\n`);
      return;
    }
    const content = body.messages.at(-1).content;
    const prompt =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part: { text?: string }) => part.text ?? "").join("\n")
          : "";
    if (prompt.startsWith("你是影视编剧助理。判断下面的原文片段")) {
      kindPrompts.push(prompt);
      const content =
        kindPrompts.length === 1
          ? "无法判断"
          : '```json\n{"kind":"novel","reason":"以雨夜的心理描写为主"}\n```';
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      return;
    }
    if (!prompt.includes("```json\n")) {
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "夜雨来信" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      return;
    }
    const vars = JSON.parse(
      requireTestValue(requireTestValue(prompt.split("```json\n")[1]).split("\n```")[0]),
    );
    let output: string;
    if (vars.episode) {
      scriptRequests.push({ prompt, source: vars.source, previous_ending: vars.previous_ending });
      output =
        vars.episode.no === 1
          ? "门廊。信使把湿信塞进门缝。"
          : scriptRequests.length === 2
            ? "屋内。她拆开了湿信。"
            : "门后。她把湿信递还给来人。";
    } else if (vars.batch_from) {
      formatPrompts.push(prompt);
      requests.push(`format:${vars.batch_from}`);
      output = JSON.stringify({
        episodes: [
          {
            title:
              vars.batch_from === 1 ? "风雨来客" : vars.batch_from === 13 ? "信中约定" : "续章来信",
            synopsis: "门前放着一封信",
            hook: "谁在门外",
            cliffhanger: "信封未拆",
            unit_from: vars.batch_from,
            unit_to: vars.batch_to,
          },
        ],
      });
      if (invalidFormats > 0) {
        invalidFormats--;
        output = "目录没有提供集数";
      }
    } else if (vars.next_episode_no) {
      planningPrompts.push(prompt);
      requests.push(`plan:${vars.next_episode_no}`);
      if (vars.next_episode_no === 2) {
        lastBatchInputs.push(vars);
        if (lastBatchInputs.length === 1) return;
      }
      output = "门前来信，信封未拆。";
    } else {
      requests.push("analyze");
      output = JSON.stringify({
        source_kind: "novel",
        summary: "夜雨送信",
        characters_md: "信使",
        outline_md: "深夜送来十四封信",
      });
    }
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("缺少回环端口");
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: root,
    LINK_STUDIO_TEST_PROJECT_PARENT: root,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [process.env.LINK_STUDIO_E2E_APP ?? "."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const skillFile = join(root, "rain-method.zip");
    await writeFile(
      skillFile,
      zipSync({
        "SKILL.md": strToU8(
          "---\nname: rain-method\nmetadata:\n  title: 雨夜衔接\ndescription: 延续湿信的位置\n---\n参考 references/letter.md。",
        ),
        "references/letter.md": strToU8("每场核对信封折痕。"),
      }),
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, skillFile);
    await page.evaluate(async () => {
      const picked = await window.desktop.skills.pick({ kind: "zip" });
      if (!picked.ok || !picked.value?.id) throw Error("无法预检雨夜技能");
      const confirmed = await window.desktop.skills.confirm({
        id: picked.value.id,
        enabled: false,
        scopes: ["plan", "scripts"],
      });
      if (!confirmed.ok) throw Error(confirmed.message);
    });
    await page.evaluate(async (endpoint) => {
      const channel = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture",
        fields: {
          name: "小说文本",
          endpoint,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      const model = await window.desktop.settings.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        enabled: true,
        upstreamModel: "novel",
        settings: { api: "chat_completions" },
        config: {
          name: "小说改编",
          kind: "agent",
          description: "",
          sort: 1,
          promptLimit: 24000,
          contextWindow: 32768,
          maxOutputTokens: 2048,
          pricing: { unit: "token", input: 1, output: 1 },
        },
      });
      if (!model.ok) throw Error(model.code);
    }, `http://127.0.0.1:${address.port}`);
    await createDramaProject(page, "夜雨来信");
    await page.getByRole("button", { name: "粘贴正文" }).click();
    const paste = page.getByLabel("粘贴正文");
    await paste.fill("门前放着一封信。");
    const start = page.locator(".drama-source > fieldset").getByRole("button", { name: "开始" });
    await start.click();
    const setup = page.getByRole("dialog", { name: "开拍设置" });
    await expect(setup.getByRole("button", { name: "原文类型" })).toHaveText("请选择");
    await expect(setup.getByRole("button", { name: "开始" })).toBeDisabled();
    await expect(setup.getByRole("button", { name: "开始" })).toHaveAttribute(
      "title",
      "先确认是剧本还是小说",
    );
    await setup.getByRole("button", { name: "取消" }).click();
    await start.click();
    await expect(setup.getByRole("button", { name: "原文类型" })).toHaveText("请选择");
    expect(kindPrompts).toHaveLength(1);
    await setup.getByRole("button", { name: "取消" }).click();
    const ambiguous =
      "首" +
      "🌙".repeat(1599) +
      "甲".repeat(180800) +
      "雨".repeat(1200) +
      "乙".repeat(181200) +
      "夜".repeat(1199) +
      "末";
    await paste.fill(ambiguous);
    await start.click();
    await expect(setup.getByRole("button", { name: "原文类型" })).toHaveText("小说");
    await expect(setup).toContainText("AI 判断为小说（以雨夜的心理描写为主）；规则统计：");
    expect(kindPrompts[1]?.split("<source>\n")[1]).toBe(
      "首" +
        "🌙".repeat(1599) +
        "\n……\n" +
        "雨".repeat(1200) +
        "\n……\n" +
        "夜".repeat(1199) +
        "末\n</source>",
    );
    await setup.getByRole("button", { name: "取消" }).click();
    await paste.fill(
      Array.from(
        { length: 15 },
        (_, index) => `第${index + 1}章 夜雨\n第${index + 1}封信到了。`,
      ).join("\n"),
    );
    await start.click();
    await expect(setup.getByRole("button", { name: "原文类型" })).toHaveText("小说");
    await expect(setup.getByRole("button", { name: "单集时长" })).toHaveText("60s/集");
    await setup.getByRole("button", { name: "规划范围" }).click();
    const range = setup.getByRole("spinbutton", { name: "规划到第几章" });
    await range.fill("13");
    await range.press("Enter");
    await expect(setup.getByRole("button", { name: "规划范围" })).toHaveText("规划到第 13 章");
    await setup.getByRole("button", { name: "分集规划", exact: true }).click();
    await setup.getByRole("button", { name: /雨夜衔接.*延续湿信的位置/ }).click();
    await setup.getByRole("button", { name: "分集剧本", exact: true }).click();
    await setup.getByRole("button", { name: "新建", exact: true }).click();
    await setup.getByRole("textbox", { name: "名称", exact: true }).fill("雨夜对白");
    await setup
      .getByRole("textbox", { name: "提示词正文" })
      .fill("只用门廊、湿信和对白描写这两集。");
    await setup.getByRole("button", { name: "保存", exact: true }).click();
    await expect(setup.getByRole("button", { name: "分集剧本", exact: true })).toContainText(
      "雨夜对白",
    );
    await setup.getByRole("button", { name: "开始" }).click();
    await expect.poll(() => lastBatchInputs.length).toBe(1);
    await stage(page, "剧本");
    await pickEpisode(page, 1);
    await expect(page.getByRole("heading", { name: "风雨来客" })).toBeVisible();
    const outline = page.getByRole("button", { name: "故事大纲", exact: true });
    const planning = page.getByRole("region", { name: "小说规划" });
    await outline.click();
    await planning.getByRole("button", { name: "暂停规划" }).click();
    await expect(planning.getByText("用户暂停", { exact: true })).toBeVisible();
    await expect(planning).toContainText("已处理 12 / 13 个原文单元");
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await page.getByRole("button", { name: /^夜雨来信/ }).click();
    await stage(page, "剧本");
    await expect(page.getByRole("heading", { name: "风雨来客" })).toBeVisible();
    await pickEpisode(page, 2);
    await expect(page.getByRole("heading", { name: "信中约定" })).toBeVisible();
    await outline.click();
    await expect(planning.getByText("用户暂停", { exact: true })).toBeVisible();
    await expect(planning).toContainText("已处理 13 / 13 个原文单元");
    await planning.getByRole("button", { name: "恢复规划" }).click();
    await expect(planning).toBeHidden();
    await pickEpisode(page, 2);
    expect(requests).toEqual(["analyze", "plan:1", "format:1", "plan:2", "plan:2", "format:13"]);
    expect(kindPrompts).toHaveLength(2);
    expect(planningPrompts).toHaveLength(3);
    expect(
      planningPrompts.every(
        (prompt) =>
          prompt.includes("【写作方法：雨夜衔接】") && prompt.includes("每场核对信封折痕。"),
      ),
    ).toBe(true);
    expect(formatPrompts).toHaveLength(2);
    expect(formatPrompts.every((prompt) => !prompt.includes("每场核对信封折痕。"))).toBe(true);
    expect(lastBatchInputs[0]).toEqual(lastBatchInputs[1]);
    expect(lastBatchInputs[1]).toMatchObject({
      source: expect.stringContaining("## [13]"),
      previous_cliffhanger: "信封未拆",
    });
    expect(JSON.stringify(lastBatchInputs[1])).not.toContain("## [14]");
    const picker = page.getByRole("dialog", { name: "生成分集剧本" });
    await page
      .locator(".drama-columns > article section")
      .filter({ has: page.getByRole("heading", { name: "信中约定" }) })
      .getByRole("button", { name: "生成剧本" })
      .click();
    await expect(picker.getByRole("note")).toHaveText(
      "第 1 集还没有剧本，第 2 集会按它的梗概和结尾悬念衔接",
    );
    await expect(picker.getByText("已选 1 集")).toBeVisible();
    await picker.getByRole("button", { name: "清空" }).click();
    await expect(picker.getByRole("button", { name: "至少选一集" })).toBeDisabled();
    await picker.getByRole("button", { name: "选中", exact: true }).click();
    await expect(picker.getByText("已选 2 集")).toBeVisible();
    await expect(picker.getByRole("note")).toHaveCount(0);
    await picker.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "小灵", exact: true }).click();
    const assistant = page.getByRole("complementary", { name: "短剧小灵" });
    await assistant.getByLabel("短剧消息").fill("把两集改编成剧本");
    await assistant.getByRole("button", { name: "发送", exact: true }).click();
    const approval = assistant.locator("section.canvas-request-card");
    await expect(approval.getByRole("heading")).toHaveText("运行短剧任务：分集剧本");
    expect(scriptRequests).toHaveLength(0);
    await approval.getByRole("button", { name: /批准并运行/ }).click();
    await pickEpisode(page, 2);
    await expect(page.locator(".drama-columns > article")).toContainText("屋内。她拆开了湿信。");
    expect(scriptRequests).toHaveLength(2);
    expect(scriptRequests[0]?.source).toContain("## [12]");
    expect(scriptRequests[0]?.source).not.toContain("## [13]");
    expect(scriptRequests[1]).toMatchObject({
      source: expect.stringContaining("## [13]"),
      previous_ending: "门廊。信使把湿信塞进门缝。",
    });
    expect(
      scriptRequests.every((item) => item.prompt.includes("只用门廊、湿信和对白描写这两集。")),
    ).toBe(true);
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "项目设置" });
    await settings.getByRole("button", { name: "分集剧本", exact: true }).click();
    await settings.getByRole("button", { name: /雨夜衔接.*延续湿信的位置/ }).click();
    await settings.getByRole("button", { name: "完成", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重新生成分集剧本", exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "命令面板" }).click();
    await page.getByRole("option", { name: /重新生成分集剧本/ }).click();
    await expect(picker.getByText("已选 0 集")).toBeVisible();
    await picker.getByRole("button", { name: "全选" }).click();
    await expect(picker.getByText("其中 2 集会覆盖现有剧本")).toBeVisible();
    await picker.getByLabel("起始集").fill("2");
    await picker.getByRole("button", { name: "选中", exact: true }).click();
    await expect(picker.getByText("其中 1 集会覆盖现有剧本")).toBeVisible();
    await expect(picker.getByText(/约 \d+ 积分/)).toBeVisible();
    await picker.getByRole("button", { name: "生成 1 集剧本" }).click();
    const episodes = page.locator(".drama-columns > article");
    await expect(episodes).toContainText("门后。她把湿信递还给来人。");
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await page.getByRole("button", { name: /^夜雨来信/ }).click();
    await pickEpisode(page, 1);
    await expect(episodes).toContainText("门廊。信使把湿信塞进门缝。");
    await pickEpisode(page, 2);
    await expect(episodes).toContainText("门后。她把湿信递还给来人。");
    await expect(episodes).not.toContainText("屋内。她拆开了湿信。");
    expect(scriptRequests).toHaveLength(3);
    expect(scriptRequests[2]).toMatchObject({
      source: requireTestValue(scriptRequests[1]).source,
      previous_ending: requireTestValue(scriptRequests[1]).previous_ending,
      prompt: expect.stringContaining("【写作方法：雨夜衔接】"),
    });
    expect(requireTestValue(scriptRequests[2]).prompt).toContain(
      "## references/letter.md\n每场核对信封折痕。",
    );
    expect(requireTestValue(scriptRequests[2]).prompt).not.toContain(
      "只用门廊、湿信和对白描写这两集。",
    );
    const extend = page.getByRole("button", { name: "继续规划", exact: true });
    const continuation = page.getByRole("dialog", { name: "继续规划" });
    await extend.click();
    await expect(continuation.getByRole("tab", { name: "全部剩余" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(continuation).toContainText(/第 14–15 章.*预计约 1 集 · 约 1 分钟/);
    await expect(continuation).toContainText(/约 \d+ 积分/);
    await continuation.getByRole("tab", { name: "规划到第 N 章" }).click();
    await continuation.getByLabel("规划到第几章").fill("5");
    await expect(continuation).toContainText("第 14–14 章");
    await continuation.getByRole("button", { name: "取消" }).click();
    expect(requests).toHaveLength(6);
    await extend.click();
    await continuation.getByRole("tab", { name: "规划到第 N 章" }).click();
    await continuation.getByLabel("规划到第几章").fill("14");
    await continuation.getByRole("button", { name: "开始规划" }).click();
    await expect(extend).toBeVisible();
    await expect(episodes).toContainText("门后。她把湿信递还给来人。");
    await pickEpisode(page, 3);
    await expect(page.getByRole("heading", { name: "续章来信" })).toBeVisible();
    expect(requests.slice(6)).toEqual(["plan:3", "format:14"]);
    expect(planningPrompts.at(-1)).toContain("## [14]");
    expect(planningPrompts.at(-1)).not.toContain("## [13]");
    expect(planningPrompts.at(-1)).not.toContain("## [15]");
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await page.getByRole("button", { name: /^夜雨来信/ }).click();
    await stage(page, "剧本");
    await extend.click();
    await expect(continuation).toContainText(/第 15–15 章.*预计约 1 集/);
    await continuation.getByRole("button", { name: "开始规划" }).click();
    await expect(extend).toHaveCount(0);
    await pickEpisode(page, 4);
    await expect(
      page.getByRole("heading", { name: "第 4 集 · 续章来信", exact: true }),
    ).toBeVisible();
    expect(requests.slice(8)).toEqual(["plan:4", "format:15"]);
    expect(planningPrompts.at(-1)).toContain("## [15]");
    expect(planningPrompts.at(-1)).not.toContain("## [14]");
    await pickEpisode(page, 1);
    await expect(episodes).toContainText("门廊。信使把湿信塞进门缝。");
    await pickEpisode(page, 2);
    await expect(episodes).toContainText("门后。她把湿信递还给来人。");
    expect(scriptRequests).toHaveLength(3);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await createDramaProject(page, "雨夜重试");
    await page.getByRole("button", { name: "粘贴正文" }).click();
    await paste.fill("第一章 门外\n风雨未停。\n第二章 门内\n来信。");
    await start.click();
    await setup.getByRole("button", { name: "分集规划", exact: true }).click();
    await setup.getByRole("button", { name: /雨夜衔接.*延续湿信的位置/ }).click();
    invalidFormats = 2;
    await setup.getByRole("button", { name: "开始" }).click();
    await expect(planning).toContainText("自定义提示词或技能导致输出不合格（plan）");
    await expect(planning).toContainText("已处理 0 / 2 个原文单元");
    await planning.getByRole("button", { name: "改用内置重试" }).click();
    await expect(planning).toBeHidden();
    await pickEpisode(page, 1);
    await expect(
      page.getByRole("heading", { name: "第 1 集 · 风雨来客", exact: true }),
    ).toBeVisible();
    expect(planningPrompts.slice(5).map((prompt) => prompt.includes("每场核对信封折痕。"))).toEqual(
      [true, false],
    );
    expect(requests.slice(10)).toEqual([
      "analyze",
      "plan:1",
      "format:1",
      "format:1",
      "plan:1",
      "format:1",
    ]);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("短剧：粘贴剧本、读取分集、批准改写，回到画布不串会话", async () => {
  test.setTimeout(100_000);
  const envelopePng =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=";
  const boardPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP432EMRwzIHAC6Cg3RoaM8aQAAAABJRU5ErkJggg==";
  const videoRequests: unknown[] = [];
  const selectedVideoRequests: string[] = [];
  const propRequests: { size: string; model: string }[] = [];
  const creativeStyle: { style: string; genre: string }[] = [];
  const boardRequests: Buffer[] = [];
  const root = await mkdtemp(join(tmpdir(), "link-drama-"));
  let calls = 0;
  let segmentTurn = 0;
  let sawAnswer = false;
  let sawSkip = false;
  let readSecond = false;
  let readIdleSegment = false;
  let outlineTurn = 0;
  let jobTurn = 0;
  let compose = false;
  let boardCounts: number[] = [];
  const observedJobs: number[] = [];
  let releaseBreakdown!: () => void;
  const breakdownGate = new Promise<void>((resolve) => {
    releaseBreakdown = resolve;
  });
  let finishAssetPrompt!: () => void, finishPropImage!: () => void;
  const assetPromptGate = new Promise<void>((resolve) => {
      finishAssetPrompt = resolve;
    }),
    propImageGate = new Promise<void>((resolve) => {
      finishPropImage = resolve;
    });
  const stages: string[] = [];
  const stagePrompts: string[] = [];
  const promptTargets: string[][] = [];
  let retryPrompts = false;
  let storyboardMode: "off" | "invalid" | "valid" = "off";
  const boardFeedback: (string | undefined)[] = [];
  let receivedJobFeedback = false;
  let readRatio = false;
  const videoFile = join(root, "take.mp4");
  await runMediaProcess(
    join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
    [
      "-f",
      "lavfi",
      "-i",
      "color=s=64x48:d=1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      videoFile,
    ],
  );
  const server = createServer(async (req, res) => {
    if (req.url === "/take.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" }).end(await readFile(videoFile));
      return;
    }
    if (req.url === "/prop.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(envelopePng, "base64"));
      return;
    }
    if (req.url?.endsWith("/images/edits")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      boardRequests.push(Buffer.concat(chunks));
      res.end(
        JSON.stringify({
          data: [{ b64_json: boardRequests.length === 1 ? boardPng : envelopePng }],
        }),
      );
      return;
    }
    if (req.url?.endsWith("/images/generations")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const { prompt, model, size } = JSON.parse(Buffer.concat(chunks).toString());
      if (model === "doubao-seedream-4-0") {
        propRequests.push({ size, model });
        await propImageGate;
        if (propRequests.length === 1) {
          res
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { message: "蜡印暂不可绘制" } }));
          return;
        }
        res.end(JSON.stringify({ data: [{ url: `http://${req.headers.host}/prop.png` }] }));
        return;
      }
      res.end(
        JSON.stringify({
          data: [{ b64_json: prompt.includes("分镜宫格") ? boardPng : envelopePng }],
        }),
      );
      return;
    }
    if (req.url?.endsWith("/tasks") && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      videoRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
      selectedVideoRequests.push(
        req.headers.authorization === "Bearer selected-video-fixture"
          ? "开拍视频"
          : req.headers.authorization === "Bearer video-fixture"
            ? "短剧视频"
            : "未知",
      );
      res.end(JSON.stringify({ id: "drama-video" }));
      return;
    }
    if (req.url?.endsWith("/tasks/drama-video")) {
      res.end(
        JSON.stringify({
          status: "succeeded",
          content: { video_url: `http://${req.headers.host}/take.mp4` },
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const names =
      body.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? [];
    if (body.model === "priced" && !names.length) {
      const prompt = body.messages.at(-1).content as string;
      const stage = prompt.match(/\n# ((?:资产|单集分镜)[^\n]+)/)?.[1] ?? "";
      stages.push(stage);
      stagePrompts.push(prompt);
      await breakdownGate;
      if (stage.startsWith("资产图提示词创作")) await assetPromptGate;
      const variables = JSON.parse(
        requireTestValue(requireTestValue(prompt.split("```json\n")[1]).split("\n```")[0]),
      );
      if (!stage.includes("格式化"))
        creativeStyle.push({ genre: variables.genre, style: variables.style });
      if (stage.startsWith("资产图提示词"))
        promptTargets.push(variables.assets.map((asset: { node_id: string }) => asset.node_id));
      const asset = {
        type: "prop",
        name: "来客的信封",
        look: "",
        aliases: [],
        episodes: [1],
        description: "信封上有蜡印",
        voice_prompt: "",
      };
      if (stage.startsWith("单集分镜格式化")) boardFeedback.push(variables.validation_error);
      const text = stage.startsWith("单集分镜格式化")
        ? JSON.stringify({
            segments: [
              {
                seconds: storyboardMode === "valid" && variables.validation_error ? 6 : 20,
                prompt: `看见@[门外的人](absent)把@[来客的信封](${requireTestValue(promptTargets[0])[0]})递进来。`,
              },
            ],
          })
        : stage.startsWith("单集分镜")
          ? "门口，信封被递进来。"
          : stage.startsWith("资产拆解创作")
            ? "道具：来客的信封，出现在第一集。"
            : stage.startsWith("资产拆解格式化")
              ? JSON.stringify({ assets: [asset] })
              : stage.startsWith("资产图提示词创作")
                ? "带着红色蜡印的旧信封。"
                : JSON.stringify({
                    prompts: [
                      { node_id: variables.assets[0].node_id, prompt: "旧信封上的红色蜡印特写。" },
                    ],
                  });
      res
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      return;
    }
    const drama = names.includes("drama_read");
    if (drama) calls++;
    const segment = segmentTurn > 0 && drama;
    if (drama) {
      const toolMessages = body.messages.filter(
        (message: { role: string }) => message.role === "tool",
      );
      receivedJobFeedback ||= toolMessages.some((message: { content: unknown }) =>
        String(message.content).includes("用户说明：先核对场景名称"),
      );
      if (jobTurn === 3) {
        const overview = JSON.parse(String(toolMessages.at(-1)?.content));
        if (compose)
          boardCounts = overview.episodes.map(
            (episode: { done_board_count: number }) => episode.done_board_count,
          );
        observedJobs.push(
          overview.active_jobs.filter(
            (job: { step: string; status: string }) =>
              job.step === "breakdown" && ["queued", "running"].includes(job.status),
          ).length,
        );
      }
      readRatio ||= toolMessages.some((message: { content: unknown }) =>
        String(message.content).includes('"ratio":"4:3"'),
      );
      sawAnswer ||= JSON.stringify(toolMessages).includes("只听见回声");
      sawSkip ||= JSON.stringify(toolMessages).includes("改发了新消息；请以用户的新消息为准");
      readIdleSegment ||= toolMessages.some((message: { content: unknown }) => {
        const text = String(message.content);
        return (
          text.includes("门扇慢慢打开") &&
          text.includes('"status":"idle"') &&
          text.includes('"takes":[]')
        );
      });
      readSecond ||= toolMessages.some((message: { content: unknown }) => {
        const text = JSON.stringify(message.content);
        return text.includes("门锁上有一张纸条") && !text.includes("一声敲门声");
      });
    }
    const id = JSON.stringify(body.messages).match(/\\?"id\\?":\\?"([a-f0-9]{32})\\?"/)?.[1];
    const sequence = compose
      ? [
          {
            name: "drama_run_job",
            input: { step: "compose", episodes: [1], reason: "合成第一集" },
          },
          { name: "drama_read", input: { scope: "overview" } },
        ]
      : jobTurn
        ? [
            {
              name: "drama_run_job",
              input: {
                step:
                  storyboardMode !== "off"
                    ? "storyboard"
                    : retryPrompts
                      ? "asset_prompts"
                      : "breakdown",
                episodes: [1],
                ...(storyboardMode !== "off" && { max_seconds: 8 }),
                reason:
                  storyboardMode !== "off"
                    ? "第一集分镜"
                    : retryPrompts
                      ? "补写信封提示词"
                      : "拆解第一集资产",
              },
            },
            { name: "drama_read", input: { scope: "overview" } },
          ]
        : outlineTurn
          ? [
              { name: "drama_read", input: { scope: "overview" } },
              { name: "drama_update_outline", input: { outline_md: "父女循着纸条在门口重逢。" } },
            ]
          : segment
            ? [
                {
                  name: "ask_user",
                  input: { questions: [{ id: "mood", label: "补充片段气氛？" }] },
                },
                { name: "drama_read", input: { scope: "segments", episode_no: 1 } },
                { name: "drama_update_segment", input: { segment_id: id, seconds: 8 } },
              ]
            : [
                {
                  name: "ask_user",
                  input: {
                    questions: [
                      { id: "ending", label: "选择结尾", options: ["留白", "揭晓"] },
                      { id: "sound", label: "结尾的声音？" },
                    ],
                  },
                },
                {
                  name: "plan_update",
                  input: { steps: [{ title: "核对第一集结尾", status: "doing" }] },
                },
                { name: "drama_read", input: { scope: "episode", episode_no: 2 } },
                { name: "drama_read", input: { scope: "episode", episode_no: 1 } },
                {
                  name: "show_card",
                  input: {
                    kind: "summary",
                    title: "第一集改写摘要",
                    rows: [{ label: "场景", value: "门外", sub: "夜晚", badge: "待改写" }],
                  },
                },
                {
                  name: "show_card",
                  input: {
                    kind: "table",
                    title: "悬念镜头对照",
                    columns: ["镜头", "声音"],
                    rows: Array.from({ length: 7 }, (_, index) => ({
                      cells: [`镜头 ${index + 1}`, { text: "门外回声", tone: "warn" }],
                    })),
                    notes: [{ text: "先核对原剧本", tone: "info" }],
                    sources: [{ title: "分镜参考", url: "https://example.com/storyboard" }],
                  },
                },
                {
                  name: "drama_update_episode",
                  input: { episode_no: 1, script_md: "门外响起第二次敲门声。" },
                },
              ];
    const action = sequence[(jobTurn || outlineTurn || (segment ? segmentTurn : calls)) - 1];
    const name = action?.name,
      input = action?.input,
      tool = drama && action && names.includes(name);
    if (jobTurn) jobTurn++;
    else if (outlineTurn) outlineTurn++;
    else if (segment) segmentTurn++;
    const frame = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" }).end(
      frame(
        tool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${calls}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(input) },
                },
              ],
            }
          : { role: "assistant", content: "已完成" },
      ) +
        frame({}, tool ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fixture");
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: root,
    LINK_STUDIO_TEST_PROJECT_PARENT: root,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [process.env.LINK_STUDIO_E2E_APP ?? "."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await seedAssistantModel(page, {
      endpoint: `http://127.0.0.1:${addr.port}`,
      label: "本地短剧模型",
      model: "fixture",
      api: "chat_completions",
      secret: "local-fixture",
    });
    const packagePath = join(root, "paper-grain.zip");
    await writeFile(
      packagePath,
      zipSync({
        "SKILL.md": strToU8(
          "---\nname: paper-grain\nmetadata:\n  title: 纸张质感\ndescription: 资产图的纸面纹理\n---\n根据 references/paper.md 描写。",
        ),
        "references/paper.md": strToU8("纸纤维边缘卷曲。"),
      }),
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, packagePath);
    await page.evaluate(async () => {
      const inspected = await window.desktop.skills.pick({ kind: "zip" });
      if (!inspected.ok || !inspected.value?.id) throw Error("技能包预检失败");
      const imported = await window.desktop.skills.confirm({
        id: inspected.value.id,
        enabled: false,
        scopes: ["asset_prompts"],
      });
      if (!imported.ok) throw Error(imported.message);
    });
    await page.evaluate(async (endpoint) => {
      const list = await window.desktop.settings.list({});
      const video = list.ok
        ? list.value.plugins.find((plugin) => plugin.key === "doubao-video")
        : undefined;
      if (!video?.source) throw Error("缺少视频适配器");
      const image = list.ok && list.value.plugins.find((plugin) => plugin.key === "openai-image");
      if (!image) throw Error("缺少图片适配器");
      const imageSaved = await window.desktop.settings.save({
        expectedRevision: 0,
        pluginHash: image.hash,
        approve: true,
        secret: "image-fixture",
        fields: {
          label: "短剧图片",
          model: "gpt-image-1",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!imageSaved.ok) throw Error(imageSaved.code);
      const propImage =
        list.ok && list.value.plugins.find((plugin) => plugin.key === "doubao-image");
      if (!propImage) throw Error("缺少可调比例的图片适配器");
      const propChannel = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "prop-fixture",
        fields: {
          name: "道具绘制",
          endpoint,
          allowLocal: true,
          enabled: true,
          sort: 3,
          headers: [],
        },
      });
      if (!propChannel.ok) throw Error(propChannel.code);
      const propSaved = await window.desktop.settings.modelSave({
        expectedRevision: 0,
        channelId: propChannel.value.id,
        channelRevision: propChannel.value.revision,
        pluginHash: propImage.hash,
        approve: true,
        enabled: true,
        settings: { as: "dataUrl" },
        upstreamModel: "doubao-seedream-4-0",
        config: {
          kind: "image",
          name: "物品图像",
          description: "",
          sort: 3,
          params: {
            aspectRatio: {
              label: "构图比例",
              values: ["1:1", "16:9", "9:16", "3:2"],
              default: "16:9",
              open: true,
            },
            resolution: {
              label: "出图精度",
              values: ["1K", "2K", "4K"],
              default: "1K",
              open: true,
              unit: "档",
            },
          },
        },
      });
      if (!propSaved.ok) throw Error(propSaved.code);
      const saved = await window.desktop.settings.save({
        expectedRevision: 0,
        pluginHash: video.hash,
        approve: true,
        secret: "video-fixture",
        fields: {
          label: "短剧视频",
          model: "doubao-seedance-2-0",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: { as: "dataUrl" },
        },
      });
      if (!saved.ok) throw Error(saved.code);
      const selectedChannel = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "selected-video-fixture",
        fields: {
          name: "开拍生成",
          endpoint,
          allowLocal: true,
          enabled: true,
          sort: 2,
          headers: [],
        },
      });
      if (!selectedChannel.ok) throw Error(selectedChannel.code);
      const selectedVideo = await window.desktop.settings.modelSave({
        expectedRevision: 0,
        approve: true,
        enabled: true,
        channelId: selectedChannel.value.id,
        channelRevision: selectedChannel.value.revision,
        pluginHash: video.hash,
        upstreamModel: "doubao-seedance-2-0",
        settings: { as: "dataUrl" },
        config: {
          kind: "video",
          name: "开拍视频",
          description: "",
          sort: 2,
          pricing: { unit: "second", input: 3 },
          params: {
            duration: {
              values: Array.from({ length: 12 }, (_, index) => String(index + 4)),
              default: "6",
              range: { min: 4, max: 15, step: 1, open: true },
            },
            resolution: {
              values: ["480p", "720p", "1080p", "4k"],
              default: "720p",
              open: true,
            },
          },
        },
      });
      if (!selectedVideo.ok) throw Error(selectedVideo.code);
      const channel = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture",
        fields: {
          name: "开拍预检",
          endpoint,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      for (const [index, name] of ["默认研读", "开拍研读", "容量不足"].entries()) {
        const model = await window.desktop.settings.modelSave({
          expectedRevision: 0,
          channelId: channel.value.id,
          channelRevision: channel.value.revision,
          enabled: true,
          upstreamModel: `read-${index}`,
          settings: { api: "chat_completions" },
          config: {
            name,
            kind: "agent",
            description: "",
            sort: 20 + index,
            promptLimit: 24000,
            contextWindow: index === 2 ? 8192 : 32768,
            maxOutputTokens: 2048,
            pricing: { unit: "token", input: 500, output: 500 },
          },
        });
        if (!model.ok) throw Error(model.code);
      }
    }, `http://127.0.0.1:${addr.port}`);
    await createDramaProject(page, "门外");
    const setup = page.getByRole("dialog", { name: "开拍设置" });
    const pickStartModel = async (field: string, option: string) => {
      await setup.getByRole("button", { name: field, exact: true }).click();
      await setup
        .getByRole("dialog", { name: field, exact: true })
        .getByRole("button", { name: option, exact: true })
        .click();
    };
    const start = page.locator(".drama-source > fieldset").getByRole("button", { name: "开始" });
    await page.getByRole("button", { name: "粘贴正文" }).click();
    const paste = page.getByLabel("粘贴正文");
    await paste.fill(
      `场景：入口\n${"风".repeat(601)}\n场景：大厅\n${"灯".repeat(601)}\n场景：出口\n落幕`,
    );
    await expect(setup).toHaveCount(0);
    await start.click();
    await confirmDramaScript(page);
    await expect(setup).toContainText("剧本一次切完 · 2 集");
    await pickStartModel("文本模型", "容量不足");
    const modelField = setup
      .locator(".drama-start-field")
      .filter({ has: page.getByRole("button", { name: "文本模型", exact: true }) });
    await expect(modelField.getByRole("alert")).toContainText("放不下提示词");
    await expect(setup.getByRole("alert")).toHaveCount(1);
    await expect(setup.getByRole("button", { name: "开始" })).toHaveAttribute(
      "title",
      "所选模型装不下原文，请换一个",
    );
    await expect(setup).toContainText("剧本一次切完 · 2 集");
    await expect(setup.locator(".drama-start-file small")).toHaveText(/字 · 3 场/);
    await expect(setup.getByText(/依据：找到/)).toBeVisible();
    await expect(setup.getByRole("button", { name: "开始" })).toBeDisabled();
    await pickStartModel("文本模型", "开拍研读");
    const assetPrompt = setup.getByRole("button", { name: "资产图提示词", exact: true });
    await assetPrompt.click();
    await setup.getByRole("button", { name: /纸张质感.*资产图的纸面纹理/ }).click();
    await expect(assetPrompt).toHaveText("技能 · 纸张质感");
    await setup.getByRole("button", { name: "单集时长" }).click();
    await setup.getByLabel("自定义单集时长（秒）").fill("181");
    await expect(setup.getByText("请输入 30–180 的整数")).toBeVisible();
    await setup.getByRole("button", { name: "180 秒 / 集" }).click();
    await page.keyboard.press("Escape");
    await expect(setup).toContainText("剧本一次切完 · 1 集");
    await setup.getByRole("button", { name: "取消" }).click();
    await expect(start).toBeFocused();
    await paste.fill(
      "第一集 来客\n门外响起一声敲门声。\n求月票\n第三集 空稿\n第二集 纸条\n门锁上有一张纸条。",
    );
    await start.click();
    await expect(setup).toContainText("按原分集 · 2 集");
    await expect(setup).toContainText(
      "找到 3 个分集标记、0 个章节标题、0 个场次头；对白行占 0% · 按原分集直接导入",
    );
    await expect(setup.getByText("剧本一次切完 · 2 集", { exact: true })).toBeVisible();
    await expect(setup.getByLabel("分集目录")).toHaveCount(0);
    await setup.getByText("已处理 2 处").click();
    await expect(setup.locator("ul li")).toHaveText(["清掉 1 行插入语", "丢弃空单元"]);
    await page.keyboard.press("Escape");
    await expect(start).toBeFocused();
    await page.getByRole("button", { name: "上传剧本 / 小说" }).click();
    const upload = page.locator('input[type="file"][aria-label="剧本文件"]');
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "选择文件" }).click(),
    ]);
    await chooser.setFiles({
      name: "原稿.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("\ufeff第一集\r\n来客\r\n第二集\r\n关门"),
    });
    await start.click();
    await expect(setup).toContainText("按原分集 · 2 集");
    await setup.getByRole("button", { name: "取消" }).click();
    await upload.setInputFiles({
      name: "原稿.txt",
      mimeType: "text/plain",
      buffer: Buffer.from([0xff]),
    });
    await start.click();
    await expect(page.getByRole("alert")).toContainText("UTF-8");
    await expect(start).toBeEnabled();
    await upload.setInputFiles({
      name: "草稿.MD",
      mimeType: "text/markdown",
      buffer: Buffer.from("第一集\n敲门\n第二集\n纸条"),
    });
    await start.click();
    await expect(setup).toContainText("按原分集 · 2 集");
    await setup.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "移除" }).click();
    await expect(setup).toHaveCount(0);
    const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const word = (body: string) =>
      strToU8(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      );
    const docx = zipSync({
      "word/document.xml": word(
        paragraph("第一集 来客") +
          paragraph("门外响起一声敲门声。") +
          paragraph("第二集 纸条") +
          `<w:tbl><w:tr><w:tc>${paragraph("门锁上有一张纸条。")}</w:tc></w:tr></w:tbl>`,
      ),
      "word/header1.xml": word(paragraph("页眉专用文字")),
    });
    await upload.setInputFiles({
      name: "门外.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from(docx),
    });
    await start.click();
    await expect(setup).toContainText("按原分集 · 2 集");
    await setup.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "粘贴正文" }).click();
    await expect(paste).toHaveValue(/第三集 空稿/u);
    await page.getByRole("button", { name: "上传剧本 / 小说" }).click();
    await expect(page.getByText("门外.docx", { exact: true })).toBeVisible();
    await start.click();
    await expect(setup.getByRole("button", { name: "9:16" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await setup.getByRole("button", { name: "4:3" }).click();
    await pickStartModel("人物图片模型", "短剧图片");
    await pickStartModel("物品图片模型", "物品图像");
    const paramChip = setup.getByRole("button", { name: "物品图片参数" });
    await expect(paramChip).toContainText("16:9");
    await paramChip.click();
    const paramMenu = setup.getByRole("dialog", { name: "物品图片参数" });
    await paramMenu
      .getByRole("radiogroup", { name: "构图比例" })
      .getByRole("radio", { name: "1:1", exact: true })
      .click();
    await paramMenu
      .getByRole("radiogroup", { name: "出图精度" })
      .getByRole("radio", { name: "4K档", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(paramChip).toHaveText("1:1 · 4K");
    await pickStartModel("物品图片模型", "短剧图片");
    await expect(paramChip).toHaveText("1:1");
    await pickStartModel("物品图片模型", "物品图像");
    await expect(paramChip).toHaveText("1:1 · 4K");
    await setup.getByRole("button", { name: "题材" }).click();
    await setup.getByRole("button", { name: "悬疑推理" }).click();
    const styleTrigger = setup.getByRole("button", { name: "画风", exact: true });
    await styleTrigger.click();
    const gallery = setup.getByRole("dialog", { name: "画风", exact: true });
    await expect(gallery.getByRole("img")).toHaveCount(11);
    await expect
      .poll(() =>
        gallery
          .locator("img")
          .evaluateAll((images) =>
            images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
          ),
      )
      .toBe(true);
    await gallery.getByRole("button", { name: /二维扁平设计/ }).click();
    await expect(gallery.getByRole("button", { name: /二维扁平设计/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await gallery.getByRole("button", { name: "自定义", exact: true }).click();
    await setup.getByLabel("自定义画风").fill("潮湿街巷，暖色窗光");
    await page.keyboard.press("Escape");
    await expect(styleTrigger).toBeFocused();
    await pickStartModel("视频模型", "开拍视频");
    await pickStartModel("场景图片模型", "短剧图片");
    await pickStartModel("文本模型", "开拍研读");
    await expect(assetPrompt).toHaveText("内置");
    await assetPrompt.click();
    await setup.getByRole("button", { name: /纸张质感.*资产图的纸面纹理/ }).click();
    await expect(setup.getByRole("button", { name: "剧本直接导入", exact: true })).toHaveCount(2);
    const openPrompt = async (step: string) => {
      await setup.getByRole("button", { name: step, exact: true }).click();
      await setup.getByRole("button", { name: "新建", exact: true }).click();
    };
    await openPrompt("资产拆解");
    await setup.getByLabel("名称", { exact: true }).fill("蜡印拆解");
    const draftBody = setup.getByRole("textbox", { name: "提示词正文" });
    expect(await draftBody.inputValue()).not.toContain("## 输出约定");
    await draftBody.fill("保留红蜡印");
    await setup.getByRole("button", { name: "保存", exact: true }).click();
    await expect(setup.getByRole("button", { name: "资产拆解", exact: true })).toHaveText(
      "我的 · 蜡印拆解",
    );
    await openPrompt("故事板提示词");
    await setup.getByLabel("名称", { exact: true }).fill("铅笔故事板");
    const editor = setup.getByRole("textbox", { name: "提示词正文" });
    await editor.fill("铅笔故事板");
    await setup.getByRole("button", { name: "保存", exact: true }).click();
    await expect(setup.getByRole("alert")).toContainText("{{画面}}");
    await setup.getByRole("button", { name: "插入占位符 画面" }).click();
    await expect(editor.locator('[data-placeholder="画面"]')).toHaveCount(1);
    await setup.getByRole("button", { name: "恢复内置" }).click();
    await editor.press("ControlOrMeta+End");
    await page.keyboard.insertText(" 保留铅笔暗纹");
    await setup.getByRole("button", { name: "保存", exact: true }).click();
    await expect(setup.getByRole("button", { name: "故事板提示词", exact: true })).toHaveText(
      "我的 · 铅笔故事板",
    );
    await setup.getByRole("button", { name: "开始" }).click();
    await page.getByRole("button", { name: "小灵", exact: true }).click();
    const assistant = page.getByRole("complementary", { name: "短剧小灵" });
    await expect(assistant).toBeVisible();
    await page.evaluate(async () => {
      const list = await window.desktop.settings.dramaPromptLibrary({ action: "list" });
      if (!list.ok) throw Error(list.code);
      const saved = list.value.entries.find((entry) => entry.name === "蜡印拆解");
      if (!saved) throw Error("未保存");
      const removed = await window.desktop.settings.dramaPromptLibrary({
        action: "delete",
        id: saved.id,
        revision: saved.revision,
      });
      if (!removed.ok) throw Error(removed.code);
    });
    await checkEmptyHistory(assistant);
    await assistant.getByRole("button", { name: "小灵设置" }).click();
    const dramaThinking = assistant.getByRole("switch", { name: "显示思考过程" });
    await expect(dramaThinking).not.toBeChecked();
    await dramaThinking.click();
    await expect(dramaThinking).toBeChecked();
    await dramaThinking.press("Escape");
    await expect(page.getByRole("heading", { level: 1, name: "门外", exact: true })).toBeVisible();
    await pickEpisode(page, 2);
    await expect(page.getByRole("heading", { name: "第二集 纸条" })).toBeVisible();
    await pickEpisode(page, 1);
    await assistant.getByRole("button", { name: "把第 1 集的结尾改得更有悬念" }).click();
    expect(calls).toBe(0);
    await assistant.getByRole("button", { name: "发送", exact: true }).click();
    const question = assistant.getByRole("form", { name: "小灵提问" });
    await expect(question.getByRole("button", { name: "提交回答" })).toBeDisabled();
    await question.getByRole("radio", { name: "留白" }).check();
    await question.getByRole("textbox", { name: "结尾的声音？" }).fill("只听见回声");
    await question.getByRole("button", { name: "提交回答" }).click();
    await expect(
      assistant.getByRole("region", { name: "小灵提问记录" }).getByLabel("你的回答：只听见回声"),
    ).toContainText("结尾的声音？");
    await expect.poll(() => sawAnswer).toBe(true);
    await expect(assistant.getByText("修改第 1 集", { exact: true })).toBeVisible();
    const document = page.locator(".drama-columns > article");
    await expect(document).toContainText("一声敲门声");
    const runPlan = assistant.getByRole("region", { name: "本轮计划" });
    await expect(runPlan.getByRole("button", { name: "展开计划" })).toContainText("核对第一集结尾");
    await expect(runPlan).toContainText("0/1");
    expect(readSecond).toBe(true);
    await expect(assistant.getByText("第一集改写摘要", { exact: true })).toBeVisible();
    const summary = assistant.getByRole("region", { name: "第一集改写摘要" });
    await expect(summary).toContainText("夜晚");
    await expect(summary).toContainText("待改写");
    const comparison = assistant.getByRole("region", { name: "悬念镜头对照" });
    await expect(comparison.getByRole("columnheader", { name: "声音" })).toBeVisible();
    await expect(comparison.locator("tbody tr")).toHaveCount(6);
    await comparison.getByRole("button", { name: "还有 1 项" }).click();
    await expect(comparison.locator("tbody tr")).toHaveCount(7);
    await expect(comparison.getByRole("list", { name: "提示" })).toHaveText("先核对原剧本");
    const source = comparison.getByRole("link", { name: "分镜参考" });
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        process.env.LINK_STUDIO_CAPTURED_SOURCE = url;
      };
    });
    await source.click();
    await expect
      .poll(() => app.evaluate(() => process.env.LINK_STUDIO_CAPTURED_SOURCE))
      .toBe("https://example.com/storyboard");
    await page.getByRole("button", { name: "新增一集" }).click();
    await expect(document.getByRole("heading", { name: "第 3 集 · 新的一集" })).toBeVisible();
    await page.getByLabel("分集剧本", { exact: true }).fill("走廊里的灯亮了。");
    await pickEpisode(page, 1);
    await assistant.getByRole("button", { name: "批准修改" }).click();
    await expect(document).toContainText("第二次敲门声");
    await checkSavedHistory(assistant, "门外改稿");
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await seedLegacyClips(root, [
      [1, "门扇慢慢打开"],
      [2, "纸条特写"],
    ]);
    await createCanvasProject(page, "助手偏好校验");
    await page.getByRole("button", { name: "打开小灵" }).click();
    const canvasAssistant = page.getByRole("region", { name: "画布小灵" });
    await expect(canvasAssistant.getByText("门外改稿", { exact: true })).toHaveCount(0);
    await canvasAssistant.getByRole("button", { name: "小灵设置" }).click();
    const canvasThinking = canvasAssistant.getByRole("switch", { name: "显示思考过程" });
    await expect(canvasThinking).toBeChecked();
    await canvasThinking.click();
    await expect(canvasThinking).not.toBeChecked();
    await canvasThinking.press("Escape");
    await page.getByRole("button", { name: "关闭小灵" }).click();
    await projectAction(page, "关闭项目");
    const dramaRecord = page.locator(".home-record > button").filter({ hasText: "门外" });
    await dramaRecord.click();
    await page.getByRole("button", { name: "小灵", exact: true }).click();
    await stage(page, "剧本");
    await expect(document).toContainText("第二次敲门声");
    await assistant.getByRole("button", { name: "小灵设置" }).click();
    await expect(dramaThinking).not.toBeChecked();
    await dramaThinking.press("Escape");
    const firstEpisode = document
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "第 1 集 · 第一集 来客", exact: true }) });
    await stage(page, "片场");
    await expectDraftSegment(firstEpisode, "门扇慢慢打开", 5);
    for (const decision of ["保留原文", "批准修改"]) {
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      segmentTurn = 1;
      await assistant.getByLabel("短剧消息").fill("把这个片段改为八秒");
      await assistant.getByRole("button", { name: "发送", exact: true }).click();
      await question.getByRole("button", { name: "跳过提问" }).click();
      await expect.poll(() => sawSkip).toBe(true);
      const card = assistant.locator("section.canvas-request-card");
      await expect(card.getByRole("heading")).toHaveText("修改第 1 集片段 1");
      await expect(card.locator("del")).toHaveText("5");
      await expect(card.locator("ins")).toHaveText("8");
      await expectDraftSegment(document, "门扇慢慢打开", 5);
      await card.getByRole("button", { name: decision }).click();
      await expect(card).toHaveCount(0);
    }
    await expectDraftSegment(document, "门扇慢慢打开", 8);
    expect(readIdleSegment).toBe(true);
    await stage(page, "剧本");
    await pickEpisode(page, 3);
    await expect(document).toContainText("走廊里的灯亮了。");
    await pickEpisode(page, 2);
    await expect(document).toContainText("门锁上有一张纸条。");
    await expect(document).not.toContainText("页眉专用文字");
    await expect(assistant.getByRole("status")).toHaveText("就绪");
    outlineTurn = 1;
    await assistant.getByLabel("短剧消息").fill("把父女重逢写进大纲");
    await assistant.getByRole("button", { name: "发送", exact: true }).click();
    const outlineCard = assistant.locator("section.canvas-request-card");
    await expect(outlineCard.getByRole("heading")).toHaveText("修改短剧大纲与人物");
    expect(readRatio).toBe(true);
    const secondEpisode = document
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "第 2 集 · 第二集 纸条", exact: true }) });
    await stage(page, "片场");
    await expectDraftSegment(secondEpisode, "纸条特写", 5);
    await page.getByRole("button", { name: "故事大纲" }).click();
    const outline = document.getByRole("region", { name: "故事大纲" });
    await expect(outline).toBeVisible();
    await expect(outline).not.toContainText("父女循着纸条在门口重逢。");
    await outlineCard.getByRole("button", { name: "批准修改" }).click();
    await expect(outline).toContainText("父女循着纸条在门口重逢。");
    await pickEpisode(page, 2);
    await stage(page, "片场");
    await expectDraftSegment(secondEpisode, "纸条特写", 5);
    await page.evaluate(async (endpoint) => {
      const channel = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "local-price",
        fields: {
          name: "任务计价",
          endpoint,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      if (!channel.ok) throw Error(channel.code);
      const defaultModel = await window.desktop.settings.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        enabled: true,
        upstreamModel: "drama-default",
        settings: { api: "chat_completions" },
        config: {
          kind: "agent",
          name: "默认任务模型",
          description: "",
          sort: 0,
          promptLimit: 24000,
          contextWindow: 32768,
          maxOutputTokens: 2048,
          pricing: { unit: "token", input: 250, output: 250 },
        },
      });
      if (!defaultModel.ok) throw Error(defaultModel.code);
      const model = await window.desktop.settings.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        enabled: true,
        upstreamModel: "priced",
        settings: { api: "chat_completions" },
        config: {
          kind: "agent",
          name: "任务计价",
          description: "",
          sort: 10,
          promptLimit: 24000,
          contextWindow: 32768,
          maxOutputTokens: 2048,
          pricing: { unit: "token", input: 1000, output: 1000 },
        },
      });
      if (!model.ok) throw Error(model.code);
    }, `http://127.0.0.1:${addr.port}`);
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    const projectSettings = page.getByRole("dialog", { name: "项目设置" });
    await expect(
      projectSettings.getByRole("button", { name: "Agent 模型", exact: true }),
    ).toContainText("开拍研读");
    await expect(projectSettings.getByRole("button", { name: "故事板提示词" })).toHaveText(
      "我的 · 铅笔故事板",
    );
    await expect(projectSettings.getByRole("button", { name: "资产拆解" })).toHaveAttribute(
      "title",
      /使用快照/,
    );
    await expect(
      projectSettings.getByRole("button", { name: "资产图提示词", exact: true }),
    ).toHaveText("技能 · 纸张质感");
    await expect(
      projectSettings.getByRole("button", { name: "人物图片模型", exact: true }),
    ).toContainText("短剧图片");
    await expect(
      projectSettings.getByRole("button", { name: "场景图片模型", exact: true }),
    ).toContainText("短剧图片");
    await expect(
      projectSettings.getByRole("button", { name: "物品图片模型", exact: true }),
    ).toContainText("物品图像");
    await projectSettings.getByRole("button", { name: "Agent 模型", exact: true }).click();
    await projectSettings.getByRole("button", { name: "任务计价", exact: true }).click();
    await projectSettings.getByRole("button", { name: "完成" }).click();
    await expect(projectSettings).toHaveCount(0);
    for (const [index, decision] of [
      "不用了",
      "不用了，并告诉小灵怎么改…",
      "批准并运行 ✦ 28",
    ].entries()) {
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      jobTurn = 1;
      await assistant.getByLabel("短剧消息").fill("拆解第一集资产");
      await assistant.getByRole("button", { name: "发送", exact: true }).click();
      const approval = assistant.locator("section.canvas-request-card");
      await expect(approval.getByRole("heading")).toHaveText("运行短剧任务：资产拆解");
      await expect(approval).toContainText("第 1 集 · 预估 28 积分");
      await approval.getByRole("button", { name: decision, exact: true }).click();
      if (decision.endsWith("…")) {
        await approval.getByLabel("拒绝说明").fill("先核对场景名称");
        await approval.getByRole("button", { name: "提交说明" }).click();
      }
      await expect.poll(() => observedJobs[index]).toBe(index === 2 ? 1 : 0);
    }
    expect(receivedJobFeedback).toBe(true);
    releaseBreakdown();
    await stage(page, "资产管理");
    const assetsArea = page.getByRole("region", { name: "资产列表" });
    await assetsArea.getByRole("tab", { name: /^道具/ }).click();
    await expect(assetsArea.getByRole("heading")).toHaveText("资产管理 · 第 2 集");
    const emptyProps = assetsArea.getByRole("tab", { name: "道具 0", exact: true });
    await expect(emptyProps).toHaveAttribute("aria-selected", "true");
    await pickEpisode(page, 1);
    await expect(assetsArea.locator(".drama-asset-caption")).toHaveText("来客的信封");
    const propCard = assetsArea.getByRole("listitem", { name: "来客的信封" });
    await expect(propCard).toContainText("正在分析设定");
    finishAssetPrompt();
    await expect(propCard).toHaveAttribute("data-status", "idle");
    expect(stages.length).toBe(4);
    const envelopeEditor = assetsArea.getByRole("button", { name: "编辑 来客的信封 的提示词" }),
      promptDialog = page.getByRole("dialog", { name: "来客的信封" });
    await envelopeEditor.click();
    await expect(promptDialog.getByRole("textbox", { name: "生成提示词" })).toContainText(
      "旧信封上的红色蜡印特写。",
    );
    await promptDialog.getByRole("textbox", { name: "生成提示词" }).fill("信封右下角的蓝色蜡印。");
    await promptDialog.press("Escape");
    const assetCanvas = assetsArea.getByRole("main", { name: "创作画布" });
    const selectedAssetNode = assetCanvas.locator(".react-flow__node.selected");
    const openPropOnCanvas = async () => {
      await propCard.getByRole("button", { name: "在画布中打开 来客的信封" }).click();
      await expect(selectedAssetNode).toContainText("来客的信封");
    };
    await openPropOnCanvas();
    await selectedAssetNode.click();
    await expect(assetCanvas.getByRole("textbox", { name: "生成提示词" })).toContainText(
      "信封右下角的蓝色蜡印。",
    );
    await assetsArea.getByRole("button", { name: "出现集数" }).click();
    const episodePicker = page.getByRole("dialog", { name: "编辑出现集数" });
    await expect(episodePicker.getByRole("button", { name: "道具" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(episodePicker.getByRole("button", { name: "1", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await episodePicker.press("Escape");
    await assetsArea
      .getByRole("group", { name: "视图" })
      .getByRole("button", { name: "列表" })
      .click();
    await pickEpisode(page, 2);
    await expect(emptyProps).toHaveAttribute("aria-selected", "true");
    await stage(page, "片场");
    await expect(assistant.getByRole("status")).toHaveText("就绪");
    retryPrompts = true;
    jobTurn = 1;
    await assistant.getByLabel("短剧消息").fill("补写第一集信封的提示词");
    await assistant.getByRole("button", { name: "发送", exact: true }).click();
    const retryCard = assistant.locator("section.canvas-request-card");
    await expect(assistant.getByText("· 1 项失败", { exact: true })).toBeVisible();
    await expect(retryCard).toHaveCount(0);
    expect(stages).toHaveLength(4);
    expect(promptTargets[0]).toHaveLength(1);
    expect(promptTargets).toEqual([promptTargets[0], promptTargets[0]]);
    const timeline = page.getByRole("group", { name: "分镜时间线" });
    const shot = (seconds = 6) =>
      timeline.getByRole("button", { name: `片段 1，${seconds} 秒`, exact: true });
    const storyboardJobs = page
      .getByRole("region", { name: "短剧任务", exact: true })
      .getByRole("article")
      .filter({ has: page.getByText("分镜脚本", { exact: true }) });
    for (const attempt of ["invalid", "valid"] as const) {
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      storyboardMode = attempt;
      const firstStage = stages.length;
      const previousJobs = await storyboardJobs.count();
      jobTurn = 1;
      await assistant.getByLabel("短剧消息").fill("生成第一集分镜，片段最长八秒");
      await assistant.getByRole("button", { name: "发送", exact: true }).click();
      await expect(retryCard.getByRole("heading")).toHaveText("运行短剧任务：分镜脚本");
      await retryCard.getByRole("button", { name: "批准并运行 ✦ 14" }).click();
      await expect(storyboardJobs).toHaveCount(previousJobs + 1);
      await expect(storyboardJobs.nth(previousJobs)).toHaveAttribute(
        "data-status",
        attempt === "valid" ? "succeeded" : "failed",
      );
      await pickEpisode(page, 1);
      if (attempt === "valid") await expect(shot()).toHaveAttribute("title", /来客的信封/);
      else
        await expect(
          page.getByRole("button", { name: "重新生成分镜脚本", exact: true }),
        ).toBeEnabled();
      await pickEpisode(page, 2);
      await expectDraftSegment(secondEpisode, "纸条特写", 5);
      expect(stages.slice(firstStage)).toEqual([
        expect.stringMatching(/^单集分镜(?!格式化)/),
        expect.stringMatching(/^单集分镜格式化/),
        expect.stringMatching(/^单集分镜格式化/),
      ]);
      expect(boardFeedback.slice(-2)).toEqual([
        undefined,
        expect.stringContaining("不超过max_seconds"),
      ]);
    }
    await stage(page, "资产管理");
    await pickEpisode(page, 1);
    await assetsArea.getByRole("tab", { name: /^道具/ }).click();
    await openPropOnCanvas();
    await selectedAssetNode.click();
    await assetCanvas.getByRole("button", { name: "开始生成", exact: true }).click();
    await assetsArea
      .getByRole("group", { name: "视图" })
      .getByRole("button", { name: "列表" })
      .click();
    await expect(propCard).toContainText("生成中");
    finishPropImage();
    await expect(propCard).toContainText("生成失败");
    await expect(propCard.locator("small")).not.toBeEmpty();
    await openPropOnCanvas();
    await selectedAssetNode.getByRole("button", { name: "重试", exact: true }).click();
    await assetsArea
      .getByRole("group", { name: "视图" })
      .getByRole("button", { name: "列表" })
      .click();
    await expect(propCard.getByRole("img", { name: "来客的信封" })).toHaveAttribute(
      "src",
      /^link-media:/,
    );
    await expect(propCard).toHaveAttribute("data-status", "done");
    expect(propRequests).toEqual(
      Array(2).fill({ model: "doubao-seedream-4-0", size: "4096x4096" }),
    );
    await stage(page, "片场");
    await shot().click();
    const priorViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 1440, height: 900 });
    const libraryEnvelope = page
      .getByRole("complementary", { name: "资产库" })
      .getByTitle("拖到提示词里")
      .filter({ hasText: "来客的信封" });
    await expect(libraryEnvelope.locator("img")).toHaveAttribute("src", /^link-media:/);
    await expect
      .poll(() =>
        libraryEnvelope.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(2);
    await expect(libraryEnvelope).not.toContainText("无图");
    await page.setViewportSize(priorViewport);
    await assistant.getByRole("button", { name: "收起小灵", exact: true }).click();
    await expect(assistant).toBeHidden();
    const videoPanel = page.getByRole("region", { name: "片段预览" });
    const inspector = page.getByRole("region", { name: "片段编辑" });
    const boardStage = videoPanel.getByRole("region", { name: "故事板预览" });
    const fillBoards = page.getByRole("button", { name: /^批量生成故事板/ });
    await expect(fillBoards).toHaveText("批量生成故事板 · 1");
    await fillBoards.click();
    const fillDialog = page.getByRole("dialog", { name: "生成 1 张故事板？" });
    await expect(fillDialog).toContainText("片段 01");
    await fillDialog.getByRole("button", { name: "取消" }).click();
    await expect(fillDialog).toBeHidden();
    expect(boardRequests).toHaveLength(0);
    await fillBoards.click();
    await fillDialog.getByRole("button", { name: "开始生成" }).click();
    const selectedImage = boardStage.getByRole("img", { name: "片段 1 的故事板" });
    await expect
      .poll(() => selectedImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(4);
    await expect(fillBoards).toBeDisabled();
    await boardStage.getByRole("button", { name: "重新生成" }).click();
    await expect(boardStage.getByRole("group", { name: "故事板版本 2 / 2" })).toBeVisible();
    await expect
      .poll(() => selectedImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(2);
    await boardStage.getByRole("group", { name: "故事板版本 2 / 2" }).press("ArrowLeft");
    await expect(boardStage.getByRole("group", { name: "故事板版本 1 / 2" })).toBeVisible();
    await expect
      .poll(() => selectedImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(4);
    expect(boardRequests).toHaveLength(2);
    expect(stagePrompts.filter((prompt) => prompt.includes("保留红蜡印"))).not.toHaveLength(0);
    const assetDrafts = stagePrompts.filter((_, index) =>
      stages[index]?.startsWith("资产图提示词创作"),
    );
    expect(assetDrafts.length).toBeGreaterThan(0);
    for (const prompt of assetDrafts) {
      expect(prompt).toContain("【写作方法：纸张质感】");
      expect(prompt).toContain(
        "<skill>\n根据 references/paper.md 描写。\n\n## references/paper.md\n纸纤维边缘卷曲。\n</skill>",
      );
      expect(prompt).toContain("## 输出约定");
    }
    expect(
      stagePrompts
        .filter((_, index) => stages[index]?.includes("格式化"))
        .every((prompt) => !prompt.includes("<skill>")),
    ).toBe(true);
    expect(
      stagePrompts
        .filter((prompt) => prompt.includes("保留红蜡印"))
        .every(
          (prompt) =>
            prompt.includes("## 本步职责") &&
            prompt.includes("## 提示词正文\n\n保留红蜡印\n\n## 输出约定") &&
            prompt.includes("## 校验规则"),
        ),
    ).toBe(true);
    for (const request of boardRequests) {
      expect(request.includes(Buffer.from(envelopePng, "base64"))).toBe(true);
      expect(request.toString()).toContain("共 4 格，整图比例 16:9");
      expect(request.toString()).toContain("保留铅笔暗纹");
      expect(request.toString()).toContain("看见门外的人把图片1递进来。");
    }
    await videoPanel
      .getByRole("group", { name: "预览", exact: true })
      .getByRole("button", { name: /^视频/ })
      .click();
    const modelPicker = page.getByTitle("生成片段视频用的模型");
    const modelMenu = page.getByRole("dialog", { name: "视频模型" });
    await expect(modelPicker).toHaveText("开拍视频");
    const referenceBar = inspector.getByRole("region", { name: "参考素材" });
    await expect(referenceBar.getByLabel("来客的信封 · 参考图")).toBeVisible();
    await expect
      .poll(() =>
        referenceBar
          .locator("img")
          .evaluateAll((images) =>
            images.map((image) => (image instanceof HTMLImageElement ? image.naturalWidth : 0)),
          ),
      )
      .toEqual([4, 2]);
    await expect(referenceBar).toContainText("图 2/");
    const secondsChip = page.getByTitle(/^片段时长 · 模型上限/);
    const bar = page.locator(".drama-studio-batch-bar");
    const resolutionPicker = bar.getByRole("button", { name: /^(分辨率|480p|720p|1080p|4k)$/i });
    const qualityMenu = page.getByRole("dialog", { name: "分辨率" });
    await resolutionPicker.click();
    await expect(qualityMenu.getByRole("button")).toHaveText(["480p", "720p", "1080p", "4k"]);
    await qualityMenu.getByRole("button", { name: "1080p", exact: true }).click();
    await secondsChip.click();
    await page
      .getByRole("dialog", { name: "片段时长" })
      .getByRole("button", { name: "8s", exact: true })
      .click();
    await expect(secondsChip).toHaveText("8s");
    await shot(8).click();
    await expect(inspector.getByRole("textbox", { name: "片段原稿" })).toBeVisible();
    const generate = bar.getByRole("button", { name: /^立即生成/ });
    await expect(generate).toHaveText("立即生成·24");
    await generate.dblclick();
    await shot(8).click();
    await expect(videoPanel.locator(".drama-take-card.chosen")).toContainText("采用", {
      timeout: 30_000,
    });
    await referenceBar.getByRole("button", { name: "本次不带故事板" }).click();
    await expect(referenceBar).toContainText("图 1/");
    await expect(referenceBar.getByRole("button", { name: "带上" })).toBeVisible();
    await secondsChip.click();
    await page
      .getByRole("dialog", { name: "片段时长" })
      .getByRole("button", { name: "6s", exact: true })
      .click();
    await expect(secondsChip).toHaveText("6s");
    const again = bar.getByRole("button", { name: /^再生成一次/ });
    await expect(again).toHaveText("再生成一次·18");
    await resolutionPicker.click();
    await qualityMenu.getByRole("button", { name: "720p", exact: true }).click();
    await modelPicker.click();
    await expect(modelMenu.getByRole("button", { name: /^开拍视频/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await modelMenu.getByRole("button", { name: /^短剧视频/ }).click();
    await expect(modelPicker).toHaveText("短剧视频");
    const original = inspector.getByRole("textbox", { name: "片段原稿" });
    await original.click();
    await original.press("ControlOrMeta+End");
    await page.keyboard.insertText("镜头停在红蜡印。");
    await original.press("ControlOrMeta+Enter");
    await expect(shot()).toHaveAttribute("title", /镜头停在红蜡印。$/);
    await expect(videoPanel.locator(".drama-take-card")).toHaveCount(2, { timeout: 30_000 });
    await expect(again).toBeEnabled({
      timeout: 30_000,
    });
    const carousel = videoPanel.getByRole("group", { name: /版本/ });
    await expect(carousel.getByRole("button", { name: "播放视频" })).toBeVisible();
    await carousel.press("ArrowLeft");
    await carousel.press("ArrowRight");
    await expect(videoPanel.locator(".drama-take-card").nth(1)).toContainText("采用");
    expect(videoRequests).toHaveLength(2);
    expect(selectedVideoRequests).toEqual(["开拍视频", "短剧视频"]);
    expect(creativeStyle.length).toBeGreaterThan(0);
    expect(
      creativeStyle.every(
        (values) => values.genre === "suspense" && values.style === "潮湿街巷，暖色窗光",
      ),
    ).toBe(true);
    expect(videoRequests[0]).toMatchObject({
      resolution: "1080p",
      duration: 8,
      content: [
        {
          type: "text",
          text: expect.stringMatching(/^图片1是本段的分镜宫格图，.*\n看见门外的人把图片2递进来。$/),
        },
        { type: "image_url", image_url: { url: `data:image/png;base64,${boardPng}` } },
        { type: "image_url", image_url: { url: `data:image/png;base64,${envelopePng}` } },
      ],
    });
    expect(videoRequests[1]).toMatchObject({
      resolution: "720p",
      duration: 6,
      content: [
        { type: "text", text: "看见门外的人把图片1递进来。镜头停在红蜡印。" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${envelopePng}` } },
      ],
    });
    compose = true;
    jobTurn = 1;
    await page.getByRole("button", { name: "小灵", exact: true }).click();
    await assistant.getByLabel("短剧消息").fill("用已采用的视频合成第一集");
    await assistant.getByRole("button", { name: "发送", exact: true }).click();
    await expect(retryCard.getByRole("heading")).toHaveText("运行短剧任务：合成整集");
    await retryCard.getByRole("button", { name: "批准并运行", exact: true }).click();
    await assistant.getByRole("button", { name: "收起小灵", exact: true }).click();
    await stage(page, "成片");
    const final = page.getByRole("region", { name: "本集成片" });
    await expect(final.getByRole("heading")).toHaveText("成片已合成");
    await expect.poll(() => boardCounts).toEqual([0, 0, 0]);
    await final.getByRole("button", { name: "播放视频" }).click();
    await expect
      .poll(() =>
        final.locator("video").evaluate((video: HTMLVideoElement) => ({
          width: video.videoWidth,
          height: video.videoHeight,
        })),
      )
      .toEqual({ width: 960, height: 720 });
    await stage(page, "片场");
    await shot().click();
    await carousel.press("ArrowLeft");
    await stage(page, "成片");
    await expect(final.getByRole("heading")).toHaveText("成片已过期，可重新合成");
    await stage(page, "片场");
    await shot().click();
    await modelPicker.click();
    await expect(modelMenu.getByRole("button", { name: /^短剧视频/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(resolutionPicker).toHaveText("720p");
    await shot().click();
    await shot().click();
    await expect(modelPicker).toHaveText("短剧视频");
    await page.getByRole("button", { name: "小灵", exact: true }).click();
    await expect(assistant.getByRole("status")).toHaveText("就绪");
    await deleteSavedHistory(assistant, "门外改稿");
    await assistant.getByRole("button", { name: "收起小灵", exact: true }).click();
    const redo = page.getByRole("button", { name: "重新生成分镜脚本" }),
      clear = page.getByRole("alertdialog", { name: "重新生成第 1 集的分镜脚本？" });
    const previousStages = stages.length;
    await redo.click();
    await expect(clear).toContainText("已生成的视频文件不会被删除");
    await clear.getByRole("button", { name: "取消" }).click();
    await expect(shot()).toBeVisible();
    expect(stages).toHaveLength(previousStages);
    await redo.click();
    await clear.getByRole("button", { name: "清空并重新生成" }).click();
    await expect(clear).toHaveCount(0);
    await expect(videoPanel).toHaveCount(0);
    await expect
      .poll(() => stages.slice(previousStages).some((step) => step.startsWith("单集分镜格式化")))
      .toBe(true);
    await expect(redo).toBeVisible();
    await pickEpisode(page, 2);
    await expectDraftSegment(secondEpisode, "纸条特写", 5);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    const dramaPath = await dramaRecord.locator("small[title]").getAttribute("title");
    const reopened = await ProjectStore.open(requireTestValue(dramaPath));
    try {
      const doc = requireTestValue(dramaDocument(reopened.snapshot));
      expect(doc.episodes[0]?.storyboard_status).toBe("ready");
      const rebuilt = doc.segments?.filter((segment) => segment.episode_no === 1);
      expect(rebuilt).toHaveLength(1);
      expect(requireTestValue(requireTestValue(rebuilt)[0]).take_ids ?? []).toEqual([]);
      const bytes = await readFile(videoFile),
        hash = createHash("sha256").update(bytes).digest("hex");
      expect(
        Object.values(reopened.snapshot.assets).some(
          (asset) => asset.sha256 === hash && asset.availability === "ready",
        ),
      ).toBe(true);
      expect(
        await readFile(join(reopened.directory, "assets", "sha256", hash.slice(0, 2), hash)),
      ).toEqual(bytes);
    } finally {
      await reopened.close();
    }
    await dramaRecord.click();
    await stage(page, "片场");
    await pickEpisode(page, 1);
    await expect(resolutionPicker).toHaveText("720p");
    await expect(modelPicker).toHaveText("短剧视频");
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await createDramaProject(page);
    await page.getByRole("button", { name: "粘贴正文" }).click();
    await paste.fill("夜里传来一声问候。");
    await start.click();
    await expect(setup.getByRole("button", { name: "4:3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await setup.getByRole("button", { name: "16:9" }).click();
    await expect(setup.getByRole("button", { name: "场景图片模型" })).toContainText(
      "场景 · 短剧图片",
    );
    await pickStartModel("场景图片模型", "跟随默认");
    await setup.getByRole("button", { name: "场景图片模型" }).click();
    await expect(setup.getByRole("button", { name: "跟随默认", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(setup.getByRole("button", { name: "视频模型" })).toContainText("开拍视频");
    await expect(setup.getByRole("button", { name: "故事板提示词", exact: true })).toHaveText(
      "我的 · 铅笔故事板",
    );
    await expect(setup.getByRole("button", { name: "资产拆解", exact: true })).toHaveText("内置");
    await expect(paramChip).toHaveText("1:1 · 4K");
    await styleTrigger.click();
    await expect(setup.getByLabel("自定义画风")).toHaveValue("潮湿街巷，暖色窗光");
    await page.keyboard.press("Escape");
    await setup.getByRole("button", { name: "单集时长" }).click();
    await setup.getByLabel("自定义单集时长（秒）").fill("120");
    await page.keyboard.press("Escape");
    await setup.getByRole("button", { name: "取消" }).click();
    await start.click();
    await expect(setup.getByRole("button", { name: "4:3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(setup.getByRole("button", { name: "单集时长" })).toContainText("60s/集");
    await setup.getByRole("button", { name: "场景图片模型" }).click();
    await expect(setup.getByRole("button", { name: "短剧图片", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    finishAssetPrompt();
    finishPropImage();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("设置抽屉：首次关闭、无模型提示、宽屏让位和窄屏覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-settings-drawer-"));
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: root,
    LINK_STUDIO_TEST_PROJECT_PARENT: root,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1080, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "应用设置" }).click();
    const trigger = page.getByRole("button", { name: "设置小灵", exact: true });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".settings-assistant")).toHaveCount(0);
    const body = page.locator(".channel-settings-body");
    await trigger.click();
    const drawer = page.getByRole("complementary", { name: "小灵设置助手" });
    await expect(drawer.getByText("暂时没有可用的 Agent 模型", { exact: true })).toBeVisible();
    await expect(drawer.getByText("请先在模型渠道发布 Agent 模型")).toBeVisible();
    await expect(drawer.getByRole("textbox")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "收起设置小灵" })).toBeHidden();
    const glass = drawer.locator(".settings-drawer-glass");
    await expect.poll(() => glass.boundingBox()).toEqual({ x: 612, y: 8, width: 460, height: 704 });
    await expect.poll(async () => (await body.boundingBox())?.width).toBe(612);
    await page.setViewportSize({ width: 767, height: 580 });
    await expect(drawer.getByRole("button", { name: "收起设置小灵" })).toBeVisible();
    await expect.poll(() => glass.boundingBox()).toEqual({ x: 8, y: 8, width: 751, height: 564 });
    await expect.poll(async () => (await body.boundingBox())?.width).toBe(767);
    await page.keyboard.press("ControlOrMeta+j");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ControlOrMeta+j");
    await expect(drawer.getByText("请先在模型渠道发布 Agent 模型")).toBeVisible();
    await page.setViewportSize({ width: 1080, height: 720 });
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: /^返回/ })
      .click();
    await page.getByRole("button", { name: "应用设置" }).click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("后台页面上下文：可移除引用、选中项生命周期及逐轮请求快照", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-settings-context-"));
  type Message = { role: string; content: unknown };
  const requests: Message[][] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    if (!body.stream) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ choices: [{ message: { content: "上下文" } }] }));
      return;
    }
    requests.push(body.messages);
    const tokens = JSON.stringify(body.messages.at(-1)?.content).includes("不带上下文")
      ? 1500
      : 24576;
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({ id: "snapshot", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish && { usage: { prompt_tokens: tokens, completion_tokens: 11, total_tokens: tokens + 11 } }) })}\n\n`;
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        chunk({ role: "assistant", content: "已核对" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("缺少回环端口");
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: root };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const model = await seedAssistantModel(page, {
      endpoint: `http://127.0.0.1:${address.port}`,
      label: "测试助手",
      model: "offline",
      api: "chat_completions",
      secret: "context-secret",
    });
    const ids = await page.evaluate(async () => {
      function requireTestValue<Value>(value: Value): NonNullable<Value> {
        if (value === null || value === undefined) throw new Error("测试页面缺少预期值");
        return value;
      }

      const api = window.desktop.settings,
        channel = await api.channelSave({
          expectedRevision: 0,
          approve: true,
          fields: {
            name: "测试渠道",
            endpoint: "https://channel.invalid",
            enabled: true,
            allowLocal: false,
            sort: 0,
            headers: [],
          },
        });
      if (!channel.ok) throw Error(channel.code);
      const selected = await api.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        enabled: false,
        upstreamModel: "context-model",
        settings: { api: "chat_completions" },
        config: {
          name: "被选模型",
          kind: "agent",
          description: "",
          sort: 1,
          promptLimit: 24000,
          contextWindow: 32768,
          maxOutputTokens: 2048,
          pricing: { unit: "token", input: 1, output: 1 },
        },
      });
      const second = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-window",
        fields: {
          name: "另一个渠道",
          endpoint: "https://another.invalid",
          enabled: true,
          allowLocal: false,
          sort: 20,
          headers: [],
        },
      });
      if (!second.ok) throw Error(second.code);
      const wide = await api.modelSave({
        expectedRevision: 0,
        channelId: second.value.id,
        channelRevision: second.value.revision,
        enabled: true,
        upstreamModel: "wide-context",
        settings: { api: "chat_completions" },
        config: {
          name: "大窗口",
          kind: "agent",
          description: "",
          sort: 20,
          promptLimit: 24000,
          contextWindow: 65536,
          maxOutputTokens: 2048,
          pricing: { unit: "token", input: 1, output: 1 },
        },
      });
      if (!wide.ok) throw Error(wide.code);
      const plugins = await api.list({});
      if (!plugins.ok || !selected.ok) throw Error("无法建立选中项");
      return {
        channel: channel.value.id,
        model: selected.value.id,
        wide: wide.value.id,
        plugin: requireTestValue(plugins.value.plugins.find((plugin) => plugin.key === "openai"))
          .hash,
      };
    });
    const verify = async (text: string, expected: object | null) => {
      const userText = (messages: Message[]) => {
        const content = messages.filter((item) => item.role === "user").at(-1)?.content;
        return Array.isArray(content) ? content.map((part) => part.text).join("") : String(content);
      };
      await expect
        .poll(() => requests.map(userText))
        .toContainEqual(expect.stringContaining(`${text}\n\n<后台上下文>`));
      const messages = requireTestValue(
        requests.find((messages) => userText(messages).includes(`${text}\n\n<后台上下文>`)),
      );
      const content = userText(messages);
      expect(
        JSON.parse(
          requireTestValue(requireTestValue(content.match(/\npage_context: ([^\n]+)\n/))[1]),
        ),
      ).toEqual(expected);
      expect(
        messages
          .filter((item) => item.role === "system")
          .map((item) => item.content)
          .join(""),
      ).not.toContain("page_context:");
    };
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "设置小灵" }).click();
    const panel = page.getByRole("complementary", { name: "小灵设置助手" }),
      composer = page.locator(".settings-assistant form.assistant-composer"),
      log = panel.getByRole("log");
    const providers = "/admin/ai/channels",
      adapters = "/admin/ai/plugins";
    const picker = composer.getByRole("button", { name: "Agent 模型" });
    await chooseAssistantModel(picker, { id: model.id });
    await expectReadableModelHover(picker);
    await page.emulateMedia({ colorScheme: "dark" });
    await picker.hover();
    await composer.screenshot({ path: test.info().outputPath("settings-model-hover.png") });
    await page.emulateMedia({ colorScheme: null });
    await expect(
      composer.getByRole("button", { name: /添加附件|插入模型|Skills 技能/ }),
    ).toHaveCount(0);
    const send = async (text: string, expected: object | null) => {
      await composer.getByRole("textbox").fill(text);
      await composer.getByRole("button", { name: "发送", exact: true }).click();
      await verify(text, expected);
      await expect(panel.getByRole("status")).toHaveText("就绪");
    };
    await expect(composer.getByRole("button", { name: `移除 渠道：${ids.channel}` })).toBeVisible();
    await composer.getByRole("button", { name: "移除 模型渠道" }).press("Enter");
    await send("只保留渠道", { route: providers, channel_key: ids.channel });
    const ring = composer.getByRole("button", { name: "上下文用量 25K / 33K" });
    await ring.hover();
    await expect(page.getByRole("tooltip")).toHaveText("上下文 25K / 33K（75%）");
    await ring.click();
    await expect(composer.locator(".agent-context")).toHaveAttribute("data-tone", "warn");
    const contextPopup = composer.locator(".agent-context-popup:popover-open");
    await expect(contextPopup).toBeVisible();
    await ring.press("Escape");
    await expect(contextPopup).toHaveCount(0);
    await expect(panel).toHaveAttribute("data-open", "true");
    const persisted = await page.evaluate(async () => {
      function requireTestValue<Value>(value: Value): NonNullable<Value> {
        if (value === null || value === undefined) throw new Error("测试页面缺少预期值");
        return value;
      }

      const api = window.desktop.settings,
        sessions = await api.agentList({});
      if (!sessions.ok) throw Error(sessions.code);
      const page = await api.agentState({
        sessionId: requireTestValue(sessions.value[0]).id,
        after: 0,
      });
      if (!page.ok) throw Error(page.code);
      return page.value.events
        .filter((event) => event.type === "run.usage")
        .map((event) => event.payload);
    });
    expect(persisted).toContainEqual({ context_tokens: 24576, spent_credits: 0 });
    await chooseAssistantModel(picker, { id: ids.wide });
    await expect(composer.getByRole("button", { name: "上下文用量 25K / 66K" })).toBeVisible();
    await expect(composer.locator(".agent-context")).toHaveAttribute("data-tone", "normal");
    await chooseAssistantModel(picker, { id: model.id });
    const retained = log.locator(".user-message").filter({ hasText: "只保留渠道" });
    await expect(retained.getByRole("group")).toHaveText(`模型渠道渠道：${ids.channel}`);
    await composer.getByRole("button", { name: `移除 渠道：${ids.channel}` }).click();
    await send("不带上下文", null);
    await expect(composer.getByRole("button", { name: "上下文用量 1.5K / 33K" })).toBeVisible();
    await expect(
      log.locator(".user-message").filter({ hasText: "不带上下文" }).getByRole("group"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /另一个渠道.*个模型/ }).click();
    await expect(composer.getByRole("group", { name: "页面上下文" })).toHaveCount(0);
    await page.getByRole("button", { name: /测试渠道.*个模型/ }).click();
    await expect(composer.getByRole("group", { name: "页面上下文" })).toHaveCount(0);
    await page.getByRole("button", { name: "被选模型", exact: true }).click();
    await expect(composer.locator(`[title="${ids.model}"]`)).toHaveText(`模型：${ids.model}`);
    const probe = async (
      text: string,
      selection: { contextId?: string; channelId?: string; pluginHash?: string },
      expected: object,
    ) => {
      const result = await page.evaluate(
        async ({ text, selection, providerId }) => {
          const api = window.desktop.settings,
            session = await api.agentCreate({});
          if (!session.ok) throw Error(session.code);
          const sent = await api.agentSend({
            sessionId: session.value.sessionId,
            message: text,
            providerId,
            ...selection,
          });
          if (!sent.ok) throw Error(sent.code);
          return session.value.sessionId;
        },
        { text, selection, providerId: model.id },
      );
      await verify(text, expected);
      await expect
        .poll(() =>
          page.evaluate(async (sessionId) => {
            const state = await window.desktop.settings.agentState({ sessionId, after: 0 });
            return state.ok && !state.value.activeRun;
          }, result),
        )
        .toBe(true);
    };
    await probe(
      "模型引用传输",
      { contextId: ids.model, channelId: ids.channel },
      { route: providers, model_key: ids.model, channel_key: ids.channel },
    );
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
    await expect(composer.locator(`[title="${ids.model}"]`)).toHaveCount(0);
    await page.getByRole("button", { name: "适配器管理", exact: true }).click();
    await page.getByRole("searchbox", { name: "搜索插件" }).fill("openai");
    await page.getByRole("button", { name: "查看 OpenAI", exact: true }).click();
    await expect(composer.locator('[title="openai"]')).toHaveText("插件：openai");
    await probe(
      "插件引用传输",
      { pluginHash: ids.plugin },
      { route: adapters, plugin_key: "openai" },
    );
    await page.getByLabel("关闭适配器详情").click();
    await expect(composer.locator('[title="openai"]')).toHaveCount(0);
    await send("插件列表页面", { route: adapters });
    await expect(retained.getByRole("group")).toHaveText(`模型渠道渠道：${ids.channel}`);
    await panel.getByRole("button", { name: "新对话", exact: true }).click();
    await expect(composer.getByRole("button", { name: "上下文用量 0 / 33K" })).toBeVisible();
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("设置助手审批、试跑与重启恢复", async () => {
  test.setTimeout(50_000);
  const directory = await mkdtemp(join(tmpdir(), "link-studio-settings-e2e-"));
  const credential = "fixture-settings-credential";
  const rejectText = "保留模型标识；不要使用 [凭证已移除]。";
  const rejection = `已拒绝：配置变更单 · 你的说明：${rejectText}`;
  const manualIssue = "新建的插件 / 渠道 / 模型请在对应页面手动删除";
  const markdownReply =
    "**即将提交配置变更单。**\n\n| 字段 | 建议 |\n| --- | --- |\n| 名称 | 待审 |";
  let releaseThinking = () => {};
  const thinkingGate = new Promise<void>((resolve) => {
    releaseThinking = resolve;
  });
  let firstReply = true;
  let propose: object | undefined;
  let action: { name: string; args: object } | undefined;
  let streaming = 0;
  let trials = 0;
  let authenticated = true;
  const requests: unknown[] = [];
  let contextChannel = "";
  let priorUsage = "";
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
    if (firstReply && propose) {
      firstReply = false;
      response.write(chunk({ role: "assistant", reasoning_content: "先核对模型名称。" }));
      await thinkingGate;
      response.write(chunk({ content: markdownReply }));
    }
    if (propose || action) {
      const call = action ?? { name: "admin_propose_changes", args: { value: propose } };
      if (!action) propose = undefined;
      action = undefined;
      response.write(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `fixture-change-${streaming}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }),
      );
      response.end(`${chunk({}, "tool_calls")}data: [DONE]\n\n`);
      return;
    }
    const lastMessage = body.messages?.at(-1);
    const manual =
      lastMessage?.role === "tool" && String(lastMessage.content).includes(manualIssue);
    response.write(chunk({ role: "assistant", content: manual ? manualIssue : "设置检查" }));
    setTimeout(
      () =>
        response.end(
          `${chunk({ content: manual ? "。" : "完成" })}${chunk({}, "stop")}data: [DONE]\n\n`,
        ),
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
      const channel = await page.evaluate(async () => {
        const result = await window.desktop.settings.channelSave({
          expectedRevision: 0,
          approve: true,
          fields: {
            name: "助手上下文渠道",
            endpoint: "https://example.invalid",
            enabled: true,
            allowLocal: false,
            sort: 0,
            headers: [],
          },
        });
        if (!result.ok) throw new Error(result.code);
        return result.value.id;
      });
      contextChannel = channel;
      const profile = await seedAssistantModel(page, {
        endpoint: `http://127.0.0.1:${address.port}`,
        label: "本地验收模型",
        model: "fixture-model",
        api: "chat_completions",
        secret: credential,
      });
      await page.getByRole("button", { name: "应用设置" }).click();
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
      await page.getByRole("button", { name: "设置小灵" }).click();
      const assistant = page.getByRole("complementary", { name: "小灵设置助手" });
      await expect(assistant.getByRole("button", { name: "Agent 模型" })).toHaveText(
        "fixture-model",
      );
      const composer = assistant.getByRole("textbox", { name: "消息", exact: true });
      await checkEmptyHistory(assistant);
      const preferences = assistant.getByRole("button", { name: "小灵设置" });
      await preferences.click();
      const thinking = assistant.getByRole("switch", { name: "显示思考过程" });
      await expect(thinking).not.toBeChecked();
      await expect(assistant.getByText("固定开", { exact: true })).toBeVisible();
      await thinking.click();
      await expect(thinking).toBeChecked();
      await thinking.press("Escape");
      await expect(thinking).toBeHidden();
      await expect(assistant).toHaveAttribute("data-open", "true");
      await expectAssistantContrast(assistant.locator(".agent-editor-placeholder"));
      const send = assistant.getByRole("button", { name: "发送", exact: true });
      await expect(send).toBeDisabled();
      await expectAssistantContrast(send);
      const starter = "查看当前页面的配置和状态";
      await assistant.getByRole("button", { name: starter }).click();
      await expectDraft(composer, starter);
      await expect(composer).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(assistant).toBeHidden();
      await expect(page.getByRole("button", { name: "设置小灵", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "适配器管理", exact: true }).click();
      await page.keyboard.press("ControlOrMeta+j");
      await expectDraft(composer, starter);
      await expect(
        assistant.locator("form").getByRole("button", { name: "移除 插件", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "模型与渠道", exact: true }).click();
      await expect(
        assistant.getByRole("button", { name: "移除 模型渠道", exact: true }),
      ).toBeVisible();
      await expect(assistant.getByRole("button", { name: `移除 渠道：${channel}` })).toBeVisible();
      expect(streaming).toBe(0);
      await composer.fill("请提出名称和模型变更。");
      await expectAssistantContrast(send);
      await composer.press("Shift+Enter");
      await expectDraft(composer, "请提出名称和模型变更。\n");
      await composer.press("Enter");
      await expect(assistant.getByText("思考中", { exact: true })).toBeVisible();
      await expect(assistant.getByText("先核对模型名称。", { exact: true })).toHaveCount(0);
      releaseThinking();
      await expect(
        assistant.getByRole("log").getByRole("heading", { name: "配置变更单" }),
      ).toBeVisible({
        timeout: 15000,
      });
      expect(JSON.stringify(requests)).toContain(channel);
      await expectAssistantContrast(assistant.getByRole("heading", { name: "配置变更单" }));
      await expectAssistantContrast(assistant.getByText(/基线修订/));
      await expectAssistantContrast(
        assistant.getByRole("log").getByText("请提出名称和模型变更。", { exact: true }),
      );
      await expect(page.getByRole("checkbox", { name: /通过审批的新名称/ })).toBeChecked();
      const modelChange = page.getByRole("checkbox", { name: /跳过的模型/ });
      await expect(modelChange).toBeChecked();
      await modelChange.uncheck();
      const pendingNumber = (
        await readRenderedText(assistant.locator(".change-order-number"))
      ).split(" ")[0];
      expect(pendingNumber).toMatch(/^CO-\d{6}-[\dA-F]{6}$/);
      await page.getByRole("option", { name: /应用 1 项变更/ }).click();
      const receipt = assistant.getByRole("group", { name: /变更单 .* 结果/ });
      await expect(receipt).toHaveAttribute("aria-label", `变更单 ${pendingNumber} 结果`);
      await expect(receipt).toContainText("已应用 1 项");
      await expect(receipt.getByRole("list", { name: "未应用的条目" })).toHaveText("未应用：model");
      await expect(receipt.locator("dd b")).toHaveText("通过审批的新名称");
      const completed = assistant.getByRole("button", { name: "已思考" });
      await expect(completed).toHaveAttribute("aria-expanded", "false");
      await completed.click();
      await expect(assistant.getByText("先核对模型名称。", { exact: true })).toBeVisible();
      await expect(assistant.getByText("即将提交配置变更单。", { exact: true })).toBeVisible();
      const reply = assistant
        .getByRole("article")
        .filter({ has: page.getByRole("button", { name: "已思考" }) });
      await expect(reply.locator("strong")).toHaveText("即将提交配置变更单。");
      await expect(reply.getByRole("columnheader")).toHaveText(["字段", "建议"]);
      const footer = assistant.locator(".run-feedback").last();
      await expect(reply.getByRole("button", { name: "复制", exact: true })).toHaveCount(0);
      await footer.getByRole("button", { name: "复制", exact: true }).click();
      await expect(footer.getByRole("status")).toHaveText("已复制");
      const stored = await page.evaluate(async () => {
        function requireTestValue<Value>(value: Value): NonNullable<Value> {
          if (value === null || value === undefined) throw new Error("测试页面缺少预期值");
          return value;
        }

        const list = await window.desktop.settings.agentList({});
        if (!list.ok) throw Error(list.code);
        const state = await window.desktop.settings.agentState({
          sessionId: requireTestValue(list.value[0]).id,
          after: 0,
        });
        if (!state.ok) throw Error(state.code);
        return (
          state.value.events.find(
            (event) =>
              event.type === "message.done" && (event.payload as { thinking?: string })?.thinking,
          )?.payload as { text: string } | undefined
        )?.text;
      });
      expect(stored?.trim()).toBe(markdownReply);
      await expect
        .poll(() =>
          first.evaluate(
            async ({ clipboard }, expected) => (await clipboard.readText()) === expected,
            stored,
          ),
        )
        .toBe(true);
      await checkSavedHistory(assistant, "后台配置核对");
      const latest = await page.evaluate(async () => {
        const result = await window.desktop.settings.list({});
        return result.ok ? result.value.providers[0] : undefined;
      });
      expect(latest).toMatchObject({ label: "通过审批的新名称", model: "fixture-model" });
      propose = {
        providerId: latest?.id,
        expectedRevision: latest?.revision,
        changes: [
          { field: "label", value: "未批准的名称" },
          { field: "model", value: "invalid-if-applied" },
          { field: "channel", key: "api", value: "responses" },
          { field: "channel", key: "pathPrefix", value: "/api/v3" },
        ],
      };
      await composer.fill("提出四项变更，先让我决定。");
      await composer.press("Enter");
      const choices = assistant.getByRole("listbox", { name: "你的决定" });
      const card = assistant.getByRole("region", { name: "配置变更单" });
      await expect(card.getByRole("checkbox")).toHaveCount(3);
      const apply = choices.getByRole("option", { name: /应用 4 项变更/ });
      await card.getByRole("button", { name: "还有 1 项" }).click();
      await expect(card.getByRole("checkbox").last()).toBeChecked();
      await apply.press("ArrowDown");
      await expect(choices.getByRole("option", { name: /^2\s*拒绝$/ })).toBeFocused();
      await choices.getByRole("option", { selected: true }).press("3");
      const reason = choices.getByRole("textbox", { name: "拒绝，并告诉小灵怎么改…" });
      await expect(reason).toBeFocused();
      await reason.fill("  ");
      await reason.press("Enter");
      await expect(reason).toBeVisible();
      await reason.press("Escape");
      const explain = choices.getByRole("option", { name: /拒绝，并告诉小灵怎么改/ });
      await expect(explain).toBeFocused();
      await explain.press("Enter");
      await reason.fill(`  保留模型标识；不要使用 ${credential}。  `);
      await reason.press("Enter");
      await expect(assistant.getByRole("log").getByText(rejection, { exact: true })).toBeVisible();
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      expect(
        requests.some((request) =>
          (request as { messages?: { role: string; content: unknown }[] }).messages?.some(
            (message) =>
              message.role === "tool" && JSON.stringify(message.content).includes(rejectText),
          ),
        ),
      ).toBe(true);
      const unchanged = await page.evaluate(async () => {
        const list = await window.desktop.settings.list({});
        return list.ok && list.value.providers[0];
      });
      expect(unchanged).toMatchObject({
        revision: latest?.revision,
        label: latest?.label,
        model: "fixture-model",
        channel: latest?.channel,
      });
      propose = {
        providerId: latest?.id,
        expectedRevision: latest?.revision,
        changes: [{ field: "label", value: "不用的新名称" }],
      };
      await composer.fill("再提出一次名称变更。");
      await composer.press("Enter");
      await choices.getByRole("option", { name: /^2\s*拒绝$/ }).click();
      await expect(
        assistant.getByRole("log").getByText("已拒绝：配置变更单", { exact: true }),
      ).toBeVisible();
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      action = {
        name: "admin_test_run",
        args: { id: latest?.id, expectedRevision: latest?.revision },
      };
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("请申请试跑。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toBeVisible();
      const invalidReason = await page.evaluate(async () => {
        function requireTestValue<Value>(value: Value): NonNullable<Value> {
          if (value === null || value === undefined) throw new Error("测试页面缺少预期值");
          return value;
        }

        const sessions = await window.desktop.settings.agentList({});
        if (!sessions.ok) throw Error(sessions.code);
        const sessionId = requireTestValue(sessions.value[0]).id;
        const state = await window.desktop.settings.agentState({ sessionId, after: 0 });
        if (!state.ok) throw Error(state.code);
        return window.desktop.settings.agentDecide({
          sessionId,
          approvalId: requireTestValue(state.value.approvals[0]).id,
          selected: [],
          answer: "试跑不能附加变更说明",
        });
      });
      expect(invalidReason).toMatchObject({ ok: false, code: "SETTINGS_PROPOSAL_INVALID" });
      priorUsage = requireTestValue(
        await assistant
          .getByRole("button", { name: /^上下文用量 [1-9]/ })
          .getAttribute("aria-label"),
      );
      expect(priorUsage).toMatch(/ \/ 33K$/);
      expect(trials).toBe(0);
    } finally {
      await first.close();
    }
    const reopened = await launch();
    try {
      const page = await reopened.firstWindow();
      await page.getByRole("button", { name: "应用设置" }).click();
      await page.getByRole("button", { name: "设置小灵" }).click();
      await expect(
        page.getByRole("log").getByText("请提出名称和模型变更。", { exact: true }),
      ).toBeVisible();
      const oldRefs = page
        .getByRole("log")
        .locator(".user-message")
        .filter({ hasText: "请提出名称和模型变更。" })
        .getByRole("group", { name: "页面上下文" });
      await expect(oldRefs).toHaveText(`模型渠道渠道：${contextChannel}`);
      await expect(oldRefs.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toBeVisible();
      const assistant = page.getByRole("complementary", { name: "小灵设置助手" });
      const composer = assistant.getByRole("textbox", { name: "消息", exact: true });
      await expect(assistant.getByRole("status")).toHaveText("等你确认 ↓");
      await expect(assistant.getByRole("button", { name: priorUsage, exact: true })).toBeVisible();
      await expect(assistant.getByRole("log").getByText(rejection, { exact: true })).toHaveCount(1);
      const restoredReceipt = assistant.getByRole("group", { name: /变更单 .* 结果/ });
      await expect(restoredReceipt.locator("dd b")).toHaveText("通过审批的新名称");
      await expect(restoredReceipt.getByRole("button", { name: "回滚" })).toBeDisabled();
      await expect(assistant.getByRole("button", { name: "已思考" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await assistant.getByRole("button", { name: "小灵设置" }).click();
      const thinking = assistant.getByRole("switch", { name: "显示思考过程" });
      await expect(thinking).toBeChecked();
      await thinking.click();
      await thinking.press("Escape");
      await expect(assistant.getByRole("button", { name: "已思考" })).toHaveCount(0);
      await expect(assistant.getByText("即将提交配置变更单。", { exact: true })).toBeVisible();
      await composer.fill("记下这条插话。");
      await expect(assistant.getByRole("button", { name: "新对话", exact: true })).toBeDisabled();
      const history = assistant.getByRole("button", { name: "历史会话，当前：后台配置核对" });
      await history.click();
      await expect(assistant.getByRole("button", { name: "删除「后台配置核对」" })).toBeDisabled();
      await history.press("Escape");
      await expectDraft(composer, "记下这条插话。");
      await page.getByRole("button", { name: "插话", exact: true }).click();
      const log = assistant.getByRole("log");
      const steer = log.getByText("记下这条插话。", { exact: true });
      const pendingTrial = log.getByRole("heading", { name: "确认文本试跑" });
      const waiting = assistant.getByRole("region", { name: "等待读取的插话" });
      await expect(waiting).toContainText("记下这条插话。");
      await expect(steer).toHaveCount(0);
      expect(trials).toBe(0);
      await page.getByRole("button", { name: "同意试跑" }).click();
      const trialSummary = /^试跑成功 · 通过审批的新名称 · 耗时 (?:\d+m )?\d+(?:\.\d+)?s$/;
      const trialOutcome = log.getByText(trialSummary);
      await expect(trialOutcome).toBeVisible();
      await expect(steer).toBeVisible();
      await expect(waiting).toHaveCount(0);
      await expect(pendingTrial).toHaveCount(0);
      await expect(trialOutcome.or(steer).first()).toHaveText(trialSummary);
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
      await expect(log.getByText("已保存密钥", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      action = {
        name: "admin_test_run",
        args: { id: latest?.id, expectedRevision: (latest?.revision ?? 0) + 1 },
      };
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("再申请一次。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toBeVisible();
      await composer.press("Escape");
      await expect(assistant).toHaveAttribute("data-open", "true");
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toBeVisible();
      await composer.fill("尚未发送");
      await expect(assistant.getByRole("button", { name: "插话", exact: true })).toBeVisible();
      await expect(assistant.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
      await composer.fill("");
      await page.getByRole("button", { name: "停止", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认文本试跑" })).toHaveCount(0);
      await expect(page.getByText("已停止", { exact: true })).toBeVisible();
      await expect(
        log.getByText("试跑请求已失效 · 通过审批的新名称", { exact: true }),
      ).toBeVisible();
      const source = `${await readFile("resources/provider-plugins/openai.js", "utf8")}\nObject.assign(module.exports.meta,{key:'approval-fixture',version:'v1.0'});`;
      action = { name: "admin_plugin_check", args: { code: source } };
      propose = { pluginSource: source };
      await composer.fill("离线检查后提出插件草稿，等待我审阅。");
      await assistant.getByRole("button", { name: "发送", exact: true }).click();
      const review = assistant.getByRole("region", { name: "配置变更单" });
      await expect(
        review.getByText(`新插件 · ${source.split("\n").length} 行`, { exact: true }),
      ).toBeVisible();
      await expect(review.getByText("静态验证通过", { exact: true })).toBeVisible();
      await expect(review.locator('[title="version"] ~ span').last()).toHaveText("1.0.0");
      await expect(review.getByRole("button", { name: "代码差异" })).toHaveCount(0);
      const competing = await page.evaluate(
        (source) =>
          window.desktop.settings.pluginUpload({
            source: `${source}\nmodule.exports.meta.version='2.0.0';`,
          }),
        source,
      );
      expect(competing.ok).toBe(true);
      await expect(
        review.getByRole("checkbox", { name: "选择 OpenAI", exact: true }),
      ).toBeChecked();
      await review.getByRole("option", { name: /应用 1 项变更/ }).click();
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const list = await window.desktop.settings.list({});
            return (
              list.ok &&
              list.value.plugins.find(
                (plugin) => plugin.key === "approval-fixture" && plugin.origin === "agent",
              )?.version
            );
          }),
        )
        .toBe("2.0.1");
      const pluginResult = assistant
        .getByRole("group", { name: /变更单 .* 结果/ })
        .filter({ hasText: "approval-fixture" });
      await expect(pluginResult.locator("dt")).toHaveText([
        "meta.auth",
        "meta.endpoints",
        "meta.name",
        "meta.vendor",
        "plugin_key",
        "version",
      ]);
      await expect(pluginResult.locator('dt[title="version"] + dd')).toHaveText("2.0.1");
      const pluginName = await readRenderedText(pluginResult.locator('dt[title="meta.name"] + dd'));
      await pluginResult.getByRole("button", { name: pluginName, exact: true }).click();
      await expect(page.getByRole("button", { name: "适配器管理" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.getByRole("region", { name: "插件目录" })).toBeVisible();
      const pluginOrder = requireTestValue(
        requireTestValue(await pluginResult.getAttribute("aria-label")).split(" ")[1],
      );
      action = { name: "admin_propose_changes", args: { revert_of: pluginOrder } };
      await pluginResult.getByRole("button", { name: "回滚" }).click();
      await expect(assistant.getByText(`${manualIssue}。`, { exact: true })).toBeVisible();
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      await expect(review).toHaveCount(0);
      expect(
        requests.some((raw) =>
          (raw as { messages?: { role: string; content: unknown }[] }).messages?.some(
            (message) =>
              message.role === "tool" &&
              String(message.content).includes(
                JSON.stringify({
                  key: "approval-fixture",
                  status: "invalid",
                  issues: [manualIssue],
                }),
              ),
          ),
        ),
      ).toBe(true);
      const versions = await page.evaluate(async () => {
        const list = await window.desktop.settings.list({});
        return (
          list.ok &&
          list.value.plugins
            .filter((plugin) => plugin.key === "approval-fixture")
            .map((plugin) => plugin.version)
        );
      });
      expect(versions).toEqual(["2.0.0", "2.0.1"]);
      await page.getByRole("searchbox", { name: "搜索插件" }).fill("approval-fixture");
      await page
        .getByRole("row")
        .filter({ hasText: "approval-fixture" })
        .getByRole("button", { name: `查看 ${pluginName}`, exact: true })
        .click();
      const pluginHistory = page.getByRole("dialog", { name: pluginName, exact: true });
      await pluginHistory.getByRole("tab", { name: /版本历史/ }).click();
      const deleteVersion = pluginHistory.getByRole("button", { name: "删除 2.0.1", exact: true });
      await deleteVersion.click();
      const confirmation = page.getByRole("alertdialog", { name: "删除插件版本？" });
      await expect(confirmation).toContainText(`${pluginName} v2.0.1`);
      await confirmation.getByRole("button", { name: "取消" }).click();
      await deleteVersion.click();
      await confirmation.getByRole("button", { name: "删除", exact: true }).click();
      await expect(deleteVersion).toHaveCount(0);
      await expect(
        pluginHistory.getByRole("button", { name: "删除 2.0.0", exact: true }),
      ).toBeVisible();
      await pluginHistory.getByLabel("关闭适配器详情").click();
      await expect(pluginResult.locator('dt[title="version"] + dd')).toHaveText("2.0.1");
      const upgrade = `${source}\n// upgrade review`;
      action = {
        name: "admin_plugin_check",
        args: {
          code: upgrade,
          ctx_sample: {
            input: { prompt: "审阅" },
            channel: { baseUrl: "https://review.invalid/gateway" },
          },
        },
      };
      propose = { pluginSource: upgrade };
      await composer.fill("比较现有版本与新草稿，先不要安装。");
      await composer.press("Enter");
      await expect(review.getByText("2.0.0 → 2.0.1", { exact: true })).toBeVisible();
      await expect(
        review.getByText("POST https://review.invalid/gateway/v1/responses", { exact: true }),
      ).toBeVisible();
      const toggle = review.getByRole("button", { name: "代码差异" });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.press("Enter");
      const diff = review.getByLabel("插件代码差异");
      await expect(diff).toContainText("-module.exports.meta.version='2.0.0';");
      await expect(diff).toContainText("+// upgrade review");
      await expect(review.getByRole("checkbox", { name: "选择 OpenAI" })).toBeChecked();
      await toggle.press("Space");
      await expect(diff).toHaveCount(0);
      await review.getByRole("option", { name: /^2\s*拒绝$|^拒绝$/ }).click();
      await expect(review).toHaveCount(0);
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      expect(
        await page.evaluate(async () => {
          const list = await window.desktop.settings.list({});
          return (
            list.ok &&
            list.value.plugins
              .filter((plugin) => plugin.key === "approval-fixture")
              .map((plugin) => plugin.version)
          );
        }),
      ).toEqual(["2.0.0"]);
      const readModel = () =>
        page.evaluate(async () => {
          function requireTestValue<Value>(value: Value): NonNullable<Value> {
            if (value === null || value === undefined) throw new Error("测试页面缺少预期值");
            return value;
          }

          const list = await window.desktop.settings.list({});
          if (!list.ok) throw Error(list.code);
          return requireTestValue(list.value.providers[0]);
        });
      const prior = await readModel();
      propose = {
        providerId: prior.id,
        expectedRevision: prior.revision,
        changes: [
          { field: "label", value: "待反向审批" },
          { field: "model", value: "未采用模型" },
        ],
      };
      await composer.fill("改名称，保留模型");
      await composer.press("Enter");
      await review.getByRole("checkbox", { name: /未采用模型/ }).uncheck();
      await review.getByRole("option", { name: /应用 1 项变更/ }).click();
      const forward = assistant
        .getByRole("group", { name: /变更单 .* 结果/ })
        .filter({ hasText: "待反向审批" });
      await expect(forward).toContainText("未应用：model");
      const order = requireTestValue(
        requireTestValue(await forward.getAttribute("aria-label")).split(" ")[1],
      );
      action = { name: "admin_propose_changes", args: { revert_of: order } };
      await composer.fill("未发送的草稿");
      await forward.getByRole("button", { name: "回滚" }).click();
      await expectDraft(composer, "未发送的草稿");
      await expect(
        assistant.locator(".user-message").getByText(`回滚变更单 ${order}`, { exact: true }),
      ).toBeVisible();
      const reverseCard = assistant.getByRole("region", { name: `回滚变更单 ${order}` });
      await expect(reverseCard).toContainText(`回滚 ${order}`);
      await expect(reverseCard.getByRole("checkbox")).toHaveCount(1);
      expect((await readModel()).label).toBe("待反向审批");
      await reverseCard.getByRole("option", { name: /应用 1 项变更/ }).click();
      const reversed = assistant
        .getByRole("group", { name: /变更单 .* 结果/ })
        .filter({ has: page.locator("del", { hasText: "待反向审批" }) });
      await expect(reversed.locator("dd b")).toHaveText(prior.label);
      await expect(reversed).not.toHaveAttribute("aria-label", `变更单 ${order} 结果`);
      await expect(reversed.getByRole("button", { name: "回滚" })).toHaveCount(0);
      expect(await readModel()).toMatchObject({ label: prior.label, model: prior.model });
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      const linked = await page.evaluate(async () => {
        const channel = await window.desktop.settings.channelSave({
          expectedRevision: 0,
          approve: true,
          fields: {
            name: "结果卡跳转验收",
            endpoint: "https://fixture.invalid",
            enabled: false,
            headers: [],
            sort: 0,
            allowLocal: false,
          },
        });
        if (!channel.ok) throw Error(channel.code);
        const result = await window.desktop.settings.modelSave({
          channelId: channel.value.id,
          channelRevision: channel.value.revision,
          expectedRevision: 0,
          enabled: false,
          settings: { api: "responses" },
          config: { kind: "agent", name: "结果卡定位模型", description: "", sort: 1 },
          upstreamModel: "original",
        });
        if (!result.ok) throw Error(result.code);
        return result.value;
      });
      propose = {
        providerId: linked.id,
        expectedRevision: linked.revision,
        changes: [{ field: "model", value: "renamed-from-card" }],
      };
      await composer.fill("更新渠道模型标识。");
      await composer.press("Enter");
      await review.getByRole("option", { name: /应用 1 项变更/ }).click();
      const navigation = assistant
        .getByRole("group", { name: /变更单 .* 结果/ })
        .filter({ hasText: "renamed-from-card" });
      await navigation.getByRole("button", { name: "model", exact: true }).click();
      const modelEditor = page.getByRole("dialog", { name: "编辑模型" });
      await expect(modelEditor.getByLabel("上游模型标识")).toHaveValue("renamed-from-card");
      await modelEditor.getByRole("button", { name: "关闭弹窗", exact: true }).click();
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      const ask = {
        name: "ask_user",
        args: {
          questions: [
            { question: "核对哪个范围？", kind: "choice", options: ["所有渠道", "当前渠道"] },
          ],
        },
      };
      const questionnaire = assistant.getByRole("group", { name: "核对哪个范围？" });
      const askOnce = async () => {
        action = ask;
        await composer.fill("先确认核对范围");
        await composer.press("Enter");
        await expect(questionnaire.getByRole("option")).toHaveCount(2);
      };
      await askOnce();
      await questionnaire.getByRole("option", { name: /所有渠道/ }).press("ArrowDown");
      await expect(questionnaire.getByRole("option", { name: /当前渠道/ })).toBeFocused();
      await questionnaire.screenshot({ path: test.info().outputPath("settings-question.png") });
      await questionnaire.getByRole("option", { name: /当前渠道/ }).press("Enter");
      const record = assistant.getByRole("region", { name: "小灵提问记录" });
      await expect(record).toHaveCount(1);
      await expect(record).toContainText("当前渠道");
      const modelMessages = () =>
        requests.flatMap(
          (request) =>
            (request as { messages?: { role: string; content: unknown }[] }).messages ?? [],
        );
      await expect
        .poll(() =>
          modelMessages()
            .filter((message) => message.role === "tool")
            .map((message) => String(message.content)),
        )
        .toContainEqual(expect.stringContaining("用户回答：当前渠道"));
      expect(
        modelMessages()
          .filter((message) => message.role === "system")
          .map((message) => message.content),
      ).toContainEqual(expect.stringMatching(/管理后台[\s\S]*show_card[\s\S]*ask_user/));
      const instructions = modelMessages().find(
        (message) =>
          message.role === "system" && String(message.content).includes("<模型字段 Schema>"),
      );
      const schema = String(instructions?.content).match(
        /<模型字段 Schema>\n([^\n]+)\n<\/模型字段 Schema>/,
      )?.[1];
      expect(JSON.parse(schema ?? "null")).toMatchObject({
        type: "object",
        properties: { name: { type: "string" }, pricing: {}, contextWindow: { type: "integer" } },
      });
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      await askOnce();
      await composer.fill("改查昨天的失败记录");
      await composer.press("Enter");
      await expect(record.last()).toContainText("跳过了这个问题");
      await expect(
        assistant.locator(".user-message").getByText("改查昨天的失败记录", { exact: true }),
      ).toBeVisible();
      await expectDraft(composer, "");
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      action = {
        name: "ask_user",
        args: {
          questions: [
            {
              question: "选择检查项",
              kind: "choice",
              multi: true,
              allowCustom: true,
              options: ["渠道", { label: "指定模型", follow: "填写模型名" }],
            },
          ],
        },
      };
      await composer.fill("指定检查项");
      await composer.press("Enter");
      const form = assistant.getByRole("form", { name: "小灵提问" });
      await form.getByRole("checkbox", { name: /指定模型/ }).click();
      await expect(form.getByRole("button", { name: "提交回答" })).toBeDisabled();
      await form.getByPlaceholder("填写模型名").fill("测试模型");
      await form.getByRole("checkbox", { name: /其他，我来说/ }).click();
      await form.getByPlaceholder("自己写").fill("计费单位");
      await form.getByRole("button", { name: "提交回答" }).click();
      await expect
        .poll(() =>
          modelMessages()
            .filter((message) => message.role === "tool")
            .map((message) => String(message.content)),
        )
        .toContainEqual(expect.stringContaining("用户回答：指定模型：测试模型、计费单位"));
      await expect(assistant.getByRole("status")).toHaveText("就绪");
      await deleteSavedHistory(assistant, "后台配置核对");
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
    releaseThinking();
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Responses 配置、无工具探测和设置小灵的只读工具调用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-responses-e2e-"));
  const pluginCode = await readFile("resources/provider-plugins/openai.js", "utf8");
  const calls: { path?: string; body: Record<string, unknown> }[] = [];
  let trialRequests = 0;
  let configuredModelId = "";
  let configuredChannelId = "";
  let finishReply = () => {};
  const replyGate = new Promise<void>((resolve) => {
    finishReply = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (JSON.stringify(body).includes("fixture-diagnostic-trial-prompt")) {
      trialRequests++;
      response
        .writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { code: "denied" } }));
      return;
    }
    calls.push({ path: request.url, body });
    const frame = (type: string, fields: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
    const reply = (item: object, delta: string, deltaType: string) =>
      frame("response.output_item.added", { output_index: 0, item }) +
      frame(deltaType, { output_index: 0, content_index: 0, delta }) +
      frame("response.output_item.done", { output_index: 0, item }) +
      frame("response.completed", {
        response: {
          status: "completed",
          output: [item],
          usage: { input_tokens: 4096, output_tokens: 23, total_tokens: 4119 },
        },
      });
    const text = Array.isArray(body.tools) && body.tools.length ? "Responses 工具检查完成" : "OK";
    const content = [{ type: "output_text", text }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    const listedModels =
      Array.isArray(body.input) &&
      body.input.find(
        (item: { type: string; call_id: string }) =>
          item.type === "function_call_output" && item.call_id === "call_5",
      );
    const listedModelId = JSON.stringify(listedModels?.output ?? "").match(
      /[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/i,
    )?.[0];
    const linkedModels =
      Array.isArray(body.input) &&
      body.input.find(
        (item: { type: string; call_id: string }) =>
          item.type === "function_call_output" && item.call_id === "call_8",
      );
    const linkedModelId = JSON.stringify(linkedModels?.output ?? "").match(
      /[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/i,
    )?.[0];
    const operations = [
      { name: "admin_query", args: { resource: "runs" } },
      { name: "admin_list_plugins", args: {} },
      { name: "admin_get_plugin", args: { key: "openai" } },
      { name: "admin_list_channels", args: {} },
      { name: "admin_get_recent_errors", args: { task_id: "diagnostic-trial" } },
      { name: "admin_list_models", args: { kind: "agent", enabled: true, q: "FIXTURE-RESPONSES" } },
      { name: "admin_get_model", args: { key: listedModelId ?? "" } },
      {
        name: "admin_quote_preview",
        args: { body: quoteVideoModel, input: { size: "large", duration: 6, count: 3 } },
      },
      {
        name: "admin_list_models",
        args: { channel: configuredChannelId, q: "fixture-navigation" },
      },
      {
        name: "show_card",
        args: {
          kind: "summary",
          title: "配置检查对象",
          rows: [
            { label: "模型", value: "查看当前模型", ref: { type: "model", key: linkedModelId } },
            {
              label: "旧模型",
              value: "查看无归属模型",
              ref: { type: "model", key: listedModelId },
            },
            {
              label: "渠道",
              value: "查看停用渠道",
              ref: { type: "channel", key: configuredChannelId },
            },
            { label: "插件", value: "查看适配器", ref: { type: "plugin", key: "openai" } },
            { label: "节点", value: "画布引用", ref: { type: "node", key: "other-scope" } },
          ],
        },
      },
      { name: "admin_get_plugin", args: { key: "" } },
      { name: "admin_get_plugin", args: { key: "openai" } },
      {
        name: "admin_plugin_check",
        args: {
          code: pluginCode,
          ctx_sample: {
            input: { prompt: "检查样例" },
            channel: { baseUrl: "https://draft.invalid/gateway" },
          },
          responses: {
            submit: {
              status: 200,
              headers: { "x-api-key": "fixture-sample-auth" },
              body: {
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "样例输出 fixture-sample-auth" }],
                  },
                ],
              },
            },
          },
        },
      },
    ];
    const step =
      calls.filter(({ body }) => Array.isArray(body.tools) && body.tools.length).length - 1;
    const previousError =
      Array.isArray(body.input) &&
      body.input.some(
        (item: { type: string; call_id: string; output: unknown }) =>
          item.type === "function_call_output" &&
          item.call_id === "call_10" &&
          JSON.stringify(item.output).includes("需要插件 key"),
      );
    const operation = step === 11 && !previousError ? undefined : operations[step];
    if (step === 0 && text !== "OK") await replyGate;
    if (text !== "OK" && operation) {
      response.end(
        reply(
          {
            type: "function_call",
            id: `fc_${step}`,
            call_id: `call_${step}`,
            name: operation.name,
            arguments: JSON.stringify(operation.args),
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
      await page.setViewportSize(compactViewport);
      const profile = await seedAssistantModel(page, {
        endpoint: `http://127.0.0.1:${address.port}`,
        label: "Responses 模型",
        model: "fixture-responses",
        api: "responses",
        secret: "fixture-responses-credential",
      });
      configuredModelId = profile.id;
      const probe = await page.evaluate(
        ({ id, revision }) =>
          window.desktop.settings.agentTestConnection({ id, expectedRevision: revision }),
        profile,
      );
      expect(probe.ok).toBe(true);
      const trial = await page.evaluate(
        ({ id, revision }) =>
          window.desktop.settings.modelTrial({
            id,
            expectedRevision: revision,
            runId: "diagnostic-trial",
            params: {},
            dry: false,
            prompt: "fixture-diagnostic-trial-prompt",
          }),
        profile,
      );
      expect(trial).toMatchObject({ ok: true, value: { status: "failed" } });
      const channel = await page.evaluate(() =>
        window.desktop.settings.channelSave({
          expectedRevision: 0,
          approve: true,
          fields: {
            name: "渠道列表验收",
            endpoint: "https://fixture.example.org",
            enabled: false,
            headers: [],
            sort: 0,
            allowLocal: false,
          },
        }),
      );
      expect(channel.ok).toBe(true);
      if (!channel.ok) throw new Error(channel.code);
      configuredChannelId = channel.value.id;
      const linkedModel = await page.evaluate(
        ({ id, revision }) =>
          window.desktop.settings.modelSave({
            channelId: id,
            channelRevision: revision,
            expectedRevision: 0,
            enabled: false,
            settings: { api: "responses" },
            config: { kind: "agent", name: "fixture-navigation", description: "", sort: 1 },
            upstreamModel: "fixture-navigation",
          }),
        channel.value,
      );
      expect(linkedModel.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.path).toBe("/v1/responses");
      expect(calls[0]?.body).toMatchObject({
        model: "fixture-responses",
        store: false,
        stream: true,
        max_output_tokens: 64,
      });
      expect(calls[0]?.body.tools ?? []).toEqual([]);
      await page.getByRole("button", { name: "应用设置" }).click();
      await page.getByRole("button", { name: "设置小灵" }).click();
      const composer = page.getByRole("textbox", { name: "消息", exact: true });
      await expect(
        page.getByRole("complementary", { name: "小灵设置助手" }).getByRole("status"),
      ).toHaveText("就绪");
      const longDraft = `查看当前配置。\n${"需要核对的配置项\n".repeat(80)}待确认`;
      await composer.fill(longDraft);
      await expectDraft(composer, longDraft);
      await composer.evaluate((element) => {
        function requireTestValue<Value>(value: Value): NonNullable<Value> {
          if (value === null || value === undefined) throw new Error("测试页面缺少预期值");
          return value;
        }

        const range = document.createRange();
        range.selectNodeContents(requireTestValue(element.lastElementChild));
        range.collapse(false);
        requireTestValue(window.getSelection()).removeAllRanges();
        requireTestValue(window.getSelection()).addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await composer.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      await composer.press("Shift+Enter");
      await expectDraft(composer, `${longDraft}\n`);
      expect(calls).toHaveLength(1);
      await composer.press("Enter");
      const log = page.getByRole("log", { name: "对话与活动" });
      await expect(log.getByText(/待确认/)).toBeVisible();
      await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBeGreaterThan(30);
      await expect(log).toHaveAttribute("data-scrolled", "true");
      await log.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(log).toHaveAttribute("data-scrolled", "false");
      const latest = page.getByRole("button", { name: "回到底部" });
      await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBeLessThan(32);
      await expect(latest).toHaveCount(0);
      finishReply();
      await expect(page.getByText("Responses 工具检查完成", { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByRole("button", { name: "上下文用量 4.1K / 33K" })).toBeVisible();
      expect(await log.evaluate((element) => element.scrollTop)).toBeLessThan(32);
      await latest.click();
      await expect(latest).toHaveCount(0);
      await expect
        .poll(() =>
          log.evaluate(
            (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThan(4);
      expect(
        calls.some(({ body }) => JSON.stringify(body.input).includes("function_call_output")),
      ).toBe(true);
      expect(
        calls.some(({ body }) => JSON.stringify(body.input).includes("本机助手运行记录")),
      ).toBe(true);
      const outputs = calls
        .flatMap(({ body }) => (Array.isArray(body.input) ? body.input : []))
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.stringify(item.output));
      expect(
        outputs.some((output) => output.includes("latest_version") && output.includes("openai")),
      ).toBe(true);
      expect(
        outputs.some(
          (output) =>
            output.includes("attempts_left") &&
            output.includes("checked_hooks") &&
            output.includes("buildSubmitRequest"),
        ),
      ).toBe(true);
      const checkOutput = requireTestValue(
        outputs.find(
          (output) => output.includes("attempts_left") && output.includes("checked_hooks"),
        ),
      );
      expect(checkOutput).toContain("parseSubmitResponse");
      expect(checkOutput).toContain("样例输出 ••••");
      expect(checkOutput).not.toContain("fixture-sample-auth");
      const draftOutput = calls
        .flatMap(({ body }) => (Array.isArray(body.input) ? body.input : []))
        .find((item) => item.type === "function_call_output" && item.call_id === "call_12");
      expect(JSON.parse(draftOutput.output).request).toEqual({
        method: "POST",
        url: "https://draft.invalid/gateway/v1/responses",
        headers: { Authorization: "••••" },
        body: { model: "sample", input: "检查样例", stream: false, store: false },
      });
      expect(
        outputs.some(
          (output) => output.includes("code") && output.includes("网关只实现了 Chat Completions"),
        ),
      ).toBe(true);
      expect(
        calls.some(
          ({ body }) =>
            Array.isArray(body.input) &&
            body.input.some(
              (item: { type: string; call_id: string; output: unknown }) =>
                item.type === "function_call_output" &&
                item.call_id === "call_11" &&
                JSON.stringify(item.output).includes("网关只实现了 Chat Completions"),
            ),
        ),
      ).toBe(true);
      expect(outputs.join("")).not.toContain("fixture-responses-credential");
      expect(
        outputs.some(
          (output) => output.includes("渠道列表验收") && output.includes("secret_configured"),
        ),
      ).toBe(true);
      expect(
        outputs.some(
          (output) =>
            output.includes("diagnostic-trial") &&
            output.includes("http_status") &&
            output.includes("403"),
        ),
      ).toBe(true);
      expect(outputs.join("")).not.toContain("fixture-diagnostic-trial-prompt");
      expect(trialRequests).toBe(1);
      expect(
        outputs.some(
          (output) =>
            output.includes("quote_credits") &&
            output.includes("90") &&
            output.includes("per_second"),
        ),
      ).toBe(true);
      expect(
        outputs.some(
          (output) =>
            output.includes("body_sha256") &&
            output.includes("fixture-responses") &&
            output.includes(configuredModelId),
        ),
      ).toBe(true);
      const card = log.getByRole("region", { name: "配置检查对象" });
      await expect(card.getByRole("button")).toHaveCount(4);
      await card.getByRole("button", { name: "查看无归属模型" }).click();
      await expect(page.getByRole("alert")).toHaveText(`模型 ${configuredModelId} 不存在`);
      await card.getByRole("button", { name: "查看适配器" }).click();
      await expect(page.getByRole("region", { name: "插件目录" })).toBeVisible();
      await card.getByRole("button", { name: "查看停用渠道" }).click();
      await expect(
        page.getByRole("region", { name: "渠道详情" }).getByRole("heading"),
      ).toContainText("渠道列表验收");
      await card.getByRole("button", { name: "查看当前模型" }).click();
      const editor = page.getByRole("dialog", { name: "编辑模型" });
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel("上游模型标识")).toHaveValue("fixture-navigation");
      const history = new DatabaseSync(join(directory, "settings", "agent.sqlite"), {
        readOnly: true,
      });
      try {
        const event = history
          .prepare(`SELECT payload FROM agent_events WHERE type = 'tool.end'
          AND json_extract(payload, '$.name') = 'admin_plugin_check'`)
          .get();
        expect(JSON.parse(String(event?.payload))).toMatchObject({
          summary: "插件验证：通过=true，第 1/3 次，剩余 2 次",
          is_error: false,
        });
        expect(String(event?.payload)).not.toContain("draft.invalid");
      } finally {
        history.close();
      }
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
