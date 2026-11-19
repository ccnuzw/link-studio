import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkerClient } from "../../packages/agent-runtime/src/client";
import { createLocalGateway } from "../../packages/agent-runtime/src/gateway";
import { type AgentScope, SpikeTargets } from "../../packages/agent-runtime/src/targets";
import type { PublishedEvent } from "../../packages/agent-runtime/upstream/src/engine/engine";
import type { Approval, Run } from "../../packages/agent-runtime/upstream/src/store/types";
import { type FakeGoOptions, fakeGo } from "../../packages/agent-runtime/upstream/test/fake-go";

const clients: AgentWorkerClient[] = [];
const servers: Awaited<ReturnType<typeof fakeGo>>[] = [];
const directories: string[] = [];
const canvas: AgentScope = { kind: "canvas", projectId: "project-a" };
const settings: AgentScope = { kind: "settings" };
const workerPath =
  process.env.LINK_STUDIO_AGENT_WORKER ?? join(process.cwd(), "out/agent-runtime/worker.mjs");

async function environment(options: FakeGoOptions, directory?: string, crashAfterEffect = false) {
  const server = await fakeGo(options);
  servers.push(server);
  const path = directory ?? (await mkdtemp(join(tmpdir(), "link-studio-agent-")));
  if (!directory) directories.push(path);
  const events: PublishedEvent[] = [];
  const client = await AgentWorkerClient.open({
    workerPath,
    directory: path,
    modelBridgeUrl: server.url,
    crashAfterEffect,
    onEvent: (event) => events.push(event),
  });
  clients.push(client);
  return { client, path, server, events };
}

async function session(client: AgentWorkerClient, scope = canvas) {
  return client.request<{ sessionId: string }>("create", { scope });
}

