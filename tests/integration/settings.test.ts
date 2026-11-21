import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalAgentRuntime } from "../../packages/agent-runtime/src/runtime";
import { SpikeTargets } from "../../packages/agent-runtime/src/targets";
import { openStore } from "../../packages/agent-runtime/upstream/src/store/store";
import type { SettingsInput } from "../../packages/link-studio-core/src/settings-api";
import { ProviderError } from "../../packages/provider-runtime/src/runner";
import { SettingsAgent } from "../../src/main/settings/agent";
import { probeAgentStream } from "../../src/main/settings/agent-model";
import { openProviderResponse } from "../../src/main/settings/network";
import { SettingsRegistry } from "../../src/main/settings/registry";
import { cleanModelStream } from "../../src/main/settings/stream";

const scope = { kind: "settings" } as const;

async function withRegistry(
  action: (fixture: {
    registry: SettingsRegistry;
    directory: string;
    input: SettingsInput<"save">;
    failEncryption: () => void;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-settings-test-"));
  let fail = false;
  let registry: SettingsRegistry | undefined;
  try {
    registry = await SettingsRegistry.open(
      directory,
      "resources/provider-plugins",
      "out/provider-runtime/runner",
      {
        encrypt: (secret) => {
          if (fail) throw new ProviderError("PROVIDER_SECRET_STORE_UNAVAILABLE");
          return Buffer.from(secret).reverse();
        },
        decrypt: (value) => Buffer.from(value).reverse().toString(),
      },
    );
    const plugin = registry.list().plugins.find(({ key }) => key === "openai");
    if (!plugin) throw new Error("内置文本插件不存在");
    await action({
      registry,
      directory,
      failEncryption: () => {
        fail = true;
      },
      input: {
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-credential",
        fields: {
          label: "测试文本",
          endpoint: "http://127.0.0.1:1",
          allowLocal: true,
          model: "fixture",
          agentEnabled: true,
          channel: { api: "chat_completions" },
        },
      },
    });
  } finally {
    registry?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("S3 设置持久化", () => {
  it("渠道模型排序校验完整列表，遇到过期修订时回滚全部修改", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "排序测试渠道",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      registry.modelImport({
        id: channel.id,
        expectedRevision: channel.revision,
        models: ["one", "two"],
      });
      const [first, second] = registry.list().providers;
      if (!first || !second) throw new Error("缺少测试模型");
      const configured = registry.modelSave({
        id: first.id,
        expectedRevision: first.revision,
        channelId: channel.id,
        channelRevision: channel.revision,
        pluginHash: input.pluginHash,
        upstreamModel: first.model,
        enabled: false,
        settings: {},
        config: { kind: "text", name: "文本模型", description: "", sort: first.pendingSort ?? 100 },
      });
      const pendingEntry = { id: second.id, expectedRevision: second.revision };
      const order = [pendingEntry, { id: configured.id, expectedRevision: configured.revision }];
      const reorder = { channelId: channel.id, channelRevision: channel.revision, order };
      const original = registry.list().providers;
      const conflict = expect.objectContaining({ code: "SETTINGS_REVISION_CONFLICT" });
      expect(() =>
        registry.modelReorder({ ...reorder, order: [pendingEntry, pendingEntry] }),
      ).toThrowError(conflict);
      expect(() =>
        registry.modelReorder({
          ...reorder,
          order: [pendingEntry, { id: configured.id, expectedRevision: first.revision }],
        }),
      ).toThrowError(conflict);
      expect(registry.list().providers).toEqual(original);
      expect(registry.modelReorder(reorder)).toEqual({ saved: true });
      expect(registry.provider(second.id)).toMatchObject({
        pending: true,
        pendingSort: 0,
        revision: second.revision + 1,
      });
      expect(registry.provider(configured.id)).toMatchObject({
        config: { sort: 1 },
        revision: configured.revision,
      });
    });
  });

  it("Vertex 模型只在凭证请求地址变化时要求确认", async () => {
    await withRegistry(async ({ registry }) => {
      const vertex = registry.list().plugins.find(({ key }) => key === "vertex-ai");
      if (!vertex) throw new Error("缺少 Vertex 适配器");
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "Vertex 测试渠道",
          endpoint: "https://us-central1-aiplatform.googleapis.com",
          allowLocal: false,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      const save: SettingsInput<"modelSave"> = {
        channelId: channel.id,
        channelRevision: channel.revision,
        expectedRevision: 0,
        upstreamModel: "veo-3.0-generate-001",
        pluginHash: vertex.hash,
        enabled: false,
        config: { kind: "video", name: "Veo", description: "", sort: 100 },
        settings: {},
      };
      const model = registry.modelSave(save);
      const changeAddress = {
        ...save,
        id: model.id,
        expectedRevision: model.revision,
        settings: { tokenUrl: "https://vertex-proxy.example/token" },
      };
      expect(() => registry.modelSave(changeAddress)).toThrowError(
        expect.objectContaining({ code: "MODEL_ENDPOINT_APPROVAL_REQUIRED" }),
      );
      expect(registry.provider(model.id)).toEqual(model);
      const updated = registry.modelSave({ ...changeAddress, approve: true });
      expect(updated.channel).toMatchObject(changeAddress.settings);
      expect(
        registry.modelSave({
          ...changeAddress,
          expectedRevision: updated.revision,
          config: { ...save.config, name: "Veo (更新名称)" },
        }).config?.name,
      ).toBe("Veo (更新名称)");
    });
  });

  it("仅在自定义鉴权连接保存第二凭证，供共享模型使用并随连接变更失效", async () => {
    await withRegistry(async ({ registry, input }) => {
      const plugin = registry.list().plugins.find(({ key }) => key === "kling");
      if (!plugin) throw new Error("Missing Kling adapter");
      const secretKey = "fixture-secondary-key";
      expect(() => registry.save({ ...input, secretKey })).toThrowError(
        expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }),
      );
      const fields = { ...input.fields, agentEnabled: false, channel: {} };
      const profile = registry.save({ ...input, pluginHash: plugin.hash, fields, secretKey });
      registry.addModels({
        id: profile.id,
        expectedRevision: profile.revision,
        models: ["second-model"],
        agentEnabled: false,
      });
      const child = registry
        .list()
        .providers.find(({ connectionId }) => connectionId === profile.id);
      if (!child) throw new Error("Missing shared model");
      expect(child.hasSecretKey).toBe(true);
      expect(registry.binding(child.id, child.revision).secretKey).toBe(secretKey);
      expect(JSON.stringify(registry.list())).not.toContain(secretKey);
      expect(registry.redact(secretKey)).toBe("[凭证已移除]");
      const update = {
        ...input,
        pluginHash: plugin.hash,
        fields,
        id: profile.id,
        secret: undefined,
      };
      const cleared = registry.save({
        ...update,
        expectedRevision: profile.revision,
        clearSecretKey: true,
      });
      expect(cleared).toMatchObject({ hasSecret: true, hasSecretKey: false });
      expect(registry.provider(child.id)).toMatchObject({
        revision: child.revision + 1,
        hasSecretKey: false,
      });
      const restored = registry.save({ ...update, expectedRevision: cleared.revision, secretKey });
      const moved = registry.save({
        ...update,
        expectedRevision: restored.revision,
        secret: input.secret,
        fields: { ...fields, endpoint: "http://127.0.0.1:2" },
      });
      expect(registry.binding(moved.id, moved.revision).secretKey).toBeUndefined();
      expect(registry.provider(child.id).hasSecretKey).toBe(false);
    });
  });

  it("保存 Vertex 服务账号 JSON，允许可选字段并保护已授权的令牌地址", async () => {
    await withRegistry(async ({ registry, input }) => {
      const plugin = registry.list().plugins.find(({ key }) => key === "vertex-ai");
      if (!plugin) throw new Error("Missing Vertex adapter");
      const secret = JSON.stringify(
        { client_email: "fixture@example.test", private_key: "fixture", project_id: "fixture" },
        null,
        2,
      );
      const fields = {
        ...input.fields,
        agentEnabled: false,
        channel: { storageUri: "gs://fixture/" },
      };
      const profile = registry.save({ ...input, fields, secret, pluginHash: plugin.hash });
      expect(profile.channel).toMatchObject({
        tokenUrl: "https://oauth2.googleapis.com/token",
        location: "us-central1",
      });
      expect(registry.binding(profile.id, profile.revision).secret).toBe(secret);
      expect(JSON.stringify(registry.list().providers)).not.toContain("private_key");
      expect(() =>
        registry.save({
          ...input,
          pluginHash: plugin.hash,
          id: profile.id,
          expectedRevision: profile.revision,
          approve: false,
          fields: {
            ...fields,
            channel: { ...fields.channel, tokenUrl: "https://oauth.example.test/token" },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "PLUGIN_APPROVAL_REQUIRED" }));
    });
  });

  it("分配版本号并按共享连接升级模型，拒绝不兼容配置与删除引用", async () => {
    await withRegistry(async ({ registry, input }) => {
      const plugin = registry.list().plugins.find(({ hash }) => hash === input.pluginHash);
      if (!plugin) throw new Error("Missing source adapter");
      const first = await registry.draft(`${plugin.source}\n// First revision`);
      const second = await registry.draft(`${plugin.source}\n// Second revision`);
      expect([first.version, second.version]).toEqual(["1.2.2", "1.2.3"]);
      await expect(registry.draft(first.source)).rejects.toMatchObject({
        code: "PLUGIN_VERSION_DUPLICATE",
      });
      const parent = registry.save(input);
      await registry.addModels({
        id: parent.id,
        expectedRevision: parent.revision,
        models: ["extra"],
        agentEnabled: true,
      });
      const incompatible = await registry.draft(
        `${plugin.source}\nmodule.exports.meta.channelSettings.extra = {type:'string', label:'Extra', required:true};`,
      );
      expect(
        registry.pluginUpgrade({ fromHash: plugin.hash, toHash: incompatible.hash, approve: true }),
      ).toMatchObject({
        upgraded: 0,
        failed: [{ code: "PROVIDER_CONFIG_INVALID" }, { code: "PROVIDER_CONFIG_INVALID" }],
      });
      expect(
        registry.pluginUpgrade({ fromHash: plugin.hash, toHash: second.hash, approve: true }),
      ).toEqual({ upgraded: 2, failed: [] });
      const providers = registry.list().providers;
      expect(providers).toHaveLength(2);
      for (const entry of providers) {
        expect(entry).toMatchObject({
          pluginHash: second.hash,
          revision: 2,
          enabled: true,
          hasSecret: true,
        });
        expect(registry.binding(entry.id, entry.revision).secret).toBe(input.secret);
      }
      expect(providers.find(({ model }) => model === "extra")?.connectionId).toBe(parent.id);
      expect(() => registry.pluginRemove({ hash: second.hash })).toThrowError(
        expect.objectContaining({ code: "PLUGIN_REFERENCED" }),
      );
    });
  });

  it("接受 128 KiB 以上的源码，按 UTF-8 字节限制到 512 KiB", async () => {
    await withRegistry(async ({ registry }) => {
      const plugin = registry.list().plugins.find(({ key }) => key === "openai");
      if (!plugin) throw new Error("Missing source adapter");
      await expect(
        registry.draft(`${plugin.source}\n/*${"字".repeat(50000)}*/`),
      ).resolves.toMatchObject({ key: "openai" });
      await expect(
        registry.draft(`${plugin.source}\n/*${"字".repeat(180000)}*/`),
      ).rejects.toMatchObject({ code: "PLUGIN_SOURCE_LIMIT" });
    });
  });

  it("保存失败保留凭证，插件 hash 改变需要重新授权，旧修订不能覆盖新值", async () => {
    await withRegistry(async ({ registry, input, failEncryption }) => {
      const profile = registry.save(input);
      const base = { ...input, id: profile.id, expectedRevision: profile.revision, approve: false };
      failEncryption();
      expect(() => registry.save({ ...base, secret: "new-fixture" })).toThrowError(
        expect.objectContaining({ code: "PROVIDER_SECRET_STORE_UNAVAILABLE" }),
      );
      expect(registry.binding(profile.id, profile.revision).secret).toBe(input.secret);
      const plugin = registry.list().plugins.find(({ hash }) => hash === profile.pluginHash);
      const draft = await registry.draft(`${plugin?.source}\n`, "agent");
      const changed = {
        ...base,
        pluginHash: draft.hash,
        secret: undefined,
        fields: { ...input.fields, agentEnabled: false },
      };
      expect(() => registry.save(changed)).toThrowError(
        expect.objectContaining({ code: "PLUGIN_APPROVAL_REQUIRED" }),
      );
      const replaced = registry.save({ ...changed, approve: true });
      expect(replaced.hasSecret).toBe(false);
      expect(() => registry.save(base)).toThrowError(
        expect.objectContaining({ code: "SETTINGS_REVISION_CONFLICT" }),
      );
    });
  });

  it("已提交配置与凭证的决定在 Worker 启动时对账，外部试跑未知不补发", async () => {
    await withRegistry(async ({ registry, directory, input }) => {
      const profile = registry.save(input);
      const store = openStore(join(directory, "agent.sqlite"));
      const targets = new SpikeTargets(join(directory, "targets.sqlite"));
      const sessions: string[] = [];
      const approvalIds: string[] = [];
      try {
        targets.scope(scope);
        const create = (kind: string, payload: unknown, pending = false) => {
          const session = store.createSession({
            userId: "1",
            canvasId: "0",
            title: kind,
            mode: "admin",
            modelKey: "fixture",
          });
          sessions.push(session.id);
          targets.bindSession(session.id, scope);
          const run = store.createRun({
            sessionId: session.id,
            canvasId: "0",
            userId: "1",
            status: pending ? "waiting_approval" : "interrupted",
            mode: "admin",
          });
          const approval = store.createApproval({
            runId: run.id,
            sessionId: session.id,
            canvasId: "0",
            userId: "1",
            kind,
            toolCallId: kind,
            payload,
            quoteCredits: 0,
            status: "pending",
            expiresAt: Date.now() + 60000,
          });
          approvalIds.push(approval.id);
          if (!pending)
            store.updateApprovalIf(approval.id, ["pending"], {
              status: "approved",
              decision: { decision: "approve", items: [{ index: 0, approve: true }] },
            });
          return approval.id;
        };
        const proposal = await registry.preview({
          providerId: profile.id,
          expectedRevision: profile.revision,
          changes: [{ field: "label", value: "已提交" }],
        });
        const changeId = create("admin_change", proposal);
        expect(await registry.applyProposal(changeId, proposal, [0])).toEqual({
          applied: 1,
          skipped: 0,
        });
        await expect(registry.applyProposal("stale-fixture", proposal, [0])).rejects.toMatchObject({
          code: "SETTINGS_REVISION_CONFLICT",
        });
        const secret = registry.actionTarget("admin_secret", profile.id, 2);
        registry.configureSecret(
          create("admin_secret", secret, true),
          secret,
          "replacement-fixture",
        );
        create("admin_test_run", registry.actionTarget("admin_test_run", profile.id, 3));
      } finally {
        store.close();
        targets.close();
      }

      for (const _boot of [1, 2]) {
        const runtime = await LocalAgentRuntime.open({
          directory,
          modelBridgeUrl: "http://127.0.0.1:1",
          settings: async (command, raw) => {
            const args = raw as {
              approvalId: string;
              payload: unknown;
              selected: number[];
              recovery: boolean;
            };
            if (command === "apply")
              return registry.applyProposal(
                args.approvalId,
                args.payload as Awaited<ReturnType<SettingsRegistry["preview"]>>,
                args.selected,
              );
            const target = args.payload as ReturnType<SettingsRegistry["actionTarget"]>;
            if (command === "hasSecretReceipt")
              return registry.hasSecretReceipt(args.approvalId, target);
            if (command === "approvedTest") {
              expect(args.recovery).toBe(true);
              return registry.approvedTest(args.approvalId, target, args.recovery);
            }
            throw new Error(`Unexpected command ${command}`);
          },
        });
        try {
          expect(approvalIds.map((id) => runtime.store.getApproval("1", id).result)).toEqual([
            { applied: 1, skipped: 0 },
            { configured: true },
            { code: "PROVIDER_OUTCOME_UNKNOWN" },
          ]);
          for (const sessionId of sessions)
            expect(
              runtime
                .page(scope, sessionId, 0)
                .events.filter(({ type }) => type === "approval.decided"),
            ).toHaveLength(1);
          expect(registry.provider(profile.id)).toMatchObject({
            revision: 3,
            label: "已提交",
            hasSecret: true,
          });
        } finally {
          await runtime.close();
        }
      }
    });
  });
});

