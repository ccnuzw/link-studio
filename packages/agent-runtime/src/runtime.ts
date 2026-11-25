import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Value } from "@sinclair/typebox/value";
import {
  feedbackStatuses,
  RunFeedback,
  type RunRating,
} from "../../link-studio-core/src/agent-feedback.ts";
import type { AttachmentCheck } from "../upstream/src/attachments.ts";
import { AgentEngine, cleanTitle, type PublishedEvent } from "../upstream/src/engine/engine.ts";
import { Err } from "../upstream/src/engine/errors.ts";
import { WATCH_KEEP_MS } from "../upstream/src/engine/watch.ts";
import { createIdCodec } from "../upstream/src/ids.ts";
import type { ApprovalDecision } from "../upstream/src/platform-client.ts";
import { type AgentStore, openStore } from "../upstream/src/store/store.ts";
import type { Run } from "../upstream/src/store/types.ts";
import { addCanvasGateway } from "./canvas-gateway.ts";
import { addDramaGateway } from "./drama-gateway.ts";
import { createLocalGateway } from "./gateway.ts";
import { historyPage } from "./history-page.ts";
import { createSettingsGateway, type SettingsBridge } from "./settings-gateway.ts";
import { settingsHistory } from "./settings-history.ts";
import { type AgentScope, LocalAgentError, SpikeTargets, scopeKey } from "./targets.ts";

export interface RuntimeOptions {
  directory: string;
  modelBridgeUrl: string;
  onEvent?: (event: PublishedEvent) => void;
  onEffectCommitted?: () => void;
  serviceToken?: string;
  settings?: SettingsBridge;
}

const desktopIdCodec = createIdCodec("link-studio-m0");

async function readSteerImages(
  store: AgentStore,
  targets: SpikeTargets,
  bridge: SettingsBridge,
  run: Run,
  assetIds: string[],
) {
  const scope = targets.assertContext(run.sessionId, run.canvasId);
  if (!scope.startsWith("canvas:")) throw new LocalAgentError("AGENT_SCOPE_DENIED");
  const session = store.getSession(run.userId, run.sessionId);
  const model = (await bridge("model", { key: session.modelKey, canvas: true })) as {
    vision?: boolean;
  };
  if (!model.vision) throw new LocalAgentError("AGENT_MEDIA_UNAVAILABLE");
  const images = (await bridge("canvas:attachments", {
    project: scope.slice(7),
    assetIds,
  })) as AttachmentCheck[];
  if (
    !Array.isArray(images) ||
    images.length !== assetIds.length ||
    images.some((image) => !image.image?.data)
  )
    throw new LocalAgentError("AGENT_MEDIA_UNAVAILABLE");
  return images;
}

