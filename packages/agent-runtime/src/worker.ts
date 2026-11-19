import { parentPort, workerData } from "node:worker_threads";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { ApprovalDecision } from "../upstream/src/platform-client.ts";
import { LocalAgentRuntime, type RuntimeOptions } from "./runtime.ts";
import { type AgentScope, LocalAgentError } from "./targets.ts";

const port = parentPort;
if (!port) throw new Error("Agent runtime requires a Worker");
let runtime: LocalAgentRuntime;

async function initialize() {
  const options = workerData as RuntimeOptions & { crashAfterEffect?: boolean };
  runtime = await LocalAgentRuntime.open({
    ...options,
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
    case "create":
      return runtime.createSession(scope);
    case "start":
      return runtime.start(scope, sessionId, String(args.message));
    case "state":
      return runtime.state(scope, sessionId);
    case "idle":
      await runtime.engine.idle();
      return null;
    case "decide":
      return runtime.decide(scope, String(args.approvalId), args.decision as ApprovalDecision);
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
  async (message: { id: string; command: string; args: Record<string, unknown> }) => {
    try {
      const result = await dispatch(message.command, message.args);
      port.postMessage({ id: message.id, result });
      if (message.command === "close") port.close();
    } catch (error) {
      port.postMessage({
        id: message.id,
        error: error instanceof LocalAgentError ? error.code : "AGENT_RUNTIME_FAILED",
      });
    }
  },
);
initialize().catch(() => {
  port.postMessage({ error: "AGENT_INITIALIZATION_FAILED" });
  port.close();
});
