import { DramaEdits, DramaJobRequest, DramaRead } from "../../link-studio-core/src/drama.ts";
import type { Platform, RunContext, ToolDecl } from "../upstream/src/platform-client.ts";
import { askTool, proposeQuestions, questionResult, resolveQuestions } from "./questionnaire.ts";
import { presentationTools, type SettingsBridge } from "./settings-gateway.ts";
import { createSkillTools, skillTools } from "./skill-tools.ts";
import { digest, LocalAgentError, type SpikeTargets } from "./targets.ts";

const dramaTools: ToolDecl[] = [
  {
    name: "drama_run_job",
    label: "运行短剧任务",
    description:
      "申请运行短剧任务。先估价显示积分并审批，批准后提交，不等待任务结束；同项目同时只能有一个进行中任务（67004）。compose 合成一集采用视频，免费。",
    parameters: DramaJobRequest,
  },
  {
    name: "drama_read",
    label: "读取短剧",
    description:
      "overview 读取大纲、人物和分集摘要，episode 按 episode_no 读取单集全文，segments 按 episode_no 读片段列表和 ID。",
    parameters: DramaRead,
  },
  {
    name: "drama_update_outline",
    label: "修改大纲",
    description: "先读取 overview，再申请修改大纲或人物传记，等待用户审核。",
    parameters: DramaEdits.drama_update_outline,
  },
  {
    name: "drama_update_segment",
    label: "修改片段",
    description: "先读 segments，再按 segment_id 申请修改提示词或秒数，等待用户审核。",
    parameters: DramaEdits.drama_update_segment,
  },
  {
    name: "drama_update_episode",
    label: "修改分集",
    description: "先读取单集，再申请修改标题、梗概或剧本，等待用户审核。",
    parameters: DramaEdits.drama_update_episode,
  },
].map((tool) => ({
  ...tool,
  verb: tool.name === "drama_run_job" ? "生成" : tool.label,
  scriptable: tool.name === "drama_read",
  executor: "server",
}));

const tools = [...dramaTools, ...presentationTools, askTool, ...skillTools];

export function addDramaGateway(
  base: Platform,
  targets: SpikeTargets,
  bridge: SettingsBridge,
): Platform {
  const call = (context: RunContext, command: string, extras: object = {}) => {
    const scope = targets.assertContext(context.session_id, context.canvas_id);
    if (context.mode !== "drama" || context.user_id !== "1" || !scope.startsWith("drama:"))
      throw new LocalAgentError("AGENT_SCOPE_DENIED");
    return bridge(`canvas:drama-${command}`, {
      project: scope.slice(6),
      runId: context.run_id,
      ...extras,
    });
  };
  const skills = createSkillTools(call);
  const error = (cause: unknown) =>
    cause instanceof LocalAgentError ? cause.code : "AGENT_RUNTIME_FAILED";
  return {
    ...base,
    endRun: async (context, signal) => {
      skills.end(context);
      return base.endRun(context, signal);
    },
    prepare: async (context, request) => {
      if (context.mode !== "drama") return base.prepare(context, request);
      await call(context, "prepare");
      const model = (await bridge("model", { key: context.model_key, canvas: true })) as Awaited<
        ReturnType<Platform["prepare"]>
      >["model"];
      return {
        model,
        tools,
        system_prompt:
          "你是短剧助手小灵。只操作当前短剧。创作条件不清楚时用 ask_user 提问。先读取相关范围，再申请修改；用户批准前不能写入。没有片段或任务工具时明确说明限制。" +
          (await skills.catalog(context)),
        first_message: request?.message,
        harness: {
          prompt_version: 1,
          tools_hash: digest(tools),
          build_sha: "drama-1",
          key: digest(tools),
        },
      };
    },
    tool: async (context, name, input, options) => {
      if (context.mode !== "drama") return base.tool(context, name, input, options);
      try {
        if (name === "skill_read" || name === "skill_search")
          return await skills.invoke(context, name, input, options.toolCallId);
        if (name !== "drama_read") throw new LocalAgentError("AGENT_SCOPE_DENIED");
        return {
          content: JSON.stringify(await call(context, "read", { input })),
          is_error: false,
          terminate: false,
        };
      } catch (cause) {
        return { content: error(cause), is_error: true, terminate: false };
      }
    },
    propose: async (context, kind, input, signal, id) => {
      if (context.mode !== "drama") return base.propose(context, kind, input, signal, id);
      try {
        if (kind === "ask") {
          await call(context, "prepare");
          return proposeQuestions(input);
        }
        if (kind === "drama_run_job" && id) {
          const payload = (await call(context, "estimate", { input })) as { estimate: number };
          return {
            payload,
            quote_credits: payload.estimate,
            summary: `运行短剧任务，预估 ${payload.estimate} 积分`,
            content: "已提交给用户确认，等待决定。批准后才会修改或提交任务。",
            is_error: false,
            terminate: true,
          };
        }
        if (!Object.hasOwn(DramaEdits, kind) || !id)
          throw new LocalAgentError("AGENT_SCOPE_DENIED");
        return {
          payload: await call(context, "preview", { kind, input }),
          quote_credits: 0,
          content: "等待批准",
          is_error: false,
          terminate: true,
        };
      } catch (cause) {
        return { content: error(cause), quote_credits: 0, is_error: true, terminate: false };
      }
    },
    resolve: async (context, kind, payload, decision, signal) => {
      if (context.mode !== "drama") return base.resolve(context, kind, payload, decision, signal);
      if (kind === "ask") {
        await call(context, "prepare");
        return resolveQuestions(payload, decision, () => call(context, "question-models"));
      }
      if (kind !== "drama_run_job" && !Object.hasOwn(DramaEdits, kind))
        throw new LocalAgentError("AGENT_SCOPE_DENIED");
      if (decision.items?.length || !["approve", "reject"].includes(decision.decision))
        throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
      await call(context, "prepare");
      return {
        status: decision.decision === "approve" ? "approved" : "rejected",
        decision: {
          decision: decision.decision,
          ...(decision.decision === "reject" && decision.answer && { answer: decision.answer }),
        },
        quote_credits:
          kind === "drama_run_job" && decision.decision === "approve"
            ? (payload as { estimate: number }).estimate
            : 0,
        drama: payload,
      };
    },
    execute: async (context, kind, id, toolCallId, outcome, signal) => {
      if (context.mode !== "drama")
        return base.execute(context, kind, id, toolCallId, outcome, signal);
      if (kind === "ask") {
        await call(context, "prepare");
        return questionResult(outcome);
      }
      if (outcome.status === "rejected") {
        const reason =
          typeof outcome.decision.answer === "string"
            ? `\n用户说明：${outcome.decision.answer}`
            : "";
        const message =
          kind === "drama_run_job" ? "用户拒绝了这次短剧操作，没有修改或提交任务。" : "保留原文";
        return { status: "rejected", outcome_text: message + reason };
      }
      try {
        if (
          (kind !== "drama_run_job" && !Object.hasOwn(DramaEdits, kind)) ||
          outcome.status !== "approved"
        )
          throw new LocalAgentError("AGENT_SCOPE_DENIED");
        const result = await call(context, "apply", { kind, id, input: outcome.drama });
        return {
          status: "executed",
          result,
          outcome_text:
            kind === "drama_run_job" ? `短剧操作已执行：${JSON.stringify(result)}` : "已写入短剧",
        };
      } catch (cause) {
        return { status: "failed", result: { code: error(cause) }, outcome_text: error(cause) };
      }
    },
  };
}