function eventApprovalId(type: string, payload: unknown) {
  if (type !== "approval.created" && type !== "approval.decided") return undefined;
  const data = payload as { id?: unknown; recoveryId?: unknown } | null;
  if (typeof data?.recoveryId === "string")
    return /^approval:([1-9]\d{0,19})$/.exec(data.recoveryId)?.[1];
  return typeof data?.id === "string" ? desktopIdCodec.decodeDecimal(data.id) : undefined;
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
        ? addDramaGateway(
            addCanvasGateway(
              createSettingsGateway(targets, options.settings, (resource, status) =>
                settingsHistory(database, resource, status),
              ),
              targets,
              options.settings,
            ),
            targets,
            options.settings,
          )
        : createLocalGateway({ targets, onEffectCommitted: options.onEffectCommitted });
      if (options.settings) await reconcileSettingsDecisions(store, platform, options.settings);
      const openedCanvases = new Set<string>();
      const settings = options.settings;
      const engine = await AgentEngine.open({
        store,
        storage: await openNodeSqliteStorage(database, { prefix: "pi_" }),
        platform,
        baseUrl: bridge.origin,
        serviceToken: options.serviceToken ?? "local-m0-not-a-provider-credential",
        codec: desktopIdCodec,
        onEvent: options.onEvent,
        autoTitle: Boolean(options.settings),
        activitySummary: Boolean(options.settings),
        leaseIntervalMs: 1000,
        ...(settings
          ? {
              watchGraceMs: 500,
              watchPollMs: 2000,
              modelDiagnostics: true,
              readSteerImages: (run: Run, ids: string[]) =>
                readSteerImages(store, targets, settings, run, ids),
              localModelUsage: true,
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
    if (
      scope.kind === "drama" &&
      (!this.desktopSettings || !this.openedCanvases.has(mapped.engineId))
    )
      throw new LocalAgentError("AGENT_SCOPE_DENIED");
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

  async interject(
    scope: AgentScope,
    sessionId: string,
    runId: string,
    message: string,
    assetIds: string[],
    bridge: SettingsBridge,
  ) {
    this.targets.assertSession(sessionId, scope);
    const run = this.store.getRun("1", runId);
    if (run.sessionId !== sessionId) throw new LocalAgentError("AGENT_SCOPE_DENIED");
    const images = assetIds.length
      ? await readSteerImages(this.store, this.targets, bridge, run, assetIds)
      : [];
    return this.engine.interject("1", runId, message, images);
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
    budgetCredits = 0,
  ) {
    this.targets.assertSession(sessionId, scope);
    if (
      scope.kind !== "settings" &&
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
      mode: this.targets.scope(scope).mode,
      pageContext,
      selection,
      attachments,
      allowWebResearch: scope.kind === "canvas" && allowWebResearch,
      budgetCredits,
    });
  }

  sessions(scope: AgentScope) {
    const { engineId } = this.targets.scope(scope);
    return this.store.listSessions("1", engineId).map(({ id, title }) => ({ id, title }));
  }

  renameSession(scope: AgentScope, sessionId: string, raw: unknown) {
    this.targets.assertSession(sessionId, scope);
    const title = typeof raw === "string" ? cleanTitle(raw, "") : "";
    if (!title) throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
    this.store.updateSession("1", sessionId, { title, titleSource: "user" });
    return { title };
  }

  async removeSession(scope: AgentScope, sessionId: string) {
    this.targets.assertSession(sessionId, scope);
    const { canvasId } = this.store.getSession("1", sessionId);
    const ensureIdle = () => {
      if (this.store.activeRun(canvasId, "1")?.sessionId === sessionId) throw Err.runActive();
    };
    ensureIdle();
    await this.engine.cancelWatches("1", sessionId);
    ensureIdle();
    this.store.deleteSession("1", sessionId);
    return { removed: true };
  }

  async recoverCanvas(scope: AgentScope, bridge: SettingsBridge) {
    if (scope.kind === "drama") {
      if (!this.desktopSettings) throw new LocalAgentError("AGENT_SCOPE_DENIED");
      await bridge("canvas:drama-prepare", { project: scope.projectId });
      const { engineId } = this.targets.scope(scope);
      const sessions = new Set(this.store.listSessions("1", engineId).map((item) => item.id));
      for (const run of this.store.listRunsByStatus([
        "interrupted",
        "waiting_approval",
        "canceled",
      ])) {
        if (
          run.mode !== "drama" ||
          run.userId !== "1" ||
          run.canvasId !== engineId ||
          !sessions.has(run.sessionId)
        )
          continue;
        this.targets.assertSession(run.sessionId, scope);
        for (const approval of this.store.listApprovals(run.id)) {
          if (
            approval.status !== "approved" ||
            ![
              "drama_update_episode",
              "drama_update_outline",
              "drama_update_segment",
              "drama_run_job",
            ].includes(approval.kind)
          )
            continue;
          const receipt = await bridge("canvas:drama-receipt", {
            project: scope.projectId,
            runId: run.id,
            id: approval.id,
            kind: approval.kind,
            input: approval.payload,
          });
          const status = receipt ? "executed" : "failed";
          const result = receipt ?? { code: "DRAMA_APPROVAL_INTERRUPTED" };
          appendRecoveryEvent(
            this.store,
            run.sessionId,
            run.id,
            "approval.decided",
            `approval:${approval.id}`,
            { kind: approval.kind, status, result },
          );
          this.store.updateApprovalIf(approval.id, ["approved"], { status, result });
        }
        if (
          run.status === "waiting_approval" &&
          !this.store.listApprovals(run.id).some((item) => item.status === "pending")
        ) {
          appendRecoveryEvent(this.store, run.sessionId, run.id, "run.status", `run:${run.id}`, {
            status: "interrupted",
          });
          this.store.updateRunIf(run.id, ["waiting_approval"], { status: "interrupted" });
        }
      }
      this.openedCanvases.add(engineId);
      return;
    }
    if (scope.kind !== "canvas") throw new LocalAgentError("AGENT_SCOPE_DENIED");
    const { engineId } = this.targets.scope(scope);
    this.openedCanvases.add(engineId);
    const approvals = this.store.generationApprovalsToRecover(
      "1",
      engineId,
      Date.now() - WATCH_KEEP_MS,
    );
    const visibleSessions = new Set(this.store.listSessions("1", engineId).map(({ id }) => id));
    for (const approval of approvals) {
      if (!visibleSessions.has(approval.sessionId)) continue;
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
            id: approval.id,
            kind: approval.kind,
            payload: approval.payload,
            decision: approval.decision,
            quote_credits: approval.quoteCredits,
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
    if (scope.kind === "settings") throw new LocalAgentError("AGENT_SCOPE_DENIED");
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

  async cancelWatches(scope: AgentScope, sessionId: string) {
    if (scope.kind !== "canvas") throw new LocalAgentError("AGENT_SCOPE_DENIED");
    this.targets.assertSession(sessionId, scope);
    return { canceled: (await this.engine.cancelWatches("1", sessionId)).length };
  }

  async page(scope: AgentScope, sessionId: string, after: number, before?: number) {
    this.targets.assertSession(sessionId, scope);
    const { canvasId, title } = this.store.getSession("1", sessionId);
    const active = this.store.activeRun(canvasId, "1");
    const activeRun = active?.sessionId === sessionId ? active.id : undefined;
    const page = before === undefined ? undefined : historyPage(this.store, sessionId, before);
    return {
      title,
      ...(scope.kind === "canvas" &&
        !before && { watches: await this.engine.watches("1", sessionId) }),
      hasMoreOlder: page?.hasMoreOlder,
      events: (page?.events ?? this.store.listEvents(sessionId, after, 100)).map(
        ({ seq, runId, type, payload, createdAt }) => ({
          seq,
          runId,
          type,
          payload,
          createdAt,
          approvalId: eventApprovalId(type, payload),
          ...(type === "run.status" &&
            feedbackStatuses.has(String((payload as { status?: string })?.status)) && {
              feedback: this.readFeedback(runId),
            }),
        }),
      ),
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

  private readFeedback(runId: string): RunRating | undefined {
    const stored = this.store.getFeedback(runId, "1");
    if (!stored) return undefined;
    const { rating, reasons, comment } = stored;
    const value = { rating, reasons, comment };
    return Value.Check(RunFeedback, value) ? value : undefined;
  }

  feedback(scope: AgentScope, sessionId: string, runId: string, value: RunRating | null) {
    this.targets.assertSession(sessionId, scope);
    const run = this.store.getRun("1", runId);
    if (run.sessionId !== sessionId || scope.kind === "drama")
      throw new LocalAgentError("AGENT_SCOPE_DENIED");
    if (!feedbackStatuses.has(run.status)) throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
    if (value) this.store.upsertFeedback({ runId, userId: "1", ...value });
    else this.store.deleteFeedback(runId, "1");
    return { saved: true };
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
            })) as { tested?: true; code?: string; duration_ms?: number })
          : undefined;
      const execution = result
        ? { status: result.tested ? "executed" : "failed", result }
        : await platform.execute(context, kind, approval.id, approval.toolCallId, outcome);
      const recoveryId = `approval:${approval.id}`;
      const display = approval.payload as { label?: unknown; revertOf?: unknown } | null;
      appendRecoveryEvent(store, session.id, run.id, "approval.decided", recoveryId, {
        kind,
        ...(kind === "admin_test_run" &&
          typeof display?.label === "string" && {
            payload: { label: display.label },
          }),
        ...(kind === "admin_change" &&
          typeof display?.revertOf === "string" && {
            payload: { revertOf: display.revertOf },
          }),
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
