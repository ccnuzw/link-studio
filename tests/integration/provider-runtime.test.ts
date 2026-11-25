import { createHash, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { providerInput } from "../../packages/link-studio-core/src/provider-input";
import { checkDraft } from "../../packages/provider-runtime/src/draft";
import {
  type Binding,
  buildHostRequest,
  mockLoopbackTransport,
  ProviderHost,
  type ReferenceMedia,
} from "../../packages/provider-runtime/src/host";
import { inspectPlugin, validateResult } from "../../packages/provider-runtime/src/plugin";
import { PluginRunner, sourceHash } from "../../packages/provider-runtime/src/runner";
import { requireTestValue } from "../require-test-value";

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
  for (const name of (await readdir("resources/provider-plugins"))
    .filter((entry) => entry.endsWith(".js"))
    .sort()) {
    const key = name.slice(0, -3);
    plugins[key] = await readFile(
      join(process.cwd(), `resources/provider-plugins/${name}`),
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
    else if (path === "/v1/videos/video-mock")
      response.end(JSON.stringify({ status: "completed", progress: 100 }));
    else if (path === "/v1/videos") response.end(JSON.stringify({ id: "video-mock" }));
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
  it("Agent 元数据仍校验提交与异步查询，但不进入离线或线上执行", async () => {
    const source = fixture("throw Error('不应执行')", "", "agent");
    const plugin = await inspectPlugin(runner, source);
    expect(plugin.kind).toBe("agent");
    const invalid = `${fixture("", "", "agent", "async")}\ndelete module.exports.buildSubmitRequest`;
    await expect(inspectPlugin(runner, invalid)).rejects.toMatchObject({
      issues: [
        {
          path: "meta.endpoints.agent.mode",
          message: expect.stringContaining("buildQueryRequest"),
        },
        {
          path: "meta.endpoints.agent.mode",
          message: expect.stringContaining("parseQueryResponse"),
        },
        { path: "exports.buildSubmitRequest" },
      ],
    });
    const call = vi.spyOn(runner, "call");
    const trace = vi.spyOn(runner, "trace");
    const transport = vi.fn(mockLoopbackTransport([baseUrl]));
    try {
      await expect(checkDraft(runner, source)).resolves.toMatchObject({
        ok: false,
        checkedHooks: [],
        issues: ["Agent 走原生网关，不执行插件钩子"],
      });
      await expect(
        new ProviderHost(runner, transport).invoke(binding(source), "submit", context()),
      ).rejects.toMatchObject({ code: "AGENT_MODEL_INCOMPATIBLE" });
      await expect(
        buildHostRequest({ method: "GET", path: "/" }, plugin, binding(source), context()),
      ).rejects.toMatchObject({ code: "AGENT_MODEL_INCOMPATIBLE" });
      expect(call.mock.calls.map(([, hook]) => hook)).toEqual(["inspect", "inspect"]);
      expect(trace).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      call.mockRestore();
      trace.mockRestore();
    }
  });
  it("预检汇总独立字段和缺失钩子，错误对象不会打断其他路径检查", async () => {
    const source = `${fixture("")}\nmodule.exports.meta.auth = null;
      module.exports.meta.channelSettings = { region: false, size: { type: 'enum', label: '', options: {} } };
      module.exports.meta.poll = {jitter: 2}; delete module.exports.parseSubmitResponse;`;
    await expect(inspectPlugin(runner, source)).rejects.toMatchObject({
      code: "PLUGIN_MANIFEST_INVALID",
      issues: [
        "meta.auth",
        "exports.parseSubmitResponse",
        "meta.channelSettings.region",
        "meta.channelSettings.size.options",
        "meta.channelSettings.size.label",
        "meta.channelSettings.size.options",
        "meta.poll.jitter",
      ].map((path) => ({ path })),
    });
  });
  it("缺少 meta 及不同鉴权声明按原字段顺序定位，保留请求头独立提示", async () => {
    const inspect = (edit: string) => inspectPlugin(runner, `${fixture("")}\n${edit}`);
    await expect(inspect("delete module.exports.meta")).rejects.toMatchObject({
      issues: [{ path: "meta", message: "插件必须导出 meta 对象" }],
    });
    await expect(
      inspect(
        "module.exports.meta.auth={type:'header',name:123};delete module.exports.buildSubmitRequest",
      ),
    ).rejects.toMatchObject({
      issues: [
        { path: "meta.auth.name", message: "类型不对，应为字符串" },
        {
          path: "meta.auth.name",
          message: "auth.type 为 header 时必须填写合法的请求头名（最长 64 个字符）",
        },
        { path: "exports.buildSubmitRequest" },
      ],
    });
    await expect(
      inspect("module.exports.meta.auth={type:'query',name:'汉'.repeat(22)}"),
    ).rejects.toMatchObject({
      issues: [
        {
          path: "meta.auth.name",
          message: "auth.type 为 query 时必须填写查询参数名（最长 64 个字符）",
        },
      ],
    });
    await expect(
      inspect("module.exports.meta.auth={type:'header',name:'hOsT'}"),
    ).rejects.toMatchObject({
      issues: [{ path: "meta.auth.name", message: "桌面宿主不允许用保留请求头作为鉴权字段" }],
    });
  });
  it("预检与请求构造都接受带点的头名和编码后的查询名，不放开保留请求头", async () => {
    for (const [type, name] of [
      ["header", "X.Api+Key"],
      ["query", "访问 & key"],
      ["query", "cookie"],
    ] as const) {
      const auth = { type, name };
      const source = `${fixture("")}\nmodule.exports.meta.auth=${JSON.stringify(auth)}`;
      const plugin = await inspectPlugin(runner, source),
        selected = binding(source);
      const descriptor = { method: "GET", path: "/models" };
      const request = await buildHostRequest(descriptor, plugin, selected, context());
      if (type === "query")
        expect([...new URL(request.url).searchParams]).toEqual([[name, selected.secret]]);
      else expect(request.headers[name.toLowerCase()]).toEqual(selected.secret);
      await expect(
        buildHostRequest(
          { ...descriptor, auth: { type: "header", name: "Connection" } },
          plugin,
          selected,
          context(),
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_REQUEST_INVALID" });
    }
  });
  it("按声明顺序报告重复枚举和无效默认值，允许空可选设置和单独的准备解析钩子", async () => {
    const valid = `${fixture("")}\nmodule.exports.meta.channelSettings={z:{label:'可空',type:'string',default:null,required:null}};
      module.exports.meta.import={args:null}; module.exports.meta.poll={future:'extension',firstDelay:null}; module.exports.parsePrepareResponses=function(){};`;
    await expect(inspectPlugin(runner, valid)).resolves.toMatchObject({ key: "fixture" });
    const invalid = `${valid}\nmodule.exports.meta.channelSettings={z:{type:'enum',label:'重复',options:['one','one'],default:'two'},a:{type:'enum',label:'空',options:[' ']}};`;
    await expect(inspectPlugin(runner, invalid)).rejects.toMatchObject({
      issues: [
        { path: "meta.channelSettings.z.options", message: '可选值 "one" 重复' },
        { path: "meta.channelSettings.z.default", message: "默认值与类型 enum 不匹配" },
        { path: "meta.channelSettings.a.options", message: "可选值不能为空字符串" },
      ],
    });
  });
  it("按 Go 字符串切片的部分解码结果报告 options 错误，不误报合法默认值", async () => {
    const inspect = (settings: object) =>
      inspectPlugin(
        runner,
        `${fixture("")}\nmodule.exports.meta.import={args:${JSON.stringify(settings)}};`,
      );
    const path = "meta.import.args.size.options";
    for (const [options, messages] of [
      [
        ["one", 2, "two"],
        ["类型不对，应为字符串数组", "可选值不能为空字符串"],
      ],
      [["one", null, "two"], ["可选值不能为空字符串"]],
      [
        ["one", "one", {}, "two"],
        ["类型不对，应为字符串数组", '可选值 "one" 重复'],
      ],
    ] as const)
      await expect(
        inspect({ size: { type: "enum", label: "尺寸", options, default: "two" } }),
      ).rejects.toMatchObject({ issues: messages.map((message) => ({ path, message })) });
    await expect(inspect({ size: { type: ["enum"], label: "尺寸" } })).rejects.toMatchObject({
      issues: [
        { path: "meta.import.args.size.type", message: "类型不对，应为字符串" },
        {
          path: "meta.import.args.size.type",
          message: "必须是 string / number / boolean / enum 之一",
        },
      ],
    });
    await expect(
      inspect({ size: { type: "string", label: "尺寸", options: ["one", null] } }),
    ).resolves.toMatchObject({ meta: { import: { args: { size: { options: ["one", ""] } } } } });
  });
  it("多 endpoint 同时报告每个错误；异步缺钩子定位到对应 mode，展示路径按 UTF-8 字节限长", async () => {
    const source = `${fixture("")}\nmodule.exports.meta.endpoints = {video:{mode:'async'},text:{mode:'invalid',method:'TRACE',path:'/'+'汉'.repeat(67)}};`;
    await expect(inspectPlugin(runner, source)).rejects.toMatchObject({
      issues: [
        {
          path: "meta.endpoints",
          message: "一个插件只能支持一种类型（现在声明了 text / video），请按类型拆成多个插件",
        },
        { path: "meta.endpoints.text.method" },
        { path: "meta.endpoints.text.path" },
        { path: "meta.endpoints.text.mode" },
        {
          path: "meta.endpoints.video.mode",
          message: "video 声明为 async，必须导出 buildQueryRequest",
        },
        {
          path: "meta.endpoints.video.mode",
          message: "video 声明为 async，必须导出 parseQueryResponse",
        },
      ],
    });
    const oversized = `${fixture("")}\nmodule.exports.meta.description='a'.repeat(65536); delete module.exports.meta.apiVersion;`;
    await expect(inspectPlugin(runner, oversized)).rejects.toMatchObject({
      issues: [
        { path: "meta", message: "meta 编码后超过 64KB" },
        { path: "meta.apiVersion", message: "缺少 apiVersion，当前只支持 1" },
      ],
    });
    const huge = `${fixture("")}\nmodule.exports.meta.description='a'.repeat(1048576);`;
    expect(await runner.call(huge, "inspect")).toEqual({ metaTooLarge: true });
    await expect(inspectPlugin(runner, huge)).rejects.toMatchObject({
      code: "PLUGIN_MANIFEST_INVALID",
      issues: [{ path: "meta", message: "meta 编码后超过 64KB" }],
    });
  });
  it("固定提交的插件来源/hash 可复核，text/image/async video 清单通过", async () => {
    const provenance = JSON.parse(
      await readFile("resources/provider-plugins/provenance.json", "utf8"),
    );
    expect(
      Object.keys(provenance.sha256)
        .filter((path) => path.endsWith(".js"))
        .sort(),
    ).toEqual(
      Object.keys(plugins)
        .map((name) => `resources/provider-plugins/${name}.js`)
        .sort(),
    );
    for (const [name, source] of Object.entries(plugins)) {
      const path = `resources/provider-plugins/${name}.js`;
      const original = provenance.sha256[path];
      expect(original).toMatch(/^[a-f0-9]{64}$/);
      expect(sourceHash(source)).toBe(original);
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

  const imageUrl = "https://media.example/sample.png";
  const operation = "models/veo-test/operations/mock-task";
  const mockTask = "mock-task";
  const submissions = [
    ["agnes-image", "fixture", { data: [{ url: imageUrl }] }],
    ["agnes-video", "fixture", { video_id: mockTask }],
    ["alibaba-image", "wan2.6-t2i", { output: { task_id: mockTask } }],
    ["alibaba-video", "wan2.6-t2v", { output: { task_id: mockTask } }],
    ["anthropic", "fixture", { content: [{ type: "text", text: "测试" }] }],
    ["doubao-audio", "fixture", { url: "https://media.example/sample.mp3" }],
    ["doubao-image", "fixture", { data: [{ url: imageUrl }] }],
    ["doubao-video", "fixture", { id: mockTask }],
    ["google", "veo-test", { name: operation }],
    ["hailuo", "fixture", { task_id: mockTask }],
    ["incho", "fixture", { id: mockTask }],
    ["new-api-video", "fixture", { id: mockTask }],
    ["openai-chat-image", "fixture", { choices: [{ message: { images: [imageUrl] } }] }],
    ["sunoapi-lyrics", "fixture", { code: "success", data: mockTask }],
    ["sunoapi-music", "fixture", { code: "success", data: mockTask }],
    ["xai", "grok-imagine-video", { request_id: mockTask }],
  ] as const;

  it.each(submissions)("%s 构造提交并解析代表性响应", async (key, model, body) => {
    const selected = binding(plugins[key] ?? "");
    const input = context();
    input.model.upstreamModel = model;
    let submissions = 0;
    const offline = new ProviderHost(runner, async (request) => {
      submissions++;
      expect(request.method).toBe("POST");
      expect(new URL(request.url).origin).toBe(baseUrl);
      expect(request.body?.length).toBeGreaterThan(0);
      return { status: 200, headers: {}, body, text: JSON.stringify(body) };
    });
    const result = await offline.invoke(selected, "submit", input);
    expect(submissions).toBe(1);
    if (result.providerTaskId)
      expect(result.providerTaskId).toBe(key === "google" ? operation : mockTask);
    else expect(result).toMatchObject({ immediate: { status: "succeeded" } });
  });

  it("离线检查规范化媒体并报告执行覆盖、日志和未知钩子", async () => {
    const source = fixture(
      "utils.log('离线示例'); return {method:'POST',path:'/offline',json:{attachment:{__fileRef:ctx.input.images[0]}}};",
      ", mysteryHook:function(){ throw new Error('should not run'); }",
    );
    const count = requests.length;
    expect(
      await checkDraft(
        runner,
        source,
        JSON.stringify({ input: { images: [1] }, responses: { submit: {} } }),
      ),
    ).toEqual({
      ok: true,
      inputMedia: { images: 1, videos: 0, audios: 0 },
      checkedHooks: ["buildSubmitRequest", "parseSubmitResponse"],
      unknownHooks: ["mysteryHook"],
      logs: ["离线示例"],
      issues: [],
    });
    expect(
      await checkDraft(runner, source, '{"input":{"images":["input:images.2"]}}'),
    ).toMatchObject({ ok: false, checkedHooks: [], issues: ["PLUGIN_SAMPLE_INVALID"] });
    expect(requests.length).toBe(count);
  });

  it("自定义凭证只能用于已授权的请求目标，错误分类失效时回退", async () => {
    const custom = fixture(
      "return {method:'POST',url:'https://foreign.invalid',json:{key:ctx.credentials.apiKey}};",
      "",
      "text",
      "sync",
      "custom",
    );
    const offline = new ProviderHost(runner, async () => ({
      status: 403,
      headers: {},
      body: null,
      text: "credit exhausted",
    }));
    await expect(offline.invoke(binding(custom), "submit", context())).rejects.toMatchObject({
      code: "PROVIDER_ENDPOINT_BLOCKED",
    });
    const source = fixture(
      "return {method:'POST',path:'/offline'};",
      ", classifyError:function(){return {class:'unrecognized'};}",
    );
    await expect(offline.invoke(binding(source), "submit", context())).rejects.toMatchObject({
      code: "PROVIDER_PROVIDER_BALANCE",
    });
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

  it("Veo 按宿主参考图的实际 MIME 构造内联数据", async () => {
    const input = context({ images: ["input:images.0"] });
    input.model.upstreamModel = "veo-test";
    const upstream = new ProviderHost(runner, async (request) => {
      expect(JSON.parse(Buffer.from(request.body ?? []).toString())).toMatchObject({
        instances: [{ image: { inlineData: { mimeType: "image/jpeg", data: "/9j/" } } }],
      });
      return {
        status: 200,
        headers: {},
        body: { name: "models/veo-test/operations/fixture" },
        text: "",
      };
    });
    expect(
      await upstream.invoke(
        {
          ...binding(plugins.google ?? ""),
          builtin: true,
          media: {
            "input:images.0": {
              bytes: Buffer.from([255, 216, 255]),
              mime: "image/jpeg",
              filename: "reference.jpg",
            },
          },
        },
        "submit",
        input,
      ),
    ).toMatchObject({ providerTaskId: "models/veo-test/operations/fixture" });
  });

  it.each([
    ["hailuo", "MiniMax-H3", "2K", undefined, { resolution: "2K" }],
    ["sora", "sora-2-pro", "1080P", "9:16", { size: "1024x1792" }],
    ["sora", "sora-2-pro", "1080P", undefined, { size: "1792x1024" }],
    ["sora", "sora-2", "720P", "9:16", { size: "720x1280" }],
  ] as const)(
    "%s 将 %s 的 %s 清晰度与 %s 画幅写入请求",
    async (adapter, model, resolution, aspectRatio, expected) => {
      const input = providerInput("video", adapter, { resolution, aspectRatio });
      const request = await runner.call(requireTestValue(plugins[adapter]), "buildSubmitRequest", [
        {
          ...context(input),
          model: { upstreamModel: model },
        },
      ]);
      expect(request).toMatchObject({ json: expected });
    },
  );

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

  it.each(["sora", "doubao-video"])("%s 遵循原版将远端取消解析为失败", async (key) => {
    expect(
      await runner.call(plugins[key] ?? "", "parseQueryResponse", [
        context(),
        { body: { status: "cancelled" } },
      ]),
    ).toMatchObject({ status: "failed" });
  });

  it("异步视频插件 submit/query 闭环；媒体 URL 缺失时明确拒绝", async () => {
    const selected = binding(plugins.sora ?? "");
    const submitted = await host.invoke(selected, "submit", context());
    expect(submitted.providerTaskId).toBe("video-mock");
    const ready = await host.invoke(
      selected,
      "query",
      context({}, { providerTaskId: submitted.providerTaskId }),
    );
    expect(ready).toMatchObject({ status: "running", state: { ready: true } });
    expect(
      await host.invoke(
        selected,
        "query",
        context({}, { providerTaskId: submitted.providerTaskId, state: ready.state }),
      ),
    ).toMatchObject({ status: "succeeded", outputs: [{ type: "asset" }] });
    const count = requests.length;
    const reference: ReferenceMedia = {
      bytes: Buffer.from("image"),
      mime: "image/png",
      filename: "reference.png",
    };
    selected.media = {
      "input:images.0": reference,
    };
    const plugin = await inspectPlugin(runner, selected.source);
    await expect(
      buildHostRequest(
        {
          method: "POST",
          path: "/v1/videos",
          json: { image: { __fileRef: "input:images.0", as: "url" } },
        },
        plugin,
        selected,
        context({ images: ["input:images.0"] }),
      ),
    ).rejects.toMatchObject({ code: "MEDIA_TRANSPORT_UNAVAILABLE" });
    expect(requests.length).toBe(count);
    reference.url = "https://media.example/reference.png";
    expect(
      await buildHostRequest(
        {
          method: "POST",
          path: "/v1/videos",
          json: { image: { __fileRef: "input:images.0", as: "url" } },
        },
        plugin,
        selected,
        context({ images: ["input:images.0"] }),
      ),
    ).toMatchObject({ method: "POST" });
  });

  it("备案仅替换内置视频协议标注的图片 URL，同图内联传输仍提供原始内容", async () => {
    const selected = { ...binding(plugins["doubao-video"] ?? ""), builtin: true };
    const url = "https://cdn.example.com/a.png";
    selected.media = {
      "input:images.0": {
        bytes: Buffer.from("fixture"),
        mime: "image/png",
        filename: "ref.png",
        url,
        filedAssetId: "asset-123",
      },
    };
    const plugin = await inspectPlugin(runner, selected.source);
    const reference = { __fileRef: "input:images.0" };
    const request = await buildHostRequest(
      {
        method: "POST",
        path: "/submit",
        json: {
          filed: { ...reference, as: "url", filed: true },
          plain: reference,
          inline: { ...reference, as: "base64", filed: true },
        },
      },
      plugin,
      selected,
      context({ images: ["input:images.0"] }),
    );
    expect(JSON.parse(Buffer.from(request.body ?? []).toString())).toEqual({
      filed: "asset://asset-123",
      plain: url,
      inline: Buffer.from("fixture").toString("base64"),
    });
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

  it("密钥只由宿主注入，钩子无 Node/网络/进程/动态构造器能力", async () => {
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

  it("custom 鉴权把凭证交给插件，并支持 HS256 签名工具", async () => {
    const source = fixture(
      "var token=utils.jwtSignHS256({sub:ctx.credentials.apiKey},'signing-secret');return {method:'POST',path:'/custom',json:{key:ctx.credentials.apiKey,token:token}};",
      ",parseSubmitResponse:function(ctx,resp){return {immediate:{status:'succeeded',outputs:[{type:'text',text:'ok'}]}};}",
      "text",
      "sync",
      "custom",
    );
    const result = await host.invoke(binding(source), "submit", context());
    expect(result).toMatchObject({ immediate: { status: "succeeded" } });
    const body = JSON.parse(requests.at(-1)?.body ?? "{}");
    expect(body.key).toBe("fake-host-only-key");
    const [header, payload, signature] = String(body.token).split(".");
    if (!header || !payload || !signature) throw new Error("JWT 结构无效");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      sub: "fake-host-only-key",
    });
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(["kling", "jimeng", "vidu"])("%s 的真实鉴权头进入请求", async (key) => {
    const secret = key === "vidu" ? "mock-vidu-token" : "mock-access|mock-signing-key";
    const selected = { ...binding(plugins[key] ?? ""), secret };
    const upstream = new ProviderHost(runner, async (request) => {
      if (key === "kling") {
        const [header, claims, signature] = (request.headers.authorization ?? "")
          .replace(/^Bearer /, "")
          .split(".");
        expect(signature).toBe(
          createHmac("sha256", "mock-signing-key")
            .update(`${header}.${claims}`)
            .digest("base64url"),
        );
        expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toMatchObject({
          iss: "mock-access",
          exp: 1760001800,
        });
      } else if (key === "jimeng") {
        expect(request.headers.authorization).toMatch(/^HMAC-SHA256 Credential=mock-access\//);
        expect(request.headers["x-content-sha256"]).toBe(
          createHash("sha256")
            .update(request.body ?? "")
            .digest("hex"),
        );
        expect(Buffer.from(request.body ?? []).toString()).toContain("\\u003c");
      } else expect(request.headers.authorization).toBe(`Token ${secret}`);
      return {
        status: 200,
        headers: {},
        text: "",
        body: {
          code: key === "jimeng" ? 10000 : 0,
          task_id: "mock-job",
          data: { task_id: "mock-job" },
        },
      };
    });
    await expect(
      upstream.invoke(selected, "submit", context({ prompt: "<测试>&" })),
    ).resolves.toMatchObject({
      providerTaskId: "mock-job",
    });
  });

  it("Vertex 用服务账号换取令牌，重建轮询上下文并下载资产", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const selected = {
      ...binding(plugins["vertex-ai"] ?? ""),
      builtin: true,
      secret: JSON.stringify({
        client_email: "fixture@example.test",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        project_id: "fixture-project",
      }),
    };
    const calls: string[] = [];
    const operation =
      "projects/fixture-project/locations/us-central1/publishers/google/models/veo-test/operations/task";
    const upstream = new ProviderHost(runner, async (request) => {
      const url = new URL(request.url);
      calls.push(url.hostname === "127.0.0.1" ? request.method : url.hostname);
      let body: unknown;
      if (url.hostname === "oauth2.googleapis.com") {
        expect(request.headers.authorization).toBeUndefined();
        const assertion = new URLSearchParams(Buffer.from(request.body ?? []).toString()).get(
          "assertion",
        );
        const [header, claims, signature] = assertion?.split(".") ?? [];
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${claims}`),
            publicKey,
            Buffer.from(signature ?? "", "base64url"),
          ),
        ).toBe(true);
        expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toMatchObject({
          aud: "https://oauth2.googleapis.com/token",
          iat: 1760000000,
          exp: 1760003600,
        });
        body = { access_token: "mock-oauth-token", expires_in: 3600 };
      } else {
        expect(request.headers.authorization).toBe("Bearer mock-oauth-token");
        if (url.hostname === "storage.googleapis.com") {
          expect(request.responseType).toBe("binary");
          return { status: 200, headers: {}, body: null, text: "", asset: { id: "0" } };
        }
        body = { name: operation };
        if (url.pathname.endsWith(":fetchPredictOperation"))
          body = {
            name: operation,
            done: true,
            response: { videos: [{ gcsUri: "gs://fixture/video.mp4" }] },
          };
      }
      return { status: 200, headers: {}, text: "", body };
    });
    const input = context({}, {}, { storageUri: "gs://fixture/" });
    input.model.upstreamModel = "veo-test";
    const submitted = await upstream.invoke(selected, "submit", input);
    expect(JSON.stringify(submitted)).not.toContain("mock-oauth-token");
    expect(submitted.providerTaskId).toBe(operation);
    const ready = await upstream.invoke(selected, "query", {
      ...input,
      task: { providerTaskId: operation, state: submitted.state },
    });
    expect(ready.state).toEqual({
      ready: true,
      url: "https://storage.googleapis.com/fixture/video.mp4",
    });
    await expect(
      upstream.invoke(selected, "query", {
        ...input,
        task: { providerTaskId: operation, state: ready.state },
      }),
    ).resolves.toMatchObject({ status: "succeeded", outputs: [{ type: "asset" }] });
    expect(calls).toEqual([
      "oauth2.googleapis.com",
      "POST",
      "oauth2.googleapis.com",
      "POST",
      "oauth2.googleapis.com",
      "storage.googleapis.com",
    ]);
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

  it("async 缺 query、prepare 不成对和多类型清单明确拒绝，custom auth 可用", async () => {
    for (const source of [
      fixture("return {};", "", "video", "async"),
      fixture("return {};", ",buildPrepareRequests:function(){return [];}", "text"),
      fixture("return {};").replace(
        "text: {mode: 'sync'}",
        "text: {mode: 'sync'},image:{mode:'sync'}",
      ),
    ])
      await expect(inspectPlugin(runner, source)).rejects.toThrow();
    const custom = await inspectPlugin(
      runner,
      fixture("return {auth: 'custom'};", "", "text", "sync", "custom"),
    );
    expect(custom.auth.type).toBe("custom");
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
