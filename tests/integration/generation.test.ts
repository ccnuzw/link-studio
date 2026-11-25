import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkerClient } from "../../packages/agent-runtime/src/client";
import type { PublishedEvent } from "../../packages/agent-runtime/upstream/src/engine/engine";
import type { Approval, Run } from "../../packages/agent-runtime/upstream/src/store/types";
import { fakeGo } from "../../packages/agent-runtime/upstream/test/fake-go";
import type { GenerationInput, JobStatus } from "../../packages/link-studio-core/src/generation";
import type { ProjectState } from "../../packages/link-studio-core/src/project";
import { settingsRequests } from "../../packages/link-studio-core/src/settings-api";
import { probeMedia } from "../../packages/media-runtime/src/probe";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { AssetFiles } from "../../src/main/project/asset-files";
import { AssetService } from "../../src/main/project/assets";
import { CanvasAgentService } from "../../src/main/project/canvas-agent";
import { CanvasMedia } from "../../src/main/project/canvas-media";
import {
  addDramaSegment,
  chooseDramaTake,
  createDrama,
  DramaTools,
  deleteDramaSegment,
  dramaDocument,
  reorderDramaSegments,
} from "../../src/main/project/drama";
import { estimateDramaJob } from "../../src/main/project/drama-estimate";
import { submitApprovedDramaJob } from "../../src/main/project/drama-job";
import { runDramaAssetJob } from "../../src/main/project/drama-worker";
import { GenerationService } from "../../src/main/project/generation";
import { ProjectStore } from "../../src/main/project/store";
import { openAgentStream } from "../../src/main/settings/agent-model";
import { runModelTrial } from "../../src/main/settings/model-trial";
import { SettingsRegistry } from "../../src/main/settings/registry";
import { uploadTrialReference } from "../../src/main/settings/trial-reference-upload";
import { applyKindTemplate } from "../../src/renderer/settings/model-kind-template";
import { batchVideoTargets } from "../../src/renderer/workspace/drama-segment-status";
import { CanvasResultObserver } from "../../src/renderer/workspace/pet/result-observer";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=";
const binaries =
  process.env.LINK_STUDIO_MEDIA_DIRECTORY ??
  join(process.cwd(), "out/media", `${process.platform}-${process.arch}`);
