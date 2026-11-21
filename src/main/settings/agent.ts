import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Value } from "@sinclair/typebox/value";
import { AgentWorkerClient } from "../../../packages/agent-runtime/src/client.ts";
import type { PublishedEvent } from "../../../packages/agent-runtime/upstream/src/engine/engine.ts";
import type { CanvasAgentAction } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import type {
  SettingsApproval,
  SettingsInput,
  SettingsValues,
} from "../../../packages/link-studio-core/src/settings-api.ts";
import { settingsRequests } from "../../../packages/link-studio-core/src/settings-api.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import { modelApi, openAgentStream, probeAgentStream } from "./agent-model.ts";
import { readAgentReference } from "./agent-reference.ts";
import { queryAgentWeb } from "./agent-web.ts";
import type { SettingsRegistry } from "./registry.ts";

const scope = { kind: "settings" } as const;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function json(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4 * 1024 * 1024) throw new ProviderError("AGENT_ARGUMENT_LIMIT");
    chunks.push(chunk);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export class SettingsAgent {
  private readonly decisionLocks = new Set<string>();
  private readonly probeLocks = new Set<string>();
  private readonly partial = new Map<string, { runId: string; text: string }>();
  private readonly token = randomBytes(32).toString("hex");
  private readonly server = createServer(
    (request, response) => void this.modelRequest(request, response),
  );
  private worker?: Promise<AgentWorkerClient>;
  private readonly canvasRecovery = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: SettingsRegistry,
    private readonly directory: string,
    private readonly workerPath: string,
    private readonly canvas?: (command: string, args: unknown) => Promise<unknown>,
  ) {}

  private onEvent(event: PublishedEvent) {
    if (event.type === "message.delta") {
      const previous = this.partial.get(event.sessionId);
      const text = object(event.payload).text;
      if (typeof text === "string")
        this.partial.set(event.sessionId, {
          runId: event.runId,
          text: `${previous?.runId === event.runId ? previous.text : ""}${text}`.slice(-32768),
        });
    } else if (event.type === "message.done" || event.type === "run.status")
      this.partial.delete(event.sessionId);
  }

  private loadModel(key: unknown) {
    if (typeof key !== "string") throw new ProviderError("AGENT_MODEL_UNAVAILABLE");
    const match = /^([a-f0-9-]{36}):(\d+)$/.exec(key);
    if (!match?.[1]) throw new ProviderError("AGENT_MODEL_UNAVAILABLE");
    const current = this.registry.provider(match[1]);
    if (!current.enabled || current.revision !== Number(match[2]))
      throw new ProviderError("AGENT_MODEL_BINDING_STALE");
    const model = this.registry.binding(match[1], Number(match[2]));
    if (!model.profile.agentEnabled || model.origin !== "builtin" || model.plugin.key !== "openai")
      throw new ProviderError("AGENT_MODEL_INCOMPATIBLE");
    return model;
  }

  async testConnection({ id, expectedRevision }: SettingsInput<"agentTestConnection">) {
    if (this.probeLocks.has(id)) throw new ProviderError("AGENT_TEST_BUSY");
    const binding = this.registry.binding(id, expectedRevision);
    if (binding.origin !== "builtin" || binding.plugin.key !== "openai")
      throw new ProviderError("AGENT_MODEL_INCOMPATIBLE");
    this.probeLocks.add(id);
    try {
      const result = await probeAgentStream(binding, this.registry.redactor());
      const current = this.registry.provider(id);
      if (!current.enabled || current.revision !== expectedRevision)
        throw new ProviderError("SETTINGS_REVISION_CONFLICT");
      return result;
    } finally {
      this.probeLocks.delete(id);
    }
  }

  private async bridge(command: string, args: unknown) {
    if (command === "canvas:web") {
      const request = object(args);
      if (!this.canvas) throw new ProviderError("AGENT_SCOPE_DENIED");
      await this.canvas("prepare", request);
      return queryAgentWeb(String(request.name), request.input, this.registry.redactor().redact);
    }
    if (command === "canvas:inspect" && !this.loadModel(object(args).modelKey).profile.agentVision)
      throw new ProviderError("AGENT_MODEL_CAPABILITY_UNSUPPORTED");
    if (command.startsWith("canvas:") && this.canvas) return this.canvas(command.slice(7), args);
    const input = object(args);
    switch (command) {
      case "models":
        return this.registry
          .list()
          .providers.filter(
            (profile) =>
              profile.enabled &&
              profile.channelEnabled !== false &&
              profile.agentEnabled &&
              profile.hasSecret,
          )
          .map(({ id, revision, label, model, config }) => ({
            key: `${id}:${revision}`,
            name: `${config?.name ?? model} · ${label}`,
            vision: false,
            context_window: config?.contextWindow ?? 32768,
          }));
      case "model": {
        const { profile } = this.loadModel(input.key);
        return {
          name: profile.model,
          context_window: profile.config?.contextWindow ?? 32768,
          max_tokens: profile.config?.maxOutputTokens ?? 2048,
          api: modelApi(profile),
          vision: input.canvas === true && profile.agentVision === true,
        };
      }
      case "query": {
        const { providers, plugins } = this.registry.list();
        return {
          providers,
          plugins: plugins.map(({ hash, key, name, version, kind, fields }) => ({
            hash,
            key,
            name,
            version,
            kind,
            fields,
          })),
        };
      }
      case "preview":
        return this.registry.preview(args);
      case "pluginCheck":
        if (!Value.Check(settingsRequests.pluginCheck, args))
          throw new ProviderError("PLUGIN_SAMPLE_INVALID");
        return this.registry.pluginCheck(args);
      case "actionTarget":
        if (
          (input.kind !== "admin_secret" && input.kind !== "admin_test_run") ||
          typeof input.id !== "string" ||
          !Number.isSafeInteger(input.expectedRevision)
        )
          throw new ProviderError("SETTINGS_PROPOSAL_INVALID");
        return this.registry.actionTarget(input.kind, input.id, Number(input.expectedRevision));
      case "approvedTest":
        return this.registry.approvedTest(
          String(input.approvalId),
          input.payload as ReturnType<SettingsRegistry["actionTarget"]>,
          input.recovery === true,
        );
      case "hasSecretReceipt":
        return this.registry.hasSecretReceipt(
          String(input.approvalId),
          input.payload as ReturnType<SettingsRegistry["actionTarget"]>,
        );
      case "apply":
        return this.registry.applyProposal(
          String(input.approvalId),
          input.payload as Awaited<ReturnType<SettingsRegistry["preview"]>>,
          input.selected as number[],
        );
      default:
        throw new ProviderError("AGENT_SCOPE_DENIED");
    }
  }

  async runCanvas(projectId: string, action: CanvasAgentAction) {
    if (action.method === "previewReference") {
      try {
        const result = await readAgentReference(action.url, this.registry.redactor().redact);
        return { fingerprint: result.asset_id, text: result.text ?? "" };
      } catch {
        throw new ProviderError("AGENT_REFERENCE_UNAVAILABLE");
      }
    }
    const scope = { kind: "canvas", projectId } as const;
    const client = await this.client();
    await this.recoverCanvas(projectId, client);
    const { method, ...input } = action;
    switch (method) {
      case "list":
        return client.request<SettingsValues["agentList"]>("sessions", { scope });
      case "create":
        return client.request<SettingsValues["agentCreate"]>("create", { scope });
      case "state": {
        const state = await client.request<SettingsValues["agentState"]>("page", {
          ...input,
          scope,
        });
        return {
          ...state,
          partial: state.activeRun ? this.partial.get(action.sessionId) : undefined,
        };
      }
      case "send": {
        const message = this.registry.redact(action.message.trim());
        if (!message.trim()) throw new ProviderError("AGENT_ARGUMENT_INVALID");
        if (action.runId) {
          if (action.referenceURL || action.attachmentAssetIds?.length || action.allowWebResearch)
            throw new ProviderError("AGENT_REFERENCE_UNAVAILABLE");
          await client.request("interject", { ...input, scope, message });
        } else {
          const provider = this.registry.provider(action.providerId);
          if (Array.from(message).length > (provider.config?.promptLimit ?? 24000))
            throw new ProviderError("AGENT_ARGUMENT_INVALID");
          const modelKey = `${provider.id}:${provider.revision}`;
          this.loadModel(modelKey);
          let attachments: Awaited<ReturnType<typeof readAgentReference>>[] = [];
          if (action.referenceURL) {
            await client.request("page", { scope, sessionId: action.sessionId, after: 0 });
            try {
              attachments = [
                await readAgentReference(action.referenceURL, this.registry.redactor().redact),
              ];
            } catch {
              throw new ProviderError("AGENT_REFERENCE_UNAVAILABLE");
            }
            if (
              action.referenceFingerprint &&
              attachments[0]?.asset_id !== action.referenceFingerprint
            )
              throw new ProviderError("AGENT_REFERENCE_CHANGED");
          }
          if (action.attachmentAssetIds?.length) {
            const checked = await this.bridge("canvas:attachments", {
              project: projectId,
              assetIds: action.attachmentAssetIds,
            });
            if (!Array.isArray(checked)) throw new ProviderError("AGENT_MEDIA_UNAVAILABLE");
            attachments = [...attachments, ...checked] as typeof attachments;
          }
          await client.request("start", { ...input, scope, message, modelKey, attachments });
        }
        return { sent: true } as const;
      }
      case "decide": {
        await client.request("decide", {
          scope,
          sessionId: action.sessionId,
          approvalId: action.approvalId,
          decision: {
            decision: action.selected.length ? "approve" : "reject",
            items: action.selected.map((index) => ({ index, approve: true })),
          },
        });
        return { decided: true } as const;
      }
      case "answer":
        return this.withDecisionLock(action.sessionId, async () => {
          await client.request("canvasAnswer", {
            scope,
            sessionId: action.sessionId,
            approvalId: action.approvalId,
            decision: action.answers
              ? {
                  decision: "approve",
                  answers: action.answers.map(({ id, value }) => ({
                    id,
                    value: Array.isArray(value)
                      ? value.map((item) => this.registry.redact(item.trim()))
                      : this.registry.redact(value.trim()),
                  })),
                }
              : { decision: "reject" },
          });
          return { decided: true } as const;
        });
      case "stop":
        await client.request("cancel", { ...input, scope });
        return { stopped: true } as const;
      case "continue":
        await client.request("resume", { ...input, scope });
        return { continued: true } as const;
      case "undo":
        return client.request<
          import("../../../packages/link-studio-core/src/canvas-agent.ts").CanvasUndoResult
        >("canvasUndo", { ...input, scope });
      case "exportDiagnostics":
        return client.request("diagnostics", { ...input, scope });
    }
  }

  async openCanvas(projectId: string) {
    await this.recoverCanvas(projectId, await this.client());
  }

  private recoverCanvas(projectId: string, client: AgentWorkerClient) {
    let pending = this.canvasRecovery.get(projectId);
    if (!pending) {
      pending = client
        .request("recoverCanvas", { scope: { kind: "canvas", projectId } })
        .catch((error: unknown) => {
          if (this.canvasRecovery.get(projectId) === pending) this.canvasRecovery.delete(projectId);
          throw error;
        });
      this.canvasRecovery.set(projectId, pending);
    }
    return pending;
  }

  async closeCanvas(projectId: string) {
    this.canvasRecovery.delete(projectId);
    const client = await this.worker;
    if (client) await client.request("closeCanvas", { scope: { kind: "canvas", projectId } });
  }

  private async modelRequest(request: IncomingMessage, response: ServerResponse) {
    if (
      request.method !== "POST" ||
      (request.url !== "/internal/platform/v1/model/chat/completions" &&
        request.url !== "/internal/platform/v1/model/responses") ||
      request.headers["x-agent-service-token"] !== this.token
    ) {
      response.writeHead(403).end();
      return;
    }
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    try {
      const payload = await json(request);
      const binding = this.loadModel(payload.model);
      if (request.url.endsWith("/responses") !== (modelApi(binding.profile) === "openai-responses"))
        throw new ProviderError("AGENT_MODEL_INCOMPATIBLE");
      const stream = await openAgentStream(
        binding,
        payload,
        this.registry.redactor(),
        (binding.profile.config?.timeoutSeconds ?? 90) * 1000,
        controller.signal,
      );
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for await (const frame of stream)
        if (!response.write(frame)) await once(response, "drain", { signal: controller.signal });
      response.end();
    } catch {
      if (!response.headersSent)
        response
          .writeHead(502)
          .end(JSON.stringify({ error: { message: "模型请求失败，请核对设置与运行状态" } }));
      else response.destroy();
    }
  }

  private client() {
    this.worker ??= (async () => {
      if (!this.server.listening) {
        this.server.listen({ host: "127.0.0.1", port: 0 });
        await once(this.server, "listening");
        this.server.unref();
      }
      const address = this.server.address();
      if (!address || typeof address === "string")
        throw new ProviderError("AGENT_MODEL_UNAVAILABLE");
      const client = await AgentWorkerClient.open({
        workerPath: this.workerPath,
        directory: this.directory,
        modelBridgeUrl: `http://127.0.0.1:${address.port}`,
        serviceToken: this.token,
        onEvent: (event) => this.onEvent(event),
        settings: (command, args) => this.bridge(command, args),
      });
      client.worker.once("exit", () => {
        this.worker = undefined;
        this.partial.clear();
        this.canvasRecovery.clear();
      });
      return client;
    })().catch((error: unknown) => {
      this.worker = undefined;
      throw error;
    });
    return this.worker;
  }

  async run<
    K extends
      | "agentList"
      | "agentCreate"
      | "agentState"
      | "agentSend"
      | "agentStop"
      | "agentContinue"
      | "agentConfigureSecret"
      | "agentDecide",
  >(method: K, input: SettingsInput<K>) {
    const client = await this.client();
    switch (method) {
      case "agentList":
        return client.request<SettingsValues["agentList"]>("sessions", { scope });
      case "agentCreate":
        return client.request<SettingsValues["agentCreate"]>("create", { scope });
      case "agentState": {
        const { sessionId, after } = input as SettingsInput<"agentState">;
        const state = await client.request<SettingsValues["agentState"]>("page", {
          scope,
          sessionId,
          after,
        });
        return { ...state, partial: state.activeRun ? this.partial.get(sessionId) : undefined };
      }
      case "agentSend": {
        const { sessionId, providerId, contextId, message, runId } =
          input as SettingsInput<"agentSend">;
        const clean = this.registry.redact(message.trim());
        if (!clean) throw new ProviderError("AGENT_ARGUMENT_INVALID");
        if (runId) await client.request("interject", { scope, sessionId, runId, message: clean });
        else {
          const provider = this.registry.provider(providerId);
          if (Array.from(clean).length > (provider.config?.promptLimit ?? 24000))
            throw new ProviderError("AGENT_ARGUMENT_INVALID");
          const modelKey = `${provider.id}:${provider.revision}`;
          this.loadModel(modelKey);
          const pageContext = contextId
            ? { route: "providers", provider: this.registry.provider(contextId) }
            : undefined;
          await client.request("start", {
            scope,
            sessionId,
            message: clean,
            modelKey,
            pageContext,
          });
        }
        return { sent: true };
      }
      case "agentStop": {
        const { sessionId, runId } = input as SettingsInput<"agentStop">;
        return this.withDecisionLock(sessionId, async () => {
          await client.request("cancel", { scope, sessionId, runId });
          return { stopped: true };
        });
      }
      case "agentContinue":
        await client.request("resume", { scope, ...input });
        return { continued: true };
      case "agentConfigureSecret": {
        const { sessionId, approvalId, secret } = input as SettingsInput<"agentConfigureSecret">;
        return this.withDecisionLock(sessionId, async () => {
          const approval = await client.request<SettingsApproval>("pendingApproval", {
            scope,
            sessionId,
            approvalId,
          });
          if (approval.kind !== "admin_secret") throw new ProviderError("AGENT_APPROVAL_STALE");
          this.registry.configureSecret(
            approvalId,
            approval.payload as ReturnType<SettingsRegistry["actionTarget"]>,
            secret,
          );
          await client.request("decide", {
            scope,
            sessionId,
            approvalId,
            decision: { decision: "approve", answer: "configured" },
          });
          return { decided: true };
        });
      }
      case "agentDecide": {
        const { sessionId, approvalId, selected, confirmTest } =
          input as SettingsInput<"agentDecide">;
        return this.withDecisionLock(sessionId, async () => {
          const { kind } = await client.request<SettingsApproval>("pendingApproval", {
            scope,
            sessionId,
            approvalId,
          });
          if (
            (selected.length && kind !== "admin_change") ||
            (confirmTest && kind !== "admin_test_run")
          )
            throw new ProviderError("SETTINGS_PROPOSAL_INVALID");
          await client.request("decide", {
            scope,
            sessionId,
            approvalId,
            decision: {
              decision: selected.length || confirmTest ? "approve" : "reject",
              items: selected.map((index) => ({ index, approve: true })),
            },
          });
          return { decided: true };
        });
      }
    }
  }

  private async withDecisionLock<Result>(sessionId: string, action: () => Promise<Result>) {
    if (this.decisionLocks.has(sessionId)) throw new ProviderError("AGENT_RUN_BUSY");
    this.decisionLocks.add(sessionId);
    try {
      return await action();
    } finally {
      this.decisionLocks.delete(sessionId);
    }
  }
}
