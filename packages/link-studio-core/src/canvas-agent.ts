import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { feedbackValue } from "./agent-feedback.ts";
import { maxAgentBudget } from "./agent-generation-quote.ts";
import {
  CanvasEdge,
  CanvasId,
  CanvasModelKey,
  CanvasOperations,
  CanvasPosition,
  cameraMoves,
  groupHue,
  maxStoryboardShots,
  shotSizes,
} from "./canvas.ts";
import { generationModes } from "./model-config.ts";
import type { SettingsValues } from "./settings-api.ts";

const strict = { additionalProperties: false };
export const maxAgentImages = 9;
export const maxAgentDocuments = 3;
export const maxAgentDocumentBytes = 200_000;
const documentId = Type.String({ pattern: "^[a-f0-9]{64}$" });
const id = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
const cursor = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const budget = Type.Optional(Type.Integer({ minimum: 0, maximum: maxAgentBudget }));
const indices = Type.Array(Type.Integer({ minimum: 0, maximum: 1000 }), {
  maxItems: 1001,
  uniqueItems: true,
});
export const CanvasAgentQuestionnaire = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          id,
          label: Type.String({ minLength: 1, maxLength: 400 }),
          kind: Type.Optional(
            Type.Union([
              Type.Literal("choice"),
              Type.Literal("text"),
              Type.Literal("number"),
              Type.Literal("url"),
              Type.Literal("model"),
            ]),
          ),
          required: Type.Optional(Type.Boolean()),
          placeholder: Type.Optional(Type.String({ maxLength: 100 })),
          allowCustom: Type.Optional(Type.Boolean()),
          follow: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  label: Type.String(),
                  placeholder: Type.String({ minLength: 1, maxLength: 100 }),
                },
                strict,
              ),
              { maxItems: 8 },
            ),
          ),
          multi: Type.Optional(Type.Boolean()),
          modelKind: Type.Optional(Type.Union([Type.Literal("image"), Type.Literal("video")])),
          models: Type.Optional(
            Type.Array(
              Type.Object(
                { key: id, name: Type.String(), hint: Type.Optional(Type.String()) },
                strict,
              ),
            ),
          ),
          options: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
              minItems: 2,
              maxItems: 8,
              uniqueItems: true,
            }),
          ),
        },
        strict,
      ),
      { minItems: 1, maxItems: 5 },
    ),
  },
  strict,
);
export type CanvasAgentQuestionnaire = Static<typeof CanvasAgentQuestionnaire>;
const answerString = Type.String({ minLength: 1, maxLength: 2048 });
export const CanvasAgentAnswers = Type.Array(
  Type.Object(
    {
      id,
      value: Type.Union([
        answerString,
        Type.Array(answerString, { minItems: 1, maxItems: 8, uniqueItems: true }),
      ]),
    },
    strict,
  ),
  { maxItems: 5 },
);
export type CanvasAgentAnswers = Static<typeof CanvasAgentAnswers>;
export type CanvasAgentQuestion = CanvasAgentQuestionnaire["questions"][number];

export function readWorkspaceQuestions(raw: unknown): CanvasAgentQuestionnaire | undefined {
  if (isCanvasAgentQuestionnaire(raw)) return raw;
  if (!raw || typeof raw !== "object" || !("questions" in raw) || !Array.isArray(raw.questions))
    return;
  const questions = raw.questions.map((entry) => {
    if (!entry || typeof entry.question !== "string") return null;
    const options: { label: string; follow?: string }[] | undefined = Array.isArray(entry.options)
      ? entry.options
      : undefined;
    if (options?.some((option) => !option || typeof option.label !== "string")) return null;
    return {
      id: entry.id,
      label: entry.question,
      kind: entry.kind,
      required: entry.required,
      multi: entry.multi,
      allowCustom: entry.allow_custom,
      modelKind: entry.model_kind,
      models: entry.models,
      placeholder: entry.placeholder,
      options: options?.map((option) => option.label),
      follow: options?.flatMap((option) =>
        option.follow ? [{ label: option.label, placeholder: option.follow }] : [],
      ),
    };
  });
  const payload = { questions };
  return isCanvasAgentQuestionnaire(payload) ? payload : undefined;
}

