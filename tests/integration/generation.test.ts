import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkerClient } from "../../packages/agent-runtime/src/client";
import type { PublishedEvent } from "../../packages/agent-runtime/upstream/src/engine/engine";
import type { Approval, Run } from "../../packages/agent-runtime/upstream/src/store/types";
import { fakeGo } from "../../packages/agent-runtime/upstream/test/fake-go";
import type { GenerationInput, JobStatus } from "../../packages/link-studio-core/src/generation";
import type { ProjectState } from "../../packages/link-studio-core/src/project";
import { probeMedia } from "../../packages/media-runtime/src/probe";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { AssetFiles } from "../../src/main/project/asset-files";
import { AssetService } from "../../src/main/project/assets";
import { CanvasAgentService } from "../../src/main/project/canvas-agent";
import { CanvasMedia } from "../../src/main/project/canvas-media";
import { GenerationService } from "../../src/main/project/generation";
import { ProjectStore } from "../../src/main/project/store";
import { runModelTrial } from "../../src/main/settings/model-trial";
import { SettingsRegistry } from "../../src/main/settings/registry";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=";
const binaries =
  process.env.LINK_STUDIO_MEDIA_DIRECTORY ??
  join(process.cwd(), "out/media", `${process.platform}-${process.arch}`);
const ffmpeg = join(binaries, "ffmpeg");
const node = (id: string, kind: "image" | "video" | "audio" = "image", text = "生成样本") => ({
  id,
  type: "creative" as const,
  position: { x: 10, y: 20 },
  data: { kind, label: id, text },
});

