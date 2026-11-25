import { requirePresent } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import {
  CanvasAgentAnswers,
  CanvasAgentQuestionnaire,
  isCanvasAgentAnswerValue,
  isCanvasAgentQuestionnaire,
  readWorkspaceQuestions,
} from "../../link-studio-core/src/canvas-agent.ts";
import type {
  ApprovalDecision,
  ApprovalOutcome,
  ToolDecl,
} from "../upstream/src/platform-client.ts";
import askDeclaration from "./ask-tool.json" with { type: "json" };
import { LocalAgentError } from "./targets.ts";

export const askTool: ToolDecl = {
  name: "ask_user",
  label: "向你提问",
  verb: "向你提问",
  description:
    "缺少创作条件时一次提出 1 到 5 个问题。id 不可重复。kind 支持 choice、text、number、url、model。choice 提供 options，multi:true 可多选。model 指定 modelKind 为 image 或 video，选项由本机模型目录提供，答案为 Provider 模型记录 ID。required:false 为选填。URL 仅收集。等待用户回答，不要擅自填写。",
  parameters: CanvasAgentQuestionnaire,
  executor: "server",
  scriptable: false,
};

const questionArray = askDeclaration.parameters.properties.questions;
export const workspaceAskTool: ToolDecl = {
  ...askTool,
  ...askDeclaration,
  verb: "提问",
  parameters: {
    ...askDeclaration.parameters,
    properties: {
      questions: {
        ...questionArray,
        items: {
          ...questionArray.items,
          required: [],
          anyOf: [{ required: ["question", "kind"] }, { required: ["label", "id"] }],
          properties: {
            ...questionArray.items.properties,
            label: { type: "string", description: "旧版问题文字" },
          },
        },
      },
    },
  },
};

function parseWorkspaceQuestions(raw: unknown) {
  if (isCanvasAgentQuestionnaire(raw)) return raw;
  const args = raw as { questions?: unknown } | null;
  const entries = Array.isArray(args?.questions) ? args.questions : [raw];
  const questions = entries.map((entry: Record<string, unknown>, index) => {
    if (
      !entry ||
      typeof entry.question !== "string" ||
      !entry.question.trim() ||
      Array.from(entry.question.trim()).length > 200
    )
      throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
    const { options, question, id, kind, required, multi, modelKind, allowCustom, placeholder } =
      entry;
    const normalized = Array.isArray(options)
      ? options.map((option) => (typeof option === "string" ? { label: option.trim() } : option))
      : undefined;
    if (
      options !== undefined &&
      (!normalized ||
        normalized.length > 4 ||
        normalized.some(
          (option) =>
            !option ||
            typeof option.label !== "string" ||
            !option.label.trim() ||
            option.label.length > 100,
        ))
    )
      throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
    return {
      id: id ?? String(index + 1),
      label: question.trim(),
      kind,
      required,
      multi,
      modelKind,
      allowCustom,
      placeholder,
      ...(normalized && {
        options: normalized.map((option) => option.label.trim()),
        follow: normalized
          .filter((option) => option.follow)
          .map((option) => ({ label: option.label.trim(), placeholder: option.follow })),
      }),
    };
  });
  return proposeQuestions({ questions }).payload;
}

type QuestionModel = { id: string; kind: "image" | "video"; name?: string; hint?: string };