export function isCanvasAgentQuestionnaire(payload: unknown): payload is CanvasAgentQuestionnaire {
  if (!Value.Check(CanvasAgentQuestionnaire, payload)) return false;
  const { questions } = payload;
  return (
    new Set(questions.map(({ id }) => id)).size === questions.length &&
    questions.every(({ label, options, kind, multi, modelKind, follow, allowCustom }) => {
      const choice = kind ? kind === "choice" : Boolean(options);
      return (
        Boolean(label.trim()) &&
        (kind === "model" ? modelKind !== undefined : modelKind === undefined) &&
        (!multi || choice) &&
        (!allowCustom || choice) &&
        (!follow || (choice && follow.every((entry) => options?.includes(entry.label)))) &&
        (choice
          ? !!options && options.every((option) => option.trim() && option === option.trim())
          : !options)
      );
    })
  );
}

export function isCanvasAgentAnswerValue(
  question: CanvasAgentQuestion,
  value: CanvasAgentAnswers[number]["value"],
) {
  const { kind, options, multi } = question;
  const validChoice = (text: string) => {
    if (!text || text !== text.trim() || text.length > 2000) return false;
    const follows = question.follow ?? [];
    if (follows.some(({ label }) => text === label)) return false;
    return (
      question.allowCustom ||
      options?.includes(text) ||
      follows.some(
        ({ label }) => text.startsWith(`${label}：`) && !!text.slice(label.length + 1).trim(),
      )
    );
  };
  if (multi)
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      new Set(value).size === value.length &&
      value.every(validChoice)
    );
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  if (options) return !!validChoice(value);
  if (kind === "model")
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  if (kind === "number") return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
  if (kind === "url") {
    if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
    const url = URL.parse(value);
    return Boolean(url && !url.username && !url.password);
  }
  return true;
}

export function canvasAgentMediaModels({ providers, plugins }: SettingsValues["list"]) {
  return providers.flatMap((provider) => {
    const plugin = plugins.find(({ hash }) => hash === provider.pluginHash);
    return provider.enabled &&
      provider.channelEnabled !== false &&
      provider.config?.kind !== "agent" &&
      plugin &&
      !plugin.disabled &&
      (plugin.kind === "image" || plugin.kind === "video") &&
      (plugin.auth === "none" || provider.hasSecret)
      ? [{ provider, kind: plugin.kind } as const]
      : [];
  });
}

