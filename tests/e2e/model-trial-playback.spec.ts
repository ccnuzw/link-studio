import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("试跑视频链接和二进制音频在结果页播放并跳转", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "trial-playback-"));
  const ffmpeg = join(
    process.env.LINK_STUDIO_MEDIA_BINARIES ?? `out/media/${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  const mediaRequests: (string | undefined)[] = [];
  let expired = false;
  let holdSecond = false;
  let holdImage = true;
  let imageSubmissions = 0;
  let imageDownloads = 0;
  let holdSigned = true;
  let staleAt = 0;
  let renewedAt = 0;
  const signedRequests: string[] = [];
  let videoSubmissions = 0;
  let secondAttempts = 0;
  let holdReceipt = false;
  const videoJobRequests: string[] = [];
  let finishVideo!: () => void;
  const videoReady = new Promise<void>((resolve) => {
    finishVideo = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/jobs")) {
      videoJobRequests.push(`${request.method} ${request.url}`);
      if (holdReceipt && request.url === "/jobs") return;
      response.setHeader("content-type", "application/json");
      if (request.url === "/jobs") response.end(JSON.stringify({ id: "fixture-job" }));
      else if (request.url === "/jobs/fixture-job/status")
        response.end(JSON.stringify({ progress: 42, cursor: "next" }));
      else if (request.url === "/jobs/fixture-job/next") {
        await videoReady;
        response
          .setHeader("content-type", "video/mp4")
          .end(await readFile(join(root, "video.mp4")));
      } else response.writeHead(404).end();
    } else if (request.url?.startsWith("/signed/")) {
      signedRequests.push(`${request.method} ${request.url}`);
      switch (request.url) {
        case "/signed/new":
          response.setHeader("content-type", "application/json").end('{"id":"task"}');
          break;
        case "/signed/task/status":
        case "/signed/task/renew": {
          const filename = request.url.endsWith("/renew") ? "fresh" : "old";
          if (filename === "fresh") renewedAt = Date.now();
          response
            .setHeader("content-type", "application/json")
            .end(JSON.stringify({ url: `http://${request.headers.host}/signed/${filename}` }));
          break;
        }
        case "/signed/old":
          if (!holdSigned) {
            staleAt = Date.now();
            response.writeHead(403).end();
          }
          break;
        case "/signed/fresh":
          response
            .setHeader("content-type", "image/png")
            .end(await readFile(join(root, "linked.png")));
          break;
        default:
          response.writeHead(404).end();
      }
    } else if (request.url === "/mixed") {
      imageSubmissions++;
      const inline = await readFile(join(root, "inline.png"));
      response.setHeader("content-type", "application/json").end(
        JSON.stringify({
          data: [
            { url: `http://${request.headers.host}/linked.png` },
            { b64_json: inline.toString("base64") },
          ],
        }),
      );
    } else if (request.url === "/linked.png") {
      imageDownloads++;
      if (!holdImage)
        response
          .setHeader("content-type", "image/png")
          .end(await readFile(join(root, "linked.png")));
    } else if (request.url === "/video") {
      videoSubmissions++;
      response.setHeader("content-type", "application/json").end(
        JSON.stringify({
          url: `http://${request.headers.host}/output?signature=fixture`,
          ...(holdSecond && { second: `http://${request.headers.host}/second` }),
        }),
      );
    } else if (request.url === "/second") {
      secondAttempts++;
      if (!holdSecond)
        response
          .setHeader("content-type", "video/mp4")
          .end(await readFile(join(root, "video.mp4")));
    } else if (request.url === "/output?signature=fixture") {
      mediaRequests.push(request.headers.authorization);
      if (expired) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader("content-type", "video/mp4").end(await readFile(join(root, "video.mp4")));
    } else if (request.url === "/audio")
      response.setHeader("content-type", "audio/wav").end(await readFile(join(root, "audio.wav")));
    else response.writeHead(404).end();
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=size=64x48:rate=10",
      "-t",
      "2",
      "-c:v",
      process.platform === "darwin" ? "h264_videotoolbox" : "libx264",
      "-pix_fmt",
      "yuv420p",
      join(root, "video.mp4"),
    ]);
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono,aformat=sample_fmts=s16",
      "-t",
      "2",
      join(root, "audio.wav"),
    ]);
    for (const [name, width] of [
      ["linked", 32],
      ["inline", 64],
    ] as const)
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=size=${width}x16`,
        "-frames:v",
        "1",
        join(root, `${name}.png`),
      ]);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少回环服务");
    const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: root };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    const launch = () =>
      electron.launch({
        ...(executablePath ? { executablePath } : { args: ["."] }),
        env,
      });
    app = await launch();
    let page = await app.firstWindow();
    const restart = async () => {
      await app?.close();
      app = await launch();
      page = await app.firstWindow();
      await page.getByRole("button", { name: "模型设置" }).click();
    };
    await page.evaluate(async (port) => {
      const api = window.desktop.settings;
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-key",
        fields: {
          name: "试跑结果",
          endpoint: `http://127.0.0.1:${port}`,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw new Error(channel.code);
      for (const name of ["audio", "video", "async-video", "mixed", "signed"] as const) {
        const kind =
          name === "mixed" || name === "signed" ? "image" : name === "async-video" ? "video" : name;
        const source =
          name === "signed"
            ? `module.exports={
            meta:{key:'play-signed',name:'Signed',apiVersion:1,auth:{type:'bearer'},endpoints:{image:{mode:'async'}},poll:{firstDelay:0.1,interval:0.1,maxInterval:0.2}},
            buildSubmitRequest:function(){return {method:'POST',path:'/signed/new',json:{}}},
            parseSubmitResponse:function(ctx,resp){return {providerTaskId:resp.body.id,state:'status'}},
            buildQueryRequest:function(ctx){return {method:'GET',path:'/signed/'+ctx.task.providerTaskId+'/'+ctx.task.state}},
            parseQueryResponse:function(ctx,resp){return {status:'succeeded',state:'renew',outputs:[{type:'url',url:resp.body.url}]}}
          }`
            : name === "mixed"
              ? `module.exports={
            meta:{key:'play-mixed',name:'Mixed',apiVersion:1,auth:{type:'bearer'},endpoints:{image:{mode:'sync'}}},
            buildSubmitRequest:function(){return {method:'POST',path:'/mixed',json:{},responseType:'image_json'}},
            parseSubmitResponse:function(ctx,resp){return {immediate:{status:'succeeded',outputs:[
              {type:'url',url:resp.body.data[0].url},{type:'asset',asset_index:resp.body.data[1].asset_index}
            ]}}}
          }`
              : name === "async-video"
                ? `module.exports={
          meta:{key:'play-async-video',name:'Play',apiVersion:1,auth:{type:'bearer'},endpoints:{video:{mode:'async'}},poll:{firstDelay:0.1,interval:0.1,maxInterval:0.2}},
          buildSubmitRequest:function(){return {method:'POST',path:'/jobs',json:{}}},
          parseSubmitResponse:function(ctx,resp){return {providerTaskId:resp.body.id,state:{cursor:'status'}}},
          buildQueryRequest:function(ctx){var cursor=ctx.task.state.cursor;return {method:'GET',path:'/jobs/'+ctx.task.providerTaskId+'/'+cursor,responseType:cursor==='status'?'json':'binary'}},
          parseQueryResponse:function(ctx,resp){return resp.asset?{status:'succeeded',outputs:[{type:'asset',text:'caption'}]}:{status:'running',progress:resp.body.progress,state:{cursor:resp.body.cursor}}}
        }`
                : `module.exports={meta:{key:'play-${kind}',name:'Play',apiVersion:1,auth:{type:'bearer'},endpoints:{${kind}:{mode:'sync'}}},buildSubmitRequest:function(){return {method:'GET',path:'/${kind}',responseType:'${kind === "audio" ? "binary" : "json"}'}},parseSubmitResponse:function(ctx,resp){var outputs=[${kind === "audio" ? "{type:'asset'}" : "{type:'url',url:resp.body.url}"}];if(resp.body && resp.body.second)outputs.push({type:'url',url:resp.body.second});return {immediate:{status:'succeeded',outputs:outputs}}}}`;
        const plugin = await api.draft({ source });
        if (!plugin.ok) throw new Error(plugin.code);
        const model = await api.modelSave({
          channelId: channel.value.id,
          channelRevision: channel.value.revision,
          expectedRevision: 0,
          upstreamModel: name,
          pluginHash: plugin.value.hash,
          settings: {},
          enabled: false,
          config: {
            kind,
            name,
            sort: 1,
            description: "",
            ...(name === "signed" && { timeoutSeconds: 5 }),
          },
        });
        if (!model.ok) throw new Error(model.code);
      }
    }, address.port);
    await page.getByRole("button", { name: "模型设置" }).click();
    for (const name of ["video", "audio", "async-video"]) {
      const kind = name === "async-video" ? "video" : name;
      await page.getByRole("button", { name: `测试 ${name}`, exact: true }).click();
      let dialog = page.getByRole("dialog", { name: `测试 ${name}` });
      await dialog.getByLabel("测试提示词").fill("播放回归");
      await dialog.getByRole("button", { name: "开始测试" }).click();
      if (name === "async-video") {
        await expect(dialog.getByRole("progressbar", { name: "试跑进度" })).toHaveAttribute(
          "value",
          "42",
          { timeout: 8000 },
        );
        await restart();
        const requestsBeforeRecovery = videoJobRequests.length;
        await page.getByRole("button", { name: `测试 ${name}`, exact: true }).click();
        dialog = page.getByRole("dialog", { name: `测试 ${name}` });
        await expect(dialog.getByRole("progressbar")).toHaveAttribute("value", "42");
        await expect(dialog.getByRole("button", { name: "开始测试" })).toBeDisabled();
        await expect
          .poll(() => videoJobRequests.slice(requestsBeforeRecovery))
          .toContain("GET /jobs/fixture-job/next");
        finishVideo();
      }
      await expect(dialog.getByRole("tab", { name: "追踪" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      if (name !== "async-video") {
        const audio = name === "audio";
        const media = await stat(join(root, audio ? "audio.wav" : "video.mp4"));
        const summary = `<binary ${audio ? "audio/wav" : "video/mp4"} ${media.size} bytes>`;
        await dialog
          .getByRole("button", { name: audio ? /http.*\/audio.*200/ : /http.*下载试跑产物.*200/ })
          .click();
        await expect(dialog.getByRole("region", { name: "响应体" })).toHaveText(`响应体${summary}`);
        await page.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text: string) => {
                document.body.dataset.trace = text;
              },
            },
          }),
        );
        await dialog.getByRole("button", { name: "复制全部（JSON）" }).click();
        const trace = await page.locator("body").getAttribute("data-trace");
        expect(trace).toContain(summary);
        expect(trace).not.toMatch(/fixture-key|signature|\/output/);
      }
      await dialog.getByRole("tab", { name: "结果", exact: true }).click();
      const player = dialog.locator(kind);
      await expect(player).toHaveAttribute("src", /^link-media:\/\/trial\//);
      await expect
        .poll(() => player.evaluate((element: HTMLMediaElement) => element.duration))
        .toBeCloseTo(2, 1);
      await player.evaluate(async (element: HTMLMediaElement) => {
        element.muted = true;
        element.currentTime = 1;
        await element.play();
      });
      await expect
        .poll(() => player.evaluate((element: HTMLMediaElement) => element.currentTime))
        .toBeGreaterThan(1.1);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      if (name === "async-video") {
        await restart();
        await page.getByRole("button", { name: `测试 ${name}`, exact: true }).click();
        dialog = page.getByRole("dialog", { name: `测试 ${name}` });
        await expect
          .poll(() =>
            dialog.locator("video").evaluate((element: HTMLMediaElement) => element.duration),
          )
          .toBeCloseTo(2, 1);
        await dialog.locator("video").evaluate(async (video: HTMLVideoElement) => {
          video.muted = true;
          await video.play();
        });
        await expect
          .poll(() =>
            dialog.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime),
          )
          .toBeGreaterThan(0.1);
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      }
    }
    holdSecond = true;
    await page.getByRole("button", { name: "测试 video", exact: true }).click();
    let multiple = page.getByRole("dialog", { name: "测试 video" });
    await multiple.getByLabel("测试提示词").fill("恢复两份产物");
    await multiple.getByRole("button", { name: "开始测试" }).click();
    await expect.poll(() => secondAttempts).toBe(1);
    await restart();
    holdSecond = false;
    await page.getByRole("button", { name: "测试 video", exact: true }).click();
    multiple = page.getByRole("dialog", { name: "测试 video" });
    await expect(multiple.getByRole("tab", { name: "追踪" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await multiple.getByRole("tab", { name: "结果", exact: true }).click();
    await expect(multiple.locator("video")).toHaveCount(2);
    for (const player of await multiple.locator("video").all())
      await expect
        .poll(() => player.evaluate((video: HTMLVideoElement) => video.duration))
        .toBeCloseTo(2, 1);
    expect(videoSubmissions).toBe(2);
    expect(mediaRequests).toHaveLength(2);
    expect(secondAttempts).toBe(2);
    await multiple.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "测试 mixed", exact: true }).click();
    let mixed = page.getByRole("dialog", { name: "测试 mixed" });
    await mixed.getByLabel("测试提示词").fill("恢复混合图片");
    await mixed.getByRole("button", { name: "开始测试" }).click();
    await expect.poll(() => imageDownloads).toBe(1);
    expect(await page.evaluate(() => window.desktop.settings.channelLoads({}))).toEqual({
      ok: true,
      value: [],
    });
    await restart();
    holdImage = false;
    await page.getByRole("button", { name: "测试 mixed", exact: true }).click();
    mixed = page.getByRole("dialog", { name: "测试 mixed" });
    await expect(mixed.getByRole("tab", { name: "追踪" })).toHaveAttribute("aria-selected", "true");
    await mixed.getByRole("tab", { name: "结果", exact: true }).click();
    const images = mixed.getByRole("img", { name: "试跑产物" });
    await expect
      .poll(() =>
        images.evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).naturalWidth)),
      )
      .toEqual([32, 64]);
    expect(imageSubmissions).toBe(1);
    expect(imageDownloads).toBe(2);
    await mixed.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "测试 signed", exact: true }).click();
    let signed = page.getByRole("dialog", { name: "测试 signed" });
    await signed.getByLabel("测试提示词").fill("签名刷新");
    await signed.getByRole("button", { name: "开始测试" }).click();
    await expect.poll(() => signedRequests).toContain("GET /signed/old");
    await restart();
    holdSigned = false;
    await page.getByRole("button", { name: "测试 signed", exact: true }).click();
    signed = page.getByRole("dialog", { name: "测试 signed" });
    await signed.getByRole("tab", { name: "追踪" }).click();
    await expect(signed.getByRole("button", { name: /下载试跑产物.*403/ })).toBeVisible({
      timeout: 7000,
    });
    await restart();
    await page.getByRole("button", { name: "测试 signed", exact: true }).click();
    signed = page.getByRole("dialog", { name: "测试 signed" });
    await expect(signed.getByRole("tab", { name: "追踪" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 18_000 },
    );
    await signed.getByRole("tab", { name: "结果", exact: true }).click();
    await expect
      .poll(() =>
        signed
          .getByRole("img", { name: "试跑产物" })
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(32);
    expect(signedRequests).toEqual([
      "POST /signed/new",
      "GET /signed/task/status",
      "GET /signed/old",
      "GET /signed/old",
      "GET /signed/task/renew",
      "GET /signed/fresh",
    ]);
    expect(renewedAt - staleAt).toBeGreaterThanOrEqual(7950);
    await signed.getByRole("button", { name: "关闭", exact: true }).click();
    expired = true;
    await page.getByRole("button", { name: "测试 video", exact: true }).click();
    const failed = page.getByRole("dialog", { name: "测试 video" });
    await failed.getByLabel("测试提示词").fill("再次试跑");
    await failed.getByRole("button", { name: "开始测试" }).click();
    const download = failed.getByRole("button", { name: /http · 失败.*下载试跑产物.*403/ });
    await expect(download).toHaveAttribute("aria-expanded", "true");
    await expect(failed.getByRole("alert").filter({ hasText: "上游已完成生成" })).toContainText(
      "下载试跑产物失败",
    );
    await expect(failed.getByRole("region", { name: "追踪时间线" }).getByRole("alert")).toHaveText(
      "MODEL_TRIAL_DOWNLOAD_FAILED",
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.body.dataset.trace = text;
          },
        },
      }),
    );
    await failed.getByRole("button", { name: "复制全部（JSON）" }).click();
    const trace = await page.locator("body").getAttribute("data-trace");
    expect(
      JSON.parse(trace ?? "[]").map(
        (step: { hook?: string; phase: string }) => step.hook ?? step.phase,
      ),
    ).toEqual(["buildSubmitRequest", "submit", "parseSubmitResponse", "finalizing"]);
    expect(trace).not.toMatch(/fixture-key|signature|\/output|再次试跑/);
    expect(mediaRequests).toEqual([undefined, undefined, undefined]);
    expect(videoJobRequests.filter((request) => request !== "GET /jobs/fixture-job/next")).toEqual([
      "POST /jobs",
      "GET /jobs/fixture-job/status",
    ]);
    await failed.getByRole("button", { name: "关闭", exact: true }).click();
    holdReceipt = true;
    await page.getByRole("button", { name: "测试 async-video", exact: true }).click();
    const pending = page.getByRole("dialog", { name: "测试 async-video" });
    await pending.getByLabel("测试提示词").fill("回执中断");
    await pending.getByRole("button", { name: "开始测试" }).click();
    await expect
      .poll(() => videoJobRequests.filter((request) => request === "POST /jobs").length)
      .toBe(2);
    const beforeExit = [...videoJobRequests];
    await restart();
    await page.getByRole("button", { name: "测试 async-video", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "测试 async-video" }).getByRole("alert"),
    ).toContainText("结果未知，请核对上游状态");
    expect(videoJobRequests).toEqual(beforeExit);
  } finally {
    finishVideo();
    await app?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