export async function proposeWorkspaceQuestions(raw: unknown, loadModels: () => Promise<unknown>) {
  const input = parseWorkspaceQuestions(raw);
  const models = input.questions.some((question) => question.kind === "model")
    ? ((await loadModels()) as QuestionModel[])
    : [];
  const questions = input.questions.map((entry) => {
    const kind = entry.kind ?? (entry.options ? "choice" : "text");
    return {
      id: entry.id,
      question: entry.label,
      kind,
      required: entry.required !== false,
      ...(entry.multi && { multi: true }),
      ...(entry.allowCustom && { allow_custom: true }),
      ...(entry.placeholder && { placeholder: entry.placeholder }),
      ...(entry.options && {
        options: entry.options.map((label) => ({
          label,
          follow: entry.follow?.find((option) => option.label === label)?.placeholder,
        })),
      }),
      ...(kind === "model" && {
        model_kind: entry.modelKind,
        models: models
          .filter((model) => model.kind === entry.modelKind)
          .map((model) => ({ key: model.id, name: model.name || model.id, hint: model.hint })),
      }),
    };
  });
  const unavailable = questions.find(
    (question) => question.kind === "model" && !question.models?.length,
  );
  if (unavailable) {
    const kind = unavailable.model_kind === "image" ? "图片" : "视频";
    return {
      content: `第 ${questions.indexOf(unavailable) + 1} 题：目前没有已发布的${kind}模型，请告诉用户需要管理员先配置。`,
      is_error: true,
      terminate: false,
      quote_credits: 0,
    };
  }
  const [first] = questions;
  if (!first) throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
  const multiple = questions.length > 1;
  const payload = {
    question: multiple ? `还差 ${questions.length} 件事要你定` : first.question,
    kind: first.kind,
    model_kind: first.model_kind,
    models: first.models,
    allow_custom: first.allow_custom,
    options: first.options?.map((option) => option.label),
    questions,
  };
  const title = Array.from(first.question)
    .slice(0, multiple ? 30 : 40)
    .join("");
  return {
    payload,
    content: "已向用户提问，等待回答。用户回答后你会收到结果。",
    summary: multiple ? `向用户提问（${questions.length} 题）：${title}` : `向用户提问：${title}`,
    quote_credits: 0,
    is_error: false,
    terminate: true,
  };
}

export function proposeQuestions(payload: unknown) {
  if (
    !isCanvasAgentQuestionnaire(payload) ||
    payload.questions.some((question) => question.models !== undefined)
  )
    throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
  return { payload, content: "等待用户回答", quote_credits: 0, is_error: false, terminate: true };
}

export async function resolveQuestions(
  raw: unknown,
  decision: ApprovalDecision,
  loadModels: () => Promise<unknown>,
): Promise<ApprovalOutcome> {
  const payload = readWorkspaceQuestions(raw);
  if (decision.decision === "reject")
    return {
      status: "rejected",
      decision: {
        decision: "reject",
        question_count: isCanvasAgentQuestionnaire(payload) ? payload.questions.length : 1,
      },
      quote_credits: 0,
    };
  const answers = decision.answers;
  if (!payload || !Value.Check(CanvasAgentAnswers, answers))
    throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
  const byId = new Map(answers.map(({ id, value }) => [id, value]));
  if (byId.size !== answers.length) throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
  const models = payload.questions.some((question) => question.kind === "model" && !question.models)
    ? ((await loadModels()) as QuestionModel[])
    : [];
  if (answers.some((entry) => !payload.questions.some((question) => question.id === entry.id)))
    throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
  const ordered = payload.questions.map((question) => {
    const value = byId.get(question.id);
    if (value === undefined && question.required === false)
      return { id: question.id, question: question.label, value: "", answer: "" };
    if (value === undefined || !isCanvasAgentAnswerValue(question, value))
      throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
    let answer = Array.isArray(value) ? value.join("、") : value;
    if (question.kind === "model") {
      const model = question.models
        ? question.models.find((model) => model.key === value)
        : models.find(({ id, kind }) => id === value && kind === question.modelKind);
      if (!model) throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
      answer = `${model.name || value}（模型 key：${value}）`;
    }
    return { id: question.id, question: question.label, value, answer };
  });
  const answer =
    ordered.length === 1
      ? requirePresent(ordered[0], "ordered[0]").answer
      : ordered
          .filter((entry) => entry.answer)
          .map((entry) => `${entry.question}：${entry.answer}`)
          .join("；");
  return {
    status: "approved",
    decision: { decision: "approve", answer, answers: ordered },
    quote_credits: 0,
  };
}

export function questionResult(outcome: ApprovalOutcome) {
  const answers = outcome.decision.answers as { question?: string; answer?: string }[] | undefined;
  const singleAnswer = answers?.length === 1 ? answers[0]?.answer : undefined;
  const text =
    answers?.length && answers.every((entry) => typeof entry.question === "string")
      ? singleAnswer
        ? `用户回答：${singleAnswer}`
        : "用户回答了你的提问：\n" +
          answers
            .map((entry, index) => `${index + 1}. ${entry.question} → ${entry.answer || "未回答"}`)
            .join("\n")
      : `用户回答：${outcome.decision.answer ?? JSON.stringify(answers ?? [])}`;
  return {
    status: "none" as const,
    outcome_text:
      outcome.status === "rejected"
        ? `用户没有回答${outcome.decision.question_count === 1 ? "这个" : "这些"}问题，改发了新消息；请以用户的新消息为准，确有必要再问。`
        : text,
  };
}
