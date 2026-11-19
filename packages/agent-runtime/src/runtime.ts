import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentEngine, type PublishedEvent } from "../upstream/src/engine/engine.ts";
import { createIdCodec } from "../upstream/src/ids.ts";
import type { ApprovalDecision } from "../upstream/src/platform-client.ts";
import { type AgentStore, openStore } from "../upstream/src/store/store.ts";
import { createLocalGateway } from "./gateway.ts";
import { type AgentScope, LocalAgentError, SpikeTargets, scopeKey } from "./targets.ts";

export interface RuntimeOptions {
  directory: string;
  modelBridgeUrl: string;
  onEvent?: (event: PublishedEvent) => void;
  onEffectCommitted?: () => void;
}

export class LocalAgentRuntime {
  private constructor(
    readonly engine: AgentEngine,
    readonly store: AgentStore,
    readonly targets: SpikeTargets,
  ) {}

  static async open(options: RuntimeOptions) {
    const bridge = new URL(options.modelBridgeUrl);
    if (
      bridge.protocol !== "http:" ||
      bridge.hostname !== "127.0.0.1" ||
      bridge.username ||
      bridge.password
    )
      throw new LocalAgentError("AGENT_MODEL_BRIDGE_DENIED");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const database = join(options.directory, "agent.sqlite");
    const targets = new SpikeTargets(join(options.directory, "targets.sqlite"));
    const store = openStore(database);
    try {
      const engine = await AgentEngine.open({
        store,
        storage: await openNodeSqliteStorage(database, { prefix: "pi_" }),
        platform: createLocalGateway({ targets, onEffectCommitted: options.onEffectCommitted }),
        baseUrl: bridge.origin,
        serviceToken: "local-m0-not-a-provider-credential",
        codec: createIdCodec("link-studio-m0"),
        onEvent: options.onEvent,
        autoTitle: false,
        activitySummary: false,
        leaseIntervalMs: 1000,
      });
      return new LocalAgentRuntime(engine, store, targets);
    } catch (error) {
      store.close();
      targets.close();
      throw error;
    }
  }

  createSession(scope: AgentScope) {
    const mapped = this.targets.scope(scope);
    const session = this.store.createSession({
      userId: "1",
      canvasId: mapped.engineId,
      title: "新对话",
      mode: mapped.mode,
      modelKey: "local-spike",
    });
    this.targets.bindSession(session.id, scope);
    return { sessionId: session.id, scope: scopeKey(scope) };
  }

  async start(scope: AgentScope, sessionId: string, message: string) {
    this.targets.assertSession(sessionId, scope);
    if (message.length > 32 * 1024) throw new LocalAgentError("AGENT_ARGUMENT_LIMIT");
    return this.engine.startRun({
      userId: "1",
      sessionId,
      message,
      modelKey: "local-spike",
      mode: scope.kind === "settings" ? "admin" : "all",
    });
  }

  async decide(scope: AgentScope, approvalId: string, decision: ApprovalDecision) {
    const approval = this.store.getApproval("1", approvalId);
    this.targets.assertSession(approval.sessionId, scope);
    return this.engine.decide("1", approvalId, decision);
  }

  state(scope: AgentScope, sessionId: string) {
    this.targets.assertSession(sessionId, scope);
    return {
      events: this.store.listEvents(sessionId, 0, 1000),
      runs: this.store.listRunsUpdatedAfter(0, 1000).filter((run) => run.sessionId === sessionId),
      target: this.targets.read(scopeKey(scope)),
    };
  }

  async close() {
    await this.engine.close();
    this.store.close();
    this.targets.close();
  }
}
