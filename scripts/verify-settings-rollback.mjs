import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { Value } from "@sinclair/typebox/value";
import { settingsRequests } from "../packages/link-studio-core/src/settings-api.ts";
import { SettingsAgent } from "../src/main/settings/agent.ts";
import { SettingsRegistry } from "../src/main/settings/registry.ts";
import { readRenderedText } from "./read-rendered-text.mjs";

const registryMethods = new Set([
  "list",
  "channelList",
  "channelLoads",
  "canvasView",
  "agentLayout",
  "agentPreferences",
]);
const agentMethods = new Set([
  "agentList",
  "agentCreate",
  "agentState",
  "agentSend",
  "agentDecide",
]);
const renamed = "待保留的显示名称";
const reason = "保留新名称，不要回滚。";
const finalReply = "已保留当前配置。";

async function host(directory, endpoint) {
  const registry = await SettingsRegistry.open(
    directory,
    "resources/provider-plugins",
    "out/provider-runtime/runner",
    {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => Buffer.from(value).toString(),
    },
  );
  if (!registry.list().providers.length) {
    const pluginHash = registry.list().plugins.find((plugin) => plugin.key === "openai").hash;
    for (const [label, agentEnabled] of [
      ["对话模型", true],
      ["旧显示名称", false],
    ])
      registry.save({
        expectedRevision: 0,
        approve: true,
        secret: "local-fixture",
        pluginHash,
        fields: {
          label,
          model: "fixture",
          agentEnabled,
          endpoint,
          allowLocal: true,
          channel: { api: "chat_completions" },
        },
      });
  }
  const agent = new SettingsAgent(
    registry,
    directory,
    path.resolve("out/agent-runtime/worker.mjs"),
    undefined,
    (session) => process.send({ session }),
  );
  process.on("message", async ({ id, method, input }) => {
    try {
      if (!registryMethods.has(method) && !agentMethods.has(method))
        throw Error(`未预期的设置调用：${method}`);
      if (!Value.Check(settingsRequests[method], input)) throw Error("SETTINGS_ARGUMENT_INVALID");
      const value = registryMethods.has(method)
        ? await registry[method](input)
        : await agent.run(method, input);
      process.send({ id, result: { ok: true, value } });
    } catch (error) {
      process.send({ id, result: { ok: false, code: error.code ?? error.message } });
    }
  });
  process.send({ ready: true });
}

export async function openSettingsPage(browser, rpc, skills = [], previews = {}) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  page.setDefaultTimeout(8000);
  await page.exposeFunction("readDesktopSettings", rpc);
  await page.addInitScript(
    ({ skills, previews }) => {
      const empty = async () => ({ ok: false, code: "UNAVAILABLE", error: { message: "不可用" } });
      const service = (obj) => new Proxy(obj, { get: (target, key) => target[key] ?? empty });
      window.desktop = {
        settings: new Proxy(
          {},
          { get: (_, method) => (input) => window.readDesktopSettings(method, input) },
        ),
        projects: service({ listRecent: async () => ({ ok: true, value: { projects: [] } }) }),
        skills: service({
          list: async () => ({ ok: true, value: skills }),
          preview: async ({ name, version, path }) => {
            const value = previews[`${name}/${version}/${path}`];
            return value ? { ok: true, value } : empty();
          },
        }),
        dialogs: service({}),
        app: service({}),
        canvasWindow: {
          onActivateProject: () => () => {},
          onSaveBeforeClose: () => () => {},
          setPending: () => {},
          setNoticeCanvas: () => {},
        },
        projectEvents: {
          onLibraryChanged: () => () => {},
          onAgentChanged: (fn) => {
            const handler = (e) => fn(e.detail);
            window.addEventListener("agent-change", handler);
            return () => window.removeEventListener("agent-change", handler);
          },
        },
      };
    },
    { skills, previews },
  );
  await page.goto(pathToFileURL(path.resolve("out/renderer/index.html")).href);
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  return page;
}

