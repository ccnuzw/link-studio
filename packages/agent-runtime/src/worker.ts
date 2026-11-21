import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { AttachmentCheck } from "../upstream/src/attachments.ts";
import { AgentError } from "../upstream/src/engine/errors.ts";
import type { ApprovalDecision } from "../upstream/src/platform-client.ts";
import { LocalAgentRuntime, type RuntimeOptions } from "./runtime.ts";
import { type AgentScope, LocalAgentError } from "./targets.ts";

const port = parentPort;
if (!port) throw new Error("Agent runtime requires a Worker");
let runtime: LocalAgentRuntime;
const settingsCalls = new Map<
  string,
  {
    resolve: (result: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function settings(command: string, args: unknown) {
  const settingsId = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        settingsCalls.delete(settingsId);
        reject(new LocalAgentError("SETTINGS_ACTION_TIMEOUT"));
      },
      command === "approvedTest" ? 120000 : 12000,
    );
    settingsCalls.set(settingsId, { resolve, reject, timer });
    port?.postMessage({ settingsId, command, args });
  });
}

async function initialize() {
  const options = workerData as RuntimeOptions & {
    crashAfterEffect?: boolean;
    desktopSettings?: boolean;
  };
  runtime = await LocalAgentRuntime.open({
    ...options,
    settings: options.desktopSettings ? settings : undefined,
    onEvent: (event) => port?.postMessage({ event }),
    onEffectCommitted: () => {
      if (options.crashAfterEffect) process.exit(73);
    },
  });
  port?.postMessage({ ready: true });
}

async function dispatch(command: string, args: Record<string, unknown>) {
  const scope = args.scope as AgentScope;
  const sessionId = String(args.sessionId);
  switch (command) {
    case "recoverCanvas":
      return runtime.recoverCanvas(scope, settings);
    case "closeCanvas":
      return runtime.closeCanvas(scope);
    case "create":
      return runtime.createSession(scope);
    case "start":
      return runtime.start(
        scope,
        sessionId,
        String(args.message),
        typeof args.modelKey === "string" ? args.modelKey : undefined,
        args.pageContext,
        Array.isArray(args.selection) ? (args.selection as string[]) : undefined,
        Array.isArray(args.attachments) ? (args.attachments as AttachmentCheck[]) : undefined,
        args.allowWebResearch === true,
      );
    case "sessions":
      return runtime.sessions(scope);
    case "page":
      return runtime.page(scope, sessionId, Number(args.after));
    case "state":
      return runtime.state(scope, sessionId);
    case "diagnostics":
      return runtime.diagnostics(scope, sessionId, String(args.runId));
    case "idle":
      await runtime.engine.idle();
      return null;
    case "canvasAnswer":
    case "decide": {
      const approval = runtime.store.getApproval("1", String(args.approvalId));
      if (args.sessionId && approval.sessionId !== sessionId)
        throw new LocalAgentError("AGENT_SCOPE_DENIED");
      if (scope.kind === "canvas" && (command === "canvasAnswer") !== (approval.kind === "ask"))
        throw new LocalAgentError("AGENT_APPROVAL_STALE");
      if (command === "canvasAnswer" && scope.kind !== "canvas")
        throw new LocalAgentError("AGENT_SCOPE_DENIED");
      return runtime.decide(scope, String(args.approvalId), args.decision as ApprovalDecision);
    }
    case "pendingApproval": {
      runtime.targets.assertSession(sessionId, scope);
      const approval = runtime.store.getApproval("1", String(args.approvalId));
      const run = runtime.store.getRun("1", approval.runId);
      if (
        approval.sessionId !== sessionId ||
        approval.status !== "pending" ||
        approval.expiresAt <= Date.now() ||
        run.status !== "waiting_approval"
      )
        throw new LocalAgentError("AGENT_APPROVAL_STALE");
      return { kind: approval.kind, payload: approval.payload };
    }
    case "approvals": {
      runtime.targets.assertSession(sessionId, scope);
      const run = runtime.store.getRun("1", String(args.runId));
      if (run.sessionId !== sessionId) throw new LocalAgentError("AGENT_SCOPE_DENIED");
      return runtime.store.listApprovals(run.id);
    }
    case "interject": {
      runtime.targets.assertSession(sessionId, scope);
      const run = runtime.store.getRun("1", String(args.runId));
      if (run.sessionId !== sessionId) throw new LocalAgentError("AGENT_SCOPE_DENIED");
      return runtime.engine.interject("1", run.id, String(args.message));
    }
    case "cancel": {
      runtime.targets.assertSession(sessionId, scope);
      const run = runtime.store.getRun("1", String(args.runId));
      if (run.sessionId !== sessionId) throw new LocalAgentError("AGENT_SCOPE_DENIED");
      return runtime.engine.cancel("1", run.id);
    }
    case "canvasUndo": {
      runtime.targets.assertSession(sessionId, scope);
      if (scope.kind !== "canvas") throw new LocalAgentError("AGENT_SCOPE_DENIED");
      const run = runtime.store.getRun("1", String(args.runId));
      if (run.sessionId !== sessionId) throw new LocalAgentError("AGENT_SCOPE_DENIED");
      return settings("canvas:undo", { project: scope.projectId, runId: run.id });
    }
    case "resume": {
      runtime.targets.assertSession(sessionId, scope);
      const run = runtime.store.getRun("1", String(args.runId));
      if (run.sessionId !== sessionId) throw new LocalAgentError("AGENT_SCOPE_DENIED");
      if (
        scope.kind === "settings" &&
        (workerData as { desktopSettings?: boolean }).desktopSettings
      )
        await settings("model", { key: runtime.store.getSession("1", sessionId).modelKey });
      return runtime.engine.resume("1", run.id);
    }
    case "sandbox": {
      const sandbox = new CodemodeSandbox({ timeoutMs: 500, memoryLimitBytes: 16 * 1024 * 1024 });
      try {
        return await sandbox.execute(String(args.code));
      } finally {
        await sandbox.close();
      }
    }
    case "close":
      await runtime.close();
      return null;
    default:
      throw new LocalAgentError("AGENT_COMMAND_INVALID");
  }
}

port.on(
  "message",
  async (message: {
    id: string;
    command: string;
    args: Record<string, unknown>;
    settingsId?: string;
    error?: string;
    result?: unknown;
  }) => {
    if (message.settingsId) {
      const call = settingsCalls.get(message.settingsId);
      if (!call) return;
      settingsCalls.delete(message.settingsId);
      clearTimeout(call.timer);
      if (message.error) call.reject(new LocalAgentError(message.error));
      else call.resolve(message.result);
      return;
    }
    try {
      const result = await dispatch(message.command, message.args);
      port.postMessage({ id: message.id, result });
      if (message.command === "close") port.close();
    } catch (error) {
      const codes: Record<number, string> = {
        60001: "AGENT_RUN_BUSY",
        60002: "AGENT_MODEL_UNAVAILABLE",
        60003: "AGENT_RUN_STATE_INVALID",
        60004: "AGENT_APPROVAL_STALE",
        60011: "AGENT_SCOPE_DENIED",
        60012: "AGENT_SCOPE_DENIED",
        60013: "AGENT_APPROVAL_STALE",
      };
      port.postMessage({
        id: message.id,
        error:
          error instanceof LocalAgentError
            ? error.code
            : error instanceof AgentError
              ? (codes[error.code] ?? "AGENT_RUNTIME_FAILED")
              : "AGENT_RUNTIME_FAILED",
      });
    }
  },
);
initialize().catch(() => {
  port.postMessage({ error: "AGENT_INITIALIZATION_FAILED" });
  port.close();
});
