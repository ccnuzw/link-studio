import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { openStore } from "../../packages/agent-runtime/upstream/src/store/store";
import { confirmDramaScript, createCanvasProject, projectAction } from "./workspace-actions";

for (const scope of ["设置", "画布", "短剧"] as const)
  test(`${scope}小灵：重启打开长会话，加载失败可重试，翻页保留阅读位置并独立追更`, async () => {
    test.setTimeout(60_000);
    const directory = await mkdtemp(join(tmpdir(), "link-history-"));
    const env = {
      ...process.env,
      LINK_STUDIO_TEST_USER_DATA: directory,
      LINK_STUDIO_TEST_PROJECT_PARENT: directory,
    };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    const launch = () =>
      electron.launch({
        ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
        env,
      });
    let app = await launch();
    const server = createServer((request, response) => {
      request.resume();
      const frame = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          frame({ role: "assistant", content: "已经建立翻页验收会话。" }, null) +
            frame({}, "stop") +
            "data: [DONE]\n\n",
        );
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("缺少回环地址");
      let page = await app.firstWindow();
      await page.evaluate(async (port) => {
        const api = window.desktop.settings;
        const channel = await api.channelSave({
          expectedRevision: 0,
          approve: true,
          secret: "fixture",
          fields: {
            name: "翻页验收",
            endpoint: `http://127.0.0.1:${port}`,
            enabled: true,
            sort: 1,
            headers: [],
            allowLocal: true,
          },
        });
        if (!channel.ok) throw Error(channel.code);
        const model = await api.modelSave({
          expectedRevision: 0,
          channelId: channel.value.id,
          channelRevision: channel.value.revision,
          enabled: true,
          upstreamModel: "fixture",
          settings: { api: "chat_completions" },
          config: {
            name: "历史验收模型",
            kind: "agent",
            sort: 1,
            description: "",
            promptLimit: 24000,
            contextWindow: 32000,
            maxOutputTokens: 500,
            pricing: { unit: "token", input: 1, output: 1 },
          },
        });
        if (!model.ok) throw Error(model.code);
      }, address.port);
      const panelForPage = () =>
        scope === "画布"
          ? page.getByRole("region", { name: "画布小灵" })
          : page.getByRole("complementary", {
              name: scope === "设置" ? "小灵设置助手" : "短剧助手",
            });
      const open = async (reopen = false) => {
        if (scope === "设置") {
          await page.getByRole("button", { name: "应用设置" }).click();
          await page.getByRole("button", { name: "设置助手" }).click();
          return;
        }
        if (reopen) await page.getByRole("button", { name: /^翻页验收项目/ }).click();
        else {
          await createCanvasProject(page, "翻页验收项目");
        }
        const action = async (name: string) => {
          await projectAction(page, name);
        };
        if (scope === "画布") {
          await page.getByRole("button", { name: "打开小灵", exact: true }).click();
          return;
        }
        if (!reopen) {
          await action("短剧工作室");
          await page.getByRole("button", { name: "粘贴正文" }).click();
          await page.getByLabel("粘贴正文").fill("第一集 翻页\n核对较早的剧本。");
          await page.getByRole("button", { name: "开始", exact: true }).click();
          await confirmDramaScript(page);
          await page
            .getByRole("dialog", { name: "开拍设置" })
            .getByRole("button", { name: "开始" })
            .click();
          await page.getByRole("button", { name: "返回画布" }).click();
        }
        await action("短剧助手");
      };
      await open();
      await panelForPage()
        .getByRole("textbox", { name: scope === "设置" ? "消息" : `${scope}消息`, exact: true })
        .fill("建立翻页验收会话");
      await panelForPage().getByRole("button", { name: "发送", exact: true }).click();
      await expect(
        panelForPage().getByRole("log").getByText("已经建立翻页验收会话。", { exact: true }),
      ).toBeVisible();
      await expect(panelForPage().getByRole("status")).toHaveText("就绪");
      await app.close();
      const path = join(directory, "settings", "agent.sqlite");
      const sessionId = (() => {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          const rows = db
            .prepare(
              "SELECT DISTINCT CAST(session_id AS TEXT) AS id FROM agent_events WHERE type='message.user'",
            )
            .all();
          expect(rows).toHaveLength(1);
          return String(rows[0]!.id);
        } finally {
          db.close();
        }
      })();
      const seed = (start: number, end: number) => {
        const store = openStore(path, { workerId: 3 });
        try {
          const { canvasId, mode } = store.getSession("1", sessionId);
          for (let index = start; index <= end; index++) {
            const run = store.createRun({
              sessionId,
              canvasId,
              mode,
              userId: "1",
              status: "completed",
            });
            store.appendEvent(sessionId, run.id, "message.user", { text: `验收问题 ${index}` });
            store.appendEvent(sessionId, run.id, "message.done", { text: `验收回答 ${index}` });
            store.appendEvent(sessionId, run.id, "run.status", { status: "completed" });
          }
        } finally {
          store.close();
        }
      };
      seed(1, 90);
      app = await launch();
      page = await app.firstWindow();
      const db = new DatabaseSync(path);
      const hide = () => db.exec("ALTER TABLE agent_events RENAME TO fixture_hidden_events");
      const restore = () => db.exec("ALTER TABLE fixture_hidden_events RENAME TO agent_events");
      try {
        const list = await page.evaluate(() => window.desktop.settings.agentList({}));
        expect(list.ok).toBe(true);
        hide();
        await open(true);
        const panel = panelForPage();
        const log = panel.getByRole("log");
        const latest = panel.getByRole("button", { name: "回到底部" });
        const users = log.getByText(/^验收问题 \d+$/);
        await expect(panel.getByText("对话加载失败")).toBeVisible();
        restore();
        await panel.getByRole("button", { name: "重试", exact: true }).click();
        await expect(users).toHaveCount(33);
        await expect(users.first()).toHaveText("验收问题 58");
        await expect(users.last()).toHaveText("验收问题 90");
        hide();
        await log.evaluate((el) => {
          el.scrollTop = 0;
        });
        const retry = panel.getByRole("button", { name: "加载失败，点击重试" });
        await expect(retry).toBeVisible();
        await expect(users).toHaveCount(33);
        const anchor = log.getByText("验收问题 58", { exact: true });
        const y = () => anchor.evaluate((el) => el.getBoundingClientRect().top);
        const original = await y();
        restore();
        seed(91, 91);
        await expect(users.last()).toHaveText("验收问题 91");
        await expect(retry).toBeVisible();
        await expect(latest).toBeVisible();
        await retry.click();
        await expect(users).toHaveCount(67);
        expect(Math.abs((await y()) - original)).toBeLessThanOrEqual(1);
        await log.evaluate((el) => {
          el.scrollTop = 0;
        });
        await expect(users).toHaveCount(91);
        await expect(users.first()).toHaveText("验收问题 1");
        expect(new Set(await users.allTextContents()).size).toBe(91);
        await latest.click();
        await expect
          .poll(() => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeLessThan(2);
        await expect(latest).toHaveCount(0);
        await panel.getByRole("button", { name: "新对话", exact: true }).click();
        await expect(users).toHaveCount(0);
        seed(92, 92);
        await panel.getByRole("button", { name: /^历史会话，当前/ }).click();
        await panel.locator(".assistant-history-row").getByRole("button").first().click();
        await expect(users).toHaveCount(92);
        await expect(users.first()).toHaveText("验收问题 1");
        await expect(users.last()).toHaveText("验收问题 92");
      } finally {
        db.close();
      }
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