async function replay() {
  const directory = await mkdtemp(path.join(tmpdir(), "link-settings-rollback-"));
  const output = path.resolve("test-results/settings-rollback-window");
  const requests = [];
  let proposal,
    browser,
    child,
    page,
    sequence = 0;
  const model = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const call =
      body.tools?.some((tool) => tool.function?.name === "admin_propose_changes") && proposal;
    if (call) proposal = undefined;
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: `fixture-${requests.length}`,
              type: "function",
              function: { name: "admin_propose_changes", arguments: JSON.stringify(call) },
            },
          ],
        }
      : {
          content: body.messages.some(
            (message) =>
              message.role === "tool" && JSON.stringify(message.content).includes(reason),
          )
            ? finalReply
            : "已处理配置变更。",
        };
    const frame = (delta, finish_reason) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        frame({ role: "assistant", ...delta }, null) +
          frame({}, call ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
  });
  const pending = new Map();
  const rpc = (method, input) =>
    new Promise((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      child.send({ id, method, input });
    });
  const closeHost = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  };
  try {
    await mkdir(output, { recursive: true });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--allow-file-access-from-files"],
    });
    const open = async () => {
      child = fork(new URL(import.meta.url), [
        "host",
        directory,
        `http://127.0.0.1:${model.address().port}`,
      ]);
      assert.deepEqual((await once(child, "message"))[0], { ready: true });
      child.on("message", ({ id, session, result }) => {
        if (session)
          void page
            ?.evaluate(
              (session) =>
                window.dispatchEvent(new CustomEvent("agent-change", { detail: session })),
              session,
            )
            .catch(() => {});
        else if (pending.has(id)) {
          pending.get(id)(result);
          pending.delete(id);
        }
      });
      page = await openSettingsPage(browser, rpc);
      await page.getByRole("button", { name: "通用与外观", exact: true }).click();
      await page.getByRole("button", { name: "设置助手" }).click();
      await expect(page.getByRole("radiogroup", { name: "应用主题" })).toBeInViewport();
      await expect(page.locator(".assistant-composer")).toBeVisible();
      await expect(
        page.locator(".assistant-composer").getByRole("group", { name: "页面上下文" }),
      ).toHaveCount(0);
      return page.getByRole("complementary", { name: "小灵设置助手" });
    };
    let panel = await open();
    const target = (await rpc("list", {})).value.providers.find(
      (provider) => !provider.agentEnabled,
    );
    proposal = {
      value: {
        providerId: target.id,
        expectedRevision: target.revision,
        changes: [{ field: "label", value: renamed }],
      },
    };
    const composer = panel.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("把显示名称改成「待保留的显示名称」。");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await panel.getByRole("option", { name: /应用 1 项变更/ }).click();
    const receipt = panel.getByRole("group", { name: /变更单 .* 结果/ });
    const order = (await receipt.getAttribute("aria-label")).split(" ")[1];
    assert.match(order, /^CO-\d{6}-[A-F\d]{6}$/);
    proposal = { revert_of: order };
    await page.getByRole("button", { name: "技能管理", exact: true }).click();
    await expect(page.getByText("没有符合条件的技能", { exact: true })).toBeVisible();
    await expect(
      panel.locator("form").getByRole("button", { name: "移除 技能", exact: true }),
    ).toBeVisible();
    await receipt.getByRole("button", { name: "回滚" }).click();
    const reverse = panel.getByRole("region", { name: `回滚变更单 ${order}` });
    await reverse.getByRole("option", { name: /拒绝，并告诉助手/ }).click();
    const explanation = reverse.getByRole("textbox", { name: /拒绝，并告诉助手/ });
    await explanation.fill(reason);
    await explanation.press("Enter");
    const status = `已拒绝：回滚变更单 ${order} · 你的说明：${reason}`;
    const inspect = async (stage) => {
      const log = panel.getByRole("log");
      const row = log.getByText(status, { exact: true });
      await expect(row).toHaveCount(1);
      const userTurn = log.getByRole("article").filter({ hasText: `回滚变更单 ${order}` });
      await expect(userTurn.getByRole("group", { name: "页面上下文" })).toHaveText("技能");
      const last = log.getByText(finalReply, { exact: true });
      await expect(log.getByRole("status")).toHaveText("就绪");
      await expect(last).toBeInViewport();
      await expect(panel.getByRole("region", { name: `回滚变更单 ${order}` })).toHaveCount(0);
      const orderOf = (locator) =>
        locator.evaluate((element) =>
          Array.from(element.closest('[role="log"]').querySelectorAll("*")).indexOf(element),
        );
      const positions = await Promise.all(
        [log.getByRole("group", { name: `变更单 ${order} 结果` }), userTurn, row, last].map(
          orderOf,
        ),
      );
      assert.ok(
        positions.every((position, index) => index === 0 || position > positions[index - 1]),
      );
      const metrics = await log.evaluate((el) => ({
        height: el.clientHeight,
        content: el.scrollHeight,
        top: el.scrollTop,
      }));
      assert.ok(
        metrics.content > metrics.height && metrics.content - metrics.height - metrics.top < 2,
        JSON.stringify(metrics),
      );
      await expect(row).toBeInViewport();
      await page.screenshot({ path: path.join(output, `${stage}.png`) });
      return metrics;
    };
    const before = await inspect("after-refusal");
    const count = requests.length;
    await page.close();
    await closeHost();
    panel = await open();
    await page.getByRole("button", { name: "技能管理", exact: true }).click();
    await expect(page.getByText("没有符合条件的技能", { exact: true })).toBeVisible();
    const after = await inspect("after-restart");
    assert.deepEqual(after, before, "同页面重开应恢复相同的内容高度和贴底位置");
    const persisted = (await rpc("list", {})).value.providers.find(
      (provider) => provider.id === target.id,
    );
    assert.equal(persisted.label, renamed);
    assert.equal(persisted.revision, target.revision + 1);
    const sessionId = (await rpc("agentList", {})).value[0].id;
    const providerId = (await rpc("list", {})).value.providers.find(
      (provider) => provider.agentEnabled,
    ).id;
    for (const stale of [
      { contextId: target.id },
      { channelId: "stale-channel" },
      { pluginHash: (await rpc("list", {})).value.plugins[0].hash },
    ]) {
      assert.ok(Object.values(stale).every(Boolean));
      assert.deepEqual(
        await rpc("agentSend", {
          sessionId,
          providerId,
          route: "skills",
          message: "不应发送",
          ...stale,
        }),
        { ok: false, code: "AGENT_ARGUMENT_INVALID" },
      );
    }
    assert.equal(requests.length, count);
    assert.ok(
      requests.some((body) =>
        body.messages.some(
          (msg) => msg.role === "tool" && JSON.stringify(msg.content).includes(reason),
        ),
      ),
    );
    const contexts = requests.flatMap((body) =>
      body.messages
        .filter((message) => message.role === "user")
        .flatMap((message) => {
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => part.text).join("");
          const context = /^page_context: (.*)$/m.exec(text);
          return context ? [{ text, context: JSON.parse(context[1]) }] : [];
        }),
    );
    assert.ok(
      contexts.some((entry) => entry.text.includes("把显示名称改成") && entry.context === null),
    );
    assert.ok(
      contexts.some(
        (entry) =>
          entry.text.includes(`回滚变更单 ${order}`) &&
          entry.context?.route === "/admin/agent/skills" &&
          Object.keys(entry.context).length === 1,
      ),
    );
    const report = {
      order,
      requests: count,
      before,
      after,
      viewport: page.viewportSize(),
      scope: "生产渲染整窗，宿主传输替身、本机设置服务和真实 Worker；未对拍基线整窗",
    };
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(report);
  } catch (error) {
    if (page && !page.isClosed()) console.error(await readRenderedText(page.locator("body")));
    console.error(
      "本机模型请求",
      requests.map((body) => ({ tools: body.tools?.length, role: body.messages.at(-1)?.role })),
    );
    throw error;
  } finally {
    await browser?.close();
    await closeHost();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "host") await host(process.argv[3], process.argv[4]);
  else await replay();
}