describe.skipIf(process.platform !== "darwin")("S4 持久生成与画布助手", () => {
  let root: string;
  let store: ProjectStore;
  let registry: SettingsRegistry;
  let service: GenerationService;
  let agent: CanvasAgentService;
  let endpoint: string;
  let provider: (request: IncomingMessage, response: ServerResponse) => void;
  let server: ReturnType<typeof createServer>;
  let calls: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "link-studio-generation-"));
    registry = await SettingsRegistry.open(
      join(root, "settings"),
      "resources/provider-plugins",
      "out/provider-runtime/runner",
      {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => Buffer.from(value).toString(),
      },
    );
    store = await ProjectStore.create(root, "生成验收");
    const assets = new AssetService(join(binaries, "ffprobe"));
    const files = new AssetFiles(join(root, "locators"));
    service = new GenerationService(async () => registry, assets, files, 20);
    agent = new CanvasAgentService(
      service,
      async () => registry,
      new CanvasMedia(files, assets, ffmpeg),
    );
    agent.attach(store);
    calls = [];
    provider = (_request, response) => response.end(JSON.stringify({ data: [{ b64_json: png }] }));
    server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      request.resume();
      provider(request, response);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing mock server");
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    if (service && store) await service.stop(store);
    await store?.close();
    registry?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  function configure(key = "openai-image", hash?: string, model = "fixture", channel = {}) {
    const plugin = registry
      .list()
      .plugins.find((item) => item.hash === hash || (!hash && item.key === key));
    if (!plugin) throw new Error(`Missing plugin ${key}`);
    return registry.save({
      expectedRevision: 0,
      pluginHash: plugin.hash,
      approve: true,
      secret: "fixture-generation-key",
      fields: {
        label: "本机测试",
        endpoint,
        model,
        allowLocal: true,
        agentEnabled: false,
        channel,
      },
    });
  }

  function generationChannel() {
    const created = registry.channelSave({
      expectedRevision: 0,
      approve: true,
      fields: {
        name: "创作服务",
        endpoint,
        allowLocal: true,
        enabled: true,
        sort: 100,
        headers: [],
      },
    });
    return registry.channelKeys({
      id: created.id,
      expectedRevision: created.revision,
      secret: "fixture-generation-key",
    });
  }

  async function edit(...nodes: ReturnType<typeof node>[]) {
    return store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: nodes.map((entry) => ({ type: "putNode", node: entry })),
    });
  }

  function input(profile: ReturnType<typeof configure>, nodeId = "sample"): GenerationInput {
    return {
      nodeId,
      providerId: profile.id,
      expectedProviderRevision: profile.revision,
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      prompt: "生成一张海报",
      referenceAssetIds: [],
    };
  }

  async function wait(id: string, status: JobStatus) {
    await expect
      .poll(() => service.list(store).jobs.find((job) => job.id === id)?.status, { timeout: 5000 })
      .toBe(status);
    return service.list(store).jobs.find((job) => job.id === id);
  }

  async function reopen() {
    await service.stop(store);
    agent.detach(store);
    const directory = store.directory;
    await store.close();
    store = await ProjectStore.open(directory);
    agent.attach(store);
    service.start(store);
  }

  it("同步图片输出入库并绑定，重复提交和重开只保留一份结果", async () => {
    await edit(node("sample"));
    const entry = { id: randomUUID(), input: input(configure()) };
    await service.submit(store, [entry]);
    const job = await wait(entry.id, "succeeded");
    expect(job?.bound).toBe(true);
    await reopen();
    await service.submit(store, [entry]);
    const asset = Object.values(store.snapshot.assets)[0];
    expect(asset).toMatchObject({ origin: "generated", metadata: { jobId: entry.id } });
    expect(store.getCanvas().canvas.nodes.find(({ id }) => id === "sample")).toMatchObject({
      data: { assetId: asset?.assetId },
    });
    expect(calls).toHaveLength(1);
  });

  it("导入模型后必须显式配置，离线图片试跑支持本地参考且不写入项目", async () => {
    const channel = generationChannel();
    const plugin = registry.list().plugins.find(({ key }) => key === "openai-image");
    if (!plugin) throw new Error("Missing image plugin");
    const identity = { id: channel.id, expectedRevision: channel.revision };
    expect(
      registry.modelImport({ ...identity, models: ["gpt-image-1", "pending", "pending"] }),
    ).toEqual({ added: 2 });
    expect(registry.modelImport({ ...identity, models: ["pending"] })).toEqual({ added: 0 });
    const draft = registry.list().providers.find(({ model }) => model === "gpt-image-1");
    if (!draft) throw new Error("缺少待配置模型");
    expect(draft).toMatchObject({ pending: true, pluginHash: "", enabled: false });
    expect(() =>
      registry.modelToggle({ id: draft.id, expectedRevision: draft.revision, enabled: true }),
    ).toThrow("MODEL_PENDING");
    expect(() => registry.trialBinding(draft.id, draft.revision)).toThrow(
      "SETTINGS_REVISION_CONFLICT",
    );
    const configured = registry.modelSave({
      id: draft.id,
      expectedRevision: draft.revision,
      channelId: channel.id,
      channelRevision: channel.revision,
      pluginHash: plugin.hash,
      upstreamModel: draft.model,
      settings: {},
      approve: true,
      enabled: false,
      config: {
        kind: "image",
        name: "图片试跑",
        description: "",
        sort: 100,
        modes: ["i2i"],
        params: { size: { values: ["1024x1024"], default: "1024x1024" } },
      },
    });
    expect(configured.pending).toBeUndefined();
    expect(() => registry.binding(configured.id, configured.revision)).toThrow(
      "SETTINGS_REVISION_CONFLICT",
    );
    const bodies: Buffer[] = [];
    provider = (request, response) => {
      request.on("data", (chunk: Buffer) => bodies.push(chunk));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ b64_json: png }] }));
      });
    };
    const trial = {
      id: configured.id,
      expectedRevision: configured.revision,
      prompt: "修改海报",
      params: {},
      references: [{ kind: "image" as const, file: { mime: "image/png", base64: png } }],
    };
    const preview = await runModelTrial(registry, { ...trial, dry: true });
    expect(preview).toMatchObject({
      status: "preview",
      trace: [],
      request: { method: "POST", endpoint: `${endpoint}/v1/images/edits` },
    });
    expect(calls).toEqual([]);
    const result = await runModelTrial(registry, { ...trial, dry: false });
    expect(result).toMatchObject({
      status: "succeeded",
      outputs: [{ mediaType: "image", image: `data:image/png;base64,${png}` }],
      trace: [{ status: 200 }],
    });
    expect(calls).toEqual(["POST /v1/images/edits"]);
    expect(Buffer.concat(bodies).toString()).toContain("1024x1024");
    expect(Object.keys(store.snapshot.assets)).toHaveLength(0);
  });

  it("渠道图片模型使用渠道凭证，并按保存的能力提交画布请求", async () => {
    await edit(node("sample"));
    const channel = generationChannel();
    const plugin = registry.list().plugins.find(({ key }) => key === "openai-image");
    if (!plugin) throw new Error("Missing image plugin");
    const save = {
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "gpt-image-1",
      pluginHash: plugin.hash,
      enabled: true,
      settings: {},
      approve: true,
      config: {
        kind: "image" as const,
        name: "海报模型",
        sort: 100,
        description: "",
        modes: ["t2i" as const],
        params: { size: { values: ["1024x1024"], default: "1024x1024" } },
      },
    };
    expect(() =>
      registry.modelSave({
        ...save,
        config: { ...save.config, params: { size: { values: ["512x512"], default: "512x512" } } },
      }),
    ).toThrow("MODEL_CAPABILITIES_INVALID");
    const updated = registry.modelSave(save);
    const textPlugin = registry.list().plugins.find(({ key }) => key === "openai");
    if (!textPlugin) throw new Error("Missing text plugin");
    const text = registry.modelSave({
      ...save,
      expectedRevision: 0,
      config: { kind: "text", name: "剧本模型", description: "", sort: 100 },
      upstreamModel: "gpt-fixture",
      pluginHash: textPlugin.hash,
      settings: {},
      approve: true,
    });
    expect(registry.binding(text.id, text.revision).secret).toBe("fixture-generation-key");
    const bodies: string[] = [];
    provider = (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      request.on("data", (chunk: Buffer) => bodies.push(chunk.toString()));
      request.on("end", () => response.end(JSON.stringify({ data: [{ b64_json: png }] })));
    };
    await expect(
      registry.test({ id: updated.id, expectedRevision: updated.revision }),
    ).resolves.toEqual({ tested: true });
    await expect(
      service.submit(store, [
        { id: randomUUID(), input: { ...input(updated), size: "1536x1024" } },
      ]),
    ).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    const entry = { id: randomUUID(), input: input(updated) };
    await service.submit(store, [entry]);
    await wait(entry.id, "succeeded");
    expect(calls).toEqual(["GET /v1/models", "POST /v1/images/generations"]);
    expect(JSON.parse(bodies.join(""))).toMatchObject({
      model: save.upstreamModel,
      size: "1024x1024",
    });
    expect(registry.binding(updated.id, updated.revision).secret).toBe("fixture-generation-key");
    registry.channelSave({
      id: channel.id,
      expectedRevision: channel.revision,
      approve: false,
      fields: {
        name: channel.name,
        endpoint,
        allowLocal: true,
        enabled: false,
        sort: 100,
        headers: [],
      },
    });
    await expect(
      service.submit(store, [{ id: randomUUID(), input: input(registry.provider(text.id)) }]),
    ).rejects.toMatchObject({ code: "JOB_MODEL_UNAVAILABLE" });
  });

  it("Seedance 节点发送比例、分辨率、时长与静音，并拦截不支持的输入", async () => {
    await edit(node("sample", "video"));
    const profile = configure("doubao-video", undefined, "doubao-seedance-1-5-pro-251215");
    const request = input(profile);
    await expect(service.prepare(store, { ...request, duration: 30 })).rejects.toMatchObject({
      code: "JOB_INPUT_INVALID",
    });
    await expect(
      service.prepare(store, { ...request, referenceAssetIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    await expect(service.prepare(store, { ...request, count: 2 })).rejects.toMatchObject({
      code: "JOB_INPUT_INVALID",
    });
    expect(calls).toHaveLength(0);

    let payload: unknown;
    provider = (incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        payload = JSON.parse(Buffer.concat(chunks).toString());
        response.end(JSON.stringify({ id: "seedance-task" }));
      });
    };
    const id = randomUUID();
    await service.submit(store, [
      {
        id,
        input: {
          ...request,
          aspectRatio: "9:16",
          resolution: "720p",
          duration: 5,
          generateAudio: false,
        },
      },
    ]);
    await wait(id, "running");
    expect(payload).toMatchObject({
      ratio: "9:16",
      resolution: "720p",
      duration: 5,
      generate_audio: false,
    });
  });

  it("参考图在 Seedance 全能参考模式下使用公网链接和参考图角色", async () => {
    await edit(node("reference"), node("sample", "video"));
    const image = { id: randomUUID(), input: input(configure(), "reference") };
    await service.submit(store, [image]);
    const output = (await wait(image.id, "succeeded"))?.outputs[0];
    if (!output || !("assetId" in output)) throw new Error("Missing generated image");
    const profile = configure("doubao-video", undefined, "doubao-seedance-2-0-fast-260615");
    const request = { ...input(profile), op: "omni" as const, referenceAssetIds: [output.assetId] };
    await expect(service.prepare(store, request)).rejects.toMatchObject({
      code: "JOB_INPUT_INVALID",
    });
    await expect(
      service.prepare(store, {
        ...request,
        referenceURLs: { [output.assetId]: "https://127.0.0.1/image.png" },
      }),
    ).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    let submitted: unknown;
    provider = (incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        submitted = JSON.parse(Buffer.concat(chunks).toString());
        response.end(JSON.stringify({ id: "seedance-reference" }));
      });
    };
    const url = "https://cdn.example.com/sample.png?signature=fixture";
    const id = randomUUID();
    await service.submit(store, [
      { id, input: { ...request, referenceURLs: { [output.assetId]: url }, duration: -1 } },
    ]);
    await wait(id, "running");
    expect(submitted).toMatchObject({
      duration: -1,
      content: [
        { type: "text", text: request.prompt },
        { type: "image_url", role: "reference_image", image_url: { url } },
      ],
    });
    expect(JSON.stringify(store.snapshot.jobs[id])).not.toContain("signature=fixture");
  });

  it("豆包音频发送音色与 OGG 格式并把返回的 Opus 音频入库", async () => {
    const bytes = Buffer.from(
      "T2dnUwACAAAAAAAAAACgCKTfAAAAAGIERBUBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAKAIpN8BAAAAvcMZTQE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAEOBAAAAAAAACgCKTfAgAAAJcZJUsFAwMDAwP4//74//74//74//74//4=",
      "base64",
    );
    await edit(node("sample", "audio"));
    const profile = configure("doubao-audio", undefined, "seed-audio");
    let submitted: unknown;
    provider = (incoming, response) => {
      if (incoming.method === "GET") {
        response.writeHead(200, { "content-type": "application/ogg" }).end(bytes);
        return;
      }
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        submitted = JSON.parse(Buffer.concat(chunks).toString());
        expect(incoming.headers["x-api-key"]).toBe("fixture-generation-key");
        response.end(JSON.stringify({ code: 0, url: `${endpoint}/result.ogg` }));
      });
    };
    const id = randomUUID();
    await service.submit(store, [
      {
        id,
        input: {
          ...input(profile),
          audioFormat: "ogg_opus",
          speaker: "fixture-speaker",
          sampleRate: 48000,
          speechRate: 0,
          loudnessRate: 10,
          pitchRate: -2,
        },
      },
    ]);
    const job = await wait(id, "succeeded");
    expect(submitted).toMatchObject({
      audio_config: {
        format: "ogg_opus",
        sample_rate: 48000,
        speech_rate: 0,
        loudness_rate: 10,
        pitch_rate: -2,
      },
      references: [{ speaker: "fixture-speaker" }],
    });
    expect(job?.bound).toBe(true);
    expect(Object.values(store.snapshot.assets)).toEqual([
      expect.objectContaining({ mimeType: "audio/ogg", mediaType: "audio" }),
    ]);
  });

  it.each(["恢复", "图片失败", "手动换主图", "参数无效"])(
    "角色联合生成按持久依赖处理%s",
    async (scenario) => {
      const image = configure();
      const voice = configure("doubao-audio", undefined, "seed-audio", { as: "base64" });
      const makeCharacter = (assetId?: string) => ({
        ...node("sample"),
        data: {
          ...node("sample").data,
          character: { name: "林舟", look: "夜班", description: "值班员", extraAssetIds: [] },
          ...(assetId ? { assetId } : {}),
        },
      });
      await edit(makeCharacter());
      let manualImage: string | undefined;
      if (scenario === "手动换主图") {
        await edit(node("manual"));
        const id = randomUUID();
        await service.submit(store, [{ id, input: input(image, "manual") }]);
        const output = (await wait(id, "succeeded"))?.outputs[0];
        if (output?.kind !== "image") throw new Error("Missing manual image fixture");
        manualImage = output.assetId;
        calls.length = 0;
      }
      const bytes = Buffer.from(
        "T2dnUwACAAAAAAAAAACgCKTfAAAAAGIERBUBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAKAIpN8BAAAAvcMZTQE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAEOBAAAAAAAACgCKTfAgAAAJcZJUsFAwMDAwP4//74//74//74//74//4=",
        "base64",
      );
      let voiceRequest: unknown;
      let imageResponse: ServerResponse | undefined;
      provider = (request, response) => {
        if (request.method === "GET") {
          response.writeHead(200, { "content-type": "application/ogg" }).end(bytes);
        } else if (request.url === "/api/v3/tts/create") {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            voiceRequest = JSON.parse(Buffer.concat(chunks).toString());
            response.end(JSON.stringify({ code: 0, url: `${endpoint}/result.ogg` }));
          });
        } else if (scenario === "手动换主图") {
          imageResponse = response;
        } else if (scenario === "图片失败") {
          response.writeHead(400).end(JSON.stringify({ error: { message: "fixture rejected" } }));
        } else {
          response.end(JSON.stringify({ data: [{ b64_json: png }] }));
        }
      };

      const imageId = randomUUID();
      const voiceId = randomUUID();
      const entries = [
        { id: imageId, input: input(image) },
        {
          id: voiceId,
          input: {
            ...input(voice),
            purpose: "character-voice" as const,
            afterImageJobId: scenario === "参数无效" ? randomUUID() : imageId,
            prompt: "列车即将进站。",
            audioFormat: "ogg_opus" as const,
          },
        },
      ];
      if (scenario === "参数无效") {
        await expect(service.submit(store, entries)).rejects.toMatchObject({
          code: "JOB_INPUT_INVALID",
        });
        expect(service.list(store).jobs).toEqual([]);
        expect(calls).toEqual([]);
        return;
      }
      const start =
        scenario === "恢复" ? vi.spyOn(service, "start").mockImplementation(() => {}) : undefined;
      try {
        expect(await service.submit(store, entries)).toMatchObject([
          { id: imageId, status: "queued" },
          { id: voiceId, status: "queued", afterImageJobId: imageId },
        ]);
      } finally {
        start?.mockRestore();
      }

      if (scenario === "恢复") {
        expect(calls).toEqual([]);
        await reopen();
        const completed = await wait(voiceId, "succeeded");
        expect(completed).toMatchObject({ afterImageJobId: imageId, bound: false });
        expect(voiceRequest).toMatchObject({
          text_prompt: "列车即将进站。",
          references: [{ image_data: png }],
        });
        expect(calls.map((call) => call.split(" ")[0])).toEqual(["POST", "POST", "GET"]);
        expect(await wait(imageId, "succeeded")).toMatchObject({ bound: true });
        return;
      }
      if (scenario === "手动换主图") {
        await expect.poll(() => Boolean(imageResponse)).toBe(true);
        expect(service.list(store).jobs.find(({ id }) => id === voiceId)?.status).toBe("queued");
        await edit(makeCharacter(manualImage));
        imageResponse?.end(JSON.stringify({ data: [{ b64_json: png }] }));
        expect(await wait(imageId, "succeeded")).toMatchObject({ bound: false });
        expect(store.getCanvas().canvas.nodes.find(({ id }) => id === "sample")).toMatchObject({
          data: { assetId: manualImage },
        });
      } else {
        await wait(imageId, "failed");
      }
      expect(await wait(voiceId, "failed")).toMatchObject({ error: "JOB_IMAGE_DEPENDENCY_FAILED" });
      expect(calls).toHaveLength(1);
    },
  );

  it.each(["MIME 不匹配", "超过输出上限"])(
    "异步任务恢复查询并拒绝无效结果：%s",
    async (failure) => {
      await edit(node("sample", "video"));
      const plugin = registry.list().plugins.find(({ key }) => key === "doubao-video");
      const draft = await registry.draft(
        String(plugin?.source).replace(
          "firstDelay: 15, interval: 10",
          "firstDelay: 0.01, interval: 0.01, maxInterval: 0.02",
        ),
        "manual",
      );
      const entry = { id: randomUUID(), input: input(configure("doubao-video", draft.hash)) };
      let complete = false;
      provider = (request, response) => {
        if (request.method === "POST") response.end(JSON.stringify({ id: "remote-1" }));
        else if (request.url === "/invalid") {
          if (failure === "超过输出上限") {
            response.writeHead(200, {
              "content-type": "video/mp4",
              "content-length": 256 * 1024 * 1024 + 1,
            });
            response.flushHeaders();
          } else response.writeHead(200, { "content-type": "text/html" }).end("not video");
        } else
          response.end(
            JSON.stringify(
              complete
                ? { status: "succeeded", content: { video_url: `${endpoint}/invalid` } }
                : { status: "running" },
            ),
          );
      };
      await service.submit(store, [entry]);
      await wait(entry.id, "running");
      await expect(service.cancel(store, entry.id)).rejects.toMatchObject({
        code: "JOB_CANNOT_CANCEL",
      });
      await reopen();
      complete = true;
      expect(await wait(entry.id, "failed")).toMatchObject({
        error: "JOB_OUTPUT_INVALID",
        outputs: [],
      });
      expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
      expect(calls).toContain("GET /api/v3/contents/generations/tasks/remote-1");
      expect(store.snapshot.assets).toEqual({});
    },
  );

  it("供应商受理不明时重启不会重发", async () => {
    await edit(node("sample"));
    provider = (request) => request.socket.destroy();
    const entry = { id: randomUUID(), input: input(configure()) };
    await service.submit(store, [entry]);
    await wait(entry.id, "outcome_unknown");
    await reopen();
    await service.submit(store, [entry]);
    await expect(
      agent.command("tasks", { project: agent.key(store), ids: [entry.id] }),
    ).resolves.toMatchObject([{ task_id: entry.id, status: "outcome_unknown" }]);
    await expect(service.recheck(store, entry.id)).rejects.toMatchObject({
      code: "JOB_CANNOT_RECHECK",
    });
    expect(calls).toHaveLength(1);
  });

  it("取消请求成功后仍以供应商查询结果为准", async () => {
    await edit(node("sample", "video"));
    const plugin = registry.list().plugins.find(({ key }) => key === "doubao-video");
    if (!plugin) throw new Error("Missing video plugin");
    const draft = await registry.draft(
      plugin.source
        .replace(
          "firstDelay: 15, interval: 10",
          "firstDelay: 0.01, interval: 0.01, maxInterval: 0.02",
        )
        .concat(
          "\nmodule.exports.buildCancelRequest = function () { return { method: 'DELETE', path: '/cancel' }; };",
        ),
    );
    let confirmed = false;
    provider = (request, response) => {
      const body =
        request.method === "POST"
          ? { id: "remote-cancel" }
          : request.method === "DELETE"
            ? {}
            : { status: confirmed ? "cancelled" : "running" };
      response.end(JSON.stringify(body));
    };
    const entry = { id: randomUUID(), input: input(configure("doubao-video", draft.hash)) };
    await service.submit(store, [entry]);
    await wait(entry.id, "running");
    expect(await service.cancel(store, entry.id)).toMatchObject({
      status: "running",
      cancelRequested: true,
    });
    await expect.poll(() => calls.includes("DELETE /cancel")).toBe(true);
    expect(service.list(store).jobs[0]?.status).toBe("running");
    confirmed = true;
    expect(await wait(entry.id, "cancelled")).toMatchObject({ outputs: [] });
    expect(calls.filter((call) => call === "DELETE /cancel")).toHaveLength(1);
  });

  it("旧任务有远端回执时，同节点的同类任务运行期间不能复查", async () => {
    await edit(node("sample", "video"));
    const plugin = registry.list().plugins.find(({ key }) => key === "doubao-video");
    if (!plugin) throw new Error("Missing video plugin");
    const draft = await registry.draft(
      plugin.source.replace("firstDelay: 15, interval: 10", "firstDelay: 0.01, interval: 0.01"),
    );
    const profile = configure("doubao-video", draft.hash);
    let failQuery = true;
    provider = (request, response) => {
      if (request.method === "POST") response.end(JSON.stringify({ id: "remote-recheck" }));
      else if (failQuery) request.socket.destroy();
      else response.end(JSON.stringify({ status: "running" }));
    };
    const first = { id: randomUUID(), input: input(profile) };
    await service.submit(store, [first]);
    expect(await wait(first.id, "outcome_unknown")).toMatchObject({ canRecheck: true });
    failQuery = false;
    const second = { id: randomUUID(), input: input(profile) };
    await service.submit(store, [second]);
    await expect(service.recheck(store, first.id)).rejects.toMatchObject({
      code: "JOB_CANNOT_RECHECK",
      message: "此节点已有同类生成任务",
    });
    expect((await wait(first.id, "outcome_unknown"))?.canRecheck).toBe(true);
    expect(await wait(second.id, "running")).toBeDefined();
  });

  it("Sora 二进制下载入库，视频提帧形成可复用的派生资产", async () => {
    const clip = join(root, "sample.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=24:d=1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
    const data = await readFile(clip);
    await edit(node("sample", "video"));
    const plugin = registry.list().plugins.find(({ key }) => key === "sora");
    const draft = await registry.draft(
      String(plugin?.source).replace(
        "firstDelay: 15, interval: 10",
        "firstDelay: 0.01, interval: 0.01, maxInterval: 0.02",
      ),
    );
    provider = (request, response) => {
      if (request.method === "POST") response.end(JSON.stringify({ id: "sora-1" }));
      else if (request.url?.endsWith("/content"))
        response.writeHead(200, { "content-type": "video/mp4" }).end(data);
      else response.end(JSON.stringify({ status: "completed" }));
    };
    const entry = { id: randomUUID(), input: input(configure("sora", draft.hash)) };
    await service.submit(store, [entry]);
    const job = await wait(entry.id, "succeeded");
    const output = job?.outputs[0];
    if (!output || !("assetId" in output)) throw new Error("Missing generated video");
    const args = { project: agent.key(store), runId: "run-frame", input: { nodeIds: ["sample"] } };
    const inspect = { ...args, media: "video", input: { nodeId: "sample", timeMs: 250 } };
    await expect(agent.command("inspect", inspect)).rejects.toMatchObject({
      code: "AGENT_READ_REQUIRED",
    });
    await agent.command("read", args);
    const frame = await agent.command("inspect", inspect);
    expect(frame).toMatchObject({ mime: "image/png", data: expect.stringMatching(/^iVBOR/) });
    expect(await agent.command("inspect", inspect)).toEqual(frame);
    expect(Object.values(store.snapshot.assets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: "generated", mediaType: "video" }),
        expect.objectContaining({
          origin: "derived",
          mediaType: "image",
          metadata: expect.objectContaining({ sourceAssetId: output.assetId, timeMs: 250 }),
        }),
      ]),
    );
    expect(Object.keys(store.snapshot.assets)).toHaveLength(2);
  });

  it("视频裁切生成新的派生素材，非法范围与编码失败不会污染项目", async () => {
    const clip = join(root, "trim-source.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=160x90:r=24:d=1.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=1.2",
      "-shortest",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      clip,
    ]);
    const files = new AssetFiles(join(root, "trim-locators"));
    const assets = new AssetService(join(binaries, "ffprobe"));
    const sourceHandle = await open(clip, "r");
    let sourceAsset: ProjectState["assets"][string] | undefined;
    try {
      const imported = await assets.importCopy(
        store,
        sourceHandle,
        "trim-source.mp4",
        randomUUID(),
      );
      if (imported.kind !== "created") throw new Error("Expected source video asset");
      sourceAsset = imported.asset;
      await store.commitAsset({
        operationId: randomUUID(),
        expectedRevision: store.snapshot.revision,
        requestHash: createHash("sha256").update("source-test").digest("hex"),
        asset: sourceAsset,
      });
    } finally {
      await sourceHandle.close();
    }
    if (!sourceAsset || typeof sourceAsset !== "object") throw new Error("Missing source asset");
    const media = new CanvasMedia(files, assets, ffmpeg);
    await expect(
      media.trim(store, sourceAsset, randomUUID(), 900, 800, false, new AbortController().signal),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const operationId = randomUUID();
    const staged = await media.trim(
      store,
      sourceAsset,
      operationId,
      200,
      800,
      true,
      new AbortController().signal,
    );
    await assets.publishBlob(store, staged);
    const committed = await store.commitAsset({
      operationId,
      expectedRevision: store.snapshot.revision,
      requestHash: createHash("sha256").update("trim-test").digest("hex"),
      asset: staged.asset,
    });
    await assets.discard(staged);
    expect(committed.asset).toMatchObject({
      origin: "derived",
      mediaType: "video",
      metadata: { trimStartMs: 200, trimEndMs: 800, audioRemoved: true },
    });
    expect(Number(committed.asset.metadata.durationMs)).toBeGreaterThanOrEqual(550);
    expect(Number(committed.asset.metadata.durationMs)).toBeLessThanOrEqual(750);
    const ffprobe = join(binaries, "ffprobe");
    expect(
      (await probeMedia(ffprobe, clip)).streams.some(({ codec_type }) => codec_type === "audio"),
    ).toBe(true);
    const { sha256 } = committed.asset;
    const cut = join(store.directory, "assets", "sha256", sha256.slice(0, 2), sha256);
    expect(
      (await probeMedia(ffprobe, cut, { inputFormat: "mov" })).streams.some(
        ({ codec_type }) => codec_type === "audio",
      ),
    ).toBe(false);
    expect(Object.values(store.snapshot.assets)).toHaveLength(2);
    await expect(
      new CanvasMedia(files, assets, "/usr/bin/false").trim(
        store,
        sourceAsset,
        randomUUID(),
        0,
        500,
        false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "ASSET_READ_FAILED" });
    expect(Object.values(store.snapshot.assets)).toHaveLength(2);
    expect(await readdir(join(store.directory, "tmp"))).toEqual([]);
  });

  it("图片宫格拆图一次提交全部派生 PNG，失败不登记半成品", async () => {
    const image = join(root, "grid-source.png");
    const pixels = Buffer.from(Array.from({ length: 5 * 3 * 4 }, (_, index) => index * 4));
    await writeFile(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAYAAABbNsX4AAAASklEQVR4nAE/AMD/AAAECAwQFBgcICQoLDA0ODxAREhMAFBUWFxgZGhscHR4fICEiIyQlJicAKCkqKywtLi8wMTIzNDU2Nzg5OjsQd0bqSpjZ0wAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const files = new AssetFiles(join(root, "split-locators"));
    const assets = new AssetService(join(binaries, "ffprobe"));
    const handle = await open(image, "r");
    let sourceAsset: ProjectState["assets"][string];
    try {
      const imported = await assets.importCopy(store, handle, "grid-source.png", randomUUID());
      if (imported.kind !== "created") throw new Error("Expected source image asset");
      sourceAsset = imported.asset;
      await store.commitAsset({
        operationId: randomUUID(),
        expectedRevision: store.snapshot.revision,
        requestHash: createHash("sha256").update("grid-source").digest("hex"),
        asset: sourceAsset,
      });
    } finally {
      await handle.close();
    }
    if (!sourceAsset) throw new Error("Missing source asset");
    const media = new CanvasMedia(files, assets, ffmpeg);
    const operationId = randomUUID();
    const staged = await media.split(
      store,
      sourceAsset,
      operationId,
      2,
      2,
      new AbortController().signal,
      { x: [0.6], y: [1 / 3] },
    );
    expect(staged).toHaveLength(4);
    for (const [index, { temporary }] of staged.entries()) {
      const left = index % 2 === 0 ? 0 : 3;
      const right = index % 2 === 0 ? 3 : 5;
      const top = index < 2 ? 0 : 1;
      const bottom = index < 2 ? 1 : 3;
      const actual = await runMediaProcess(ffmpeg, [
        "-v",
        "error",
        "-f",
        "png_pipe",
        "-i",
        temporary,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
      ]);
      expect(actual).toEqual(
        Buffer.concat(
          Array.from({ length: bottom - top }, (_, row) =>
            pixels.subarray(((top + row) * 5 + left) * 4, ((top + row) * 5 + right) * 4),
          ),
        ),
      );
    }
    for (const item of staged) await assets.publishBlob(store, item);
    const expectedRevision = store.snapshot.revision;
    const requestHash = createHash("sha256").update("grid-split").digest("hex");
    const committed = await store.commitAssets({
      operationId,
      expectedRevision,
      requestHash,
      assets: staged.map(({ asset }) => asset),
    });
    await Promise.all(staged.map((item) => assets.discard(item)));
    expect(committed.assets).toHaveLength(4);
    expect(committed.revision).toBe(expectedRevision + 1);
    expect(store.replayAssetBatch(operationId, requestHash)).toEqual(committed);
    expect(
      committed.assets.every((item) => item?.origin === "derived" && item.mediaType === "image"),
    ).toBe(true);
    expect(committed.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ splitRow: 0, splitColumn: 0 }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ splitRow: 1, splitColumn: 1 }),
        }),
      ]),
    );
    expect(Object.values(store.snapshot.assets)).toHaveLength(5);
    let writes = 0;
    const failingAssets = new AssetService(
      join(binaries, "ffprobe"),
      async (target, chunk, position) => {
        if (++writes === 2) throw new Error("test disk write fault");
        return (await target.write(chunk, 0, chunk.length, position)).bytesWritten;
      },
    );
    await expect(
      new CanvasMedia(files, failingAssets, ffmpeg).split(
        store,
        sourceAsset,
        randomUUID(),
        2,
        2,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "ASSET_STORAGE_FAILED" });
    expect(writes).toBe(2);
    expect(await readdir(join(store.directory, "tmp"))).toEqual([]);
    expect(store.snapshot.revision).toBe(committed.revision);
    const abort = new AbortController();
    const interruptedAssets = new AssetService(
      join(binaries, "ffprobe"),
      async (target, chunk, position) => {
        const { bytesWritten } = await target.write(chunk, 0, chunk.length, position);
        abort.abort();
        return bytesWritten;
      },
    );
    await expect(
      new CanvasMedia(files, interruptedAssets, ffmpeg).split(
        store,
        sourceAsset,
        randomUUID(),
        2,
        2,
        abort.signal,
      ),
    ).rejects.toMatchObject({ code: "ASSET_IMPORT_CANCELLED" });
    expect(await readdir(join(store.directory, "tmp"))).toEqual([]);
    expect(store.snapshot.revision).toBe(committed.revision);
    await expect(
      media.split(store, sourceAsset, randomUUID(), 1, 1, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(Object.values(store.snapshot.assets)).toHaveLength(5);
  });

  it("图片涂鸦生成新的派生 PNG，保留原图并可校验来源", async () => {
    const image = join(root, "annotate-source.png");
    await writeFile(image, Buffer.from(png, "base64"));
    const files = new AssetFiles(join(root, "annotate-locators"));
    const assets = new AssetService(join(binaries, "ffprobe"));
    const sourceHandle = await open(image, "r");
    let sourceAsset: ProjectState["assets"][string] | undefined;
    try {
      const imported = await assets.importCopy(
        store,
        sourceHandle,
        "annotate-source.png",
        randomUUID(),
      );
      if (imported.kind !== "created") throw new Error("Expected source image asset");
      sourceAsset = imported.asset;
      await store.commitAsset({
        operationId: randomUUID(),
        expectedRevision: store.snapshot.revision,
        requestHash: createHash("sha256").update("annotate-source").digest("hex"),
        asset: sourceAsset,
      });
    } finally {
      await sourceHandle.close();
    }
    if (!sourceAsset) throw new Error("Missing source image asset");
    const media = new CanvasMedia(files, assets, ffmpeg);
    const operationId = randomUUID();
    const staged = await media.annotate(
      store,
      sourceAsset,
      operationId,
      `data:image/png;base64,${png}`,
      new AbortController().signal,
    );
    expect(staged.asset).toMatchObject({
      origin: "derived",
      mediaType: "image",
      metadata: { sourceAssetId: sourceAsset.assetId, annotation: "doodle" },
    });
    await assets.publishBlob(store, staged);
    const committed = await store.commitAsset({
      operationId,
      expectedRevision: store.snapshot.revision,
      requestHash: createHash("sha256").update("annotate-test").digest("hex"),
      asset: staged.asset,
    });
    await assets.discard(staged);
    expect(committed.asset.assetId).not.toBe(sourceAsset.assetId);
    expect(Object.values(store.snapshot.assets)).toHaveLength(2);
    expect(await readFile(image)).toEqual(Buffer.from(png, "base64"));
    expect(
      await readFile(
        join(
          store.directory,
          "assets",
          "sha256",
          committed.asset.sha256.slice(0, 2),
          committed.asset.sha256,
        ),
      ),
    ).toEqual(Buffer.from(png, "base64"));
    await expect(
      media.annotate(store, sourceAsset, randomUUID(), "not-a-png", new AbortController().signal),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("生成期间人工编辑保留，待处理任务可取消且不会联系供应商", async () => {
    await edit(node("sample"), node("second"));
    const profile = configure();
    let release: ServerResponse | undefined;
    provider = (_request, response) => {
      release = response;
    };
    const first = { id: randomUUID(), input: input(profile) };
    const second = { id: randomUUID(), input: input(profile, "second") };
    await service.submit(store, [first, second]);
    await expect.poll(() => Boolean(release)).toBe(true);
    await service.cancel(store, second.id);
    await edit(node("sample", "image", "人工输入"));
    release?.end(JSON.stringify({ data: [{ b64_json: png }] }));
    expect(await wait(first.id, "succeeded")).toMatchObject({ bound: false });
    await wait(second.id, "cancelled");
    expect(Object.values(store.snapshot.assets)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("只执行审批中的选中项，对账幂等且任务状态不能跨项目读取", async () => {
    await edit(node("sample"), node("second"));
    const profile = configure();
    const args = { project: agent.key(store), runId: "run-1" };
    await agent.command("read", { ...args, input: { nodeIds: ["sample", "second"] } });
    const preview = await agent.command("generate-preview", {
      ...args,
      input: { items: [input(profile), input(profile, "second")] },
    });
    const apply = { ...args, id: "approval-1", input: preview, selected: [1] };
    await agent.command("generate-apply", apply);
    await agent.command("generate-apply", apply);
    const jobs = service.list(store).jobs;
    expect(jobs.map(({ nodeId }) => nodeId)).toEqual(["second"]);
    const [job] = jobs;
    if (!job) throw new Error("Missing approved job");
    await wait(job.id, "succeeded");
    const other = await ProjectStore.create(root, "另一项目");
    try {
      agent.attach(other);
      expect(await agent.command("tasks", { project: agent.key(other), ids: [job.id] })).toEqual(
        [],
      );
    } finally {
      agent.detach(other);
      await other.close();
    }
    expect(calls).toHaveLength(1);
  });

  it.each(["审批后 Worker 中止", "审批后用户停止", "混合成败后 Worker 中止"])(
    "%s，保留原任务且只交付一次",
    async (scenario) => {
      const mixed = scenario === "混合成败后 Worker 中止";
      const nodeIds = mixed ? ["sample", "second"] : ["sample"];
      await edit(...nodeIds.map((id) => node(id)));
      const profile = configure();
      if (mixed) {
        provider = (_request, response) =>
          response.end(JSON.stringify({ data: [{ b64_json: calls.length === 1 ? png : "bad" }] }));
      }
      const model = await fakeGo({
        turns: [
          { tools: [{ id: "read", name: "canvas_get_state", args: { nodeIds } }] },
          {
            tools: [
              {
                id: "generate",
                name: "generate_media",
                args: { items: nodeIds.map((id) => input(profile, id)) },
              },
            ],
          },
          { text: "恢复后的任务结果已收到" },
        ],
      });
      const projectId = agent.key(store);
      const scope = { kind: "canvas", projectId };
      const events: PublishedEvent[] = [];
      let client: AgentWorkerClient | undefined;
      let stop: (() => Promise<unknown>) | undefined;
      let executions = 0;
      const open = () =>
        AgentWorkerClient.open({
          workerPath:
            process.env.LINK_STUDIO_AGENT_WORKER ??
            join(process.cwd(), "out/agent-runtime/worker.mjs"),
          directory: join(root, "assistant"),
          modelBridgeUrl: model.url,
          onEvent: (event) => events.push(event),
          settings: async (command, args) => {
            if (command === "model")
              return { name: "Fixture", context_window: 32768, max_tokens: 2048, vision: false };
            if (!command.startsWith("canvas:"))
              throw new Error(`Unexpected bridge call ${command}`);
            const result = await agent.command(command.slice(7), args);
            if (command === "canvas:generate-apply") {
              executions++;
              if (scenario !== "审批后用户停止") await client?.worker.terminate();
              else await stop?.();
            }
            return result;
          },
        });
      try {
        const original = await open();
        client = original;
        await original.request("recoverCanvas", { scope });
        const { sessionId } = await original.request<{ sessionId: string }>("create", { scope });
        const run = await original.request<Run>("start", { scope, sessionId, message: "生成海报" });
        await original.request("idle");
        const [approval] = await original.request<Approval[]>("approvals", {
          scope,
          sessionId,
          runId: run.id,
        });
        expect(approval?.status).toBe("pending");
        stop = () => original.request("cancel", { scope, sessionId, runId: run.id });
        const decision = original.request("decide", {
          scope,
          sessionId,
          approvalId: approval?.id,
          decision: {
            decision: "approve",
            items: nodeIds.map((_, index) => ({ index, approve: true })),
          },
        });
        const crashed = scenario !== "审批后用户停止";
        if (crashed) {
          await expect(decision).rejects.toThrow("AGENT_WORKER_EXITED");
          expect(events.filter(({ type }) => type === "watch.updated")).toHaveLength(0);
        } else {
          await decision;
          await original.request("closeCanvas", { scope });
          await original.close();
        }
        const approved = service.list(store).jobs;
        expect(approved).toHaveLength(nodeIds.length);
        await expect
          .poll(() =>
            service
              .list(store)
              .jobs.map(({ status }) => status)
              .sort(),
          )
          .toEqual(mixed ? ["failed", "succeeded"] : ["succeeded"]);
        await reopen();
        const recovered = await open();
        client = recovered;
        await recovered.request("recoverCanvas", { scope });
        await recovered.request("recoverCanvas", { scope });
        await expect
          .poll(() => events.filter(({ type }) => type === "tasks.settled").length, {
            timeout: 5000,
          })
          .toBe(1);
        await recovered.request("idle");
        await recovered.close();
        const reopened = await open();
        client = reopened;
        await reopened.request("recoverCanvas", { scope });
        const state = await reopened.request<{ events: PublishedEvent[] }>("state", {
          scope,
          sessionId,
        });
        const settled = state.events.filter(({ type }) => type === "tasks.settled");
        expect(settled).toHaveLength(1);
        const result = settled[0]?.payload as { tasks: { task_status: string }[] } | undefined;
        const tasks = result?.tasks ?? [];
        expect(tasks.map(({ task_status }) => task_status).sort()).toEqual(
          mixed ? ["failed", "succeeded"] : ["succeeded"],
        );
        expect(
          state.events.filter(
            ({ type, payload }) =>
              type === "watch.updated" && (payload as { state: string }).state === "waiting",
          ),
        ).toHaveLength(1);
        expect(service.list(store).jobs).toHaveLength(nodeIds.length);
        expect(executions).toBe(1);
        expect(calls).toHaveLength(nodeIds.length);
        expect(model.modelRequests).toHaveLength(crashed ? 3 : 2);
      } finally {
        await client?.close();
        await model.close();
      }
    },
  );

  it("读集与修订门控编辑，撤销跳过后来手工编辑", async () => {
    await edit(node("sample"), node("second"));
    const args = { project: agent.key(store), runId: "run-2" };
    const input = {
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [
        { type: "putNode", node: node("sample", "image", "助手修改") },
        { type: "removeNode", id: "second" },
      ],
    };
    await expect(agent.command("edit-preview", { ...args, input })).rejects.toMatchObject({
      code: "AGENT_READ_REQUIRED",
    });
    await agent.command("read", { ...args, input: {} });
    await expect(agent.command("edit-preview", { ...args, input })).rejects.toMatchObject({
      code: "AGENT_READ_REQUIRED",
    });
    await expect(
      agent.command("read", { ...args, input: { nodeIds: ["sample", "second", "missing"] } }),
    ).resolves.toMatchObject({ missingNodeIds: ["missing"] });
    const preview = await agent.command("edit-preview", { ...args, input });
    await agent.command("edit-apply", { ...args, input: preview, id: "edit-1" });
    await expect(
      agent.command("edit-apply", { ...args, input: preview, id: "edit-2" }),
    ).rejects.toMatchObject({ code: "CANVAS_REVISION_CONFLICT" });
    await edit(node("sample", "image", "人工修改"));
    expect(await agent.command("undo", args)).toMatchObject({
      reverted: 1,
      skipped: [{ id: "sample" }],
    });
    expect(store.getCanvas().canvas.nodes.find(({ id }) => id === "sample")).toMatchObject({
      data: { text: "人工修改" },
    });
    expect(store.getCanvas().canvas.nodes.some(({ id }) => id === "second")).toBe(true);
    agent.detach(store);
    await expect(agent.command("read", { ...args, input: {} })).rejects.toMatchObject({
      code: "AGENT_SCOPE_DENIED",
    });
  });

  it("小灵按需读取导演场景，概览仅含摘要，精读内容脱敏", async () => {
    const director = {
      version: 1 as const,
      duration: 4,
      activeCameraId: "camera-1",
      props: [],
      characters: [],
      cameras: [
        {
          id: "camera-1",
          name: "sk-fixturedirectorsecret",
          aspect: "9:16" as const,
          x: 0,
          y: 1.6,
          z: 5,
          yaw: 0,
          pitch: 0,
          fov: 45,
          keys: [{ t: 0, x: 0, y: 1.6, z: 5, yaw: 0, pitch: 0, fov: 45, ease: "linear" as const }],
        },
      ],
    };
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [
        {
          type: "putNode",
          node: {
            ...node("director"),
            data: { kind: "script", label: "导演台", text: "", director },
          },
        },
      ],
    });
    const args = { project: agent.key(store), runId: "director-read" };
    const summary = await agent.command("read", { ...args, input: {} });
    expect(summary).toMatchObject({
      nodes: [{ data: { directorSummary: { cameraCount: 1, duration: 4, aspect: "9:16" } } }],
    });
    expect(JSON.stringify(summary)).not.toContain('"cameras"');
    const detail = await agent.command("read", { ...args, input: { nodeIds: ["director"] } });
    expect(detail).toMatchObject({
      nodes: [{ data: { director: { cameras: [{ name: "[凭证已移除]", keys: [{ t: 0 }] }] } } }],
    });
    expect(JSON.stringify(detail)).not.toContain("sk-fixturedirectorsecret");
  });
});