const ffmpeg = join(binaries, "ffmpeg");
const node = (
  id: string,
  kind: "image" | "video" | "audio" | "script" = "image",
  text = "生成样本",
) => ({
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

  function openRegistry(
    recentProjects?: () => Promise<{ projectId: string; directory: string }[]>,
  ) {
    return SettingsRegistry.open(
      join(root, "settings"),
      "resources/provider-plugins",
      "out/provider-runtime/runner",
      {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => Buffer.from(value).toString(),
      },
      undefined,
      recentProjects,
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "link-studio-generation-"));
    registry = await openRegistry();
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

  function draftVideo(source: string) {
    return registry.draft(`${source}\nmodule.exports.meta.key='fixture-video';`);
  }

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

  function generationChannel(running?: number, headers: { name: string; value: string }[] = []) {
    const created = registry.channelSave({
      expectedRevision: 0,
      approve: true,
      fields: {
        name: "创作服务",
        running,
        endpoint,
        allowLocal: true,
        enabled: true,
        sort: 100,
        headers,
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

  it("故事板重画排队时保留历史，取消后恢复采用版和本集完成数", async () => {
    const profile = configure();
    const document = await createDrama(store, { title: "来客", script: "敲门" });
    const { segments } = await addDramaSegment(store, {
      episode_no: 1,
      revision: document.revision,
      prompt: "推开门。",
      seconds: 5,
    });
    const segment = segments![0]!;
    await store.updateGeneration((state) => {
      dramaDocument(state)!.episodes[0]!.locked = true;
      return { changed: true, result: null };
    });
    const tools = new DramaTools();
    const summary = () =>
      tools.command(store, "drama-read", {
        runId: "board",
        input: { scope: "episode", episode_no: 1 },
      });
    const nodeId = randomUUID();
    const entry = () => ({
      id: randomUUID(),
      input: {
        ...input(profile, nodeId),
        purpose: "drama-board" as const,
        board: {
          segmentId: segment.id,
          sourceHash: createHash("sha256").update(segment.prompt).digest("hex"),
          refs: [],
        },
      },
    });
    const first = entry();
    await service.submit(store, [first]);
    const result = await wait(first.id, "succeeded");
    const outputId = `${first.id}:0`;
    const asset = result?.outputs[0];
    if (asset?.kind !== "image") throw Error("缺少故事板图片");
    await expect(summary()).resolves.toMatchObject({ done_board_count: 1 });
    await service.stop(store);
    const pump = vi.spyOn(service, "start").mockImplementation(() => {});
    const second = entry();
    await service.submit(store, [second]);
    const board = () => store.getCanvas().canvas.nodes.find((node) => node.id === nodeId)?.data;
    expect(board()).not.toHaveProperty("assetId");
    expect(board()).toMatchObject({ outputs: [{ id: outputId, assetId: asset.assetId }] });
    await expect(summary()).resolves.toMatchObject({ done_board_count: 0 });
    expect(await service.cancel(store, second.id)).toMatchObject({ status: "cancelled" });
    expect(board()).toMatchObject({ activeOutputId: outputId, assetId: asset.assetId });
    await expect(summary()).resolves.toMatchObject({ done_board_count: 1 });
    await store.updateGeneration((state) => {
      dramaDocument(state)!.segments![0]!.prompt += "回头。";
      return { changed: true, result: null };
    });
    await expect(summary()).resolves.toMatchObject({ done_board_count: 0 });
    expect(calls).toHaveLength(1);
    pump.mockRestore();
    const failed = entry();
    failed.input.board.sourceHash = createHash("sha256")
      .update(`${segment.prompt}回头。`)
      .digest("hex");
    provider = (_request, response) =>
      response.writeHead(400).end(JSON.stringify({ error: { message: "图片请求失败" } }));
    await service.submit(store, [failed]);
    await wait(failed.id, "failed");
    expect(board()).not.toHaveProperty("assetId");
    expect(board()).toMatchObject({ outputs: [{ id: outputId, assetId: asset.assetId }] });
    await expect(summary()).resolves.toMatchObject({ done_board_count: 0 });
  });

  it("文本任务按提交快照和产物用量计价；缺报按报价、超报封顶，重开不重新计价", async () => {
    const channel = generationChannel(1),
      plugin = registry.list().plugins.find((item) => item.key === "openai")!;
    const model = registry.modelSave({
      channelId: channel.id,
      channelRevision: channel.revision,
      expectedRevision: 0,
      upstreamModel: "fixture-text",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: { api: "chat_completions" },
      config: {
        kind: "text",
        name: "用量测试",
        sort: 1,
        description: "",
        systemPrompt: "📷",
        contextWindow: 4096,
        maxOutputTokens: 256,
        pricing: { unit: "token", input: 1_000_000, output: 500_000 },
      },
    });
    await edit({ ...node("script"), data: { kind: "script", label: "对白", text: "" } });
    const receipts = [];
    for (const [usage, expected] of [
      [{ prompt_tokens: 2, completion_tokens: 3 }, 4],
      [undefined, 131],
      [{ prompt_tokens: 999, completion_tokens: 5 }, 131],
      [{ prompt_tokens: 0, completion_tokens: 0 }, 1],
    ] as const) {
      provider = (_request, response) =>
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ choices: [{ message: { content: "回执" } }], usage }));
      const entry = { id: randomUUID(), input: { ...input(model, "script"), prompt: "海🌙" } };
      const [queued] = await service.submit(store, [entry]);
      expect(queued).toMatchObject({
        status: "queued",
        quotedCredits: 131,
        modelKey: model.id,
        model: "用量测试",
      });
      expect(queued).not.toHaveProperty("settledCredits");
      expect(await wait(entry.id, "succeeded")).toMatchObject({
        quotedCredits: 131,
        settledCredits: expected,
      });
      receipts.push({ entry, expected });
    }
    await reopen();
    for (const { entry, expected } of receipts)
      expect((await service.submit(store, [entry]))[0]).toMatchObject({
        quotedCredits: 131,
        modelKey: model.id,
        settledCredits: expected,
      });
    expect(calls).toHaveLength(4);
  });

  it("停用 OpenAI 后 Gemini 分镜经宿主流式网关提交，持久化分镜且重开不重复请求", async () => {
    const channel = generationChannel(1, [{ name: "x-fixture-channel", value: "split" }]);
    const plugin = registry.list().plugins.find((item) => item.key === "openai")!;
    registry.pluginToggle({ hash: plugin.hash, enabled: false });
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "fixture",
      config: {
        kind: "agent",
        name: "分镜助手",
        description: "",
        sort: 100,
        agentDeadlineSeconds: 180,
        timeoutSeconds: 20,
        contextWindow: 4096,
        maxOutputTokens: 256,
        pricing: { unit: "token", input: 1000000, output: 1000000 },
      },
      enabled: true,
      settings: { api: "gemini" },
    });
    const original = {
      id: "shot-before",
      scene: "原镜头",
      shot: "",
      camera: "",
      action: "",
      dialogue: "",
      duration: 2,
    } as const;
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [
        {
          type: "putNode",
          node: {
            ...node("board"),
            data: { kind: "script", label: "分镜表", text: "", storyboard: [original] },
          },
        },
      ],
    });
    const headers: unknown[] = [];
    provider = (request, response) => {
      headers.push([request.headers["x-fixture-channel"], request.headers["x-goog-api-key"]]);
      const text = JSON.stringify([{ scene: "新镜头", duration: 4 }]);
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, thoughtsTokenCount: 2 } })}\n\n`,
        );
    };
    const entry = {
      id: randomUUID(),
      input: {
        ...input(model, "board"),
        purpose: "storyboard-split" as const,
        storyboardSplitMode: "append" as const,
      },
    };
    await service.submit(store, [entry]);
    expect(await wait(entry.id, "succeeded")).toMatchObject({
      bound: true,
      canCancelRemote: false,
      storyboardShotIds: [expect.any(String)],
      settledCredits: 10,
    });
    const snapshot = store.snapshot.jobs[entry.id] as { deadline: number; submittedAt: string };
    expect(Math.abs(snapshot.deadline - Date.parse(snapshot.submittedAt) - 180000)).toBeLessThan(
      1000,
    );
    await reopen();
    expect((await service.submit(store, [entry]))[0]?.status).toBe("succeeded");
    expect(store.getCanvas().canvas.nodes.find((item) => item.id === "board")?.data).toMatchObject({
      storyboard: [original, { scene: "新镜头", duration: 4 }],
    });
    expect(headers).toEqual([["split", "fixture-generation-key"]]);
    expect(calls).toEqual([
      "POST /antigravity/v1beta/models/fixture:streamGenerateContent?alt=sse",
    ]);
  });
  it("脚本节点使用未配置价格的 Responses Agent 生成正文", async () => {
    const channel = generationChannel(1);
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "fixture",
      config: { kind: "agent", name: "对白", description: "", sort: 1 },
      enabled: true,
      settings: { api: "responses" },
    });
    await edit(node("script", "script"));
    provider = (_request, response) => {
      const item = {
        type: "message",
        id: "msg_fixture",
        role: "assistant",
        content: [{ type: "output_text", text: "雨停了。" }],
      };
      const frame = (type: string, fields: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" }).end(
        frame("response.output_item.added", { output_index: 0, item }) +
          frame("response.output_text.delta", {
            output_index: 0,
            content_index: 0,
            delta: "雨停了。",
          }) +
          frame("response.output_item.done", { output_index: 0, item }) +
          frame("response.completed", {
            response: {
              status: "completed",
              output: [item],
              usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
            },
          }),
      );
    };
    const entry = { id: randomUUID(), input: input(model, "script") };
    await service.submit(store, [entry]);
    await wait(entry.id, "succeeded");
    expect(
      store.getCanvas().canvas.nodes.find((entry) => entry.id === "script")?.data,
    ).toMatchObject({ text: "雨停了。" });
    expect(calls).toEqual(["POST /v1/responses"]);
  });
  it("文本任务失败清空旧稿，成功清除错误，迟到的失败不会覆盖新稿", async () => {
    const profile = configure("openai", undefined, "fixture", { api: "chat_completions" });
    const initial = {
      ...node("script"),
      data: { kind: "script" as const, label: "对白", text: "旧稿" },
    };
    const putNode = (text: string) =>
      store.applyCanvasOperations({
        operationId: randomUUID(),
        expectedCanvasRevision: store.getCanvas().canvasRevision,
        operations: [{ type: "putNode", node: { ...initial, data: { ...initial.data, text } } }],
      });
    const saved = () =>
      store.getCanvas().canvas.nodes.find((entry) => entry.id === initial.id)?.data;
    await putNode("旧稿");
    const petResults = new CanvasResultObserver(Date.now());
    const send = async () => {
      const entry = { id: randomUUID(), input: input(profile, initial.id) };
      await service.submit(store, [entry]);
      return entry.id;
    };
    const fail = (response: ServerResponse) =>
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "剧本服务繁忙" } }));
    provider = (_request, response) => {
      fail(response);
    };
    const failed = await wait(await send(), "failed");
    expect(saved()).toMatchObject({
      text: "",
      textStatus: "error",
      textError: failed?.errorMessage || failed?.error,
    });
    provider = (_request, response) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ choices: [{ message: { content: "新一版对白" } }] }));
    const successful = await wait(await send(), "succeeded");
    expect(successful).toMatchObject({ bound: true });
    const completed = service.list(store).jobs;
    expect(
      petResults
        .collect(completed)
        .map(({ id }) => id)
        .sort(),
    ).toEqual([failed?.id, successful?.id].sort());
    expect(petResults.collect(completed)).toEqual([]);
    await reopen();
    const reopenedResults = new CanvasResultObserver(Date.now());
    expect(reopenedResults.collect(service.list(store).jobs)).toEqual([]);
    expect(saved()).toMatchObject({ text: "新一版对白", textStatus: "done" });
    expect(saved()).not.toHaveProperty("textError");
    let pending: ServerResponse | undefined;
    provider = (_request, response) => {
      pending = response;
    };
    const late = await send();
    await expect.poll(() => Boolean(pending)).toBe(true);
    expect(saved()).toMatchObject({ text: "", outputs: [{ text: "新一版对白" }] });
    expect(saved()).not.toHaveProperty("activeOutputId");
    await putNode("人工改稿");
    fail(pending!);
    await wait(late, "failed");
    expect(saved()).toMatchObject({ text: "人工改稿" });
    expect(saved()).not.toHaveProperty("textError");
  });
  it("同步图片输出入库并绑定，重复提交和重开只保留一份结果", async () => {
    await edit(node("sample"));
    const profile = configure();
    const project = agent.key(store);
    const models = await agent.command("model-list", { project, input: { kind: "image" } });
    expect(models).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({
          key: profile.id,
          revision: profile.revision,
          ops: expect.arrayContaining(["t2i"]),
        }),
      ]),
    });
    expect(JSON.stringify(models)).not.toContain("fixture-generation-key");
    const entry = { id: randomUUID(), input: input(profile) };
    await service.submit(store, [entry]);
    const job = await wait(entry.id, "succeeded");
    expect(job?.bound).toBe(true);
    expect(await agent.command("tasks", { project, ids: [entry.id] })).toMatchObject([
      { task_id: entry.id, status: "succeeded", outputs: [{ media_type: "image" }] },
    ]);
    await reopen();
    await service.submit(store, [entry]);
    const asset = Object.values(store.snapshot.assets)[0];
    expect(asset).toMatchObject({ origin: "generated", metadata: { jobId: entry.id } });
    expect(store.getCanvas().canvas.nodes.find(({ id }) => id === "sample")).toMatchObject({
      data: { assetId: asset?.assetId },
    });
    expect(calls).toHaveLength(1);
  });

  it("视频模型编辑值经保存、请求预览和本地试跑使用同一份配置", async () => {
    const channel = generationChannel();
    const upstreamModel = "doubao-seedance-2-5-flash";
    const config = applyKindTemplate(
      { kind: "video", name: "视频", description: "", sort: 0 },
      "video",
      false,
      { adapter: "doubao-video", model: upstreamModel },
    );
    config.refs = {
      image: { max: 9, mb: 10 },
      audio: { max: 4, mb: 15, on: false },
      video: { max: 1, mb: 100 },
    };
    const plugin = registry.list().plugins.find((entry) => entry.key === "doubao-video")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      pluginHash: plugin.hash,
      upstreamModel,
      settings: { as: "url" },
      approve: true,
      enabled: false,
      config,
    });
    const trial = {
      id: model.id,
      expectedRevision: model.revision,
      prompt: "山间云雾",
      op: "omni" as const,
      params: { duration: 8, resolution: "4K", generateAudio: false },
    };
    const received: Blob[] = [];
    const grant = (blob: Blob) => {
      received.push(blob);
      return "link-media://trial/fixture";
    };
    const reference = join(root, "reference.mp4");
    const maximum = 100 * 1024 * 1024;
    const handle = await open(reference, "w");
    await handle.truncate(maximum);
    await handle.close();
    const assetURL = "https://assets.example.com/uploaded-video.mp4";
    let uploadBytes = 0;
    let multipartPrefix = "";
    let multipartSuffix = "";
    provider = (request, response) => {
      request.on("data", (chunk: Buffer) => {
        if (!uploadBytes) multipartPrefix = chunk.subarray(0, 512).toString();
        uploadBytes += chunk.length;
        multipartSuffix = (multipartSuffix + chunk.subarray(-128).toString()).slice(-128);
      });
      request.on("end", () => response.end(JSON.stringify({ code: 0, data: { url: assetURL } })));
    };
    await expect(
      uploadTrialReference(reference, "video/mp4", maximum - 1, `${endpoint}/assets`),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    const url = await uploadTrialReference(reference, "video/mp4", maximum, `${endpoint}/assets`);
    const headerBytes = multipartPrefix.indexOf("\r\n\r\n") + 4;
    const footerBytes = multipartSuffix.length - multipartSuffix.indexOf("\r\n--link-studio-");
    expect(multipartPrefix).toContain('name="file"; filename="reference.mp4"');
    expect(uploadBytes - headerBytes - footerBytes).toBe(maximum);
    const references = [{ kind: "video" as const, url }];
    const preview = await runModelTrial(registry, { ...trial, references, dry: true }, grant);
    expect(preview.status).toBe("preview");
    const expected = {
      ratio: "Auto",
      resolution: "4K",
      duration: 8,
      generate_audio: false,
      content: expect.arrayContaining([
        { type: "video_url", video_url: { url: assetURL }, role: "reference_video" },
      ]),
    };
    expect(JSON.parse(preview.request!.body!)).toMatchObject(expected);
    expect(calls).toEqual(["POST /assets"]);
    const clip = join(root, "trial.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=s=64x48:d=0.2",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      clip,
    ]);
    const video = await readFile(clip);
    const tasks = "/api/v3/contents/generations/tasks";
    let sent: unknown;
    provider = (request, response) => {
      if (request.url === tasks && request.method === "POST") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          sent = JSON.parse(Buffer.concat(chunks).toString());
          response.end(JSON.stringify({ id: "trial-video" }));
        });
      } else if (request.url === `${tasks}/trial-video`) {
        response.end(
          JSON.stringify({ status: "succeeded", content: { video_url: `${endpoint}/trial.mp4` } }),
        );
      } else if (request.url === "/trial.mp4") {
        response.writeHead(200, { "content-type": "video/mp4" }).end(video);
      } else response.writeHead(404).end();
    };
    const result = await runModelTrial(registry, { ...trial, references, dry: false }, grant);
    expect(result).toMatchObject({
      status: "succeeded",
      outputs: [{ mediaType: "video", previewUrl: "link-media://trial/fixture" }],
    });
    expect(Buffer.from(await received[0]!.arrayBuffer())).toEqual(video);
    expect(sent).toMatchObject(expected);
    expect(calls).toEqual([
      "POST /assets",
      `POST ${tasks}`,
      `GET ${tasks}/trial-video`,
      "GET /trial.mp4",
    ]);
  }, 40000);

  it("全能参考请求接收各类型配置之和并拒绝单项超限", async () => {
    const channel = generationChannel();
    const upstreamModel = "doubao-seedance-2-5-flash";
    const config = applyKindTemplate(
      { kind: "video", name: "视频", description: "", sort: 0 },
      "video",
      false,
      { adapter: "doubao-video", model: upstreamModel },
    );
    const refs = {
      image: { max: 9, mb: 10 },
      audio: { max: 4, mb: 15 },
      video: { max: 1, mb: 100 },
    };
    const plugin = registry.list().plugins.find((entry) => entry.key === "doubao-video")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      pluginHash: plugin.hash,
      upstreamModel,
      settings: { as: "url" },
      approve: true,
      enabled: false,
      config: { ...config, refs },
    });
    const references = (["image", "audio", "video"] as const).flatMap((kind) =>
      Array.from({ length: refs[kind].max }, (_, index) => ({
        kind,
        url: `https://assets.example.com/${kind}-${index}`,
      })),
    );
    const mixed = {
      id: model.id,
      expectedRevision: model.revision,
      prompt: "云雾",
      params: {},
      op: "omni" as const,
      references,
      dry: true,
    };
    expect(references).toHaveLength(14);
    expect(Value.Check(settingsRequests.modelTrial, mixed)).toBe(true);
    const grant = () => {
      throw new Error("请求预览不应产生文件");
    };
    const preview = await runModelTrial(registry, mixed, grant);
    expect(preview.status).toBe("preview");
    const media = JSON.parse(preview.request!.body!).content.filter(
      (item: { type: string }) => item.type !== "text",
    );
    expect(media).toHaveLength(references.length);
    for (const { kind, url } of references)
      expect(media).toContainEqual({
        type: `${kind}_url`,
        [`${kind}_url`]: { url },
        role: `reference_${kind}`,
      });
    await expect(
      runModelTrial(
        registry,
        {
          ...mixed,
          references: [...references, { kind: "video", url: "https://assets.example.com/extra" }],
        },
        grant,
      ),
    ).rejects.toMatchObject({ code: "MODEL_TRIAL_INPUT_INVALID" });
    expect(calls).toEqual([]);
  });

  it("OpenAI 生图预设经保存和真实适配器换算为尺寸，Auto 不发送 size", async () => {
    const channel = generationChannel();
    const plugin = registry.list().plugins.find(({ key }) => key === "openai-image")!;
    const upstreamModel = "gpt-image-2";
    const config = applyKindTemplate(
      { kind: "image", name: upstreamModel, description: "", sort: 0 },
      "image",
      false,
      { adapter: plugin.key, model: upstreamModel },
    );
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      pluginHash: plugin.hash,
      upstreamModel,
      settings: {},
      approve: true,
      enabled: false,
      config,
    });
    for (const [ratio, size] of [
      [undefined, "1024x1024"],
      ["Auto", undefined],
      ["16:9", "1536x1024"],
      ["9:16", "1024x1536"],
      ["4:3", "1536x1024"],
      ["3:4", "1024x1536"],
    ] as const) {
      const preview = await runModelTrial(
        registry,
        {
          id: model.id,
          expectedRevision: model.revision,
          dry: true,
          prompt: "比例测试",
          params: ratio ? { aspectRatio: ratio } : {},
        },
        () => "",
      );
      expect(preview.status).toBe("preview");
      const body = JSON.parse(preview.request!.body!);
      if (size === undefined) expect(body).not.toHaveProperty("size");
      else expect(body.size).toBe(size);
      expect(body).not.toHaveProperty("quality");
    }
    const trial = {
      id: model.id,
      expectedRevision: model.revision,
      prompt: "色彩",
      params: {},
    };
    expect(calls).toEqual([]);
    let editBody = "";
    provider = (request, response) => {
      request.on("data", (chunk) => {
        editBody += chunk.toString("latin1");
      });
      request.on("end", () => response.end(JSON.stringify({ data: [{ b64_json: png }] })));
    };
    const edited = await runModelTrial(
      registry,
      {
        ...trial,
        dry: false,
        references: [{ kind: "image", file: { mime: "image/png", base64: png } }],
      },
      () => "link-media://trial/fixture",
    );
    expect(edited.status).toBe("succeeded");
    expect(calls).toEqual(["POST /v1/images/edits"]);
    expect(editBody).not.toContain('name="quality"');
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
    const received: Blob[] = [];
    const grant = (blob: Blob) => {
      received.push(blob);
      return "link-media://trial/fixture";
    };
    const preview = await runModelTrial(registry, { ...trial, dry: true }, grant);
    expect(preview).toMatchObject({
      status: "preview",
      trace: [],
      request: { method: "POST", endpoint: `${endpoint}/v1/images/edits` },
    });
    expect(calls).toEqual([]);
    const result = await runModelTrial(registry, { ...trial, dry: false }, grant);
    expect(result).toMatchObject({
      status: "succeeded",
      outputs: [{ mediaType: "image", previewUrl: "link-media://trial/fixture" }],
      trace: [
        { kind: "hook", hook: "buildSubmitRequest" },
        { kind: "http", status: 200 },
        { kind: "hook", hook: "parseSubmitResponse" },
      ],
    });
    expect(calls).toEqual(["POST /v1/images/edits"]);
    expect(Buffer.from(await received[0]!.arrayBuffer()).toString("base64")).toBe(png);
    expect(Buffer.concat(bodies).toString()).toContain("1024x1024");
    expect(Object.keys(store.snapshot.assets)).toHaveLength(0);
  });

  it("画布自定义生成数量绑定同一节点，部分失败不丢结果，重提交复用整批回执", async () => {
    const channel = generationChannel(1);
    const plugin = registry.list().plugins.find((item) => item.key === "openai-image")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "gpt-image-1",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: {
        kind: "image",
        name: "批量海报",
        sort: 100,
        description: "",
        pricing: { unit: "request", input: 7 },
        customParams: {
          copies: { type: "enum", label: "生成数量", values: [1, 3], default: 1, fanout: true },
        },
      },
    });
    provider = (_request, response) => {
      if (calls.length === 2) response.writeHead(400).end("{}");
      else response.end(JSON.stringify({ data: [{ b64_json: png }] }));
    };
    await edit(node("sample"));
    const entry = { id: randomUUID(), input: { ...input(model), customParams: { copies: 3 } } };
    const ids = (await service.submit(store, [entry])).map((job) => job.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(entry.id);
    expect(service.list(store).jobs.map((job) => job.batchId)).toEqual(ids.map(() => entry.id));
    expect(service.list(store).jobs.map((job) => job.quotedCredits)).toEqual([7, 7, 7]);
    for (const id of ids) {
      expect(store.snapshot.jobs[id]).not.toHaveProperty("input.customParams.copies");
      expect(store.snapshot.jobs[id]).toHaveProperty("input.seed");
    }
    await expect
      .poll(
        () =>
          service
            .list(store)
            .jobs.map((job) => job.status)
            .sort(),
        { timeout: 8000 },
      )
      .toEqual(["failed", "succeeded", "succeeded"]);
    const result = store.getCanvas().canvas.nodes[0];
    expect(result?.type === "creative" && result.data.outputs?.length).toBe(2);
    await reopen();
    expect((await service.submit(store, [entry])).map((job) => job.id)).toEqual(ids);
    for (const job of service.list(store).jobs) {
      expect(job.quotedCredits).toBe(7);
      expect(job.settledCredits).toBe(job.status === "succeeded" ? 7 : undefined);
    }
    expect(calls).toHaveLength(3);
  });

  it("队列只剩两个位置时接纳前两份，同一请求重开后只补建第三份", async () => {
    const channel = generationChannel(1);
    const plugin = registry.list().plugins.find((item) => item.key === "openai-image")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "gpt-image-1",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: {
        kind: "image",
        name: "海报",
        sort: 1,
        description: "",
        customParams: {
          copies: { type: "enum", label: "份数", values: [1, 3], default: 1, fanout: true },
        },
      },
    });
    const pins = Array.from({ length: 20 }, () => ({
      id: randomUUID(),
      pluginHash: plugin.hash,
      channelId: channel.id,
    }));
    registry.reconcileJobPins("other-project", pins);
    await edit(node("sample"));
    const entry = { id: randomUUID(), input: { ...input(model), customParams: { copies: 3 } } };
    await expect(service.submit(store, [entry])).rejects.toMatchObject({ code: "JOB_QUEUE_FULL" });
    expect(service.list(store).jobs).toEqual([]);
    registry.reconcileJobPins("other-project", pins.slice(0, 18));
    const accepted = await service.submit(store, [entry]);
    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toMatchObject({ id: entry.id, unsubmittedCount: 1 });
    for (const job of accepted) await wait(job.id, "succeeded");
    await reopen();
    const completed = await service.submit(store, [entry]);
    expect(completed).toHaveLength(3);
    expect(completed.slice(0, 2).map((job) => job.id)).toEqual(accepted.map((job) => job.id));
    expect(completed[0]).not.toHaveProperty("unsubmittedCount");
    await wait(completed[2]!.id, "succeeded");
    expect((await service.submit(store, [entry])).map((job) => job.id)).toEqual(
      completed.map((job) => job.id),
    );
    expect(calls).toHaveLength(3);
    const result = store.getCanvas().canvas.nodes[0];
    expect(result?.type === "creative" && result.data.outputs?.length).toBe(3);
  });

  it("正式生成跨渠道共享四个运行名额，试跑只占渠道名额", () => {
    const first = generationChannel(3);
    const second = generationChannel(3);
    const releases = [first, first, second, second].map((channel, index) =>
      registry.acquireGeneration(channel.id, `project-${index}`, `job-${index}`),
    );
    expect(releases.every(Boolean)).toBe(true);
    expect(registry.acquireGeneration(first.id, "another", "waiting")).toBeUndefined();
    expect(registry.acquireGeneration(undefined, "legacy", "direct")).toBeUndefined();
    const trial = registry.acquireGeneration(first.id, "model-trial", "trial-run");
    expect(trial).toBeTypeOf("function");
    expect(registry.acquireGeneration(first.id, "model-trial", "second-trial")).toBeUndefined();
    expect(registry.acquireGeneration(first.id, "project-0", "job-0")).toBeTypeOf("function");
    releases[2]!();
    expect(registry.acquireGeneration(first.id, "another", "waiting")).toBeUndefined();
    trial!();
    expect(registry.acquireGeneration(first.id, "another", "waiting")).toBeTypeOf("function");
    releases[1]!();
    expect(registry.acquireGeneration(undefined, "legacy", "direct")).toBeTypeOf("function");
  });

  it("同渠道多项目竞争按创建顺序分配空位，取消、退出与过期不阻塞后续任务", () => {
    const channel = generationChannel(2),
      now = Date.now(),
      until = now + 30000;
    const first = registry.acquireGeneration(channel.id, "active", "one")!,
      second = registry.acquireGeneration(channel.id, "active", "two")!;
    const enter = (index: number) =>
      registry.acquireGeneration(channel.id, `pending-${index}`, `job-${index}`, until, {
        created: now + index - 30,
        until,
      });
    for (let index = 11; index >= 0; index--) expect(enter(index)).toBeUndefined();
    first();
    second();
    registry.reconcileJobPins("pending-0", []);
    registry.clearGenerationWaiters("pending-1");
    expect(enter(4)).toBeUndefined();
    const third = enter(3)!;
    expect(enter(4)).toBeUndefined();
    const next = enter(2)!;
    expect(registry.acquireGeneration(channel.id, "model-trial", "trial")).toBeUndefined();
    next();
    third();
    for (let index = 4; index < 12; index++) {
      if (index + 2 < 12) expect(enter(index + 2)).toBeUndefined();
      const release = enter(index);
      expect(release).toBeTypeOf("function");
      release!();
    }
    const future = vi.spyOn(Date, "now").mockReturnValue(now + 40000);
    try {
      const held = registry.acquireGeneration(channel.id, "active", "a")!,
        other = registry.acquireGeneration(channel.id, "active", "b")!;
      expect(
        registry.acquireGeneration(channel.id, "stale", "expired", now + 41000, {
          created: now,
          until: now + 41000,
        }),
      ).toBeUndefined();
      held();
      future.mockReturnValue(now + 42000);
      expect(registry.acquireGeneration(channel.id, "model-trial", "trial")).toBeTypeOf("function");
      other();
    } finally {
      future.mockRestore();
    }
  });

  it("冷启动保留同毫秒的入队顺序，未打开项目与已撤销的旧票不挡住活跃任务", async () => {
    const channel = generationChannel(1),
      created = Date.now() - 100,
      until = created + 30000;
    const enter = (project: string) =>
      registry.acquireGeneration(channel.id, project, "job", until, { created, until });
    const holder = () => registry.acquireGeneration(channel.id, "holder", "active")!;
    expect(holder()).toBeTypeOf("function");
    for (const name of ["sleeping", "cancelled", "first", "second"])
      expect(enter(name)).toBeUndefined();
    registry.reconcileJobPins("cancelled", []);
    registry.close();
    registry = await openRegistry();
    for (const name of ["second", "first", "cancelled"]) expect(enter(name)).toBeUndefined();
    holder()();
    expect(enter("second")).toBeUndefined();
    expect(enter("cancelled")).toBeUndefined();
    const release = enter("first");
    expect(release).toBeTypeOf("function");
    release!();
    registry.clearGenerationWaiters("second");
    const next = enter("cancelled");
    expect(next).toBeTypeOf("function");
    next!();
    expect(calls).toEqual([]);
  });

  it("转存中保留设备名额，不占上游名额；重开设置库仍能按原任务恢复", async () => {
    const channel = generationChannel(1);
    registry.reconcileJobPins("source", [
      { id: "transfer", channelId: channel.id, pluginHash: "fixture" },
    ]);
    expect(registry.acquireGeneration(channel.id, "source", "transfer")).toBeTypeOf("function");
    expect(registry.acquireGeneration(channel.id, "next", "generate")).toBeUndefined();
    registry.markFinalizing("source", "transfer");
    registry.close();
    registry = await openRegistry();
    expect(registry.acquireGeneration(channel.id, "next", "generate")).toBeTypeOf("function");
    expect(registry.channelLoads()).toEqual([{ channel: channel.id, running: 1, waiting: 0 }]);
    expect(registry.acquireGeneration(channel.id, "source", "transfer")).toBeTypeOf("function");
    for (const job of ["third", "fourth"])
      expect(registry.acquireGeneration(undefined, "other", job)).toBeTypeOf("function");
    expect(registry.acquireGeneration(undefined, "other", "fifth")).toBeUndefined();
    registry.reconcileJobPins("source", []);
    expect(registry.acquireGeneration(undefined, "other", "fifth")).toBeTypeOf("function");
    expect(registry.acquireGeneration(channel.id, "again", "busy")).toBeUndefined();
  });

  it("两个打开的项目共用渠道生成名额，等待期间不重复提交", async () => {
    const channel = generationChannel(1);
    const plugin = registry.list().plugins.find((item) => item.key === "openai-image")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "gpt-image-1",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: { kind: "image", name: "海报", sort: 100, description: "" },
    });
    const second = await ProjectStore.create(root, "第二个项目");
    const pending: ServerResponse[] = [];
    provider = (_request, response) => {
      pending.push(response);
    };
    try {
      await edit(node("sample"));
      await second.applyCanvasOperations({
        operationId: randomUUID(),
        expectedCanvasRevision: second.getCanvas().canvasRevision,
        operations: [{ type: "putNode", node: node("second") }],
      });
      const firstJob = { id: randomUUID(), input: input(model) };
      const secondJob = {
        id: randomUUID(),
        input: {
          ...input(model, "second"),
          expectedCanvasRevision: second.getCanvas().canvasRevision,
        },
      };
      await service.submit(store, [firstJob]);
      await expect.poll(() => pending.length).toBe(1);
      await service.submit(second, [secondJob]);
      await expect
        .poll(() => {
          const job = second.snapshot.jobs[secondJob.id];
          return job && typeof job === "object" && !Array.isArray(job) ? Number(job.pollAfter) : 0;
        })
        .toBeGreaterThan(0);
      expect(service.list(second).jobs[0]?.status).toBe("queued");
      expect(pending).toHaveLength(1);
      const body = JSON.stringify({ data: [{ b64_json: png }] });
      pending[0]!.setHeader("content-type", "application/json").end(body);
      await wait(firstJob.id, "succeeded");
      await expect.poll(() => pending.length).toBe(2);
      pending[1]!.setHeader("content-type", "application/json").end(body);
      await expect.poll(() => service.list(second).jobs[0]?.status).toBe("succeeded");
      expect(Object.keys(store.snapshot.assets)).toHaveLength(1);
      expect(Object.keys(second.snapshot.assets)).toHaveLength(1);
      expect(calls).toHaveLength(2);
    } finally {
      for (const response of pending) response.destroy();
      await service.stop(second);
      await second.close();
    }
  });

  it("四个项目共用一个上游名额，关掉最早的等待项目后按顺序提交", async () => {
    const channel = generationChannel(1);
    const plugin = registry.list().plugins.find((item) => item.key === "openai-image")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "fixture-image",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: { kind: "image", name: "海报", sort: 1, description: "" },
    });
    const others: ProjectStore[] = [],
      pending: ServerResponse[] = [],
      sent: string[] = [];
    provider = (request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        sent.push(JSON.parse(body).prompt);
        pending.push(response);
      });
    };
    const ready = (response: ServerResponse) =>
      response
        .setHeader("content-type", "application/json")
        .end(JSON.stringify({ data: [{ b64_json: png }] }));
    try {
      for (const name of ["在生成", "待关闭", "先排队", "后排队"]) {
        const target = name === "在生成" ? store : await ProjectStore.create(root, name);
        if (target !== store) others.push(target);
        await target.applyCanvasOperations({
          operationId: randomUUID(),
          expectedCanvasRevision: target.getCanvas().canvasRevision,
          operations: [{ type: "putNode", node: node("sample") }],
        });
        const id = randomUUID();
        await service.submit(target, [
          {
            id,
            input: {
              ...input(model),
              prompt: name,
              expectedCanvasRevision: target.getCanvas().canvasRevision,
            },
          },
        ]);
        if (target === store) await expect.poll(() => sent).toEqual([name]);
        else
          await expect
            .poll(() =>
              Number((target.snapshot.jobs[id] as { pollAfter?: number })?.pollAfter ?? 0),
            )
            .toBeGreaterThan(0);
      }
      await service.stop(others[0]!);
      ready(pending[0]!);
      await expect.poll(() => sent).toEqual(["在生成", "先排队"]);
      ready(pending[1]!);
      await expect.poll(() => sent).toEqual(["在生成", "先排队", "后排队"]);
      ready(pending[2]!);
      await expect.poll(() => service.list(others[2]!).jobs[0]?.status).toBe("succeeded");
      expect(service.list(others[0]!).jobs[0]?.status).toBe("queued");
    } finally {
      for (const response of pending) response.destroy();
      for (const target of others) {
        await service.stop(target);
        await target.close();
      }
    }
  });

  it("等待渠道名额的任务超过模型时限后停止排队", async () => {
    await edit(node("sample"));
    const channel = generationChannel(1);
    const plugin = registry.list().plugins.find((item) => item.key === "openai-image")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "gpt-image-1",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: { kind: "image", name: "海报", sort: 100, description: "", timeoutSeconds: 0.2 },
    });
    const release = registry.acquireGeneration(channel.id);
    try {
      const entry = { id: randomUUID(), input: input(model) };
      await service.submit(store, [entry]);
      expect(await wait(entry.id, "failed")).toMatchObject({ error: "JOB_QUEUE_TIMEOUT" });
      expect(calls).toEqual([]);
    } finally {
      release?.();
    }
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

  it("100 MB 视频按模型上限校验并向 Seedance 发送公网引用", async () => {
    await edit(node("sample", "video"));
    const path = join(root, "reference.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=160x90:r=24:d=1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const handle = await open(path, "r+");
    const serviceAssets = new AssetService(join(binaries, "ffprobe"));
    let reference: string;
    try {
      await handle.truncate(100 * 1024 * 1024);
      const imported = await serviceAssets.importCopy(store, handle, "reference.mp4", randomUUID());
      if (imported.kind !== "created") throw new Error("缺少测试视频");
      await store.commitAsset({
        operationId: randomUUID(),
        expectedRevision: store.snapshot.revision,
        requestHash: imported.asset.sha256,
        asset: imported.asset,
      });
      reference = imported.asset.assetId;
    } finally {
      await handle.close();
    }
    const channel = generationChannel();
    const plugin = registry.list().plugins.find((item) => item.key === "doubao-video")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "doubao-seedance-2-0",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: {
        kind: "video",
        name: "大视频",
        sort: 1,
        description: "",
        refs: { video: { max: 1, mb: 100 } },
      },
    });
    const generation = { ...input(model), op: "omni" as const, referenceAssetIds: [reference] };
    await expect(service.prepare(store, generation)).rejects.toMatchObject({
      code: "JOB_INPUT_INVALID",
    });
    const url = "https://cdn.example.com/model-reference.mp4";
    let body = "";
    provider = (request, response) => {
      if (request.method !== "POST") {
        response.end('{"status":"running"}');
        return;
      }
      request.on("data", (chunk) => {
        body += chunk.toString();
      });
      request.on("end", () => response.end('{"id":"video-reference"}'));
    };
    const id = randomUUID();
    await service.submit(store, [
      { id, input: { ...generation, referenceURLs: { [reference]: url } } },
    ]);
    await wait(id, "running");
    expect(body).toContain(url);
    expect(Buffer.byteLength(body)).toBeLessThan(2048);
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

  it.each(["恢复", "不收参考图", "图片失败", "手动换主图", "参数无效"])(
    "角色联合生成按持久依赖处理%s",
    async (scenario) => {
      const image = configure();
      const voice = (() => {
        if (scenario !== "不收参考图")
          return configure("doubao-audio", undefined, "seed-audio", { as: "base64" });
        const channel = generationChannel();
        const plugin = registry.list().plugins.find((item) => item.key === "doubao-audio")!;
        const model = registry.modelSave({
          expectedRevision: 0,
          channelId: channel.id,
          channelRevision: channel.revision,
          upstreamModel: "seed-audio",
          pluginHash: plugin.hash,
          enabled: true,
          approve: true,
          settings: { as: "base64" },
          config: {
            kind: "audio",
            name: "纯文字音色",
            description: "",
            sort: 0,
            refs: { image: { max: 0, mb: 1 } },
          },
        });
        return registry.provider(model.id);
      })();
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
        } else if (scenario === "手动换主图" || scenario === "不收参考图") {
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

      if (scenario === "恢复" || scenario === "不收参考图") {
        if (scenario === "恢复") {
          expect(calls).toEqual([]);
          await reopen();
        } else {
          await expect.poll(() => !!imageResponse).toBe(true);
          expect(service.list(store).jobs.find((job) => job.id === voiceId)?.status).toBe("queued");
          expect(voiceRequest).toBeUndefined();
          imageResponse!.end(JSON.stringify({ data: [{ b64_json: png }] }));
        }
        const completed = await wait(voiceId, "succeeded");
        expect(completed).toMatchObject({ afterImageJobId: imageId, bound: true });
        const voiceOutput = completed?.outputs[0];
        if (voiceOutput?.kind !== "audio") throw new Error("缺少完成任务的音频");
        expect(store.getCanvas().canvas.nodes.find((node) => node.id === "sample")).toMatchObject({
          data: { character: { voice: { assetId: voiceOutput.assetId } } },
        });
        expect(voiceRequest).toMatchObject({
          text_prompt: "列车即将进站。",
        });
        if (scenario === "不收参考图") expect(voiceRequest).not.toHaveProperty("references");
        else expect(voiceRequest).toHaveProperty("references", [{ image_data: png }]);
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

  it("片场同批视频分别落盘，重开后只重试失败片段", async () => {
    const clip = join(root, "batch.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=s=64x48:d=1",
      "-an",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      clip,
    ]);
    const video = await readFile(clip);
    const builtin = registry.list().plugins.find((entry) => entry.key === "doubao-video")!;
    const plugin = await draftVideo(
      String(builtin.source).replace(
        "firstDelay: 15, interval: 10",
        "firstDelay: 0.01, interval: 0.01",
      ),
    );
    const model = configure("doubao-video", plugin.hash);
    const submitted: string[] = [];
    provider = async (request, response) => {
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const prompt = body.content.find((entry: { type: string }) => entry.type === "text").text;
        const failed = prompt === "关门。" && !submitted.includes(prompt);
        submitted.push(prompt);
        response.end(JSON.stringify({ id: failed ? "rejected" : `take-${submitted.length}` }));
      } else if (request.url === "/batch.mp4") {
        response.writeHead(200, { "content-type": "video/mp4" }).end(video);
      } else {
        response.end(
          JSON.stringify(
            request.url?.endsWith("/rejected")
              ? { status: "failed", error: { message: "片段生成失败" } }
              : { status: "succeeded", content: { video_url: `${endpoint}/batch.mp4` } },
          ),
        );
      }
    };
    let document = await createDrama(store, { title: "门口", script: "开门又关上。" });
    for (const prompt of ["开门。", "关门。", ""]) {
      document = await addDramaSegment(store, {
        episode_no: 1,
        revision: document.revision,
        seconds: 5,
        prompt,
      });
    }
    await store.updateGeneration((state) => {
      dramaDocument(state)!.episodes[0]!.locked = true;
      return { changed: true, result: null };
    });
    const files = new AssetFiles(join(root, "locators"));
    const pending = async () => {
      const available = await Promise.all(
        Object.values(store.snapshot.assets)
          .filter((asset) => asset.availability !== "deleted")
          .map(async (asset) => ({
            ...asset,
            availability: (await files.previewMetadata(store, asset))
              ? ("ready" as const)
              : ("missing" as const),
          })),
      );
      return batchVideoTargets(
        dramaDocument(store.snapshot)!.segments!,
        1,
        service.list(store).jobs,
        available,
      );
    };
    const entries = async () =>
      (await pending()).map((segment) => ({
        id: randomUUID(),
        input: {
          ...input(model, `seg:${segment.id}`),
          purpose: "drama-segment" as const,
          prompt: segment.prompt,
        },
      }));
    const first = await entries();
    expect(first.map((entry) => entry.input.prompt)).toEqual(["开门。", "关门。"]);
    await Promise.all(first.map((entry) => service.submit(store, [entry])));
    await Promise.all([wait(first[0]!.id, "succeeded"), wait(first[1]!.id, "failed")]);
    await reopen();
    const retry = await entries();
    expect(retry.map((entry) => entry.input.prompt)).toEqual(["关门。"]);
    await service.submit(store, retry);
    await wait(retry[0]!.id, "succeeded");
    await reopen();
    expect(await pending()).toEqual([]);
    expect(submitted.sort()).toEqual(["开门。", "关门。", "关门。"].sort());
    const read = await new DramaTools().command(store, "drama-read", {
      runId: "batch-read",
      input: { scope: "segments", episode_no: 1 },
    });
    expect(read).toMatchObject([
      {
        chosen_task_id: first[0]!.id,
        takes: [{ task_id: first[0]!.id, status: "succeeded", asset: { kind: "video" } }],
      },
      {
        chosen_task_id: retry[0]!.id,
        takes: [
          { task_id: first[1]!.id, status: "failed", asset: null },
          { task_id: retry[0]!.id, status: "succeeded", asset: { kind: "video" } },
        ],
      },
      { takes: [] },
    ]);
    const asset = Object.values(store.snapshot.assets).find((item) => item.mediaType === "video")!;
    await rm(join(store.directory, "assets", "sha256", asset.sha256.slice(0, 2), asset.sha256));
    expect((await pending()).map((segment) => segment.prompt)).toEqual(["开门。", "关门。"]);
  });

  it("短剧片段采用首次成功视频，后续失败保留采用，重开后可改选", async () => {
    const clip = join(root, "take.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=s=64x48:d=1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      clip,
    ]);
    let video = await readFile(clip);
    const plugin = registry.list().plugins.find((entry) => entry.key === "doubao-video")!;
    const draft = await draftVideo(
      String(plugin.source).replace(
        "firstDelay: 15, interval: 10",
        "firstDelay: 0.01, interval: 0.01",
      ),
    );
    const model = configure("doubao-video", draft.hash);
    await createDrama(store, { title: "邻居", script: "门开了" });
    const document = await addDramaSegment(store, {
      revision: 1,
      episode_no: 1,
      seconds: 5,
      prompt: "门打开",
    });
    const segment = document.segments![0]!;
    const request = {
      ...input(model, `seg:${segment.id}`),
      purpose: "drama-segment" as const,
      prompt: segment.prompt,
    };
    const first = { id: randomUUID(), input: request };
    await expect(service.submit(store, [first])).rejects.toMatchObject({
      code: "DRAMA_STEP_NOT_READY",
    });
    await store.updateGeneration((state) => {
      dramaDocument(state)!.episodes[0]!.locked = true;
      return { changed: true, result: null };
    });
    let success = true;
    provider = (req, res) => {
      if (req.method === "POST") res.end(JSON.stringify({ id: "take" }));
      else if (req.url === "/take.mp4")
        res.writeHead(200, { "content-type": "video/mp4" }).end(video);
      else
        res.end(
          JSON.stringify(
            success
              ? { status: "succeeded", content: { video_url: `${endpoint}/take.mp4` } }
              : { status: "failed", error: { message: "无法生成" } },
          ),
        );
    };
    const tools = new DramaTools();
    const read = () =>
      tools.command(store, "drama-read", {
        runId: "verify",
        input: { scope: "segments", episode_no: 1 },
      });
    await service.submit(store, [first]);
    await expect(
      estimateDramaJob(
        dramaDocument(store.snapshot)!,
        { step: "storyboard", episodes: [1] },
        registry,
      ),
    ).rejects.toMatchObject({ code: "DRAMA_STORYBOARD_HAS_TAKES" });
    await wait(first.id, "succeeded");
    await expect(read()).resolves.toMatchObject([
      {
        status: "done",
        chosen_task_id: first.id,
        revision: 2,
        takes: [{ task_id: first.id, asset: { kind: "video", mime_type: "video/mp4" } }],
      },
    ]);
    const second = { id: randomUUID(), input: request };
    await service.submit(store, [second]);
    await wait(second.id, "succeeded");
    success = false;
    const failed = { id: randomUUID(), input: request };
    await service.submit(store, [failed]);
    await wait(failed.id, "failed");
    await reopen();
    await expect(read()).resolves.toMatchObject([
      {
        status: "error",
        chosen_task_id: first.id,
        revision: 2,
        takes: [
          { status: "succeeded" },
          { status: "succeeded" },
          {
            status: "failed",
            asset: null,
            error_message:
              service.list(store).jobs.find((entry) => entry.id === failed.id)!.errorMessage ||
              service.list(store).jobs.find((entry) => entry.id === failed.id)!.error,
          },
        ],
      },
    ]);
    await expect(
      chooseDramaTake(store, { segmentId: segment.id, taskId: failed.id, revision: 2 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await chooseDramaTake(store, { segmentId: segment.id, taskId: second.id, revision: 2 });
    await expect(
      chooseDramaTake(store, { segmentId: segment.id, taskId: first.id, revision: 2 }),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    await expect(read()).resolves.toMatchObject([{ chosen_task_id: second.id, revision: 3 }]);
    expect(store.getCanvas().canvasRevision).toBe(request.expectedCanvasRevision);
    await addDramaSegment(store, {
      episode_no: 1,
      revision: dramaDocument(store.snapshot)!.revision,
      seconds: 5,
      prompt: "尚未拍摄",
    });
    const last = await addDramaSegment(store, {
      episode_no: 1,
      revision: dramaDocument(store.snapshot)!.revision,
      seconds: 5,
      prompt: "白色信纸",
    });
    const paper = join(root, "paper.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=48x64:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      "-c:a",
      "aac",
      paper,
    ]);
    video = await readFile(paper);
    success = true;
    const lastId = randomUUID();
    await service.submit(store, [
      { id: lastId, input: { ...request, nodeId: `seg:${last.segments!.at(-1)!.id}` } },
    ]);
    const lastJob = await wait(lastId, "succeeded");
    const previous = last.segments!.map((item) => item.id);
    const ids = [...previous].reverse();
    const order = { episodeNo: 1, episodeOrder: last.episode_order ?? 0, previous, ids };
    const ordered = await reorderDramaSegments(store, order);
    await expect(reorderDramaSegments(store, order)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    expect((await reorderDramaSegments(store, { ...order, previous: ids })).revision).toBe(
      ordered.revision,
    );
    await reopen();
    expect(dramaDocument(store.snapshot)!.segments!.map((item) => item.id)).toEqual(ids);
    const payload = { args: { step: "compose" as const, episodes: [1] }, estimate: 0 };
    const task = await submitApprovedDramaJob(store, registry, "run", "compose-approval", payload);
    expect(task).not.toHaveProperty("model");
    const assetIdFor = (jobId: string) =>
      (service.list(store).jobs.find((job) => job.id === jobId)!.outputs[0] as { assetId: string })
        .assetId;
    expect(task.compose_input).toMatchObject({
      asset_ids: [assetIdFor(lastJob!.id), assetIdFor(second.id)],
      skipped_seqs: [1],
    });
    await chooseDramaTake(store, { segmentId: segment.id, taskId: first.id, revision: 4 });
    const files = new AssetFiles(join(root, "locators"));
    const media = new CanvasMedia(files, new AssetService(join(binaries, "ffprobe")), ffmpeg);
    const render = () =>
      runDramaAssetJob(store, registry, task.id, new AbortController().signal, media);
    const interrupted = new AbortController();
    const materialize = files.materialize.bind(files);
    vi.spyOn(files, "materialize").mockImplementationOnce(async (...args) => {
      await materialize(...args);
      interrupted.abort();
    });
    await runDramaAssetJob(store, registry, task.id, interrupted.signal, media);
    expect(dramaDocument(store.snapshot)!.jobs!.find((job) => job.id === task.id)).toMatchObject({
      status: "running",
      compose_input: task.compose_input,
    });
    await reopen();
    const composeJob = () => dramaDocument(store.snapshot)?.jobs?.find((job) => job.id === task.id);
    await expect
      .poll(() => composeJob()?.status, { timeout: 15_000 })
      .toMatch(/^(succeeded|failed|canceled)$/);
    const finished = composeJob()!;
    expect(finished, finished.error_message).toMatchObject({
      status: "succeeded",
      frozen_credits: 0,
    });
    const final = store.snapshot.assets[finished.final_asset_id!]!;
    expect(final).toMatchObject({
      mediaType: "video",
      origin: "derived",
      metadata: { width: 720, height: 1280 },
    });
    expect(final.metadata.durationMs).toBeGreaterThanOrEqual(1950);
    expect(final.metadata.durationMs).toBeLessThan(2100);
    const output = join(root, "composed.mp4");
    await new AssetFiles(join(root, "locators")).materialize(store, final, output);
    const probe = await probeMedia(join(binaries, "ffprobe"), output);
    expect(probe.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_name: "h264", r_frame_rate: "30/1" }),
        expect.objectContaining({ codec_name: "aac", channels: 2, sample_rate: "48000" }),
      ]),
    );
    const centerPixel = async (seconds: number) =>
      (
        await runMediaProcess(ffmpeg, [
          "-v",
          "error",
          "-ss",
          String(seconds),
          "-i",
          output,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "crop=2:2",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ])
      )[0]!;
    expect(await centerPixel(0.5)).toBeGreaterThan(240);
    expect(await centerPixel(1.5)).toBeLessThan(10);
    await expect(
      tools.command(store, "drama-read", {
        runId: "read",
        input: { scope: "episode", episode_no: 1 },
      }),
    ).resolves.toMatchObject({ final_stale: true, final: { id: final.assetId } });
    const revision = store.snapshot.revision;
    expect(
      (await submitApprovedDramaJob(store, registry, "run", "compose-approval", payload)).id,
    ).toBe(task.id);
    await render();
    expect(store.snapshot.revision).toBe(revision);
    const previousSegments = dramaDocument(store.snapshot)!.segments!;
    const removed = previousSegments[0]!;
    const deletion = { segmentId: removed.id, episodeNo: 1, episodeOrder: order.episodeOrder };
    const beforeDelete = store.snapshot;
    for (const mismatch of [{ episodeOrder: order.episodeOrder + 1 }, { episodeNo: 2 }]) {
      await expect(deleteDramaSegment(store, { ...deletion, ...mismatch })).rejects.toMatchObject({
        code: "AGENT_APPROVAL_STALE",
      });
    }
    const afterDelete = await deleteDramaSegment(store, deletion);
    expect(afterDelete.segments).toEqual(
      previousSegments.slice(1).map((item, seq) => ({ ...item, seq, revision: item.revision + 1 })),
    );
    await expect(deleteDramaSegment(store, deletion)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    await reopen();
    expect(store.snapshot.assets).toEqual(beforeDelete.assets);
    expect(store.snapshot.jobs).toEqual(beforeDelete.jobs);
    expect(dramaDocument(store.snapshot)).toEqual(afterDelete);
    const original = join(root, "removed-segment.mp4");
    await files.materialize(store, store.snapshot.assets[assetIdFor(lastJob!.id)]!, original);
    expect(await readFile(original)).toEqual(video);
  });

  it.each(["首次转存", "刷新后仍过期", "转存查询中重开", "转存查询暂回运行中"] as const)(
    "异步视频按原回执取最新 URL：%s",
    async (scenario) => {
      const clip = join(root, "fresh-output.mp4");
      await runMediaProcess(ffmpeg, [
        "-f",
        "lavfi",
        "-i",
        "color=s=64x48:d=1",
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        clip,
      ]);
      const video = await readFile(clip);
      await edit(node("sample", "video"));
      const plugin = registry.list().plugins.find(({ key }) => key === "doubao-video");
      const draft = await draftVideo(
        String(plugin?.source).replace(
          "firstDelay: 15, interval: 10",
          "firstDelay: 0.01, interval: 0.01",
        ),
      );
      const entry = { id: randomUUID(), input: input(configure("doubao-video", draft.hash)) };
      const tasks = "/api/v3/contents/generations/tasks";
      const query = `GET ${tasks}/original-task`;
      let queries = 0;
      provider = (request, response) => {
        if (request.method === "POST") response.end(JSON.stringify({ id: "original-task" }));
        else if (request.url === "/expired") response.writeHead(403).end();
        else if (request.url === "/first" || request.url === "/fresh")
          response.writeHead(200, { "content-type": "video/mp4" }).end(video);
        else if (request.url === `${tasks}/original-task`) {
          queries++;
          if (queries === 2 && scenario === "转存查询中重开") return;
          if (queries === 2 && scenario === "转存查询暂回运行中") {
            response.end(JSON.stringify({ status: "running" }));
            return;
          }
          const name =
            queries === 1
              ? "first"
              : queries === 2 && scenario === "刷新后仍过期"
                ? "expired"
                : "fresh";
          response.end(
            JSON.stringify({ status: "succeeded", content: { video_url: `${endpoint}/${name}` } }),
          );
        } else response.writeHead(404).end();
      };
      await service.submit(store, [entry]);
      if (scenario === "转存查询中重开") {
        await expect.poll(() => queries).toBe(2);
        expect(store.snapshot.jobs[entry.id]).toMatchObject({
          status: "downloading",
          providerTaskId: "original-task",
        });
        await reopen();
      }
      const finished = await wait(entry.id, "succeeded");
      expect(finished?.outputs).toHaveLength(1);
      expect(Object.keys(store.snapshot.assets)).toHaveLength(1);
      const retry =
        scenario === "首次转存"
          ? []
          : scenario === "刷新后仍过期"
            ? ["GET /expired", query]
            : [query];
      expect(calls).toEqual([`POST ${tasks}`, query, query, ...retry, "GET /fresh"]);
    },
  );

  it.each(["MIME 不匹配", "超过输出上限"])(
    "异步任务恢复查询并拒绝无效结果：%s",
    async (failure) => {
      await edit(node("sample", "video"));
      const plugin = registry.list().plugins.find(({ key }) => key === "doubao-video");
      const draft = await draftVideo(
        String(plugin?.source).replace(
          "firstDelay: 15, interval: 10",
          "firstDelay: 0.01, interval: 0.01, maxInterval: 0.02",
        ),
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

  it("C6 停用渠道拒绝新任务，已取得回执的视频按原渠道完成", async () => {
    await edit(node("sample", "video"), node("later", "video"));
    const channel = generationChannel();
    const builtin = registry.list().plugins.find((plugin) => plugin.key === "doubao-video")!;
    const draft = await draftVideo(
      builtin.source.replace("firstDelay: 15, interval: 10", "firstDelay: 0.05, interval: 0.05"),
    );
    const model = registry.modelSave({
      channelId: channel.id,
      channelRevision: channel.revision,
      expectedRevision: 0,
      upstreamModel: "fixture-video",
      pluginHash: draft.hash,
      enabled: true,
      settings: {},
      config: { kind: "video", name: "视频", sort: 1, description: "" },
    });
    const clip = join(root, "disable-channel.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=s=64x48:d=1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      clip,
    ]);
    const media = await readFile(clip);
    let complete = false;
    let queriesAfterDisable = 0;
    provider = (request, response) => {
      if (request.url === "/result")
        response.writeHead(200, { "content-type": "video/mp4" }).end(media);
      else if (request.method === "POST") response.end(JSON.stringify({ id: "before-disable" }));
      else if (request.url === "/api/v3/contents/generations/tasks/before-disable")
        response.end(
          JSON.stringify(
            complete && ++queriesAfterDisable >= 2
              ? { status: "succeeded", content: { video_url: `${endpoint}/result` } }
              : { status: "running" },
          ),
        );
      else response.writeHead(404).end();
    };
    const entry = { id: randomUUID(), input: input(model) };
    await service.submit(store, [entry]);
    await wait(entry.id, "running");
    const fields = {
      name: channel.name,
      endpoint,
      enabled: false,
      allowLocal: true,
      headers: [],
      sort: channel.sort,
    };
    registry.channelSave({
      id: channel.id,
      expectedRevision: channel.revision,
      approve: false,
      fields,
    });
    const later = { id: randomUUID(), input: input(registry.provider(model.id), "later") };
    await expect(service.submit(store, [later])).rejects.toMatchObject({
      code: "JOB_MODEL_UNAVAILABLE",
    });
    expect(store.snapshot.jobs[later.id]).toBeUndefined();
    complete = true;
    expect((await wait(entry.id, "succeeded"))?.outputs).toHaveLength(1);
    expect(queriesAfterDisable).toBe(3);
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    expect(calls).toContain("GET /api/v3/contents/generations/tasks/before-disable");
    expect(calls).toContain("GET /result");
  });

  it("C6 停用渠道不为退避中的无回执任务重提", async () => {
    await edit(node("sample", "video"));
    const channel = generationChannel();
    const plugin = registry.list().plugins.find((plugin) => plugin.key === "doubao-video")!;
    const model = registry.modelSave({
      channelId: channel.id,
      channelRevision: channel.revision,
      expectedRevision: 0,
      upstreamModel: "fixture-video",
      pluginHash: plugin.hash,
      enabled: true,
      settings: {},
      config: { kind: "video", name: "视频", sort: 1, description: "" },
    });
    provider = (_request, response) => response.writeHead(429).end("{}");
    const entry = { id: randomUUID(), input: input(model) };
    await service.submit(store, [entry]);
    await expect
      .poll(() => store.snapshot.jobs[entry.id])
      .toMatchObject({ status: "queued", submitRetries: 1 });
    registry.channelSave({
      id: channel.id,
      expectedRevision: channel.revision,
      approve: false,
      fields: {
        name: channel.name,
        endpoint,
        enabled: false,
        allowLocal: true,
        headers: [],
        sort: channel.sort,
      },
    });
    await wait(entry.id, "failed");
    expect(calls).toEqual(["POST /api/v3/contents/generations/tasks"]);
  });

  it("已获任务号的渠道任务在项目和设置库重开后继续占用原名额", async () => {
    await edit(node("sample", "video"));
    const channel = generationChannel(1);
    const plugin = registry.list().plugins.find((item) => item.key === "doubao-video")!;
    const draft = await draftVideo(
      plugin.source.replace(
        "firstDelay: 15, interval: 10",
        "firstDelay: 0.05, interval: 0.05, maxInterval: 0.1",
      ),
    );
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "fixture-video",
      pluginHash: draft.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: { kind: "video", name: "视频", sort: 100, description: "" },
    });
    let complete = false;
    provider = (request, response) =>
      response.end(
        JSON.stringify(
          request.method === "POST"
            ? { id: "slot-1" }
            : { status: complete ? "failed" : "running" },
        ),
      );
    const entry = { id: randomUUID(), input: input(model) };
    await service.submit(store, [entry]);
    await wait(entry.id, "running");
    await service.stop(store);
    agent.detach(store);
    const directory = store.directory;
    await store.close();
    registry.close();
    registry = await openRegistry();
    expect(registry.acquireGeneration(channel.id)).toBeUndefined();
    complete = true;
    store = await ProjectStore.open(directory);
    agent.attach(store);
    service.start(store);
    await wait(entry.id, "failed");
    await expect
      .poll(() => {
        const release = registry.acquireGeneration(channel.id);
        release?.();
        return Boolean(release);
      })
      .toBe(true);
    expect(calls.filter((method) => method.startsWith("POST"))).toHaveLength(1);
    expect(calls).toContain("GET /api/v3/contents/generations/tasks/slot-1");
  });

  it("提交退避中迁移并重开，原渠道完成重提和临时失败的查询", async () => {
    await edit(node("sample", "video"));
    const source = generationChannel(1, [{ name: "x-route", value: "original" }]);
    const destination = generationChannel(1);
    const target = registry.channelKeys({
      id: destination.id,
      expectedRevision: destination.revision,
      secret: "destination-key",
    });
    const plugin = registry.list().plugins.find((item) => item.key === "doubao-video")!;
    const draft = await draftVideo(
      plugin.source.replace(
        "firstDelay: 15, interval: 10",
        "firstDelay: 0.02, interval: 0.02, maxInterval: 0.05",
      ) +
        `
      module.exports.buildPrepareRequests = function () { return [{method:'POST',path:'/prepare'}]; };
      module.exports.parsePrepareResponses = function (ctx, replies) { return replies[0].body; };
      var submitVideo = module.exports.buildSubmitRequest;
      module.exports.buildSubmitRequest = function(ctx) {
        if (ctx.prepared.receipt !== 'fixture-prepared') throw new Error('Missing preparation');
        return submitVideo(ctx);
      };`,
    );
    const fields = {
      upstreamModel: "fixture-video",
      pluginHash: draft.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: { kind: "video" as const, name: "原视频", sort: 1, description: "" },
    };
    const model = registry.modelSave({
      ...fields,
      expectedRevision: 0,
      channelId: source.id,
      channelRevision: source.revision,
    });
    const entry = { id: randomUUID(), input: input(model) };
    const auth: (string | undefined)[] = [];
    const times: number[] = [];
    const routes: unknown[] = [];
    provider = (request, response) => {
      if (request.url === "/prepare") {
        response.end(JSON.stringify({ receipt: "fixture-prepared" }));
        return;
      }
      auth.push(request.headers.authorization);
      routes.push(request.headers["x-route"]);
      times.push(Date.now());
      if (times.length === 1 || times.length === 3)
        response.writeHead(times.length === 1 ? 429 : 503).end("{}");
      else if (request.method === "POST") response.end(JSON.stringify({ id: "original-receipt" }));
      else response.writeHead(401).end("{}");
    };
    await service.submit(store, [entry]);
    await expect
      .poll(() => store.snapshot.jobs[entry.id])
      .toMatchObject({ status: "queued", submitRetries: 1 });
    expect(JSON.stringify(store.snapshot)).not.toContain("fixture-prepared");
    expect(registry.readPrepared(store.projectId, entry.id)).toEqual({
      receipt: "fixture-prepared",
    });
    const moved = registry.modelSave({
      ...fields,
      id: model.id,
      expectedRevision: model.revision,
      channelId: target.id,
      channelRevision: target.revision,
      moveFrom: { id: source.id, revision: source.revision },
    });
    expect(registry.binding(moved.id, moved.revision).secret).toBe("destination-key");
    registry.channelSave({
      id: source.id,
      expectedRevision: source.revision,
      approve: true,
      secret: "rotated-source-key",
      fields: {
        name: source.name,
        endpoint,
        enabled: true,
        allowLocal: true,
        sort: 100,
        running: 1,
        headers: [{ name: "x-route", value: "edited" }],
      },
    });
    await reopen();
    expect(await wait(entry.id, "failed")).toMatchObject({
      error: "PROVIDER_TERMINAL",
      canRecheck: false,
    });
    await expect.poll(() => registry.readPrepared(store.projectId, entry.id)).toBeUndefined();
    expect(calls).toEqual([
      "POST /prepare",
      "POST /api/v3/contents/generations/tasks",
      "POST /api/v3/contents/generations/tasks",
      "GET /api/v3/contents/generations/tasks/original-receipt",
      "GET /api/v3/contents/generations/tasks/original-receipt",
    ]);
    expect(auth).toEqual([
      "Bearer fixture-generation-key",
      ...Array(3).fill("Bearer rotated-source-key"),
    ]);
    expect(routes).toEqual(Array(4).fill("original"));
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1590);
    await service.stop(store);
    registry.close();
    registry = await openRegistry();
    expect(
      registry.agentRecentErrors({ model_key: model.id, channel_key: source.id, task_id: entry.id })
        .items,
    ).toMatchObject([{ task_id: entry.id, error_code: "PROVIDER_TERMINAL", is_test: false }]);
    expect(
      registry.agentRecentErrors({ channel_key: target.id, task_id: entry.id }).items,
    ).toHaveLength(0);
  });

  it("持续限流时按指数退避，五次重试耗尽后停止发送", async () => {
    await edit(node("sample"));
    const entry = { id: randomUUID(), input: input(configure()) };
    const timestamps: number[] = [];
    provider = (_request, response) => {
      timestamps.push(Date.now());
      response.writeHead(429).end("{}");
    };
    const systemNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => systemNow() + offset);
    try {
      await service.submit(store, [entry]);
      for (let attempt = 1; attempt <= 5; attempt++) {
        await expect
          .poll(() => store.snapshot.jobs[entry.id])
          .toMatchObject({ status: "queued", submitRetries: attempt });
        const job = store.snapshot.jobs[entry.id] as { pollAfter: number };
        const base = 2000 * 2 ** (attempt - 1);
        const waitMs = job.pollAfter - timestamps[attempt - 1]!;
        expect(waitMs).toBeGreaterThanOrEqual(base * 0.8);
        expect(waitMs).toBeLessThan(base * 1.2 + 1000);
        offset += Math.max(0, job.pollAfter - Date.now()) + 1;
      }
      expect(await wait(entry.id, "failed")).toMatchObject({ error: "PROVIDER_RETRYABLE" });
      await reopen();
      expect((await service.submit(store, [entry]))[0]?.status).toBe("failed");
      expect(timestamps).toHaveLength(6);
    } finally {
      clock.mockRestore();
    }
  });

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

  it.each(["cancelled", "succeeded"] as const)(
    "视频重生成取消请求成功后仍以供应商查询结果为准：%s",
    async (outcome) => {
      await edit(node("sample", "video"));
      const plugin = registry.list().plugins.find(({ key }) => key === "doubao-video");
      if (!plugin) throw new Error("Missing video plugin");
      const draft = await draftVideo(
        plugin.source
          .replace(
            "firstDelay: 15, interval: 10",
            "firstDelay: 0.01, interval: 0.01, maxInterval: 0.02",
          )
          .concat(
            "\nmodule.exports.buildCancelRequest = function () { return { method: 'DELETE', path: '/cancel' }; };",
            "\nvar parseQuery = module.exports.parseQueryResponse; module.exports.parseQueryResponse = function (ctx, resp) { return resp.body.status === 'cancelled' ? {status:'cancelled'} : parseQuery(ctx, resp); };",
          ),
      );
      const clip = join(root, "cancel-race.mp4");
      await runMediaProcess(ffmpeg, [
        "-f",
        "lavfi",
        "-i",
        "color=s=64x48:d=1",
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        clip,
      ]);
      const bytes = await readFile(clip);
      let submittingSeed = true;
      let confirmed = false;
      let interruptQuery = false;
      const receivedKeys: (string | undefined)[] = [];
      provider = (request, response) => {
        if (request.url === "/clip.mp4")
          return void response.writeHead(200, { "content-type": "video/mp4" }).end(bytes);
        receivedKeys.push(request.headers.authorization);
        if (interruptQuery && request.method === "GET") {
          request.socket.destroy();
          return;
        }
        const body =
          request.method === "POST"
            ? { id: submittingSeed ? "seed" : "remote-cancel" }
            : request.method === "DELETE"
              ? {}
              : submittingSeed || (confirmed && outcome === "succeeded")
                ? { status: "succeeded", content: { video_url: `${endpoint}/clip.mp4` } }
                : { status: confirmed ? "cancelled" : "running" };
        response.end(JSON.stringify(body));
      };
      const channel = generationChannel();
      const model = registry.modelSave({
        expectedRevision: 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        config: { kind: "video", name: "视频任务", description: "", sort: 1 },
        upstreamModel: "fixture",
        pluginHash: draft.hash,
        settings: {},
        enabled: true,
      });
      const seed = { id: randomUUID(), input: input(model) };
      await service.submit(store, [seed]);
      await wait(seed.id, "succeeded");
      submittingSeed = false;
      interruptQuery = true;
      const data = () => store.getCanvas().canvas.nodes[0]?.data;
      expect(data()).toMatchObject({ activeOutputId: `${seed.id}:0` });
      const entry = { id: randomUUID(), input: input(model) };
      await service.submit(store, [entry]);
      expect(await wait(entry.id, "outcome_unknown")).toMatchObject({ canRecheck: true });
      const target = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "target-only",
        fields: { name: "迁入", endpoint, enabled: true, allowLocal: true, headers: [], sort: 2 },
      });
      registry.modelMove({
        id: model.id,
        expectedRevision: model.revision,
        sourceId: channel.id,
        sourceRevision: channel.revision,
        targetId: target.id,
        targetRevision: target.revision,
      });
      await reopen();
      interruptQuery = false;
      await service.recheck(store, entry.id);
      expect(await service.cancel(store, entry.id)).toMatchObject({
        status: "running",
        cancelRequested: true,
      });
      await expect.poll(() => calls.includes("DELETE /cancel")).toBe(true);
      expect(service.list(store).jobs[0]?.status).toBe("running");
      expect(data()).not.toHaveProperty("assetId");
      expect(data()).toMatchObject({
        pendingMediaVersion: { batchId: entry.id, outputId: `${seed.id}:0` },
      });
      confirmed = true;
      const result = await wait(entry.id, outcome);
      if (outcome === "cancelled") expect(result?.outputs).toEqual([]);
      else expect(result).toMatchObject({ bound: true, outputs: [{ kind: "video" }] });
      await reopen();
      expect(data()).toMatchObject({
        assetId: expect.any(String),
        activeOutputId: `${outcome === "cancelled" ? seed.id : entry.id}:0`,
      });
      expect(data()).not.toHaveProperty("pendingMediaVersion");
      expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(2);
      expect(calls.filter((call) => call === "DELETE /cancel")).toHaveLength(1);
      expect(new Set(receivedKeys)).toEqual(new Set(["Bearer fixture-generation-key"]));
    },
  );

  it.each(["bearer", "custom"])(
    "同步失败的生成与试跑一致；%s 鉴权决定是否展示已清洗的原因",
    async (auth) => {
      await edit(node("sample"));
      const source = registry.agentPlugin("openai-image").code;
      const plugin = await registry.draft(
        `${source}\nmodule.exports.meta.key='failure-image';module.exports.meta.auth={type:'${auth}'};module.exports.buildSubmitRequest=function(ctx){return {method:'POST',path:'/route/private-segment',json:{prompt:ctx.input.prompt}}};module.exports.parseSubmitResponse=function(ctx,resp){return {immediate:{status:'failed',error:{class:'moderation',message:resp.body.reason}}};};`,
      );
      const channel = generationChannel();
      const model = registry.modelSave({
        expectedRevision: 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        pluginHash: plugin.hash,
        upstreamModel: "fixture",
        enabled: true,
        settings: {},
        config: { kind: "image", name: "同步失败", description: "", sort: 0 },
      });
      const entry = { id: randomUUID(), input: input(model) };
      provider = (_request, response) =>
        response.end(JSON.stringify({ reason: `不支持此画幅 ${entry.input.prompt}` }));
      const preview = await runModelTrial(
        registry,
        {
          id: model.id,
          expectedRevision: model.revision,
          prompt: entry.input.prompt,
          params: {},
          dry: true,
        },
        () => {
          throw new Error("unexpected output");
        },
      );
      expect(preview.status).toBe("preview");
      expect(calls).toHaveLength(0);
      await service.submit(store, [entry]);
      const failed = await wait(entry.id, "failed");
      const trial = await runModelTrial(
        registry,
        {
          id: model.id,
          expectedRevision: model.revision,
          prompt: entry.input.prompt,
          params: {},
          dry: false,
        },
        () => {
          throw new Error("unexpected output");
        },
      );
      expect(trial).toMatchObject({ status: "failed", error: "PROVIDER_TEST_FAILED" });
      expect(failed?.error).toBe("JOB_PROVIDER_FAILED");
      if (auth === "custom") {
        expect(failed?.errorMessage).toBeUndefined();
        expect(trial.logs.join("")).not.toContain("不支持此画幅");
        expect(trial.errorMessage).toBeUndefined();
        expect(preview.request?.endpoint).toBe(endpoint);
        expect(trial.request?.body).toBeUndefined();
        expect(trial.trace.find((step) => step.kind === "http")).toMatchObject({
          endpoint,
          method: "POST",
          status: 200,
        });
        for (const step of trial.trace)
          for (const key of [
            "hookInput",
            "hookOutput",
            "requestHeaders",
            "requestBody",
            "responseBody",
          ])
            expect(step).not.toHaveProperty(key);
        for (const value of [preview, trial])
          for (const privateText of [
            "private-segment",
            entry.input.prompt,
            "fixture-generation-key",
          ])
            expect(JSON.stringify(value)).not.toContain(privateText);
      } else {
        expect(failed?.errorMessage).toBe("不支持此画幅 [已隐藏]");
        expect(trial.logs).toContain(failed?.errorMessage);
        expect(trial.errorMessage).toBe(failed?.errorMessage);
        expect(preview.request?.endpoint).toBe(`${endpoint}/route/private-segment`);
        expect(trial.trace.find((step) => step.kind === "http")).toMatchObject({
          requestBody: { text: expect.stringContaining("[文本") },
          responseBody: { text: expect.stringContaining("[文本") },
        });
      }
      expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(2);
    },
  );

  it("豆包上游取消按失败落库，原因为空时补文案；重开后不复查，重新生成有独立回执", async () => {
    await edit(node("sample", "video"));
    const source = registry
      .agentPlugin("doubao-video")
      .code.replace("firstDelay: 15, interval: 10", "firstDelay: 0.01, interval: 0.01");
    const plugin = await draftVideo(source),
      channel = generationChannel(undefined, [{ name: "x-route", value: "header-value-private" }]);
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      pluginHash: plugin.hash,
      upstreamModel: "fixture",
      enabled: true,
      settings: {},
      config: { kind: "video", name: "取消样本", description: "", sort: 0 },
    });
    const prompt = "镜头推向私人建筑";
    let submissions = 0;
    provider = (request, response) =>
      response.end(
        JSON.stringify(
          request.method === "POST"
            ? { id: `cancel-${++submissions}` }
            : {
                status: "cancelled",
                ...(submissions === 1 && {
                  error: {
                    message: `内容审核未通过 ${prompt} fixture-generation-key header-value-private https://example.invalid/private?sig=abc`,
                  },
                }),
              },
        ),
      );
    const entry = { id: randomUUID(), input: { ...input(model), prompt } };
    await service.submit(store, [entry]);
    const failed = await wait(entry.id, "failed");
    expect(failed).toMatchObject({
      error: "JOB_PROVIDER_FAILED",
      canRecheck: false,
      canCancelRemote: false,
      outputs: [],
    });
    expect(failed?.errorMessage).toMatch(
      /^内容审核未通过 \[已隐藏\] \[redacted\] \[已隐藏\] \[地址已隐藏\]$/,
    );
    await reopen();
    expect(service.list(store).jobs.find((job) => job.id === entry.id)?.errorMessage).toBe(
      failed?.errorMessage,
    );
    await expect(service.recheck(store, entry.id)).rejects.toMatchObject({
      code: "JOB_CANNOT_RECHECK",
    });
    const retry = { id: randomUUID(), input: { ...input(model), prompt } };
    await service.submit(store, [retry]);
    expect(await wait(retry.id, "failed")).toMatchObject({ errorMessage: "上游任务已被取消" });
    expect(submissions).toBe(2);
  });

  it.each(["不在最近清单", "最近清单无渠道", "最近清单有渠道"])(
    "旧任务删除保护：%s，迁移后不会向新渠道查询",
    async (scenario) => {
      await edit(node("sample", "video"));
      const source = generationChannel();
      const destination = generationChannel();
      const builtin = registry.list().plugins.find((plugin) => plugin.key === "doubao-video")!;
      const uploaded = await draftVideo(builtin.source);
      const fields = {
        upstreamModel: "fixture",
        enabled: true,
        settings: {},
        config: { kind: "video" as const, name: "旧视频", description: "", sort: 0 },
      };
      const model = registry.modelSave({
        ...fields,
        expectedRevision: 0,
        channelId: source.id,
        channelRevision: source.revision,
        pluginHash: uploaded.hash,
      });
      const entry = { id: randomUUID(), input: input(model) };
      provider = (_request, response) => response.end(JSON.stringify({ id: "legacy-receipt" }));
      await service.submit(store, [entry]);
      await wait(entry.id, "running");
      await service.stop(store);
      await store.updateGeneration((state) => {
        const record = state.jobs[entry.id];
        if (!record || typeof record !== "object" || Array.isArray(record))
          throw new Error("Missing job");
        if (scenario !== "最近清单有渠道") delete record.channelId;
        record.pollAfter = Date.now() + 60_000;
        return { result: null, changed: true };
      });
      registry.reconcileJobPins(store.projectId, []);
      agent.detach(store);
      const directory = store.directory;
      const projectId = store.projectId;
      await store.close();
      registry.modelSave({
        ...fields,
        id: model.id,
        expectedRevision: model.revision,
        pluginHash: builtin.hash,
        channelId: destination.id,
        channelRevision: destination.revision,
        moveFrom: { id: source.id, revision: source.revision },
      });
      const removePlugin = () => registry.pluginRemove({ hash: uploaded.hash, allVersions: true });
      const recentProjects = async () =>
        scenario === "不在最近清单" ? [] : [{ directory, projectId }];
      const removeChannel = () =>
        registry.channelRemove({ id: source.id, expectedRevision: source.revision });
      for (let boot = 0; boot < 2; boot++) {
        registry.close();
        registry = await openRegistry(recentProjects);
        expect(registry.pluginDeleteCheck({ key: uploaded.key }).jobs).toBe(
          scenario === "不在最近清单" ? 0 : 1,
        );
        expect(registry.channelList().find((item) => item.id === source.id)?.activeJobs).toBe(
          scenario === "最近清单有渠道" ? 1 : 0,
        );
        expect(registry.channelList().find((item) => item.id === destination.id)?.activeJobs).toBe(
          0,
        );
        expect(registry.channelLoads()).toEqual([]);
      }
      if (scenario === "不在最近清单") expect(removePlugin()).toEqual({ removed: true });
      else {
        expect(removePlugin).toThrow("PLUGIN_JOB_REFERENCED");
        expect(() => registry.pluginRemove({ hash: uploaded.hash })).toThrow(
          "PLUGIN_JOB_REFERENCED",
        );
      }
      if (scenario === "最近清单有渠道") expect(removeChannel).toThrow("CHANNEL_ACTIVE_JOBS");
      store = await ProjectStore.open(directory);
      agent.attach(store);
      service.start(store);
      if (scenario !== "不在最近清单") {
        await expect.poll(() => registry.pluginDeleteCheck({ key: uploaded.key }).jobs).toBe(1);
        expect(removePlugin).toThrow("PLUGIN_JOB_REFERENCED");
      }
      if (scenario !== "最近清单有渠道") expect(removeChannel()).toEqual({ removed: true });
      await service.stop(store);
      await store.updateGeneration((state) => {
        const record = state.jobs[entry.id];
        if (!record || typeof record !== "object" || Array.isArray(record))
          throw new Error("Missing job");
        record.pollAfter = 0;
        return { result: null, changed: true };
      });
      service.start(store);
      expect(await wait(entry.id, "outcome_unknown")).toMatchObject({
        error: "JOB_ORIGINAL_BINDING_MISSING",
        canRecheck: false,
      });
      await expect(service.recheck(store, entry.id)).rejects.toMatchObject({
        code: "JOB_CANNOT_RECHECK",
      });
      await reopen();
      expect(await wait(entry.id, "outcome_unknown")).toMatchObject({
        error: "JOB_ORIGINAL_BINDING_MISSING",
        canRecheck: false,
      });
      if (scenario !== "不在最近清单") {
        await expect.poll(() => registry.pluginDeleteCheck({ key: uploaded.key }).jobs).toBe(0);
        expect(removePlugin()).toEqual({ removed: true });
      }
      expect(calls).toEqual(["POST /api/v3/contents/generations/tasks"]);
    },
  );

  it("撤包后重开设置库和工程，用已保存的回执和原渠道完成复查，不重新生成", async () => {
    await edit(node("sample", "video"));
    const source = registry
      .agentPlugin("doubao-video")
      .code.replace("firstDelay: 15, interval: 10", "firstDelay: 0.01, interval: 0.01");
    const plugin = await registry.draft(
      source + "\nmodule.exports.meta.key='retired-video';",
      "builtin",
    );
    const channel = generationChannel();
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      pluginHash: plugin.hash,
      upstreamModel: "fixture",
      enabled: true,
      settings: {},
      config: { kind: "video", name: "撤包样本", description: "", sort: 0 },
    });
    let recover = false;
    const clip = join(root, "resume.mp4");
    await runMediaProcess(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=s=64x48:d=1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      clip,
    ]);
    const bytes = await readFile(clip),
      tokens: (string | undefined)[] = [];
    provider = (request, response) => {
      if (request.url === "/resume.mp4")
        return void response.writeHead(200, { "content-type": "video/mp4" }).end(bytes);
      tokens.push(request.headers.authorization);
      if (request.method === "POST") response.end(JSON.stringify({ id: "retired-task" }));
      else if (!recover) request.socket.destroy();
      else
        response.end(
          JSON.stringify({ status: "succeeded", content: { video_url: `${endpoint}/resume.mp4` } }),
        );
    };
    const entry = { id: randomUUID(), input: input(model) };
    await service.submit(store, [entry]);
    expect(await wait(entry.id, "outcome_unknown")).toMatchObject({
      error: "JOB_OUTCOME_UNKNOWN",
      canRecheck: true,
    });
    await expect.poll(() => registry.pluginDeleteCheck({ key: "retired-video" }).jobs).toBe(0);
    await service.stop(store);
    const offline = registry.modelToggle({
      id: model.id,
      expectedRevision: model.revision,
      enabled: false,
    });
    registry.modelRemove({ id: model.id, expectedRevision: offline.revision });
    registry.close();
    registry = await openRegistry();
    expect(() => registry.pluginDetail({ key: "retired-video" })).toThrow("PLUGIN_VERSION_MISSING");
    await reopen();
    recover = true;
    await service.recheck(store, entry.id);
    expect(await wait(entry.id, "succeeded")).toMatchObject({ outputs: [{ kind: "video" }] });
    expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("GET ") && call.endsWith("/retired-task"))).toBe(
      true,
    );
    expect(new Set(tokens)).toEqual(new Set(["Bearer fixture-generation-key"]));
  });

  it("旧任务有远端回执时，同节点的同类任务运行期间不能复查", async () => {
    await edit(node("sample", "video"));
    const plugin = registry.list().plugins.find(({ key }) => key === "doubao-video");
    if (!plugin) throw new Error("Missing video plugin");
    const draft = await draftVideo(
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

  it("Sora 二进制下载入库，查看视频只返回带时间戳的临时帧", async () => {
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
    const draft = await draftVideo(
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
    const inspect = { ...args, media: "video", input: { nodeId: "sample" } };
    await expect(agent.command("inspect", inspect)).rejects.toMatchObject({
      code: "AGENT_READ_REQUIRED",
    });
    await agent.command("read", args);
    const analyze = async (video: { mime_type: string; data: string }) => {
      expect(video.mime_type).toBe("video/mp4");
      expect(Buffer.from(video.data, "base64")).toEqual(data);
      return "整段视频分析";
    };
    await expect(
      agent.command("inspect", { ...inspect, analyze, allowFrames: false }),
    ).resolves.toEqual({ analysis: "整段视频分析" });
    const failed = async () => {
      throw new Error("upstream failed");
    };
    await expect(
      agent.command("inspect", { ...inspect, analyze: failed, allowFrames: false }),
    ).rejects.toMatchObject({ code: "AGENT_MEDIA_UNAVAILABLE" });
    await expect(
      agent.command("inspect", {
        ...inspect,
        analyze: failed,
        allowFrames: true,
        input: { nodeId: "sample", count: 1 },
      }),
    ).resolves.toMatchObject({ frames: [{ at: 0.5 }] });
    const result = await agent.command("inspect", inspect);
    if (!result || !("frames" in result) || !("duration" in result))
      throw new Error("Missing sampled frames");
    expect(result.duration).toBeCloseTo(1);
    expect(result.frames).toHaveLength(6);
    for (const [index, frame] of result.frames.entries()) {
      expect(frame.at).toBeCloseTo(index * 0.18);
      expect(frame.data).toMatch(/^iVBOR/);
    }
    expect(
      await agent.command("inspect", { ...inspect, input: { nodeId: "sample", count: 1 } }),
    ).toMatchObject({ frames: [{ at: 0.5 }] });
    await expect(
      agent.command("inspect", { ...inspect, input: { nodeId: "sample", count: 7 } }),
    ).rejects.toMatchObject({ code: "AGENT_MEDIA_UNAVAILABLE" });
    expect(Object.keys(store.snapshot.assets)).toEqual([output.assetId]);
    await edit(node("next", "video"));
    const capture = {
      project: args.project,
      runId: "capture-run",
      id: "capture-first-last",
      input: {
        nodeId: "sample",
        frames: [{ at: "first" }, { at: 0, connectTo: ["next"] }, { at: "last" }],
      },
    };
    const beforeCapture = store.getCanvas();
    await expect(
      agent.command("capture", {
        ...capture,
        input: { nodeId: "sample", frames: [{ at: "first" }, { at: 4 }] },
      }),
    ).rejects.toMatchObject({ code: "AGENT_MEDIA_UNAVAILABLE" });
    expect(Object.keys(store.snapshot.assets)).toEqual([output.assetId]);
    const captured = await agent.command("capture", capture);
    if (!captured || !("frames" in captured) || !("nodeIds" in captured))
      throw new Error("Missing frame nodes");
    expect(captured.frames).toMatchObject([
      { at: 0, label: "sample · 首帧", connected_to: ["next"] },
      { at: 0.9, label: "sample · 尾帧", connected_to: [] },
    ]);
    const [first, last] = captured.nodeIds;
    expect(store.getCanvas().canvas.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "sample", target: first }),
        expect.objectContaining({ source: first, target: "next" }),
        expect.objectContaining({ source: "sample", target: last }),
      ]),
    );
    const revision = store.getCanvas().canvasRevision;
    expect(await agent.command("capture", capture)).toEqual(captured);
    expect(store.getCanvas().canvasRevision).toBe(revision);
    expect(Object.keys(store.snapshot.assets)).toHaveLength(3);
    expect(await agent.command("undo", capture)).toMatchObject({ reverted: 5, skipped: [] });
    expect(store.getCanvas().canvas).toEqual(beforeCapture.canvas);
    expect(Object.keys(store.snapshot.assets)).toHaveLength(3);
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

  it("宽幅图片的单格长边限于 4096 像素，单格分别按自身比例取整", async () => {
    const path = join(root, "wide.png");
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=white:s=12288x24",
      "-frames:v",
      "1",
      path,
    ]);
    const assets = new AssetService(join(binaries, "ffprobe"));
    const file = await open(path, "r");
    const source = await assets
      .importCopy(store, file, "宽图.png", randomUUID())
      .finally(() => file.close());
    if (source.kind !== "created") throw Error("缺少宽图");
    const media = new CanvasMedia(new AssetFiles(join(root, "split-locators")), assets, ffmpeg);
    const tiles = await media.split(
      store,
      source.asset,
      randomUUID(),
      1,
      2,
      new AbortController().signal,
      { x: [0.25] },
    );
    try {
      expect(tiles.map((tile) => [tile.asset.metadata.width, tile.asset.metadata.height])).toEqual([
        [3072, 24],
        [4096, 11],
      ]);
    } finally {
      await Promise.all(tiles.map((tile) => assets.discard(tile)));
    }
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
      displayName: "doodle.png",
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
    const result = await wait(first.id, "succeeded");
    expect(result).toMatchObject({ bound: true });
    expect(store.getCanvas().canvas.nodes.find((item) => item.id === "sample")?.data).toMatchObject(
      {
        text: "人工输入",
        activeOutputId: `${first.id}:0`,
        assetId: Object.keys(store.snapshot.assets)[0],
      },
    );
    await wait(second.id, "cancelled");
    expect(Object.values(store.snapshot.assets)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("重生成失败后保留非末尾采用版，重开并取消下一批最后一份才恢复它", async () => {
    await edit(node("sample"));
    const profile = configure();
    const seed = { id: randomUUID(), input: input(profile) };
    await service.submit(store, [seed]);
    await wait(seed.id, "succeeded");
    const source = store.getCanvas().canvas.nodes[0];
    if (source?.type !== "creative" || !source.data.outputs?.[0]) throw new Error("缺少历史");
    const original = source.data.outputs[0];
    const withHistory = {
      ...node("sample"),
      data: {
        ...node("sample").data,
        assetId: original.assetId,
        activeOutputId: original.id,
        outputs: [original, { ...original, id: "another-version" }],
      },
    };
    await edit(withHistory);
    provider = (_request, response) =>
      response.writeHead(400).end(JSON.stringify({ error: { message: "拒绝" } }));
    const failed = { id: randomUUID(), input: input(profile) };
    await service.submit(store, [failed]);
    await wait(failed.id, "failed");
    await reopen();
    const data = () => store.getCanvas().canvas.nodes[0]?.data;
    expect(data()).not.toHaveProperty("assetId");
    expect(data()).toMatchObject({
      outputs: withHistory.data.outputs,
      pendingMediaVersion: { batchId: failed.id, outputId: original.id },
    });
    const channel = generationChannel(1);
    const plugin = registry.list().plugins.find((item) => item.key === "openai-image")!;
    const model = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "fixture",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: {
        kind: "image",
        name: "两张",
        sort: 1,
        description: "",
        customParams: {
          copies: { type: "enum", label: "份数", values: [1, 2], default: 1, fanout: true },
        },
      },
    });
    await service.stop(store);
    const pump = vi.spyOn(service, "start").mockImplementation(() => {});
    try {
      const retry = { id: randomUUID(), input: { ...input(model), customParams: { copies: 2 } } };
      const accepted = await service.submit(store, [retry]);
      expect(accepted).toHaveLength(2);
      await service.cancel(store, accepted[0]!.id);
      expect(data()).not.toHaveProperty("assetId");
      expect(data()).toMatchObject({
        pendingMediaVersion: { batchId: retry.id, outputId: original.id },
      });
      await service.cancel(store, accepted[1]!.id);
      expect(data()).toMatchObject(withHistory.data);
      expect(data()).not.toHaveProperty("pendingMediaVersion");
      expect(calls).toHaveLength(2);
    } finally {
      pump.mockRestore();
    }
  });

  it.each(["人工换素材", "同素材换采用版本", "旧任务没有采用快照"])(
    "普通媒体回填保护：%s",
    async (scenario) => {
      const base = node("sample");
      await edit(base);
      const profile = configure();
      const seed = { id: randomUUID(), input: input(profile) };
      await service.submit(store, [seed]);
      await wait(seed.id, "succeeded");
      const source = store.getCanvas().canvas.nodes[0];
      if (source?.type !== "creative" || !source.data.assetId || !source.data.outputs?.[0])
        throw new Error("缺少初始版本");
      const assetId = source.data.assetId;
      const original = source.data.outputs[0];
      const alternate = { ...original, id: "manual-version" };
      const seeded = {
        ...base,
        data: {
          ...base.data,
          assetId,
          outputs: [original, alternate],
          activeOutputId: original.id,
        },
      };
      await edit(scenario === "人工换素材" ? base : seeded);
      let response: ServerResponse | undefined;
      provider = (_request, outgoing) => {
        response = outgoing;
      };
      const entry = { id: randomUUID(), input: input(profile) };
      await service.submit(store, [entry]);
      await expect.poll(() => !!response).toBe(true);
      if (scenario === "旧任务没有采用快照")
        await store.updateGeneration((state) => {
          const current = state.jobs[entry.id];
          if (!current || typeof current !== "object" || Array.isArray(current))
            throw new Error("缺少任务");
          delete current.mediaBindingHash;
          return { changed: true, result: null };
        });
      const chosen = {
        ...seeded,
        data: {
          ...seeded.data,
          activeOutputId: scenario === "同素材换采用版本" ? alternate.id : original.id,
          text: scenario === "旧任务没有采用快照" ? "新草稿" : base.data.text,
        },
      };
      await edit(chosen);
      response?.end(JSON.stringify({ data: [{ b64_json: png }] }));
      expect(await wait(entry.id, "succeeded")).toMatchObject({ bound: false });
      expect(store.getCanvas().canvas.nodes[0]?.data).toMatchObject({
        assetId,
        activeOutputId: chosen.data.activeOutputId,
        text: chosen.data.text,
        outputs: expect.arrayContaining([expect.objectContaining({ id: `${entry.id}:0` })]),
      });
    },
  );

  it("只执行审批中的选中项，对账幂等且任务状态不能跨项目读取", async () => {
    const profile = configure();
    await edit(
      ...["sample", "second"].map((id) => ({
        ...node(id),
        data: { ...node(id).data, generation: { providerId: profile.id } },
      })),
    );
    const args = { project: agent.key(store), runId: "run-1" };
    await agent.command("read", { ...args, input: { nodeIds: ["sample", "second"] } });
    const preview = await agent.command("generate-preview", {
      ...args,
      input: { items: [{ nodeId: "sample" }, { nodeId: "second" }], reason: "🎬".repeat(201) },
    });
    expect(preview).toMatchObject({ reason: "🎬".repeat(200) });
    const requests = Array.from({ length: 9 }, (_, index) => ({ nodeId: `different-${index}` }));
    await expect(
      agent.command("generate-preview", { ...args, input: { items: requests.slice(0, 8) } }),
    ).rejects.toMatchObject({ code: "AGENT_READ_REQUIRED" });
    await expect(
      agent.command("generate-preview", { ...args, input: { items: requests } }),
    ).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
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

  it("按节点绑定和连线申请生成，审批不可悄悄改写，重放不覆盖原图", async () => {
    const profile = configure("openai-image", undefined, "gpt-image-1");
    await edit(node("source"));
    const original = randomUUID();
    await service.submit(store, [{ id: original, input: input(profile, "source") }]);
    const output = (await wait(original, "succeeded"))?.outputs[0];
    if (!output || !("assetId" in output)) throw new Error("Missing generated reference image");

    const args = { project: agent.key(store), runId: "node-bound" };
    const read = (...nodeIds: string[]) => agent.command("read", { ...args, input: { nodeIds } });
    const preview = (...nodeIds: string[]) =>
      agent.command("generate-preview", {
        ...args,
        input: { items: nodeIds.map((nodeId) => ({ nodeId })) },
      });
    await read("source");
    const result = (await agent.command("apply-ops", {
      ...args,
      id: "connect",
      input: {
        ops: [
          { op: "create_node", tempId: "story", kind: "script", prompt: "窗外下着雪" },
          { op: "create_node", tempId: "variant", kind: "image", prompt: "参考@[原图](source)" },
          { op: "connect", source: "story", target: "variant" },
          { op: "connect", source: "source", target: "variant" },
        ],
      },
    })) as { created: Record<string, string> };
    const variant = result.created.variant!;
    const story = result.created.story!;
    await expect(preview(variant)).rejects.toMatchObject({ code: "JOB_MODEL_UNAVAILABLE" });
    await agent.command("apply-ops", {
      ...args,
      id: "bind",
      input: { ops: [{ op: "update_node", id: variant, model: profile.id }] },
    });
    expect(await read(variant)).toMatchObject({ nodes: [{ data: { model: profile.id } }] });
    await expect(preview(variant, variant)).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    await expect(
      agent.command("generate-preview", { ...args, input: { items: [input(profile, variant)] } }),
    ).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    await expect(
      agent.command("generate-preview", {
        ...args,
        runId: "unread",
        input: { items: [{ nodeId: variant }] },
      }),
    ).rejects.toMatchObject({ code: "AGENT_READ_REQUIRED" });
    const stale = await preview(variant);
    await read(story);
    await agent.command("apply-ops", {
      ...args,
      id: "edit-story",
      input: { ops: [{ op: "update_node", id: story, prompt: "夜里下着雪" }] },
    });
    const apply = (proposal: unknown) =>
      agent.command("generate-apply", { ...args, id: "approved", selected: [0], input: proposal });
    await expect(apply(stale)).rejects.toMatchObject({ code: "CANVAS_REVISION_CONFLICT" });

    const proposal = await preview(variant);
    const prompt = "参考图片1\n\n夜里下着雪";
    expect(proposal).toMatchObject({
      items: [
        {
          node_id: variant,
          request: { prompt, providerId: profile.id, referenceAssetIds: [output.assetId] },
        },
      ],
    });
    expect(calls).toHaveLength(1);
    const source = store.getCanvas().canvas.nodes.find((entry) => entry.id === "source")!;
    if (source.type !== "creative") throw Error("缺少已连接的原图节点");
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [{ type: "putNode", node: { ...source, position: { x: 700, y: 80 } } }],
    });
    const chunks: Buffer[] = [];
    provider = (request, response) => {
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => response.end(JSON.stringify({ data: [{ b64_json: png }] })));
    };
    const receipt = (await apply(proposal)) as { tasks: { task_id: string }[] };
    await wait(receipt.tasks[0]!.task_id, "succeeded");
    expect(await apply(proposal)).toEqual(receipt);
    expect(calls.at(-1)).toMatch(/\/images\/edits$/);
    expect(calls).toHaveLength(2);
    expect(Buffer.concat(chunks).toString().replaceAll("\r\n", "\n")).toContain(prompt);
    expect(Buffer.concat(chunks).includes(Buffer.from(png, "base64"))).toBe(true);
    await read(variant, "source");
    await expect(preview(variant)).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    await expect(preview("source")).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    expect(
      store.getCanvas().canvas.nodes.find((entry) => entry.id === "source")?.data,
    ).toMatchObject({ assetId: output.assetId, outputs: [expect.anything()] });
  });

  it("生成方式与参数按绑定模型读写，非法批次不落盘，重开后仍只申请一个结果", async () => {
    const channel = generationChannel();
    const plugin = registry.list().plugins.find((entry) => entry.key === "openai-image")!;
    const image = registry.modelSave({
      expectedRevision: 0,
      channelId: channel.id,
      channelRevision: channel.revision,
      upstreamModel: "gpt-image-1",
      pluginHash: plugin.hash,
      enabled: true,
      approve: true,
      settings: {},
      config: {
        kind: "image",
        name: "海报",
        sort: 1,
        description: "",
        customParams: {
          copies: { type: "enum", label: "生成份数", values: [1, 3], default: 3, fanout: true },
        },
      },
    });
    const video = configure("doubao-video", undefined, "doubao-seedance-1-5-pro-251215");
    const args = { project: agent.key(store), runId: "parameters" };
    const change = (ops: unknown[]) =>
      agent.command("apply-ops", { ...args, id: randomUUID(), input: { ops } });
    const result = (await change([
      {
        op: "create_node",
        kind: "image",
        tempId: "poster",
        prompt: "冬天",
        model: image.id,
        params: { copies: 3 },
      },
      {
        op: "create_node",
        kind: "video",
        tempId: "shot",
        prompt: "雪景",
        model: video.id,
        mode: "t2v",
        params: { duration: 5, aspect_ratio: "16:9" },
      },
    ])) as { created: Record<string, string> };
    const poster = result.created.poster!;
    const shot = result.created.shot!;
    const read = (nodeId: string) =>
      agent.command("read", { ...args, input: { nodeIds: [nodeId] } });
    const preview = (nodeId: string) =>
      agent.command("generate-preview", { ...args, input: { items: [{ nodeId }] } });
    expect(await read(poster)).toMatchObject({
      nodes: [{ mode: { auto: true, op: "" }, data: { params: { copies: 3 } } }],
    });
    expect(await agent.command("model-list", { ...args, input: { kind: "image" } })).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({
          key: image.id,
          params: expect.objectContaining({ copies: expect.objectContaining({ values: [1, 3] }) }),
        }),
      ]),
    });
    const before = store.getCanvas().canvasRevision;
    for (const invalid of [
      { mode: "t2i" },
      { mode: "omni" },
      { params: { images: "foreign" } },
      { params: { op: "t2i" } },
      { params: { copies: 2 } },
      { params: { duration: "oops" } },
      { params: { constructor: true } },
    ]) {
      await expect(
        change([
          { op: "update_node", id: poster, prompt: "不得写入" },
          { op: "update_node", id: poster, ...invalid },
        ]),
      ).rejects.toMatchObject({ code: "CANVAS_OPERATION_INVALID" });
    }
    expect(store.getCanvas().canvasRevision).toBe(before);
    await change([{ op: "update_node", id: shot, params: { duration: 6 } }]);
    await reopen();
    expect(await read(shot)).toMatchObject({
      nodes: [
        {
          mode: { op: "t2v", options: expect.arrayContaining(["t2v", "i2v"]) },
          data: { params: { op: "t2v", duration: 6, aspect_ratio: "16:9" } },
        },
      ],
    });
    expect(await preview(shot)).toMatchObject({
      items: [{ request: { op: "t2v", duration: 6, aspectRatio: "16:9", referenceAssetIds: [] } }],
    });
    await read(poster);
    const proposal = await preview(poster);
    expect(proposal).toMatchObject({
      items: [{ request: { prompt: "冬天", customParams: { copies: 1 } } }],
    });
    const receipt = (await agent.command("generate-apply", {
      ...args,
      id: "single-result",
      input: proposal,
      selected: [0],
    })) as { tasks: { task_id: string }[] };
    expect(receipt.tasks).toHaveLength(1);
    expect((await wait(receipt.tasks[0]!.task_id, "succeeded"))?.outputs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    await read(shot);
    await change([{ op: "update_node", id: shot, model: "" }]);
    await expect(preview(shot)).rejects.toMatchObject({ code: "JOB_MODEL_UNAVAILABLE" });
  });

  it("普通连线超过模型容量时不申请，断开一张后只发送保留的 PNG，重放不重复出图", async () => {
    const generator = configure("openai-image", undefined, "gpt-image-1");
    const editor = configure("openai-image", undefined, "dall-e-2");
    const retained =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    const edits: Buffer[] = [];
    provider = (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url?.endsWith("/edits")) edits.push(Buffer.concat(chunks));
        response.end(JSON.stringify({ data: [{ b64_json: calls.length === 2 ? retained : png }] }));
      });
    };
    const poster = {
      ...node("poster"),
      data: { ...node("poster").data, generation: { providerId: editor.id } },
    };
    await edit(node("discard"), node("keep"), poster);
    for (const id of ["discard", "keep"]) {
      const jobId = randomUUID();
      await service.submit(store, [{ id: jobId, input: input(generator, id) }]);
      await wait(jobId, "succeeded");
    }
    const connect = (source: string) => ({
      type: "putEdge" as const,
      edge: { id: `edge-${source}`, source, target: "poster" },
    });
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [connect("discard"), connect("keep")],
    });
    const args = { project: agent.key(store), runId: "ordinary-references" };
    const read = () =>
      agent.command("read", { ...args, input: { nodeIds: ["poster", "keep", "discard"] } });
    const preview = () =>
      agent.command("generate-preview", { ...args, input: { items: [{ nodeId: "poster" }] } });
    const detail = await read();
    if (!detail || !("nodes" in detail) || !detail.nodes) throw Error("缺少节点精读结果");
    const retainedNode = detail.nodes.find((item) => item.id === "keep");
    expect(retainedNode?.data).toMatchObject({ hasOutput: true, outputCount: 1 });
    for (const field of ["assetId", "activeOutputId", "outputs"])
      expect(retainedNode?.data).not.toHaveProperty(field);
    await expect(preview()).rejects.toMatchObject({ code: "AGENT_REFERENCE_LIMIT" });
    expect(calls).toHaveLength(2);
    expect(service.list(store).jobs).toHaveLength(2);
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [{ type: "removeEdge", id: "edge-discard" }],
    });
    await read();
    const proposal = await preview();
    const apply = () =>
      agent.command("generate-apply", {
        ...args,
        id: "one-edit",
        selected: [0],
        input: proposal,
      }) as Promise<{ tasks: { task_id: string }[] }>;
    const receipt = await apply();
    await wait(receipt.tasks[0]!.task_id, "succeeded");
    expect((await apply()).tasks).toEqual(receipt.tasks);
    expect(calls).toEqual([
      "POST /v1/images/generations",
      "POST /v1/images/generations",
      "POST /v1/images/edits",
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.includes(Buffer.from(retained, "base64"))).toBe(true);
    expect(edits[0]!.includes(Buffer.from(png, "base64"))).toBe(false);
  });

  it.each(["omni", "i2v"] as const)(
    "空参考的 %s：助手可申请但批准前不出站，普通面板仍要求连线",
    async (mode) => {
      const video = configure("doubao-video", undefined, "doubao-seedance-2-0");
      const args = { project: agent.key(store), runId: "empty-agent-reference" };
      const made = await agent.command("apply-ops", {
        ...args,
        id: "prepare-shot",
        input: {
          ops: [
            {
              op: "create_node",
              tempId: "shot",
              kind: "video",
              model: video.id,
              mode,
              prompt: "远处的窗亮了",
            },
          ],
        },
      });
      if (!made || !("created" in made) || !made.created?.shot) throw Error("缺少新建的视频节点");
      const nodeId = made.created.shot;
      const proposal = (await agent.command("generate-preview", {
        ...args,
        input: { items: [{ nodeId }] },
      })) as { items: { request: GenerationInput }[] };
      expect(proposal.items[0]!.request).toMatchObject({
        op: mode,
        referenceAssetIds: [],
        prompt: "远处的窗亮了",
      });
      await expect(service.prepare(store, proposal.items[0]!.request)).rejects.toMatchObject({
        code: "JOB_INPUT_INVALID",
      });
      expect(calls).toHaveLength(0);
      const requests: unknown[] = [];
      provider = (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          requests.push(JSON.parse(Buffer.concat(chunks).toString()));
          response.end(JSON.stringify({ error: { message: "测试终态" } }));
        });
      };
      const approve = () =>
        agent.command("generate-apply", {
          ...args,
          id: "approve-empty",
          selected: [0],
          input: proposal,
        }) as Promise<{ tasks: { task_id: string }[] }>;
      const result = await approve();
      await wait(result.tasks[0]!.task_id, "failed");
      expect(await approve()).toEqual(result);
      expect(requests).toEqual([
        expect.objectContaining({ content: [{ type: "text", text: "远处的窗亮了" }] }),
      ]);
    },
  );

  it("申请视频后才开始制作角色声音：再次预检与原审批均不提交，取消声音后可以生成", async () => {
    const video = configure("doubao-video", undefined, "doubao-seedance-1-5-pro-251215");
    const audio = configure("doubao-audio", undefined, "seed-audio");
    const args = { project: agent.key(store), runId: "character-voice-race" };
    const result = (await agent.command("apply-ops", {
      ...args,
      id: "story",
      input: {
        ops: [
          { op: "create_node", tempId: "role", kind: "character", character: { name: "林夏" } },
          {
            op: "create_node",
            tempId: "shot",
            kind: "video",
            model: video.id,
            mode: "t2v",
            prompt: "等待开门",
          },
          { op: "connect", source: "role", target: "shot" },
        ],
      },
    })) as { created: Record<string, string> };
    const { role, shot } = result.created;
    const preview = () =>
      agent.command("generate-preview", { ...args, input: { items: [{ nodeId: shot }] } });
    const proposal = await preview();
    const apply = (input: unknown) =>
      agent.command("generate-apply", { ...args, id: "confirmed", selected: [0], input });
    const voiceId = randomUUID();
    const start = vi.spyOn(service, "start").mockImplementation(() => {});
    try {
      const revision = store.getCanvas().canvasRevision;
      await service.submit(store, [
        {
          id: voiceId,
          input: { ...input(audio, role), purpose: "character-voice", speaker: "fixture-speaker" },
        },
      ]);
      expect(store.getCanvas().canvasRevision).toBe(revision);
      await expect(apply(proposal)).rejects.toMatchObject({ code: "AGENT_ROLE_VOICE_PENDING" });
      await expect(preview()).rejects.toMatchObject({ code: "AGENT_ROLE_VOICE_PENDING" });
      expect(service.list(store).jobs.map((job) => job.id)).toEqual([voiceId]);
      expect(calls).toEqual([]);
      await service.cancel(store, voiceId);
      expect(await apply(await preview())).toMatchObject({ tasks: [{ node_id: shot }] });
      expect(service.list(store).jobs.filter((job) => job.nodeId === shot)).toHaveLength(1);
    } finally {
      start.mockRestore();
    }
  });

  it.each([
    "审批后 Worker 中止",
    "审批后用户停止",
    "混合成败后 Worker 中止",
    "部分批准后 Worker 中止",
    "Worker 中止八天后重开",
  ])("%s，保留原任务且不重复交付", async (scenario) => {
    const mixed = scenario === "混合成败后 Worker 中止";
    const partial = scenario === "部分批准后 Worker 中止";
    const nodeIds = mixed || partial ? ["sample", "second"] : ["sample"];
    const expectedNodes = partial ? ["second"] : nodeIds;
    const profile = configure();
    await edit(
      ...nodeIds.map((id) => ({
        ...node(id),
        data: { ...node(id).data, generation: { providerId: profile.id } },
      })),
    );
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
              args: { items: nodeIds.map((nodeId) => ({ nodeId })) },
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
          if (!command.startsWith("canvas:")) throw new Error(`Unexpected bridge call ${command}`);
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
          ...(scenario === "审批后 Worker 中止"
            ? {}
            : { items: nodeIds.map((_, index) => ({ index, approve: !partial || index === 1 })) }),
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
      expect(approved.map((job) => job.nodeId).sort()).toEqual([...expectedNodes].sort());
      await expect
        .poll(() =>
          service
            .list(store)
            .jobs.map(({ status }) => status)
            .sort(),
        )
        .toEqual(mixed ? ["failed", "succeeded"] : ["succeeded"]);
      if (scenario === "Worker 中止八天后重开") {
        const database = new DatabaseSync(join(root, "assistant", "agent.sqlite"));
        try {
          const update = database.prepare(
            "UPDATE agent_approvals SET decided_at = ? WHERE id = ? AND status = 'approved'",
          );
          expect(update.run(Date.now() - 8 * 24 * 3600000, approval!.id).changes).toBe(1);
        } finally {
          database.close();
        }
      }
      await reopen();
      const recovered = await open();
      client = recovered;
      await recovered.request("recoverCanvas", { scope });
      await recovered.request("recoverCanvas", { scope });
      if (scenario === "Worker 中止八天后重开") {
        const decisions = await recovered.request<Approval[]>("approvals", {
          scope,
          sessionId,
          runId: run.id,
        });
        expect(decisions).toMatchObject([
          { id: approval!.id, status: "executed", result: { tasks: [{ node_id: "sample" }] } },
        ]);
        const { events } = await recovered.request<{
          events: { type: string; approvalId?: string }[];
        }>("page", { scope, sessionId, after: 0 });
        for (const type of ["approval.created", "approval.decided"])
          expect(
            events.filter((event) => event.type === type).map((event) => event.approvalId),
          ).toEqual([approval!.id]);
        expect(
          events.some((event) => event.type === "watch.updated" || event.type === "tasks.settled"),
        ).toBe(false);
        expect(service.list(store).jobs.map((job) => job.id)).toEqual(
          approved.map((job) => job.id),
        );
        expect(executions).toBe(1);
        expect(calls).toHaveLength(1);
        expect(model.modelRequests).toHaveLength(2);
        return;
      }
      await expect
        .poll(() => events.filter(({ type }) => type === "tasks.settled").length, {
          timeout: 5000,
        })
        .toBe(1);
      if (crashed) {
        const deliveryRun = events.find((event) => event.type === "tasks.settled")?.runId;
        await expect
          .poll(
            () =>
              events.some(
                (event) =>
                  event.runId === deliveryRun &&
                  event.type === "run.status" &&
                  (event.payload as { status?: string }).status === "succeeded",
              ),
            { timeout: 5000 },
          )
          .toBe(true);
      }
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
      const result = settled[0]?.payload as
        | { receipt_only?: boolean; tasks: { task_status: string }[] }
        | undefined;
      expect(result?.receipt_only === true).toBe(!crashed);
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
      expect(service.list(store).jobs).toHaveLength(expectedNodes.length);
      expect(executions).toBe(1);
      expect(calls).toHaveLength(expectedNodes.length);
      if (partial)
        expect(
          state.events
            .filter((event) => event.type === "approval.decided")
            .map((event) => event.payload),
        ).toEqual([
          expect.objectContaining({
            status: "executed",
            decision: { decision: "approve", items: [{ index: 1, approve: true, count: 1 }] },
            result: { tasks: [expect.objectContaining({ node_id: "second" })] },
          }),
        ]);
      expect(model.modelRequests).toHaveLength(crashed ? 3 : 2);
    } finally {
      await client?.close();
      await model.close();
    }
  });

  it("普通画布编辑原子提交，同批临时 ID 可连线，重放只写一次并可整轮撤销", async () => {
    const project = agent.key(store);
    const runId = "direct-run";
    const apply = (id: string, ops: unknown[]) =>
      agent.command("apply-ops", { project, runId, id, input: { ops } });
    const original = store.getCanvas();
    const ops = [
      { op: "create_node", tempId: "script", kind: "script", prompt: "剧本" },
      { op: "create_node", tempId: "frame", kind: "image" },
      { op: "move", id: "frame", position: { x: 200, y: 120 } },
      { op: "connect", source: "script", target: "frame" },
    ];
    const result = await apply("first", ops);
    expect(await apply("first", ops)).toEqual(result);
    const applied = store.getCanvas();
    expect(applied.canvasRevision).toBe(original.canvasRevision + 1);
    expect(applied.canvas.edges.length).toBe(original.canvas.edges.length + 1);
    const frame = applied.canvas.nodes.find(
      (node) => node.type === "creative" && node.data.kind === "image" && node.position.x === 200,
    );
    expect(frame).toBeDefined();
    await expect(
      apply("second", [
        { op: "update_node", id: frame?.id, prompt: "改写" },
        { op: "move", id: "missing", position: { x: 0, y: 0 } },
      ]),
    ).rejects.toMatchObject({ code: "CANVAS_OPERATION_INVALID" });
    expect(store.getCanvas()).toEqual(applied);
    await expect(apply("second", [{ op: "removeNode", id: frame?.id }])).rejects.toMatchObject({
      code: "CANVAS_OPERATION_INVALID",
    });
    await apply("third", [{ op: "update_node", id: frame?.id, prompt: "已改写" }]);
    expect(await agent.command("undo", { project, runId })).toMatchObject({
      reverted: 4,
      skipped: [],
    });
    expect(store.getCanvas().canvas).toEqual(original.canvas);
  });

  it("原生删除审批保留组内成员绝对坐标，清除相关连线，支持撤销、重放及过期拒绝", async () => {
    const group = {
      id: "g",
      type: "group" as const,
      position: { x: 200, y: 300 },
      width: 300,
      height: 200,
      data: { label: "组" },
    };
    const child = { ...node("child"), parentId: group.id };
    const edge = { id: "link", source: "child", target: "other" };
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [
        ...[group, child, node("other")].map((node) => ({ type: "putNode" as const, node })),
        { type: "putEdge", edge },
      ],
    });
    const args = { project: agent.key(store), runId: "native-delete" };
    const preview = (nodeIds: string[], edgeIds: string[]) =>
      agent.command("edit-preview", { ...args, input: { nodeIds, edgeIds, reason: "清理草稿" } });
    const apply = (input: unknown, id: string, selected: number[]) =>
      agent.command("edit-apply", { ...args, id, selected, input });
    const original = store.getCanvas();
    await expect(preview([], [])).rejects.toMatchObject({ code: "CANVAS_OPERATION_INVALID" });
    await expect(preview([], ["missing"])).rejects.toMatchObject({
      code: "CANVAS_OPERATION_INVALID",
    });
    const pending = await preview(["g", "other", "child"], []);
    expect(store.getCanvas()).toEqual(original);
    const receipt = await apply(pending, "partial", [0, 1]);
    expect(await apply(pending, "partial", [0, 1])).toEqual(receipt);
    const changed = store.getCanvas().canvas;
    expect(changed.nodes.find((n) => n.id === "child")).toEqual({
      ...node("child"),
      position: { x: 210, y: 320 },
    });
    expect(changed.edges).not.toContainEqual(edge);
    expect(await agent.command("undo", args)).toMatchObject({ reverted: 4, skipped: [] });
    expect(store.getCanvas().canvas.edges).toContainEqual(edge);
    expect(store.getCanvas().canvas.nodes).toContainEqual(child);
    const edgeOnly = await preview([], ["link"]);
    await edit(node("other", "image", "人工编辑"));
    await expect(apply(edgeOnly, "stale", [0])).rejects.toMatchObject({
      code: "CANVAS_REVISION_CONFLICT",
    });
    await apply(await preview([], ["link"]), "edge-only", [0]);
    expect(store.getCanvas().canvas.edges).not.toContainEqual(edge);
    expect(store.getCanvas().canvas.nodes).toContainEqual(child);
  });

  it("小灵编辑角色卡可清除音色描述，撤销恢复设定", async () => {
    const project = agent.key(store);
    const apply = (runId: string, ops: unknown[]) =>
      agent.command("apply-ops", { project, runId, id: runId, input: { ops } });
    const result = await apply("create-character", [
      {
        op: "create_node",
        kind: "character",
        tempId: "lead",
        prompt: "雨夜站台",
        character: { name: " 阿远 ", voicePrompt: "沙哑低音" },
      },
    ]);
    if (!result || !("created" in result) || !result.created?.lead) throw new Error("缺少角色节点");
    const id = result.created.lead;
    const original = store.getCanvas().canvas;
    expect(original.nodes.find((node) => node.id === id)).toMatchObject({
      data: { kind: "image", label: "阿远 · 基础形象", character: { voicePrompt: "沙哑低音" } },
    });
    const args = { project, runId: "edit-character" };
    await agent.command("read", { ...args, input: { nodeIds: [id] } });
    await apply(args.runId, [
      { op: "update_node", id, character: { look: " 夜班 ", voicePrompt: "   " } },
    ]);
    expect(store.getCanvas().canvas.nodes.find((node) => node.id === id)?.data).toEqual({
      kind: "image",
      label: "阿远 · 基础形象",
      text: "雨夜站台",
      character: { name: "阿远", look: "夜班", description: "", extraAssetIds: [] },
    });
    await agent.command("undo", args);
    expect(store.getCanvas().canvas).toEqual(original);
  });

  it("精读分镜区分手传配图与关联节点，改台词和撤销保留配图", async () => {
    const path = join(root, "shot.png");
    await writeFile(path, Buffer.from(png, "base64"));
    const handle = await open(path, "r");
    const imported = await new AssetService(join(binaries, "ffprobe"))
      .importCopy(store, handle, "shot.png", randomUUID())
      .finally(() => handle.close());
    if (imported.kind !== "created") throw Error("缺少镜头图片");
    await store.commitAsset({
      operationId: randomUUID(),
      expectedRevision: store.snapshot.revision,
      requestHash: imported.asset.sha256,
      asset: imported.asset,
    });
    const sheet = node("sheet", "script");
    const shot = {
      id: "first",
      scene: "来信",
      shot: "中景" as const,
      camera: "固定" as const,
      dialogue: "",
      action: "",
      duration: 4,
      imageNodeId: "still",
      videoNodeId: "clip",
    };
    const shots = [
      { ...shot, imageAssetId: imported.asset.assetId },
      { ...shot, id: "second" },
    ];
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [
        node("still"),
        node("clip", "video"),
        { ...sheet, data: { ...sheet.data, storyboard: shots } },
      ].map((node) => ({ type: "putNode", node })),
    });
    const original = store.getCanvas().canvas;
    const run = { project: agent.key(store), runId: "read-shot-images" };
    const result = await agent.command("read", { ...run, input: { nodeIds: ["sheet"] } });
    expect(result).toMatchObject({
      nodes: [
        {
          data: {
            shotCount: 2,
            storyboard: [
              { ...shot, no: 1, hasImage: true },
              { ...shot, id: "second", no: 2 },
            ],
          },
        },
      ],
    });
    if (!result || !("nodes" in result) || !result.nodes) throw Error("缺少镜头详情");
    expect(result.nodes[0]).not.toHaveProperty("data.storyboard.1.hasImage");
    expect(JSON.stringify(result.nodes)).not.toContain(imported.asset.assetId);
    await agent.command("apply-ops", {
      ...run,
      id: "dialogue",
      input: {
        ops: [
          {
            op: "update_node",
            id: "sheet",
            storyboard: { edits: [{ op: "update", no: 1, set: { dialogue: "请进。" } }] },
          },
        ],
      },
    });
    expect(store.getCanvas().canvas.nodes.find((item) => item.id === "sheet")).toMatchObject({
      data: {
        storyboard: [{ ...shots[0], dialogue: "请进。" }, shots[1]],
      },
    });
    await agent.command("undo", run);
    expect(store.getCanvas().canvas).toEqual(original);
  });

  it("小灵一次搭建剧本到分镜到视频的工作流，重放只写入一次", async () => {
    const input = {
      ops: [
        { op: "create_node", kind: "script", tempId: "script", prompt: "剧本模板" },
        { op: "create_node", kind: "storyboard", tempId: "board", storyboard: { shots: [] } },
        { op: "create_node", kind: "video", tempId: "clip" },
        { op: "connect", source: "script", target: "board" },
        { op: "connect", source: "board", target: "clip" },
        { op: "create_group", label: "剧本 → 分镜 → 视频", memberIds: ["script", "board", "clip"] },
      ],
    };
    const model = await fakeGo({
      turns: [
        { tools: [{ id: "create", name: "canvas_apply_ops", args: input }] },
        { text: "工作流已搭建" },
      ],
    });
    const scope = { kind: "canvas", projectId: agent.key(store) };
    let write: unknown;
    let bridgeError: unknown;
    let client: AgentWorkerClient | undefined;
    try {
      const profile = registry.save({
        expectedRevision: 0,
        pluginHash: registry.list().plugins.find(({ key }) => key === "openai")!.hash,
        approve: true,
        secret: "sk-fixture-only",
        fields: {
          label: "回放模型",
          endpoint: model.url,
          model: "fixture",
          allowLocal: true,
          agentEnabled: true,
          channel: { api: "chat_completions", pathPrefix: "/internal/platform/v1/model" },
        },
      });
      const binding = registry.agentBinding(profile.id, profile.revision);
      provider = async (incoming, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const upstream = await openAgentStream(
            binding,
            JSON.parse(Buffer.concat(chunks).toString()),
            registry.redactor(),
            5000,
            AbortSignal.timeout(5000),
          );
          response.writeHead(200, { "content-type": "text/event-stream" });
          for await (const chunk of upstream) response.write(chunk);
          response.end();
        } catch (error) {
          bridgeError = error;
          response.destroy(error as Error);
        }
      };
      client = await AgentWorkerClient.open({
        workerPath: join(process.cwd(), "out/agent-runtime/worker.mjs"),
        directory: join(root, "assistant"),
        modelBridgeUrl: endpoint,
        settings: async (command, args) => {
          if (command === "model")
            return { name: "fixture", context_window: 32768, max_tokens: 2048 };
          if (command === "canvas:apply-ops") {
            expect(write).toBeUndefined();
            write = args;
          }
          return agent.command(command.slice(7), args);
        },
      });
      await client.request("recoverCanvas", { scope });
      const { sessionId } = await client.request<{ sessionId: string }>("create", { scope });
      await client.request("start", {
        scope,
        sessionId,
        message: "搭建剧本到分镜再到视频的工作流",
      });
      await client.request("idle");
      const state = await client.request<{ runs: Run[] }>("state", { scope, sessionId });
      expect(bridgeError).toBeUndefined();
      expect(state.runs[0]?.status, JSON.stringify(state.runs[0])).toBe("succeeded");
      expect(write).toMatchObject({ input });
    } finally {
      await client?.close();
      await model.close();
    }
    const canvas = store.getCanvas();
    const receipt = await agent.command("apply-ops", write);
    if (!receipt || !("created" in receipt) || !receipt.created) throw Error("缺少创建结果");
    const { script, board, clip } = receipt.created;
    expect(canvas.canvas.nodes).toHaveLength(4);
    expect(canvas.canvas.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: script, target: board }),
        expect.objectContaining({ source: board, target: clip }),
      ]),
    );
    expect(store.getCanvas()).toEqual(canvas);
  });

  it("小灵按当前镜号修改分镜表，修正时长，保留镜头 ID，可重放和撤销", async () => {
    const args = { project: agent.key(store), runId: "storyboard-create" };
    const apply = (id: string, ops: unknown[], runId = args.runId) =>
      agent.command("apply-ops", { ...args, runId, id, input: { ops } });
    const shots = Array.from({ length: 200 }, (_, index) => ({ scene: `画面 ${index + 1}` }));
    const created = await apply("board", [
      { op: "create_node", tempId: "board", kind: "storyboard", storyboard: { shots } },
    ]);
    if (!created || !("created" in created) || !created.created?.board)
      throw new Error("缺少分镜表 ID");
    const id = created.created.board;
    const rows = () => {
      const board = store.getCanvas().canvas.nodes.find((node) => node.id === id);
      if (board?.type !== "creative" || !board.data.storyboard) throw new Error("缺少镜头");
      return board.data.storyboard;
    };
    const original = rows();
    const run = "storyboard-edit";
    const edits = [
      { op: "delete", no: 1 },
      { op: "insert", after: 0, set: { scene: "  雨后  ", duration: 61 } },
      { op: "move", no: 200, to: 2 },
      { op: "update", no: 2, set: { dialogue: "结尾提前", duration: 4.46 } },
    ];
    const update = [{ op: "update_node", id, storyboard: { edits } }];
    await expect(apply("edit", update, run)).rejects.toMatchObject({ code: "AGENT_READ_REQUIRED" });
    expect(
      await agent.command("read", { ...args, runId: run, input: { nodeIds: [id] } }),
    ).toMatchObject({
      nodes: [
        {
          data: {
            storyboard: expect.arrayContaining([
              expect.objectContaining({ no: 200, scene: "画面 200" }),
            ]),
          },
        },
      ],
    });
    const result = await apply("edit", update, run);
    expect(result).toMatchObject({ warnings: [expect.stringContaining("已修正")] });
    expect(rows()[0]).toMatchObject({ scene: "雨后", duration: 60, shot: "中景", camera: "固定" });
    expect(rows()[1]).toEqual({ ...original[199], dialogue: "结尾提前", duration: 4.5 });
    expect(rows()[2]).toEqual(original[1]);
    const committed = store.getCanvas();
    expect(await apply("edit", update, run)).toEqual(result);
    await expect(
      apply(
        "invalid",
        [
          {
            op: "update_node",
            id,
            storyboard: {
              edits: [
                { op: "delete", no: 1 },
                { op: "move", no: 1, to: 201 },
              ],
            },
          },
        ],
        run,
      ),
    ).rejects.toMatchObject({ code: "CANVAS_OPERATION_INVALID" });
    expect(store.getCanvas()).toEqual(committed);
    await agent.command("undo", { ...args, runId: run });
    expect(rows()).toEqual(original);
  });

  it("小灵建组及增减成员保留绝对坐标，错误操作整批回滚", async () => {
    await edit(node("first"), { ...node("second"), position: { x: 800, y: 70 } });
    const original = store.getCanvas();
    const args = { project: agent.key(store), runId: "group-ops" };
    const apply = (id: string, ops: unknown[]) =>
      agent.command("apply-ops", { ...args, id, input: { ops } });
    const create = {
      op: "create_group",
      tempId: "group",
      memberIds: ["first"],
      color: "blue",
      labelColor: "pink",
    };
    await expect(apply("unread", [create])).rejects.toMatchObject({ code: "AGENT_READ_REQUIRED" });
    await agent.command("read", { ...args, input: { nodeIds: ["first", "second"] } });
    const result = await apply("make", [
      create,
      {
        op: "set_group",
        id: "group",
        label: "开场",
        addMembers: ["second"],
        removeMembers: ["first"],
      },
    ]);
    if (!result || !("created" in result) || !result.created?.group) throw new Error("缺少新组 ID");
    const group = result.created.group;
    const canvas = store.getCanvas();
    expect(canvas.canvas.nodes).toContainEqual(node("first"));
    expect(canvas.canvas.nodes).toContainEqual({
      ...node("second"),
      parentId: group,
      position: { x: 48, y: 72 },
    });
    expect(canvas.canvas.nodes).toContainEqual({
      id: group,
      type: "group",
      data: { label: "开场", color: "blue", labelColor: "pink" },
      position: { x: 752, y: -2 },
      width: 672,
      height: 444,
    });
    await expect(
      apply("invalid", [
        { op: "set_group", id: group, label: "临时" },
        { op: "set_group", id: group, removeMembers: ["first"] },
      ]),
    ).rejects.toMatchObject({ code: "CANVAS_OPERATION_INVALID" });
    expect(store.getCanvas()).toEqual(canvas);
    await apply("colors", [{ op: "set_group", id: group, labelColor: "" }]);
    const colored = store.getCanvas();
    expect(colored.canvas.nodes.find((node) => node.id === group)?.data).toEqual({
      label: "开场",
      color: "blue",
    });
    const detail = await agent.command("read", { ...args, input: { nodeIds: [group, "second"] } });
    expect(detail).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: group,
          size: { x: 672, y: 444 },
          data: { label: "开场", color: "blue" },
        }),
        expect.objectContaining({ id: "second", parent: group, position: { x: 48, y: 72 } }),
      ]),
    });
    await expect(
      apply("bad-color", [
        { op: "set_group", id: group, color: "red" },
        { op: "set_group", id: group, labelColor: "invalid" },
      ]),
    ).rejects.toMatchObject({ code: "CANVAS_OPERATION_INVALID" });
    expect(store.getCanvas()).toEqual(colored);
    await agent.command("undo", args);
    expect(store.getCanvas().canvas).toEqual(original.canvas);
  });

  it("无位移整理保留当前修订，手工修改前的精读记录仍然失效", async () => {
    await edit(node("sample"));
    const args = { project: agent.key(store), runId: "no-op-layout" };
    await agent.command("read", { ...args, input: { nodeIds: ["sample"] } });
    await edit(node("sample", "image", "用户修改"));
    const revision = store.getCanvas().canvasRevision;
    await agent.command("arrange", {
      ...args,
      id: "layout",
      input: { layout: "row", nodeIds: ["sample"] },
    });
    expect(store.getCanvas().canvasRevision).toBe(revision);
    await expect(
      agent.command("apply-ops", {
        ...args,
        id: "update",
        input: { ops: [{ op: "update_node", id: "sample", prompt: "覆盖" }] },
      }),
    ).rejects.toMatchObject({ code: "AGENT_READ_REQUIRED" });
  });

  it("小灵保留指定位置，回执汇总组间重叠，贴边后清除提醒", async () => {
    const group = (id: string, x: number) => ({
      id,
      type: "group" as const,
      data: { label: id },
      position: { x, y: 0 },
      width: 1000,
      height: 800,
    });
    const groups = [
      group("alpha", 0),
      group("bravo", 300),
      group("charlie", 700),
      group("delta", 900),
    ];
    const member = { ...node("member"), parentId: "bravo", position: { x: 48, y: 72 } };
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [...groups, member].map((node) => ({ type: "putNode", node })),
    });
    const original = store.getCanvas();
    const run = { project: agent.key(store), runId: "overlap" };
    await agent.command("read", { ...run, input: { nodeIds: groups.map((group) => group.id) } });
    const request = {
      ...run,
      id: "fixed",
      input: {
        ops: groups.map((group) => ({
          op: "move",
          id: group.id,
          position: { ...group.position, y: 10 },
        })),
      },
    };
    const receipt = await agent.command("apply-ops", request);
    const warnings = receipt && "warnings" in receipt ? receipt.warnings : undefined;
    expect(warnings).toHaveLength(5);
    expect(warnings?.[0]).toContain("「alpha」（alpha）与「bravo」（bravo）重叠");
    expect(warnings?.[1]).toContain("「charlie」（charlie）与「delta」（delta）重叠");
    expect(warnings?.join(" ")).not.toContain("member");
    expect(store.getCanvas().canvas.nodes).toEqual(
      expect.arrayContaining(
        groups.map((group) => ({ ...group, position: { ...group.position, y: 10 } })),
      ),
    );
    expect(await agent.command("apply-ops", request)).toEqual(receipt);
    const aligned = await agent.command("apply-ops", {
      ...run,
      id: "touch",
      input: { ops: [{ op: "move", id: "delta", position: { x: 1700, y: 10 } }] },
    });
    expect(aligned).not.toHaveProperty("warnings");
    await agent.command("undo", run);
    expect(store.getCanvas().canvas).toEqual(original.canvas);
  });

  it("小灵扩组时绕开同批固定节点并撤销邻居位移", async () => {
    const frame = {
      id: "frame",
      type: "group" as const,
      data: { label: "分镜组", color: "blue" as const },
      position: { x: 0, y: 0 },
      width: 200,
      height: 140,
    };
    const image = { ...node("image"), position: { x: 48, y: 72 } };
    const neighbor = { ...node("neighbor"), position: { x: 320, y: 0 } };
    const fixed = { ...node("fixed"), position: { x: 1200, y: 0 } };
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [frame, image, neighbor, fixed].map((node) => ({ type: "putNode", node })),
    });
    const original = store.getCanvas();
    const run = { project: agent.key(store), runId: "group-growth" };
    await agent.command("read", { ...run, input: { nodeIds: ["frame", "image", "fixed"] } });
    const request = {
      ...run,
      id: "group-member",
      input: {
        ops: [
          { op: "set_group", id: "frame", addMembers: ["image"] },
          { op: "move", id: "image", position: { x: 58, y: 82 } },
          { op: "move", id: "fixed", position: fixed.position },
        ],
      },
    };
    const receipt = await agent.command("apply-ops", request);
    expect(store.getCanvas().canvas.nodes).toEqual(
      expect.arrayContaining([
        { ...frame, position: { x: 10, y: 10 }, width: 672, height: 444 },
        { ...image, parentId: frame.id, position: { x: 48, y: 72 } },
        { ...neighbor, position: { x: 1896, y: 0 } },
        fixed,
      ]),
    );
    expect(await agent.command("apply-ops", request)).toEqual(receipt);
    expect(store.getCanvas().canvasRevision).toBe(original.canvasRevision + 1);
    await agent.command("undo", run);
    expect(store.getCanvas().canvas).toEqual(original.canvas);
  });

  it("小灵直接在同批新组和已有组内创建节点", async () => {
    const original = store.getCanvas();
    const project = agent.key(store);
    const run = { project, runId: "direct-members" };
    const create = await agent.command("apply-ops", {
      ...run,
      id: "make",
      input: {
        ops: [
          { op: "create_group", tempId: "group", position: { x: 1000, y: 200 } },
          { op: "create_node", tempId: "first", kind: "image", parentGroup: "group" },
          {
            op: "create_node",
            tempId: "second",
            kind: "audio",
            parentGroup: "group",
            position: { x: 20, y: 420 },
          },
          { op: "create_node", tempId: "third", kind: "audio", parentGroup: "group" },
        ],
      },
    });
    if (!create || !("created" in create) || !create.created) throw Error("缺少创建回执");
    const { group, first, second, third } = create.created;
    const made = store.getCanvas();
    expect(made.canvas.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: group,
          position: { x: 972, y: 200 },
          width: 1144,
          height: 792,
        }),
        expect.objectContaining({ id: first, parentId: group, position: { x: 76, y: 72 } }),
        expect.objectContaining({ id: second, parentId: group, position: { x: 48, y: 420 } }),
        expect.objectContaining({ id: third, parentId: group, position: { x: 772, y: 420 } }),
      ]),
    );
    const nextRun = { project, runId: "append-member" };
    const append = {
      ...nextRun,
      id: "append",
      input: { ops: [{ op: "create_node", kind: "video", tempId: "video", parentGroup: group }] },
    };
    await expect(agent.command("apply-ops", append)).rejects.toMatchObject({
      code: "AGENT_READ_REQUIRED",
    });
    await agent.command("read", { ...nextRun, input: { nodeIds: [group] } });
    const receipt = await agent.command("apply-ops", append);
    expect(await agent.command("apply-ops", append)).toEqual(receipt);
    expect(store.getCanvas().canvas.nodes).toContainEqual(
      expect.objectContaining({ parentId: group, position: { x: 1216, y: 420 } }),
    );
    await agent.command("undo", nextRun);
    expect(store.getCanvas().canvas).toEqual(made.canvas);
    await agent.command("undo", run);
    expect(store.getCanvas().canvas).toEqual(original.canvas);
  });

  it("小灵按竖屏视频与宽图的实际画幅整理分组并撤销", async () => {
    const group = {
      id: "mixed",
      type: "group" as const,
      position: { x: 3000, y: 0 },
      width: 500,
      height: 400,
      data: { label: "混合画幅" },
    };
    const video = node("portrait", "video");
    const image = node("wide", "image");
    const neighbor = { ...node("neighbor"), position: { x: 3700, y: 100 } };
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [
        group,
        {
          ...video,
          parentId: group.id,
          position: { x: 48, y: 72 },
          data: { ...video.data, mediaAspect: 9 / 16 },
        },
        {
          ...image,
          parentId: group.id,
          position: { x: 100, y: 80 },
          data: { ...image.data, generation: { params: { customParams: { ratio: "21:9" } } } },
        },
        neighbor,
      ].map((node) => ({ type: "putNode", node })),
    });
    const original = store.getCanvas();
    const args = {
      project: agent.key(store),
      runId: "mixed-frames",
      id: "row",
      input: { layout: "row", groupId: group.id },
    };
    const receipt = await agent.command("arrange", args);
    expect(await agent.command("arrange", args)).toEqual(receipt);
    expect(store.getCanvas().canvasRevision).toBe(original.canvasRevision + 1);
    expect(store.getCanvas().canvas.nodes).toEqual(
      expect.arrayContaining([
        { ...group, width: 1296, height: 696 },
        expect.objectContaining({ id: "wide", position: { x: 492, y: 72 } }),
        { ...neighbor, position: { x: 4416, y: 100 } },
      ]),
    );
    await agent.command("undo", args);
    expect(store.getCanvas().canvas).toEqual(original.canvas);
  });

  it("小灵布局贴合组框，推开邻居，重放和整轮撤销保留原坐标", async () => {
    const group = {
      id: "group",
      type: "group" as const,
      position: { x: 10000, y: 200 },
      width: 300,
      height: 200,
      data: { label: "分镜组" },
    };
    const left = { ...node("left"), parentId: group.id, position: { x: 48, y: 72 } };
    const right = { ...node("right", "audio"), parentId: group.id, position: { x: 90, y: 30 } };
    const neighbor = { ...node("neighbor"), position: { x: 10650, y: 250 } };
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: [group, left, right, neighbor].map((node) => ({ type: "putNode", node })),
    });
    const original = store.getCanvas();
    const args = {
      project: agent.key(store),
      runId: "layout-run",
      id: "arrange-id",
      input: { groupId: "group", layout: "row" },
    };
    const first = await agent.command("arrange", args);
    expect(await agent.command("arrange", args)).toEqual(first);
    const arranged = store.getCanvas();
    expect(arranged.canvasRevision).toBe(original.canvasRevision + 1);
    expect(arranged.canvas.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "group",
          position: { x: 10000, y: 158 },
          width: 1116,
          height: 444,
        }),
        expect.objectContaining({ id: "left", position: { x: 48, y: 72 } }),
        expect.objectContaining({ id: "right", position: { x: 744, y: 72 } }),
        expect.objectContaining({ id: "neighbor", position: { x: 11236, y: 250 } }),
      ]),
    );
    await agent.command("undo", args);
    expect(store.getCanvas().canvas).toEqual(original.canvas);
  });

  it("小灵补写失败文本、清空正文并撤销", async () => {
    const failed = node("script", "script", "初稿");
    await edit({
      ...failed,
      data: {
        ...failed.data,
        textStatus: "error",
        textError: "旧错误",
        textFailureTask: { id: "legacy-job", reference: "legacy-ref" },
      },
    } as typeof failed);
    const original = store.getCanvas().canvas;
    const run = { project: agent.key(store), runId: "rewrite-script" };
    await agent.command("apply-ops", {
      ...run,
      id: "create",
      input: {
        ops: [
          { op: "create_node", kind: "script", label: "有正文", prompt: "## 来信" },
          { op: "create_node", kind: "script", label: "空白正文", prompt: "  " },
          { op: "create_node", kind: "script", label: "尚未填写" },
        ],
      },
    });
    const dataFor = (label: string) =>
      store.getCanvas().canvas.nodes.find((item) => item.data.label === label)?.data;
    expect(dataFor("有正文")).toMatchObject({ text: "## 来信", textStatus: "done" });
    expect(dataFor("空白正文")).toMatchObject({ text: "  ", textStatus: "idle" });
    expect(dataFor("尚未填写")).toMatchObject({ text: "" });
    expect(dataFor("尚未填写")).not.toHaveProperty("textStatus");
    const read = () => agent.command("read", { ...run, input: { nodeIds: [failed.id] } });
    await read();
    const write = (id: string, prompt: string) =>
      agent.command("apply-ops", {
        ...run,
        id,
        input: { ops: [{ op: "update_node", id: failed.id, prompt }] },
      });
    await write("rewrite", "## 第一集");
    const rewritten = await read();
    expect(rewritten).toMatchObject({
      nodes: [{ data: { text: "## 第一集", textStatus: "done" } }],
    });
    expect(rewritten).not.toHaveProperty("nodes.0.data.textError");
    expect(dataFor(failed.data.label)).not.toHaveProperty("textFailureTask");
    await write("clear", "");
    expect(await read()).toMatchObject({ nodes: [{ data: { text: "", textStatus: "idle" } }] });
    await agent.command("undo", run);
    expect(store.getCanvas().canvas).toEqual(original);
  });

  it("精读长正文保留完整字符并返回全部关联边", async () => {
    const prefix = "信".repeat(3999) + "📬";
    const letter = node("letter", "script", prefix + "到达");
    const targets = Array.from({ length: 101 }, (_, index) => node(`target-${index}`));
    await edit(letter, ...targets);
    const edges = targets.map((target) => ({
      id: `to-${target.id}`,
      source: letter.id,
      target: target.id,
    }));
    await store.applyCanvasOperations({
      operationId: randomUUID(),
      expectedCanvasRevision: store.getCanvas().canvasRevision,
      operations: edges.map((edge) => ({ type: "putEdge", edge })),
    });
    const result = await agent.command("read", {
      project: agent.key(store),
      runId: "letter-detail",
      input: { nodeIds: [letter.id] },
    });
    expect(result).toMatchObject({
      nodes: [{ id: letter.id, data: { text: prefix + "…" } }],
      edges,
    });
  });

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
    ).rejects.toMatchObject({
      code: "CANVAS_OPERATION_INVALID",
      message: expect.stringContaining("missing"),
    });
    await expect(agent.command("edit-preview", { ...args, input })).rejects.toMatchObject({
      code: "AGENT_READ_REQUIRED",
    });
    await expect(
      agent.command("read", { ...args, input: { nodeIds: Array(51).fill("sample") } }),
    ).rejects.toMatchObject({ code: "CANVAS_OPERATION_INVALID" });
    await expect(
      agent.command("read", {
        ...args,
        input: { nodeIds: ["second", ...Array(49).fill("sample")] },
      }),
    ).resolves.toMatchObject({ nodes: [{ id: "second" }, { id: "sample" }] });
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
