import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Binding,
  buildHostRequest,
  mockLoopbackTransport,
  ProviderHost,
} from "../../packages/provider-runtime/src/host";
import { inspectPlugin, validateResult } from "../../packages/provider-runtime/src/plugin";
import { PluginRunner, sourceHash } from "../../packages/provider-runtime/src/runner";

const runner = new PluginRunner(
  process.env.LINK_STUDIO_PROVIDER_RUNNER ?? join(process.cwd(), "out/provider-runtime/runner"),
);
const plugins: Record<string, string> = {};
const requests: { path: string; method: string; auth?: string; body: string; type?: string }[] = [];
let server: Server;
let baseUrl: string;
let host: ProviderHost;

function context(input: object = {}, task: object = {}, settings: object = {}) {
  return {
    channel: { baseUrl, settings },
    model: { upstreamModel: "gpt-image-1" },
    input: { prompt: "灵可 mock", ...input },
    task,
    now: 1760000000,
  };
}

function binding(source: string): Binding {
  return { source, approvedHash: sourceHash(source), baseUrl, secret: "fake-host-only-key" };
}

function fixture(hook: string, extra = "", kind = "text", mode = "sync", auth = "bearer") {
  return `module.exports = {
    meta: { apiVersion: 1, key: 'fixture', name: 'Fixture', auth: {type: '${auth}'}, endpoints: {${kind}: {mode: '${mode}'}} },
    buildSubmitRequest: function(ctx) { ${hook} },
    parseSubmitResponse: function(ctx,resp) { return {immediate:{status:'succeeded',outputs:[{type:'text',text:'ok'}]}}; }
    ${extra}
  };`;
}