interface State {
  events: { seq: number; type: string; payload: unknown }[];
  runs: Run[];
  target: { revision: number; value: unknown };
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("M0-05 local Agent Worker", () => {
  it("Pi 流式模型、tool calling、SQLite 事件与目标回执串联", async () => {
    const e = await environment({
      turns: [
        {
          tools: [
            {
              id: "write1",
              name: "canvas_apply_ops",
              args: { expectedRevision: 1, value: { title: "灵可" } },
            },
          ],
        },
        { text: "小灵已完成本地验证", charDelayMs: 30 },
      ],
    });
    const { sessionId } = await session(e.client);
    await e.client.request("start", { scope: canvas, sessionId, message: "修改合成画布" });
    await e.client.request("idle");
    const state = await e.client.request<State>("state", { scope: canvas, sessionId });
    expect(state.runs[0]?.status).toBe("succeeded");
    expect(state.target).toEqual({ revision: 2, value: { title: "灵可" } });
    expect(state.events.map((event) => event.type)).toContain("tool.end");
    expect(e.events.some((event) => event.type === "message.delta" && event.seq === 0)).toBe(true);
    expect(state.events.map((event) => event.seq)).toEqual(
      state.events.map((_, index) => index + 1),
    );
    expect(JSON.stringify(state)).not.toContain("local-m0-not-a-provider-credential");
    await e.client.close();
    const reopened = await AgentWorkerClient.open({
      workerPath,
      directory: e.path,
      modelBridgeUrl: e.server.url,
    });
    clients.push(reopened);
    expect(await reopened.request<State>("state", { scope: canvas, sessionId })).toEqual(state);
  });

  it("Pi code-mode 子工具经本地 Gateway 提交并记录内外层调用", async () => {
    const e = await environment({
      turns: [
        {
          tools: [
            {
              id: "script",
              name: "codemode",
              args: {
                code: 'return await tools.canvas_apply_ops({expectedRevision:1,value:{via:"codemode"}});',
              },
            },
          ],
        },
        { text: "脚本完成" },
      ],
    });
    const { sessionId } = await session(e.client);
    await e.client.request("start", { scope: canvas, sessionId, message: "用脚本修改" });
    await e.client.request("idle");
    const state = await e.client.request<State>("state", { scope: canvas, sessionId });
    expect(state.runs[0]?.status).toBe("succeeded");
    expect(state.target).toEqual({ revision: 2, value: { via: "codemode" } });
    expect(state.events.filter((event) => event.type === "tool.end")).toHaveLength(2);
  });

  it("Gateway 执行端拒绝伪造项目上下文与跨 scope 工具", async () => {
    const directory = await mkdtemp(join(tmpdir(), "link-studio-scope-"));
    directories.push(directory);
    const targets = new SpikeTargets(join(directory, "target.sqlite"));
    try {
      targets.scope(settings);
      targets.bindSession("settings-session", settings);
      const gateway = createLocalGateway({ targets });
      const context = {
        user_id: "1",
        run_id: "1",
        session_id: "settings-session",
        canvas_id: "0",
        mode: "admin",
      };
      await expect(gateway.prepare({ ...context, canvas_id: "99" })).rejects.toMatchObject({
        code: "AGENT_SCOPE_DENIED",
      });
      await expect(
        gateway.tool(context, "canvas_apply_ops", {}, { idemKey: "forged", toolCallId: "forged" }),
      ).rejects.toThrow();
      expect(targets.read("settings").revision).toBe(1);
    } finally {
      targets.close();
    }
  });

  it("settings/canvas 和不同项目隔离，错误 scope 不能读取或启动", async () => {
    const e = await environment({ turns: [{ text: "只读当前范围" }] });
    const { sessionId } = await session(e.client, settings);
    await expect(
      e.client.request("start", { scope: canvas, sessionId, message: "越界" }),
    ).rejects.toMatchObject({ code: "AGENT_SCOPE_DENIED" });
    await expect(
      e.client.request("state", { scope: { kind: "canvas", projectId: "project-b" }, sessionId }),
    ).rejects.toMatchObject({ code: "AGENT_SCOPE_DENIED" });
    await e.client.request("start", { scope: settings, sessionId, message: "检查设置" });
    await e.client.request("idle");
    const model = e.server.modelRequests[0];
    expect(JSON.stringify(model?.body)).toContain("admin_query");
    expect(JSON.stringify(model?.body)).not.toContain("canvas_apply_ops");
  });

  it("审批跨重启保留，批准后才写入，跨 scope 决定被拒绝", async () => {
    const e = await environment({
      turns: [
        {
          tools: [
            { id: "proposal", name: "admin_propose_changes", args: { value: { plugin: "draft" } } },
          ],
        },
        { text: "配置完成" },
      ],
    });
    const { sessionId } = await session(e.client, settings);
    const run = await e.client.request<Run>("start", {
      scope: settings,
      sessionId,
      message: "创建配置变更单",
    });
    await e.client.request("idle");
    const approvals = await e.client.request<Approval[]>("approvals", {
      scope: settings,
      sessionId,
      runId: run.id,
    });
    expect(approvals[0]?.status).toBe("pending");
    expect(
      (await e.client.request<State>("state", { scope: settings, sessionId })).target.revision,
    ).toBe(1);
    await e.client.close();
    const reopened = await AgentWorkerClient.open({
      workerPath,
      directory: e.path,
      modelBridgeUrl: e.server.url,
    });
    clients.push(reopened);
    await expect(
      reopened.request("decide", {
        scope: canvas,
        approvalId: approvals[0]?.id,
        decision: { decision: "approve" },
      }),
    ).rejects.toMatchObject({ code: "AGENT_SCOPE_DENIED" });
    await reopened.request("decide", {
      scope: settings,
      approvalId: approvals[0]?.id,
      decision: { decision: "approve" },
    });
    await reopened.request("idle");
    expect((await reopened.request<State>("state", { scope: settings, sessionId })).target).toEqual(
      { revision: 2, value: { plugin: "draft" } },
    );
  });

  it("同 scope 活跃运行互斥；等待模型时可插话和取消", async () => {
    const e = await environment({ turns: [{ text: "处理中", hang: true }] });
    const first = await session(e.client);
    const second = await session(e.client);
    const run = await e.client.request<Run>("start", {
      scope: canvas,
      sessionId: first.sessionId,
      message: "开始",
    });
    await expect(
      e.client.request("start", { scope: canvas, sessionId: second.sessionId, message: "并发" }),
    ).rejects.toThrow();
    await e.client.request("interject", {
      scope: canvas,
      sessionId: first.sessionId,
      runId: run.id,
      message: "先暂停",
    });
    await e.client.request("cancel", { scope: canvas, sessionId: first.sessionId, runId: run.id });
    await e.client.request("idle");
    const state = await e.client.request<State>("state", {
      scope: canvas,
      sessionId: first.sessionId,
    });
    expect(state.events.some((event) => event.type.startsWith("steer."))).toBe(true);
    expect(state.runs[0]?.status).toBe("canceled");
  });

  it("目标效果已提交而 Agent 未确认时 Worker 崩溃，恢复不重复写入", async () => {
    const e = await environment(
      {
        turns: [
          {
            tools: [
              {
                id: "durable-write",
                name: "canvas_apply_ops",
                args: { expectedRevision: 1, value: { node: "saved-once" } },
              },
            ],
          },
          { text: "恢复后完成" },
        ],
      },
      undefined,
      true,
    );
    const { sessionId } = await session(e.client);
    const exited = once(e.client.worker, "exit");
    await e.client
      .request("start", { scope: canvas, sessionId, message: "写入并模拟崩溃" })
      .catch(() => undefined);
    expect((await exited)[0]).toBe(73);
    const target = new SpikeTargets(join(e.path, "targets.sqlite"));
    expect(target.read("canvas:project-a").revision).toBe(2);
    target.close();
    const recovered = await AgentWorkerClient.open({
      workerPath,
      directory: e.path,
      modelBridgeUrl: e.server.url,
    });
    clients.push(recovered);
    await recovered.request("idle");
    const state = await recovered.request<State>("state", { scope: canvas, sessionId });
    expect(state.runs[0]?.status).toBe("succeeded");
    expect(state.target).toEqual({ revision: 2, value: { node: "saved-once" } });
    expect(state.events.filter((event) => event.type === "tool.end")).toHaveLength(1);
  });

  it("QuickJS Worker 无 Node/网络/文件 API，死循环与内存超限后仍可运行", async () => {
    const e = await environment({ turns: [] });
    const result = await e.client.request<{ ok: boolean; value: unknown }>("sandbox", {
      code: "return [typeof process,typeof require,typeof fetch,typeof setTimeout];",
    });
    expect(result).toMatchObject({
      ok: true,
      value: ["undefined", "undefined", "undefined", "undefined"],
    });
    expect(await e.client.request("sandbox", { code: "while(true){}" })).toMatchObject({
      ok: false,
      error: { kind: "timeout" },
    });
    expect(
      await e.client.request("sandbox", {
        code: "const list=[];while(true){list.push(new Array(100000).fill(7));}",
      }),
    ).toMatchObject({ ok: false });
    expect(await e.client.request("sandbox", { code: "return 42;" })).toMatchObject({
      ok: true,
      value: 42,
    });
  });

  it("目标事务回执验证 requestHash、revision，陈旧/伪造审批不能写入", async () => {
    const path = await mkdtemp(join(tmpdir(), "link-studio-target-"));
    directories.push(path);
    const target = new SpikeTargets(join(path, "target.sqlite"));
    target.scope(settings);
    const first = target.apply("settings", "op1", 1, { plugin: "v1" });
    expect(target.apply("settings", "op1", 1, { plugin: "v1" })).toEqual(first);
    expect(() => target.apply("settings", "op1", 1, { plugin: "v2" })).toThrow(
      "AGENT_OPERATION_ID_REUSED",
    );
    const proposal = target.propose("settings", "proposal1", { plugin: "approved" });
    expect(() =>
      target.execute("settings", "approval1", { ...proposal, value: { plugin: "tampered" } }),
    ).toThrow("AGENT_APPROVAL_INVALID");
    target.apply("settings", "manual-edit", 2, { plugin: "manual" });
    expect(() => target.execute("settings", "approval1", proposal)).toThrow(
      "AGENT_TARGET_CONFLICT",
    );
    target.close();
  });
});
