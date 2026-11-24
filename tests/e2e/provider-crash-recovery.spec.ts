import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";
import { createCanvasProject, projectAction } from "./workspace-actions";

const source = `module.exports={
  meta:{key:'crash-image',name:'Crash image',apiVersion:1,auth:{type:'bearer'},endpoints:{image:{mode:'async'}},poll:{firstDelay:0.1,interval:0.1}},
  buildSubmitRequest:function(){return {method:'POST',path:'/jobs',json:{}}},
  parseSubmitResponse:function(ctx,resp){return {providerTaskId:resp.body.id,state:'status'}},
  buildQueryRequest:function(ctx){return {method:'GET',path:'/jobs/'+ctx.task.providerTaskId+'/'+ctx.task.state,responseType:ctx.task.state==='status'?'json':'binary'}},
  parseQueryResponse:function(ctx,resp){return resp.asset?{status:'succeeded',outputs:[{type:'asset'}]}:{status:'running',progress:42,state:resp.body.cursor}}
}`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
  "base64",
);

for (const flow of ["模型试跑", "工程任务"] as const) {
  test(`${flow}：主进程被强制终止后仅凭原回执与游标续查`, async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-provider-crash-"));
    const receipt = randomUUID(),
      cursor = randomUUID();
    const status = `/jobs/${receipt}/status`,
      next = `/jobs/${receipt}/${cursor}`;
    const calls: string[] = [];
    let recovering = false;
    let resumedQuery: ServerResponse | undefined;
    const server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      request.resume();
      if (request.url === next && request.method === "GET") {
        if (recovering) resumedQuery = response;
        return;
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/jobs" && request.method === "POST")
        response.end(JSON.stringify({ id: receipt }));
      else if (request.url === status && request.method === "GET")
        response.end(JSON.stringify({ cursor }));
      else response.writeHead(404).end("{}");
    });
    let app: ElectronApplication | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("缺少回环服务");
      const env = {
        ...process.env,
        LINK_STUDIO_TEST_USER_DATA: root,
        LINK_STUDIO_TEST_PROJECT_PARENT: root,
      };
      delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
      const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
      const launch = () =>
        electron.launch({ ...(executablePath ? { executablePath } : { args: ["."] }), env });
      app = await launch();
      let page = await app.firstWindow();
      await page.evaluate(
        async ({ port, source }) => {
          const api = window.desktop.settings;
          const channel = await api.channelSave({
            expectedRevision: 0,
            approve: true,
            secret: "fixture-key",
            fields: {
              name: "本地夹具",
              endpoint: `http://127.0.0.1:${port}`,
              allowLocal: true,
              enabled: true,
              sort: 1,
              headers: [],
            },
          });
          if (!channel.ok) throw Error(channel.code);
          const plugin = await api.draft({ source });
          if (!plugin.ok) throw Error(plugin.code);
          const model = await api.modelSave({
            channelId: channel.value.id,
            channelRevision: channel.value.revision,
            expectedRevision: 0,
            approve: true,
            upstreamModel: "恢复测试",
            pluginHash: plugin.value.hash,
            enabled: true,
            settings: {},
            config: { kind: "image", name: "恢复测试", sort: 1, description: "" },
          });
          if (!model.ok) throw Error(model.code);
        },
        { port: address.port, source },
      );
      const openTrial = async () => {
        await page.getByRole("button", { name: "应用设置" }).click();
        await page.getByRole("button", { name: "测试 恢复测试", exact: true }).click();
        return page.getByRole("dialog", { name: "测试 恢复测试" });
      };
      if (flow === "模型试跑") {
        const dialog = await openTrial();
        await dialog.getByLabel("测试提示词").fill("恢复测试");
        await dialog.getByRole("button", { name: "开始测试" }).click();
      } else {
        await createCanvasProject(page, "原回执验收");
        await page.getByRole("button", { name: /^图片生成 文字或参考图/ }).click();
        await page.locator('.react-flow__node.selected article[data-card-kind="image"]').click();
        await page.getByRole("textbox", { name: "生成提示词" }).fill("恢复测试");
        await page.getByRole("button", { name: "开始生成" }).click();
      }
      const beforeCrash = ["POST /jobs", `GET ${status}`, `GET ${next}`];
      await expect.poll(() => calls, { timeout: 10000 }).toEqual(beforeCrash);
      const child = app.process();
      const exited = once(child, "exit");
      expect(child.kill("SIGKILL")).toBe(true);
      expect(await exited).toEqual([null, "SIGKILL"]);
      app = undefined;
      recovering = true;
      app = await launch();
      page = await app.firstWindow();
      const finishQuery = async () => {
        await expect.poll(() => calls).toEqual([...beforeCrash, `GET ${next}`]);
        if (!resumedQuery) throw Error("未收到重启后的续查");
        resumedQuery.setHeader("content-type", "image/png").end(png);
      };
      if (flow === "模型试跑") {
        const dialog = await openTrial();
        await expect(dialog.getByRole("progressbar")).toHaveAttribute("value", "42");
        await finishQuery();
        await expect(dialog.getByRole("tab", { name: "追踪" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await dialog.getByRole("tab", { name: "结果", exact: true }).click();
        await expect(dialog.getByRole("status").filter({ hasText: "试跑任务" })).toContainText(
          "succeeded",
        );
        const image = dialog.getByRole("img", { name: "试跑产物" });
        await expect(image).toHaveCount(1);
        await expect
          .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
          .toBe(2);
      } else {
        await page.getByRole("button", { name: /^原回执验收/ }).click();
        await finishQuery();
        const image = page.locator(".react-flow__node .node-media img");
        await expect(image).toHaveCount(1);
        await expect
          .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
          .toBe(2);
        await projectAction(page, "生成任务");
        await expect(
          page.getByRole("region", { name: "生成任务中心" }).getByText("已完成", { exact: true }),
        ).toHaveCount(1);
      }
      expect(calls).toEqual([...beforeCrash, `GET ${next}`]);
    } finally {
      await app?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