it("S3 生产传输拒绝跨源、重定向和未授权的本机端点", async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.writeHead(302, { location: "/never-follow" }).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("回环测试服务未监听");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const request = {
      method: "GET",
      url: endpoint,
      headers: {},
      timeoutMs: 1000,
      responseType: "text",
    } as const;
    const blocked = { code: "PROVIDER_ENDPOINT_BLOCKED" };
    await expect(openProviderResponse(endpoint, false, request)).rejects.toMatchObject(blocked);
    await expect(
      openProviderResponse(endpoint, true, { ...request, url: "http://127.0.0.1:1" }),
    ).rejects.toMatchObject(blocked);
    expect(hits).toBe(0);
    await expect(openProviderResponse(endpoint, true, request)).rejects.toMatchObject(blocked);
    expect(hits).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("小灵连接检测区分认证、限流、非流式响应、断流与超时", async () => {
  await withRegistry(async ({ registry, input }) => {
    let mode = "auth";
    const server = createServer((_request, response) => {
      switch (mode) {
        case "auth":
          response.writeHead(401).end();
          break;
        case "rate":
          response.writeHead(429).end();
          break;
        case "json":
          response.writeHead(200, { "content-type": "application/json" }).end("{}");
          break;
        case "truncated":
          response
            .writeHead(200, { "content-type": "text/event-stream" })
            .end(
              'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_partial"}}\n\n' +
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"OK"}\n\n',
            );
          break;
        default:
          response.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务未监听");
      const profile = registry.save({
        ...input,
        fields: {
          ...input.fields,
          endpoint: `http://127.0.0.1:${address.port}`,
          channel: { api: "responses" },
        },
      });
      const binding = registry.binding(profile.id, profile.revision);
      const redactor = registry.redactor();
      for (const [scenario, code] of [
        ["auth", "AGENT_TEST_AUTH_FAILED"],
        ["rate", "AGENT_TEST_RATE_LIMITED"],
        ["json", "AGENT_TEST_INVALID_STREAM"],
        ["truncated", "AGENT_TEST_INVALID_STREAM"],
        ["timeout", "AGENT_TEST_TIMEOUT"],
      ]) {
        mode = scenario ?? "";
        await expect(
          probeAgentStream(binding, redactor, mode === "timeout" ? 100 : 3000),
        ).rejects.toMatchObject({ code });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("小灵检测拒绝重入和陈旧修订，不创建会话", async () => {
  await withRegistry(async ({ registry, directory, input }) => {
    let finish!: () => void;
    const arrived = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hits = 0;
    const server = createServer(async (_request, response) => {
      hits++;
      finish();
      await waiting;
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务未监听");
      const profile = registry.save({
        ...input,
        fields: { ...input.fields, endpoint: `http://127.0.0.1:${address.port}` },
      });
      const agent = new SettingsAgent(registry, directory, "unused");
      const target = { id: profile.id, expectedRevision: profile.revision };
      const pending = expect(agent.testConnection(target)).rejects.toMatchObject({
        code: "SETTINGS_REVISION_CONFLICT",
      });
      await arrived;
      await expect(agent.testConnection(target)).rejects.toMatchObject({ code: "AGENT_TEST_BUSY" });
      registry.disable(target);
      release();
      await pending;
      await expect(agent.testConnection(target)).rejects.toMatchObject({
        code: "SETTINGS_REVISION_CONFLICT",
      });
      expect(hits).toBe(1);
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("Responses 文本和工具参数增量中的跨帧凭证会被移除", () => {
  const secret = "fixture-secret-value";
  const clean = cleanModelStream(
    {
      secrets: [secret],
      redact: (value) => value.replaceAll(secret, "[凭证已移除]"),
    },
    true,
  );
  for (const type of ["response.output_text.delta", "response.function_call_arguments.delta"]) {
    const event = (delta: string) => `data: ${JSON.stringify({ type, output_index: 0, delta })}`;
    expect(clean(event("fixture-secret"))).not.toContain("fixture-secret");
    expect(clean(event("-value"))).toContain("[凭证已移除]");
  }
});
