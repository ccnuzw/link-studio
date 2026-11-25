import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { desktopElectron as electron } from "./desktop-window";
import { createCanvasProject, projectAction } from "./workspace-actions";

test("生成三份时满队列就地提示，释放两个名额后提示一份未提交", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-admission-"));
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    request.resume();
    response.setHeader("content-type", "application/json").end(
      JSON.stringify({
        data: [
          {
            b64_json:
              "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
          },
        ],
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test endpoint");
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: directory,
    LINK_STUDIO_TEST_PROJECT_PARENT: directory,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const hash = await page.evaluate(async (endpoint) => {
      const api = window.desktop.settings;
      const list = await api.list({});
      const plugin = list.ok && list.value.plugins.find((item) => item.key === "openai-image");
      if (!plugin) throw new Error("missing plugin");
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: { name: "样例", endpoint, enabled: true, allowLocal: true, sort: 0, headers: [] },
      });
      if (!channel.ok) throw new Error(channel.code);
      const keys = await api.channelKeys({
        id: channel.value.id,
        expectedRevision: channel.value.revision,
        secret: "fixture",
      });
      if (!keys.ok) throw new Error(keys.code);
      const model = await api.modelSave({
        expectedRevision: 0,
        approve: true,
        channelId: keys.value.id,
        channelRevision: keys.value.revision,
        enabled: true,
        upstreamModel: "gpt-image-1",
        pluginHash: plugin.hash,
        settings: {},
        config: {
          kind: "image",
          name: "海报",
          description: "",
          sort: 0,
          customParams: {
            copies: { type: "enum", label: "生成数量", values: [3], default: 3, fanout: true },
          },
        },
      });
      if (!model.ok) throw new Error(model.code);
      return plugin.hash;
    }, `http://127.0.0.1:${address.port}`);
    const database = new DatabaseSync(join(directory, "settings", "settings.sqlite"));
    try {
      for (let index = 0; index < 20; index++)
        database
          .prepare("INSERT INTO plugin_job_pins VALUES (?,?,?)")
          .run("fixture-project", String(index), hash);
      await createCanvasProject(page, "排队验收");
      await page.getByRole("button", { name: /^图片生成 文字或参考图/ }).click();
      await page.mouse.click(420, 210);
      await page.locator(".react-flow__node .node-media").click({ position: { x: 30, y: 30 } });
      const editor = page.getByRole("textbox", { name: "生成提示词" });
      await editor.fill("生成海报");
      const submit = page.getByRole("button", { name: "开始生成" });
      await submit.click();
      const reason = "排队任务已达上限，请等前面的任务完成后再试";
      await expect(page.getByText(reason, { exact: true })).toBeVisible();
      expect(calls).toBe(0);
      database
        .prepare(
          "DELETE FROM plugin_job_pins WHERE project='fixture-project' AND job IN ('18','19')",
        )
        .run();
      await submit.click();
      await expect(
        page.getByRole("status").filter({ hasText: `有 1 张没能提交：${reason}` }),
      ).toBeVisible();
      await projectAction(page, "生成任务");
      await expect(
        page.getByRole("region", { name: "生成任务中心" }).getByText("已完成", { exact: true }),
      ).toHaveCount(2);
      expect(calls).toBe(2);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
