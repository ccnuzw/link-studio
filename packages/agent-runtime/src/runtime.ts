import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AttachmentCheck } from "../upstream/src/attachments.ts";
import { AgentEngine, type PublishedEvent } from "../upstream/src/engine/engine.ts";
import { WATCH_KEEP_MS } from "../upstream/src/engine/watch.ts";
import { createIdCodec } from "../upstream/src/ids.ts";
import type { ApprovalDecision } from "../upstream/src/platform-client.ts";
import { type AgentStore, openStore } from "../upstream/src/store/store.ts";
import { addCanvasGateway } from "./canvas-gateway.ts";
import { createLocalGateway } from "./gateway.ts";
import { createSettingsGateway, type SettingsBridge } from "./settings-gateway.ts";
import { type AgentScope, LocalAgentError, SpikeTargets, scopeKey } from "./targets.ts";

export interface RuntimeOptions {
  directory: string;
  modelBridgeUrl: string;
  onEvent?: (event: PublishedEvent) => void;
  onEffectCommitted?: () => void;
  serviceToken?: string;
  settings?: SettingsBridge;
}

export class LocalAgentRuntime {
  private constructor(
    readonly engine: AgentEngine,
    readonly store: AgentStore,
    readonly targets: SpikeTargets,
    private readonly openedCanvases: Set<string>,
    private readonly desktopSettings: boolean,
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
      const platform = options.settings
        ? addCanvasGateway(
            createSettingsGateway(targets, options.settings),
            targets,
            options.settings,
          )
        : createLocalGateway({ targets, onEffectCommitted: options.onEffectCommitted });
      if (options.settings) await reconcileSettingsDecisions(store, platform, options.settings);
      const openedCanvases = new Set<string>();
      const engine = await AgentEngine.open({
        store,
        storage: await openNodeSqliteStorage(database, { prefix: "pi_" }),
        platform,
        baseUrl: bridge.origin,
        serviceToken: options.serviceToken ?? "local-m0-not-a-provider-credential",
        codec: createIdCodec("link-studio-m0"),
        onEvent: options.onEvent,
        autoTitle: false,
        activitySummary: false,
        leaseIntervalMs: 1000,
        ...(options.settings
          ? {
              watchGraceMs: 500,
              watchPollMs: 2000,
              modelDiagnostics: true,
              canvasWatchEnabled: (id: string) => openedCanvases.has(id),
            }
          : {}),
      });
      return new LocalAgentRuntime(
        engine,
        store,
        targets,
        openedCanvases,
        Boolean(options.settings),
      );
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

  async start(
    scope: AgentScope,
    sessionId: string,
    message: string,
    modelKey = "local-spike",
    pageContext?: unknown,
    selection?: string[],
    attachments?: AttachmentCheck[],
    allowWebResearch = false,
  ) {
    this.targets.assertSession(sessionId, scope);
    if (
      scope.kind === "canvas" &&
      this.desktopSettings &&
      !this.openedCanvases.has(this.targets.scope(scope).engineId)
    )
      throw new LocalAgentError("AGENT_SCOPE_DENIED");
    if (message.length > 32 * 1024) throw new LocalAgentError("AGENT_ARGUMENT_LIMIT");
    return this.engine.startRun({
      userId: "1",
      sessionId,
      message,
      modelKey,
      mode: scope.kind === "settings" ? "admin" : "all",
      pageContext,
      selection,
      attachments,
      allowWebResearch: scope.kind === "canvas" && allowWebResearch,
    });
  }

  sessions(scope: AgentScope) {
    const { engineId } = this.targets.scope(scope);
    return this.store.listSessions("1", engineId).map(({ id, title }) => ({ id, title }));
  }

  async recoverCanvas(scope: AgentScope, bridge: SettingsBridge) {
    if (scope.kind !== "canvas") throw new LocalAgentError("AGENT_SCOPE_DENIED");
    const { engineId } = this.targets.scope(scope);
    this.openedCanvases.add(engineId);
    const approvals = this.store.recentGenerationApprovals(
      "1",
      engineId,
      Date.now() - WATCH_KEEP_MS,
    );
    for (const approval of approvals) {
      this.targets.assertSession(approval.sessionId, scope);
      if (approval.status !== "executed") {
        const decision = approval.decision as ApprovalDecision;
        const result = await bridge("canvas:generate-receipt", {
          project: scope.projectId,
          runId: approval.runId,
          id: approval.id,
          selected: (decision.items ?? [])
            .filter(({ approve }) => approve)
            .map(({ index }) => index),
          input: approval.payload,
        });
        const status = result ? "executed" : "failed";
        const evidence = result ?? { code: "JOB_APPROVAL_INTERRUPTED" };
        appendRecoveryEvent(
          this.store,
          approval.sessionId,
          approval.runId,
          "approval.decided",
          `approval:${approval.id}`,
          {
            kind: approval.kind,
            status,
            result: evidence,
          },
        );
        this.store.updateApprovalIf(approval.id, [approval.status], { status, result: evidence });
      }
      await this.engine.recoverGenerationWatch("1", approval.id);
      const run = this.store.getRun("1", approval.runId);
      if (
        run.status === "waiting_approval" &&
        !this.store.listApprovals(run.id).some(({ status }) => status === "pending")
      ) {
        appendRecoveryEvent(this.store, run.sessionId, run.id, "run.status", `run:${run.id}`, {
          status: "interrupted",
        });
        this.store.updateRunIf(run.id, [run.status], { status: "interrupted" });
      }
    }
  }

  async closeCanvas(scope: AgentScope) {
    if (scope.kind !== "canvas") throw new LocalAgentError("AGENT_SCOPE_DENIED");
    const { engineId } = this.targets.scope(scope);
    this.openedCanvases.delete(engineId);
    const active = this.store.activeRun(engineId, "1");
    if (active) {
      try {
        await this.engine.cancel("1", active.id);
      } catch (error) {
        if (this.store.activeRun(engineId, "1")?.id === active.id) throw error;
      }
    }
  }

  page(scope: AgentScope, sessionId: string, after: number) {
    this.targets.assertSession(sessionId, scope);
    const { canvasId, title } = this.store.getSession("1", sessionId);
    const active = this.store.activeRun(canvasId, "1");
    const activeRun = active?.sessionId === sessionId ? active.id : undefined;
    return {
      title,
      events: this.store
        .listEvents(sessionId, after, 100)
        .map(({ seq, runId, type, payload }) => ({ seq, runId, type, payload })),
      activeRun,
      activeStatus: activeRun ? active?.status : undefined,
      otherActiveSession: active && !activeRun ? active.sessionId : undefined,
      approvals: activeRun
        ? this.store
            .listApprovals(activeRun)
            .filter(({ status }) => status === "pending")
            .map(({ id, kind, status, payload }) => ({ id, kind, status, payload }))
        : [],
    };
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

  diagnostics(scope: AgentScope, sessionId: string, runId: string) {
    this.targets.assertSession(sessionId, scope);
    const run = this.store.getRun("1", runId);
    if (run.sessionId !== sessionId) throw new LocalAgentError("AGENT_SCOPE_DENIED");
    const metadataEvents = new Set([
      "run.status",
      "run.usage",
      "tool.start",
      "tool.end",
      "approval.created",
      "approval.decided",
      "context.compacted",
      "activity.summarized",
      "watch.updated",
      "tasks.settled",
      "model.call",
      "model.usage",
    ]);
    const events = this.store.listRunEvents(runId).flatMap(({ seq, type, createdAt, payload }) => {
      if (!metadataEvents.has(type)) return [];
      const data = (payload ?? {}) as Record<string, unknown>;
      const purpose = ["main", "summary", "title", "activity"].find(
        (item) => item === data.purpose,
      );
      return [
        {
          seq,
          type,
          timestamp: createdAt,
          ...((type === "tool.start" || type === "tool.end") &&
            (data.name === "web_search" || data.name === "web_fetch") && { tool: data.name }),
          ...(typeof data.is_error === "boolean" && { failed: data.is_error }),
          ...(typeof data.failed === "boolean" && { failed: data.failed }),
          ...(typeof data.context_tokens === "number" && { contextTokens: data.context_tokens }),
          ...(typeof data.spent_credits === "number" && { spentCredits: data.spent_credits }),
          ...(typeof data.input_tokens === "number" && { inputTokens: data.input_tokens }),
          ...(typeof data.output_tokens === "number" && { outputTokens: data.output_tokens }),
          ...(purpose && { purpose }),
          ...(type === "model.call" &&
            typeof data.status === "number" && { httpStatus: data.status }),
        },
      ];
    });
    const { id, status, steps, contextTokens, spentCredits, createdAt, endedAt } = run;
    return {
      schemaVersion: 1,
      run: { id, status, steps, contextTokens, spentCredits, createdAt, endedAt },
      events,
    };
  }

  async close() {
    await this.engine.close();
    this.store.close();
    this.targets.close();
  }
}

async function reconcileSettingsDecisions(
  store: AgentStore,
  platform: ReturnType<typeof createSettingsGateway>,
  bridge: SettingsBridge,
) {
  for (const run of store.listRunsByStatus([
    "running",
    "interrupted",
    "waiting_approval",
    "canceled",
  ])) {
    if (run.mode !== "admin" || run.canvasId !== "0" || run.userId !== "1") continue;
    const session = store.getSession("1", run.sessionId);
    const context = {
      run_id: run.id,
      user_id: "1",
      session_id: session.id,
      canvas_id: "0",
      mode: "admin",
      model_key: session.modelKey,
    };
    const approvals = store.listApprovals(run.id);
    for (const approval of approvals) {
      const kind = approval.kind;
      if (kind !== "admin_change" && kind !== "admin_test_run" && kind !== "admin_secret") continue;
      const recoveredSecret =
        approval.status === "pending" &&
        kind === "admin_secret" &&
        (await bridge("hasSecretReceipt", {
          approvalId: approval.id,
          payload: approval.payload,
        })) === true;
      if (!recoveredSecret && !["approved", "partially_approved"].includes(approval.status))
        continue;
      const outcome = await platform.resolve(
        context,
        kind,
        approval.payload,
        recoveredSecret
          ? { decision: "approve", answer: "configured" }
          : (approval.decision as ApprovalDecision),
      );
      const result =
        kind === "admin_test_run"
          ? ((await bridge("approvedTest", {
              approvalId: approval.id,
              payload: approval.payload,
              recovery: true,
            })) as { tested?: true; code?: string })
          : undefined;
      const execution = result
        ? { status: result.tested ? "executed" : "failed", result }
        : await platform.execute(context, kind, approval.id, approval.toolCallId, outcome);
      const recoveryId = `approval:${approval.id}`;
      appendRecoveryEvent(store, session.id, run.id, "approval.decided", recoveryId, {
        kind,
        status: execution.status,
        result: execution.result,
      });
      store.updateApprovalIf(approval.id, [approval.status], {
        status: execution.status,
        result: execution.result ?? {},
        ...(recoveredSecret && { decision: outcome.decision, decidedAt: Date.now() }),
      });
    }
    if (
      run.status === "waiting_approval" &&
      !store.listApprovals(run.id).some(({ status }) => status === "pending")
    ) {
      appendRecoveryEvent(store, session.id, run.id, "run.status", `run:${run.id}`, {
        status: "interrupted",
      });
      store.updateRunIf(run.id, [run.status], { status: "interrupted" });
    }
  }
}

function appendRecoveryEvent(
  store: AgentStore,
  sessionId: string,
  runId: string,
  type: string,
  recoveryId: string,
  payload: object,
) {
  let after = 0;
  for (;;) {
    const events = store.listEvents(sessionId, after, 200);
    if (
      events.some(
        (event) =>
          event.type === type &&
          (event.payload as { recoveryId?: string } | null)?.recoveryId === recoveryId,
      )
    )
      return;
    const last = events.at(-1);
    if (!last || events.length < 200) break;
    after = last.seq;
  }
  store.appendEvent(sessionId, runId, type, { ...payload, recoveryId });
}
