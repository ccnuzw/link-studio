import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { confirmDramaScript, createCanvasProject, projectAction } from "./workspace-actions";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const scope of ["设置", "画布", "短剧"] as const)
  for (const fails of [false, true])
    test(`${scope}小灵：自动整理${fails ? "失败" : "成功"}、继续回答及历史恢复`, async () => {
      test.setTimeout(50_000);
      const directory = await mkdtemp(join(tmpdir(), "link-compaction-"));
      const summaryGate = gate(),
        replyGate = gate();
      const summaryText = "摘要验收标记：灯光保持暖色";
      const prompt = "请核对这次拍摄的渠道。";
      const contextWindow = scope === "短剧" ? 16000 : 3000;
      let mainCalls = 0,
        summaries = 0,
        sawSummary = false;
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const summary = JSON.stringify(body.messages?.[0]?.content ?? "").includes(
          "上下文摘要助手",
        );
        const main = !!body.tools?.length;
        if (summary) {
          summaries++;
          await summaryGate.promise;
        }
        if (main) {
          mainCalls++;
          if (summaries) {
            sawSummary = JSON.stringify(body.messages).includes(summaryText);
            await replyGate.promise;
          }
        }
        const tool = main && ((!summaries && mainCalls <= 3) || (fails && mainCalls === 2));
        const toolName =
          scope === "设置"
            ? "admin_list_channels"
            : scope === "画布"
              ? "canvas_get_state"
              : "drama_read";
        const delta = tool
          ? {
              role: "assistant",
              content: "核对项目配置。".repeat(Math.ceil(contextWindow / 5)),
              tool_calls: [
                {
                  index: 0,
                  id: `read-${mainCalls}`,
                  type: "function",
                  function: {
                    name: toolName,
                    arguments: scope === "短剧" ? '{"scope":"overview"}' : "{}",
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: summary
                ? fails
                  ? ""
                  : summaryText
                : main
                  ? "拍摄渠道核对完成。"
                  : "渠道核对",
            };
        const input = tool
          ? Math.round(contextWindow * 0.93)
          : summary
            ? 1600
            : contextWindow * 0.2;
        const frame = (fields: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: fields, finish_reason: finish }], ...(finish && { usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20 } }) })}\n\n`;
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(frame(delta, null) + frame({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("缺少回环端口");
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
      try {
        let page = await app.firstWindow();
        await page.evaluate(
          async ({ port, contextWindow }) => {
            const api = window.desktop.settings;
            const channel = await api.channelSave({
              expectedRevision: 0,
              approve: true,
              secret: "offline",
              fields: {
                name: "回环渠道",
                endpoint: `http://127.0.0.1:${port}`,
                allowLocal: true,
                enabled: true,
                sort: 1,
                headers: [],
              },
            });
            if (!channel.ok) throw Error(channel.code);
            const model = await api.modelSave({
              expectedRevision: 0,
              channelId: channel.value.id,
              channelRevision: channel.value.revision,
              enabled: true,
              upstreamModel: "small-window",
              settings: { api: "chat_completions" },
              config: {
                name: "整理验收模型",
                kind: "agent",
                description: "",
                sort: 1,
                promptLimit: 24000,
                contextWindow,
                maxOutputTokens: 500,
                pricing: { unit: "token", input: 1, output: 1 },
              },
            });
            if (!model.ok) throw Error(model.code);
          },
          { port: address.port, contextWindow },
        );
        const panel = () =>
          scope === "画布"
            ? page.getByRole("region", { name: "画布小灵" })
            : page.getByRole("complementary", {
                name: scope === "设置" ? "小灵设置助手" : "短剧助手",
              });
        const action = async (name: string) => {
          await projectAction(page, name);
        };
        const open = async (reopen = false) => {
          if (scope === "设置") {
            await page.getByRole("button", { name: "应用设置" }).click();
            await page.getByRole("button", { name: "设置助手" }).click();
            return;
          }
          if (reopen) await page.getByRole("button", { name: /^自动整理验收项目/ }).click();
          else {
            await createCanvasProject(page, "自动整理验收项目");
          }
          if (scope === "画布") {
            await page.getByRole("button", { name: "打开小灵", exact: true }).click();
            return;
          }
          if (!reopen) {
            await action("短剧工作室");
            await page.getByRole("button", { name: "粘贴正文" }).click();
            await page.getByLabel("粘贴正文").fill("第一集 灯光\n拍摄之前核对灯光。");
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
        const divider = () =>
          panel().getByRole("separator", {
            name: fails ? "较早的对话没能整理" : "已整理较早的对话",
          });
        const tooltip = () =>
          page.getByRole("tooltip", {
            name: fails ? /这一轮不会再自动整理/ : /聊天记录没有变/,
          });
        await open();
        await expect(panel().getByRole("status")).toHaveText("就绪");
        const composer = panel().getByRole("textbox", {
          name: scope === "设置" ? "消息" : `${scope}消息`,
          exact: true,
        });
        await composer.fill(prompt);
        await panel().getByRole("button", { name: "发送", exact: true }).click();
        await expect(panel().getByRole("log").getByRole("status")).toHaveText(
          /正在整理较早的对话…\d+sEsc停止/,
          { timeout: 12000 },
        );
        await expect(divider()).toHaveCount(0);
        summaryGate.resolve();
        await expect(divider()).toHaveCount(1);
        const text = fails
          ? "较早的对话没能整理 · 这一轮不再自动整理，建议新开对话"
          : "已整理较早的对话 · 上下文 93% →";
        await expect(divider()).toContainText(fails ? text : `${text} …`);
        replyGate.resolve();
        await expect(panel().getByText("拍摄渠道核对完成。", { exact: true })).toBeVisible();
        await expect(panel().getByRole("status")).toHaveText("就绪");
        expect(summaries).toBe(1);
        expect(sawSummary).toBe(!fails);
        await expect(divider()).toContainText(fails ? text : `${text} 20%`);
        await app.close();
        app = await launch();
        page = await app.firstWindow();
        await open(true);
        await expect(divider()).toHaveCount(1);
        await expect(divider()).toContainText(fails ? text : `${text} 20%`);
        await expect(panel().getByText(prompt, { exact: true })).toBeVisible();
        await expect(panel().getByText(summaryText, { exact: true })).toHaveCount(0);
        await divider().focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(divider()).toBeFocused();
        await expect(tooltip()).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(tooltip()).toHaveCount(0);
        await panel().getByRole("button", { name: "新对话", exact: true }).click();
        await expect(divider()).toHaveCount(0);
        await expect(panel().getByRole("button", { name: /^上下文用量 0 \// })).toBeVisible();
        await panel()
          .getByRole("button", { name: /^历史会话，当前/ })
          .click();
        await panel().locator(".assistant-history-row").getByRole("button").first().click();
        await expect(divider()).toHaveCount(1);
        await expect(divider()).toContainText(fails ? text : `${text} 20%`);
      } finally {
        summaryGate.resolve();
        replyGate.resolve();
        await app.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    });
