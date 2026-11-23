import { once } from "node:events";
import { createServer } from "node:http";
import { expect } from "@playwright/test";

export async function pendingImageProvider(page, png) {
  let reply;
  const server = createServer((request, response) => {
    if (request.url !== "/v1/images/generations") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    reply = response;
  }).listen(0, "127.0.0.1");
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  try {
    await once(server, "listening");
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings,
        list = await settings.list({});
      const plugin = list.ok && list.value.plugins.find((entry) => entry.key === "openai-image");
      if (!plugin) throw Error("缺少图片适配器");
      const result = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-key",
        fields: {
          label: "回填对照",
          endpoint,
          model: "gpt-image-1",
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!result.ok) throw Error(result.code);
    }, `http://127.0.0.1:${server.address().port}`);
    return {
      close,
      finish: async (failed) => {
        await expect.poll(() => Boolean(reply)).toBe(true);
        reply
          .writeHead(failed ? 400 : 200, { "content-type": "application/json" })
          .end(
            JSON.stringify(
              failed ? { error: { message: "图片生成被拒绝" } } : { data: [{ b64_json: png }] },
            ),
          );
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

export const taskSetup = `import {useTasksStore} from '/src/store/tasks';import {makeTask,succeeded} from '/src/tests/utils/tasks/fixtures';
  const task={id:123,canvas_id:'1001',node_id:'video',kind:'image'};
  useTasksStore.getState().upsert(makeTask(task));window.finishFixtureTask=failed=>useTasksStore.getState().upsert(failed?makeTask({...task,version:5,status:'failed',error_message:'图片生成被拒绝'}):succeeded({...task,outputs:[{asset_id:77,url:'/audit-output.png',media_type:'image',width:32,height:32}]}));`;

export async function startDesktopImage(page) {
  await page.locator("article[data-card-kind=image]").click({ position: { x: 32, y: 32 } });
  await page.getByRole("button", { name: "开始生成", exact: true }).click();
}
