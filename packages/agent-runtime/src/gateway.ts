import type {
  ApprovalExecution,
  Platform,
  RunContext,
  ToolDecl,
} from "../upstream/src/platform-client.ts";
import { PlatformError } from "../upstream/src/platform-client.ts";
import { digest, LocalAgentError, type SpikeTargets } from "./targets.ts";

export interface GatewayOptions {
  targets: SpikeTargets;
  onEffectCommitted?: () => void;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
  return value as Record<string, unknown>;
}

function tools(settings: boolean): ToolDecl[] {
  return [
    { name: settings ? "admin_query" : "canvas_get_state", scriptable: true },
    { name: settings ? "admin_propose_changes" : "canvas_apply_ops", scriptable: !settings },
  ].map((tool) => ({
    ...tool,
    label: tool.name,
    verb: settings ? "配置" : "画布",
    description: `M0 本地 ${tool.name}`,
    executor: "server",
    parameters: {
      type: "object",
      properties: {
        expectedRevision: { type: "integer" },
        value: {},
      },
      additionalProperties: false,
    },
  }));
}

export function createLocalGateway({ targets, onEffectCommitted }: GatewayOptions): Platform {
  const scopeOf = (context: RunContext) => {
    if (context.user_id !== "1") throw new LocalAgentError("AGENT_SCOPE_DENIED");
    const scope = targets.assertContext(context.session_id, context.canvas_id);
    if ((scope === "settings") !== (context.mode === "admin"))
      throw new LocalAgentError("AGENT_SCOPE_DENIED");
    return scope;
  };
  const unsupported = async (): Promise<never> => {
    throw new PlatformError("M0 capability unavailable", 400, 10001);
  };
  return {
    encodeId: async (id) => id,
    models: async () => [
      { key: "local-spike", name: "本地验证模型", vision: false, context_window: 32768 },
    ],
    checkCanvas: async () => undefined,
    checkMessage: async (_user, _canvas, _message, selection) => selection ?? [],
    checkAttachments: unsupported,
    undo: unsupported,
    prepare: async (context, request) => {
      const scope = scopeOf(context);
      const declarations = tools(scope === "settings");
      return {
        model: { name: "小灵验证", context_window: 32768, max_tokens: 2048, vision: false },
        system_prompt: `你是灵可的创作助手小灵。当前 scope=${scope}。只能使用此 scope 声明的工具。M0 合成目标不是真实项目。`,
        tools: declarations,
        first_message: request?.message,
        harness: {
          prompt_version: 1,
          tools_hash: digest(declarations),
          build_sha: "m0-05",
          key: digest({ scope, declarations }),
        },
      };
    },
    tool: async (context, name, raw, options) => {
      const scope = scopeOf(context);
      const read = scope === "settings" ? "admin_query" : "canvas_get_state";
      if (name === read)
        return { content: JSON.stringify(targets.read(scope)), is_error: false, terminate: false };
      if (scope === "settings" || name !== "canvas_apply_ops")
        throw new PlatformError("工具不属于当前 scope", 403, 10001);
      const args = object(raw);
      if (!Number.isSafeInteger(args.expectedRevision) || !options.idemKey)
        throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
      const result = targets.apply(
        scope,
        options.idemKey,
        Number(args.expectedRevision),
        args.value,
      );
      onEffectCommitted?.();
      return { content: JSON.stringify(result), is_error: false, terminate: false };
    },
    propose: async (context, kind, raw, _signal, idemKey) => {
      const scope = scopeOf(context);
      if (scope !== "settings" || kind !== "admin_change" || !idemKey)
        throw new LocalAgentError("AGENT_SCOPE_DENIED");
      const args = object(raw);
      const payload = targets.propose(scope, idemKey, args.value);
      return {
        is_error: false,
        payload,
        quote_credits: 0,
        content: "等待用户批准本地配置变更",
        terminate: true,
      };
    },
    resolve: async (context, kind, payload, decision) => {
      const scope = scopeOf(context);
      if (scope !== "settings" || kind !== "admin_change")
        throw new LocalAgentError("AGENT_SCOPE_DENIED");
      return {
        status: decision.decision === "approve" ? "approved" : "rejected",
        decision: { decision: decision.decision },
        quote_credits: 0,
        admin_change: payload,
      };
    },
    execute: async (
      context,
      kind,
      approvalId,
      _toolCallId,
      outcome,
    ): Promise<ApprovalExecution> => {
      const scope = scopeOf(context);
      if (scope !== "settings" || kind !== "admin_change")
        throw new LocalAgentError("AGENT_SCOPE_DENIED");
      if (outcome.status === "rejected") return { status: "rejected", outcome_text: "用户拒绝" };
      const result = targets.execute(scope, `approval:${approvalId}`, outcome.admin_change);
      onEffectCommitted?.();
      return { status: "executed", result, outcome_text: "本地验证配置已提交" };
    },
    usage: async () => ({ spent_credits: 0, context_tokens: 0 }),
    pushEvents: async () => undefined,
    taskStates: unsupported,
    endRun: async () => null,
  };
}