export const CanvasAgentAction = Type.Union([
  Type.Object({ method: Type.Literal("list") }, strict),
  Type.Object({ method: Type.Literal("create") }, strict),
  Type.Object(
    {
      method: Type.Literal("rename"),
      sessionId: id,
      title: Type.String({ minLength: 1, maxLength: 40 }),
    },
    strict,
  ),
  Type.Object({ method: Type.Literal("remove"), sessionId: id }, strict),
  Type.Object(
    {
      method: Type.Literal("attachDocument"),
      name: Type.String({ minLength: 1, maxLength: 255 }),
      bytes: Type.Uint8Array({ minByteLength: 1, maxByteLength: maxAgentDocumentBytes }),
    },
    strict,
  ),
  Type.Object({ method: Type.Literal("readDocument"), documentId }, strict),
  Type.Object(
    { method: Type.Literal("state"), sessionId: id, after: cursor, before: Type.Optional(cursor) },
    strict,
  ),
  Type.Object({ method: Type.Literal("cancelWatches"), sessionId: id }, strict),
  Type.Object({ method: Type.Literal("exportDiagnostics"), sessionId: id, runId: id }, strict),
  Type.Object(
    { method: Type.Literal("feedback"), sessionId: id, runId: id, value: feedbackValue },
    strict,
  ),
  Type.Object(
    {
      method: Type.Literal("previewReference"),
      url: Type.String({ minLength: 1, maxLength: 2048 }),
    },
    strict,
  ),
  Type.Object(
    {
      method: Type.Literal("send"),
      budgetCredits: budget,
      sessionId: id,
      providerId: id,
      message: Type.String({ minLength: 1, maxLength: 24000 }),
      selection: Type.Array(CanvasId, { maxItems: 20, uniqueItems: true }),
      referenceURL: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      allowWebResearch: Type.Optional(Type.Boolean()),
      referenceFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      attachmentAssetIds: Type.Optional(
        Type.Array(
          Type.String({
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          }),
          { maxItems: maxAgentImages, uniqueItems: true },
        ),
      ),
      documentIds: Type.Optional(
        Type.Array(documentId, { maxItems: maxAgentDocuments, uniqueItems: true }),
      ),
      runId: Type.Optional(id),
    },
    strict,
  ),
  Type.Object(
    {
      method: Type.Union([Type.Literal("stop"), Type.Literal("undo")]),
      sessionId: id,
      runId: id,
    },
    strict,
  ),
  Type.Object(
    { method: Type.Literal("continue"), sessionId: id, runId: id, addBudget: budget },
    strict,
  ),
  Type.Object(
    {
      method: Type.Literal("decide"),
      sessionId: id,
      approvalId: id,
      selected: indices,
      addBudget: budget,
      answer: Type.Optional(Type.String({ maxLength: 2000 })),
    },
    strict,
  ),
  Type.Object(
    {
      method: Type.Literal("answer"),
      sessionId: id,
      approvalId: id,
      answers: Type.Optional(CanvasAgentAnswers),
    },
    strict,
  ),
]);
export type CanvasAgentAction = Static<typeof CanvasAgentAction>;
export type CanvasUndoResult = {
  reverted: number;
  skipped: { id: string; reason: string }[];
  revision: number;
};
export type CanvasAgentValues = {
  attachDocument: { documentId: string };
  readDocument: { name: string; text: string };
  list: SettingsValues["agentList"];
  create: SettingsValues["agentCreate"];
  rename: { title: string };
  remove: { removed: boolean };
  state: SettingsValues["agentState"];
  cancelWatches: { canceled: number };
  exportDiagnostics: { exported: boolean };
  feedback: SettingsValues["agentFeedback"];
  previewReference: { fingerprint: string; text: string };
  send: SettingsValues["agentSend"];
  stop: SettingsValues["agentStop"];
  continue: SettingsValues["agentContinue"];
  decide: SettingsValues["agentDecide"];
  answer: SettingsValues["agentDecide"];
  undo: CanvasUndoResult;
};