beforeAll(async () => {
  for (const name of ["openai", "openai-image", "sora", "doubao-video"]) {
    plugins[name] = await readFile(
      join(process.cwd(), `resources/provider-plugins/${name}.js`),
      "utf8",
    );
  }
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      method: request.method ?? "",
      auth: request.headers.authorization,
      body: Buffer.concat(chunks).toString(),
      type: request.headers["content-type"],
    });
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (path === "/slow") return;
    if (path === "/redirect") {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      response.end("{}");
      return;
    }
    if (path === "/retry") {
      response.writeHead(429);
      response.end(JSON.stringify({ error: { message: "mock rate limit" } }));
      return;
    }
    if (path === "/echo-secret") {
      response.end(JSON.stringify({ echoed: request.headers.authorization }));
      return;
    }
    if (path === "/v1/videos/video-mock/content") {
      response.setHeader("content-type", "video/mp4");
      response.end(Buffer.from("synthetic-mp4-placeholder"));
      return;
    }
    if (path.includes("/images/"))
      response.end(JSON.stringify({ data: [{ url: "https://media.example/image.png" }] }));
    else if (path === "/v1/responses")
      response.end(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "灵可文本结果" }] }],
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
      );
    else if (path === "/v1/chat/completions")
      response.end(JSON.stringify({ choices: [{ message: { content: "兼容 Chat" } }] }));
    else if (path === "/v1/videos") response.end(JSON.stringify({ id: "video-mock" }));
    else if (path === "/v1/videos/video-mock")
      response.end(JSON.stringify({ status: "completed", progress: 100 }));
    else if (path.endsWith("/tasks")) response.end(JSON.stringify({ id: "ark-mock" }));
    else if (path.endsWith("/tasks/ark-mock"))
      response.end(
        JSON.stringify({
          status: "succeeded",
          content: { video_url: "https://media.example/video.mp4" },
        }),
      );
    else response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock 未监听");
  baseUrl = `http://127.0.0.1:${address.port}`;
  host = new ProviderHost(runner, mockLoopbackTransport([baseUrl]));
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(process.platform !== "darwin")("M0-02 Provider Runtime", () => {
  it("固定提交的插件来源/hash 可复核，text/image/async video 清单通过", async () => {
    const provenance = JSON.parse(
      await readFile("resources/provider-plugins/provenance.json", "utf8"),
    );
    for (const [name, source] of Object.entries(plugins)) {
      expect(sourceHash(source)).toBe(provenance.sha256[`resources/provider-plugins/${name}.js`]);
      const plugin = await inspectPlugin(runner, source);
      expect(plugin.key).toBe(name);
      expect(plugin.hooks).toContain("buildSubmitRequest");
      expect(plugin.hash).toBe(sourceHash(source));
    }
  });

  it("OpenAI Responses 和 Chat 插件完成真实回环 HTTP 及结果转换", async () => {
    const selected = binding(plugins.openai ?? "");
    const result = await host.invoke(selected, "submit", context());
    expect(result).toMatchObject({
      immediate: { status: "succeeded", outputs: [{ type: "text", text: "灵可文本结果" }] },
    });
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/responses",
      auth: "Bearer fake-host-only-key",
    });
    const chat = await host.invoke(
      selected,
      "submit",
      context({}, {}, { api: "chat_completions" }),
    );
    expect(chat).toMatchObject({ immediate: { outputs: [{ text: "兼容 Chat" }] } });
  });

  it("OpenAI 图片生成和参考图片编辑走 image_json 与 multipart", async () => {
    const selected = binding(plugins["openai-image"] ?? "");
    expect(await host.invoke(selected, "submit", context())).toMatchObject({
      immediate: { status: "succeeded", outputs: [{ type: "url", media_type: "image" }] },
    });
    selected.media = {
      "input:images.0": {
        bytes: Buffer.from("synthetic-image-bytes"),
        mime: "image/png",
        filename: "reference.png",
      },
    };
    await host.invoke(selected, "submit", context({ images: ["input:images.0"] }));
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/images/edits",
      auth: "Bearer fake-host-only-key",
    });
    expect(requests.at(-1)?.body).toContain("synthetic-image-bytes");
    expect(requests.at(-1)?.body).toContain('name="image[]"');
    expect(requests.at(-1)?.type).toContain("multipart/form-data; boundary=");
  });

  it("Sora 参考素材直传、任务 ID 和跨调用 state 恢复，不重复 submit", async () => {
    const selected = binding(plugins.sora ?? "");
    selected.media = {
      "input:images.0": {
        bytes: Buffer.from("synthetic-image"),
        mime: "image/png",
        filename: "reference.png",
      },
    };
    const submitted = await host.invoke(
      selected,
      "submit",
      context({ images: ["input:images.0"] }),
    );
    expect(submitted.providerTaskId).toBe("video-mock");
    const queried = await host.invoke(
      selected,
      "query",
      context({}, { providerTaskId: submitted.providerTaskId }),
    );
    expect(queried).toMatchObject({ status: "running", progress: 99, state: { ready: true } });
    const next = await runner.call(selected.source, "buildQueryRequest", [
      context({}, { providerTaskId: submitted.providerTaskId, state: queried.state }),
    ]);
    expect(next).toMatchObject({ path: "/v1/videos/video-mock/content", responseType: "binary" });
    expect(
      await host.invoke(
        selected,
        "query",
        context(
          {},
          {
            providerTaskId: submitted.providerTaskId,
            state: queried.state,
          },
        ),
      ),
    ).toMatchObject({ status: "succeeded", outputs: [{ type: "asset" }] });
    expect(
      await runner.call(selected.source, "parseQueryResponse", [
        context(),
        { asset: { id: "mock-asset" } },
      ]),
    ).toMatchObject({ status: "succeeded", outputs: [{ type: "asset" }] });
    expect(
      await host.invoke(selected, "cancel", context({}, { providerTaskId: "video-mock" })),
    ).toEqual({ cancellation: "local_only" });
  });

  it("异步视频插件 submit/query 闭环；需要公网素材 URL 时在发送前明确拒绝", async () => {
    const selected = binding(plugins["doubao-video"] ?? "");
    const submitted = await host.invoke(selected, "submit", context());
    expect(submitted.providerTaskId).toBe("ark-mock");
    expect(
      await host.invoke(
        selected,
        "query",
        context({}, { providerTaskId: submitted.providerTaskId }),
      ),
    ).toMatchObject({ status: "succeeded", outputs: [{ url: "https://media.example/video.mp4" }] });
    const count = requests.length;
    selected.media = {
      "input:images.0": {
        bytes: Buffer.from("image"),
        mime: "image/png",
        filename: "reference.png",
      },
    };
    await expect(
      host.invoke(selected, "submit", context({ images: ["input:images.0"] })),
    ).rejects.toMatchObject({ code: "MEDIA_TRANSPORT_UNAVAILABLE" });
    expect(requests.length).toBe(count);
  });

  it("prepare、audio、query 和 cancel 用同一 Host，state 通过 JSON 重建", async () => {
    const source = fixture(
      "return {method:'POST',path:'/submit',json:{prepared:ctx.prepared}};",
      `,
      buildPrepareRequests:function(){return [{method:'POST',path:'/prepare'}];},
      parsePrepareResponses:function(ctx,resps){return {upload:'prepared-receipt'};},
      parseSubmitResponse:function(ctx,resp){return {providerTaskId:'audio-mock',state:{prepared:ctx.prepared}};},
      buildQueryRequest:function(ctx){return {method:'GET',path:'/audio/'+ctx.task.providerTaskId};},
      parseQueryResponse:function(ctx,resp){return {status:'succeeded',outputs:[{type:'url',url:'https://media.example/audio.wav',media_type:'audio'}],state:ctx.task.state};},
      buildCancelRequest:function(ctx){return {method:'DELETE',path:'/audio/'+ctx.task.providerTaskId};}
    `,
      "audio",
      "async",
    );
    const submitted = await host.invoke(binding(source), "submit", context());
    expect(submitted.state).toEqual({ prepared: { upload: "prepared-receipt" } });
    expect(JSON.parse(requests.at(-1)?.body ?? "{}")).toMatchObject({
      prepared: { upload: "prepared-receipt" },
    });
    const task = JSON.parse(JSON.stringify(submitted));
    expect(await host.invoke(binding(source), "query", context({}, task))).toMatchObject({
      status: "succeeded",
      state: task.state,
    });
    expect(await host.invoke(binding(source), "cancel", context({}, task))).toEqual({
      cancellation: "requested",
    });
    expect(requests.at(-1)?.method).toBe("DELETE");
  });

  it("密钥只在宿主同源注入，钩子无 Node/网络/进程/动态构造器能力", async () => {
    const source = fixture(`return {method:'POST',path:'/secrets',json:{
      credentials:typeof ctx.credentials, secret:typeof ctx.channel.secret,
      require:typeof require, process:typeof process, fetch:typeof fetch,
      timer:typeof setTimeout, promise:typeof Promise, eval:typeof eval,
      constructor:typeof (function(){}).constructor,
      generator:typeof Object.getPrototypeOf(function*(){}).constructor
    }};`);
    await host.invoke(binding(source), "submit", context());
    expect(new Set(Object.values(JSON.parse(requests.at(-1)?.body ?? "{}")))).toEqual(
      new Set(["undefined"]),
    );
    expect(requests.at(-1)?.body).not.toContain("fake-host-only-key");
    const plugin = await inspectPlugin(runner, source);
    const foreign = await buildHostRequest(
      { method: "GET", url: "https://media.example/output" },
      plugin,
      binding(source),
      context(),
    );
    expect(foreign.headers.authorization).toBeUndefined();
    const count = requests.length;
    await expect(
      host.invoke({ ...binding(source), approvedHash: "changed" }, "submit", context()),
    ).rejects.toMatchObject({ code: "PLUGIN_APPROVAL_REQUIRED" });
    await expect(
      host.invoke(binding(source), "submit", { ...context(), credentials: { apiKey: "no" } }),
    ).rejects.toMatchObject({ code: "PLUGIN_CONTEXT_INVALID" });
    expect(requests.length).toBe(count);
  });

  it("危险请求描述、metadata、越界媒体和非法输出都被拒绝", async () => {
    const source = fixture("return {method:'POST',path:'/test'};");
    const plugin = await inspectPlugin(runner, source);
    for (const descriptor of [
      { method: "POST", path: "//evil.example/" },
      { method: "POST", path: "/a/%2e%2e/b" },
      { method: "POST", path: "/ok", headers: { Authorization: "bad" } },
      { method: "POST", path: "/ok", headers: { test: "a\nb" } },
      { method: "POST", url: "file:///etc/passwd" },
      { method: "POST", url: "http://169.254.169.254/" },
      { method: "POST", path: "/ok", json: {}, form: {} },
      {
        method: "POST",
        path: "/ok",
        json: { image: { __fileRef: "input:images.0", as: "base64" } },
      },
    ])
      await expect(
        buildHostRequest(descriptor, plugin, binding(source), context()),
      ).rejects.toThrow();
    for (const result of [
      { status: "unknown" },
      { status: "succeeded", outputs: [] },
      { status: "failed", error: {} },
      { status: "succeeded", outputs: [{ type: "text", text: "x" }] },
    ]) {
      expect(() => validateResult(result, "image")).toThrow();
    }
  });

  it("base64/dataUrl 参考文件在宿主转换，utils 摘要与编码兼容", async () => {
    const source = fixture(
      "return {method:'POST',path:'/inline',json:{image:{__fileRef:'input:images.0',as:'dataUrl'}}};",
    );
    const selected = binding(source);
    selected.media = {
      "input:images.0": { bytes: Buffer.from("image"), mime: "image/png", filename: "a.png" },
    };
    await host.invoke(selected, "submit", context({ images: ["input:images.0"] }));
    expect(JSON.parse(requests.at(-1)?.body ?? "{}").image).toBe(
      `data:image/png;base64,${Buffer.from("image").toString("base64")}`,
    );
    const utility = fixture(
      "return {sha:utils.sha256('abc'),value:utils.base64Decode(utils.base64('灵可')),hmac:utils.hmacSHA256('key','message')};",
    );
    expect(await runner.call(utility, "buildSubmitRequest", [context()])).toMatchObject({
      sha: createHash("sha256").update("abc").digest("hex"),
      value: "灵可",
    });
  });

  it("HTTP 429 只分类不自动重发 submit，重定向拒绝，超时标记结果未知", async () => {
    const retry = fixture("return {method:'POST',path:'/retry'};");
    const before = requests.filter((request) => request.path === "/retry").length;
    await expect(host.invoke(binding(retry), "submit", context())).rejects.toMatchObject({
      code: "PROVIDER_RETRYABLE",
    });
    expect(requests.filter((request) => request.path === "/retry").length).toBe(before + 1);
    const redirect = fixture("return {method:'POST',path:'/redirect'};");
    await expect(host.invoke(binding(redirect), "submit", context())).rejects.toMatchObject({
      code: "PROVIDER_REDIRECT_BLOCKED",
    });
    const slow = fixture("return {method:'POST',path:'/slow'};");
    const timeoutHost = new ProviderHost(runner, mockLoopbackTransport([baseUrl], 30));
    await expect(timeoutHost.invoke(binding(slow), "submit", context())).rejects.toMatchObject({
      code: "PROVIDER_OUTCOME_UNKNOWN",
    });
  });

  it("顶层、getter、hook、toJSON 死循环均中断；输出与 state 有上限", async () => {
    for (const source of [
      "while(true){}",
      "Object.defineProperty(module.exports,'meta',{get:function(){while(true){}}});",
      fixture("while(true){}"),
      fixture("return {toJSON:function(){while(true){}}};"),
    ]) {
      const hook = source.startsWith("module.exports") ? "buildSubmitRequest" : "inspect";
      await expect(runner.call(source, hook, [context()])).rejects.toMatchObject({
        code: "PLUGIN_TIMEOUT",
      });
    }
    await expect(
      runner.call(fixture("return 'x'.repeat(1100000);"), "buildSubmitRequest", [context()]),
    ).rejects.toMatchObject({ code: "PLUGIN_OUTPUT_LIMIT" });
    expect(() =>
      validateResult({ status: "running", state: { text: "x".repeat(65536) } }, "text"),
    ).toThrow();
    await expect(runner.call("x".repeat(512 * 1024 + 1), "inspect")).rejects.toMatchObject({
      code: "PLUGIN_SOURCE_LIMIT",
    });
  }, 15_000);

  it("执行取消终止子进程，后续正常调用仍可用", async () => {
    const controller = new AbortController();
    const pending = runner.call(
      fixture("while(true){}"),
      "buildSubmitRequest",
      [context()],
      controller.signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "PLUGIN_CANCELLED" });
    controller.abort();
    await assertion;
    expect(
      await runner.call(fixture("return {alive:true};"), "buildSubmitRequest", [context()]),
    ).toEqual({ alive: true });
  });

  it("响应回显凭证先脱敏，插件异常不回传源码或异常正文", async () => {
    const source = fixture(
      "return {method:'POST',path:'/echo-secret'};",
      `,
      parseSubmitResponse:function(ctx,resp){return {immediate:{status:'succeeded',outputs:[{type:'text',text:resp.body.echoed}]}};}
    `,
    );
    expect(await host.invoke(binding(source), "submit", context())).toMatchObject({
      immediate: { outputs: [{ text: "Bearer [redacted]" }] },
    });
    await expect(
      runner.call(fixture("throw new Error('private-input-marker');"), "buildSubmitRequest", [
        context(),
      ]),
    ).rejects.toMatchObject({ message: "PLUGIN_EXECUTION_FAILED" });
  });

  it("async 缺 query、prepare 不成对、custom auth 和多类型清单明确拒绝", async () => {
    for (const source of [
      fixture("return {};", "", "video", "async"),
      fixture("return {};", ",buildPrepareRequests:function(){return [];}", "text"),
      fixture("return {};", "", "text", "sync", "custom"),
      fixture("return {};").replace(
        "text: {mode: 'sync'}",
        "text: {mode: 'sync'},image:{mode:'sync'}",
      ),
    ])
      await expect(inspectPlugin(runner, source)).rejects.toThrow();
  });

  it("超大内存分配受到 RSS 监测终止，宿主仍可继续调用", async () => {
    const source = fixture("var bytes=new Uint8Array(96*1024*1024);bytes.fill(7);while(true){}");
    await expect(runner.call(source, "buildSubmitRequest", [context()])).rejects.toMatchObject({
      code: "PLUGIN_MEMORY_LIMIT",
    });
    expect(
      await runner.call(fixture("return {alive:true};"), "buildSubmitRequest", [context()]),
    ).toEqual({ alive: true });
  });

  it("上游简写结果和 queued 状态规范化，写错类型仍拒绝", () => {
    expect(validateResult({ status: "queued", progress: -1 }, "video")).toMatchObject({
      status: "queued",
      progress: 0,
    });
    expect(validateResult({ status: "succeeded", outputs: ["正文"] }, "text")).toMatchObject({
      outputs: [{ type: "text", text: "正文" }],
    });
    expect(validateResult({ status: "failed", error: "mock failure" }, "video")).toMatchObject({
      error: { class: "terminal", message: "mock failure" },
    });
    expect(() =>
      validateResult({ status: "succeeded", outputs: [{ type: "text", text: "错类型" }] }, "video"),
    ).toThrow();
  });

  it("query 错误可用原句柄重试，取消已发出的 submit 仍是结果未知", async () => {
    const source = fixture(
      "return {method:'POST',path:'/slow'};",
      `,
      buildQueryRequest:function(ctx){return {method:'GET',path:'/retry'};},
      parseQueryResponse:function(ctx,resp){return {status:'running'};}
    `,
      "video",
      "async",
    );
    const task = { providerTaskId: "original-task", state: { attempt: 1 } };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(host.invoke(binding(source), "query", context({}, task))).rejects.toMatchObject({
        code: "PROVIDER_RETRYABLE",
      });
      expect(requests.at(-1)?.method).toBe("GET");
    }
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport = mockLoopbackTransport([baseUrl]);
    const abortHost = new ProviderHost(runner, (request, signal) => {
      const result = transport(request, signal);
      started();
      return result;
    });
    const result = abortHost.invoke(binding(source), "submit", context(), controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ code: "PROVIDER_OUTCOME_UNKNOWN" });
    await ready;
    controller.abort();
    await assertion;
  });

  it("Mock transport 仅接受明确列出的数字回环 origin，外部地址发出前阻止", async () => {
    const source = fixture("return {method:'GET',url:'http://localhost:1/private'};");
    await expect(host.invoke(binding(source), "submit", context())).rejects.toMatchObject({
      code: "PROVIDER_ENDPOINT_BLOCKED",
    });
    const source2 = fixture("return {method:'GET',url:'https://example.com/private'};");
    await expect(host.invoke(binding(source2), "submit", context())).rejects.toMatchObject({
      code: "PROVIDER_ENDPOINT_BLOCKED",
    });
  });
});