export const CanvasAgentEdit = Type.Object(
  { expectedCanvasRevision: cursor, operations: CanvasOperations },
  strict,
);
export const CanvasAgentDelete = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 4096 }),
    nodeIds: Type.Optional(Type.Array(CanvasId, { maxItems: 1000, uniqueItems: true })),
    edgeIds: Type.Optional(
      Type.Array(CanvasEdge.properties.id, { maxItems: 4000, uniqueItems: true }),
    ),
  },
  strict,
);
const shotFields = Type.Object(
  {
    scene: Type.Optional(Type.String()),
    action: Type.Optional(Type.String()),
    dialogue: Type.Optional(Type.String()),
    shot: Type.Optional(Type.Union(shotSizes.map((value) => Type.Literal(value)))),
    camera: Type.Optional(Type.Union(cameraMoves.map((value) => Type.Literal(value)))),
    duration: Type.Optional(Type.Number()),
  },
  strict,
);
const shotNumber = Type.Integer({ minimum: 1 });
const storyboardPatch = Type.Object(
  {
    shots: Type.Optional(Type.Array(shotFields, { maxItems: maxStoryboardShots })),
    edits: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Object(
            { op: Type.Literal("insert"), after: Type.Integer({ minimum: 0 }), set: shotFields },
            strict,
          ),
          Type.Object({ op: Type.Literal("update"), no: shotNumber, set: shotFields }, strict),
          Type.Object({ op: Type.Literal("delete"), no: shotNumber }, strict),
          Type.Object({ op: Type.Literal("move"), no: shotNumber, to: shotNumber }, strict),
        ]),
      ),
    ),
  },
  strict,
);
export type AgentStoryboardPatch = Static<typeof storyboardPatch>;
const nodeFields = {
  model: Type.Optional(Type.Union([CanvasModelKey, Type.Literal("")])),
  mode: Type.Optional(Type.Union(generationModes.map((mode) => Type.Literal(mode)))),
  params: Type.Optional(
    Type.Record(
      Type.String({ pattern: "^[a-z][a-zA-Z0-9_]{0,31}$" }),
      Type.Union([Type.String({ maxLength: 2000 }), Type.Number(), Type.Boolean()]),
      { additionalProperties: false, maxProperties: 40 },
    ),
  ),
  character: Type.Optional(
    Type.Object(
      {
        name: Type.Optional(Type.String({ maxLength: 64 })),
        look: Type.Optional(Type.String({ maxLength: 64 })),
        description: Type.Optional(Type.String({ maxLength: 500 })),
        voicePrompt: Type.Optional(Type.String({ maxLength: 500 })),
      },
      strict,
    ),
  ),
  storyboard: Type.Optional(storyboardPatch),
  label: Type.Optional(Type.String({ maxLength: 40 })),
  prompt: Type.Optional(Type.String({ maxLength: 32768 })),
};
const members = Type.Optional(Type.Array(CanvasId, { maxItems: 1000, uniqueItems: true }));
const groupColors = {
  color: Type.Optional(Type.Union([groupHue, Type.Literal("")])),
  labelColor: Type.Optional(Type.Union([groupHue, Type.Literal("")])),
};
export const CanvasAgentOps = Type.Object(
  {
    ops: Type.Array(
      Type.Union([
        Type.Object(
          {
            op: Type.Literal("create_node"),
            parentGroup: Type.Optional(CanvasId),
            kind: Type.Union([
              Type.Literal("script"),
              Type.Literal("image"),
              Type.Literal("video"),
              Type.Literal("audio"),
              Type.Literal("storyboard"),
              Type.Literal("character"),
            ]),
            tempId: Type.Optional(CanvasId),
            position: Type.Optional(CanvasPosition),
            ...nodeFields,
          },
          strict,
        ),
        Type.Object({ op: Type.Literal("move"), id: CanvasId, position: CanvasPosition }, strict),
        Type.Object(
          {
            op: Type.Literal("create_group"),
            ...groupColors,
            tempId: Type.Optional(CanvasId),
            label: nodeFields.label,
            position: Type.Optional(CanvasPosition),
            memberIds: members,
          },
          strict,
        ),
        Type.Object(
          {
            op: Type.Literal("set_group"),
            ...groupColors,
            id: CanvasId,
            label: nodeFields.label,
            addMembers: members,
            removeMembers: members,
          },
          strict,
        ),
        Type.Object({ op: Type.Literal("update_node"), id: CanvasId, ...nodeFields }, strict),
        Type.Object({ op: Type.Literal("connect"), source: CanvasId, target: CanvasId }, strict),
      ]),
      { minItems: 1, maxItems: 30 },
    ),
  },
  strict,
);
export type CanvasAgentOps = Static<typeof CanvasAgentOps>;
export const CanvasAgentArrange = Type.Object(
  {
    layout: Type.Union([Type.Literal("row"), Type.Literal("column"), Type.Literal("grid")]),
    nodeIds: Type.Optional(Type.Array(CanvasId, { uniqueItems: true, maxItems: 1000 })),
    groupId: Type.Optional(CanvasId),
  },
  strict,
);
export type CanvasAgentArrange = Static<typeof CanvasAgentArrange>;
export const CanvasAgentGenerate = Type.Object(
  {
    items: Type.Array(Type.Object({ nodeId: CanvasId }, strict), { minItems: 1, maxItems: 8 }),
    reason: Type.Optional(Type.String()),
    wait: Type.Optional(Type.Boolean()),
  },
  strict,
);
export const CanvasAgentCapture = Type.Object(
  {
    nodeId: CanvasId,
    frames: Type.Array(
      Type.Object(
        {
          at: Type.Union([
            Type.Literal("first"),
            Type.Literal("last"),
            Type.Number({ minimum: 0 }),
          ]),
          connectTo: Type.Optional(Type.Array(CanvasId, { maxItems: 1000 })),
        },
        strict,
      ),
      { minItems: 1, maxItems: 6 },
    ),
  },
  strict,
);
export const CanvasAgentRead = Type.Object(
  {
    nodeIds: Type.Optional(Type.Array(CanvasId, { minItems: 1, maxItems: 50 })),
    offset: Type.Optional(cursor),
  },
  strict,
);
