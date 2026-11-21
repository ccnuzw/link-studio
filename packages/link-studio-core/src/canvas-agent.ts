import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CanvasId, CanvasOperations } from "./canvas.ts";
import { GenerationInput } from "./generation.ts";
import type { SettingsValues } from "./settings-api.ts";

const strict = { additionalProperties: false };
const id = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
const cursor = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const indices = Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), {
  maxItems: 20,
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
          multi: Type.Optional(Type.Boolean()),
          modelKind: Type.Optional(Type.Union([Type.Literal("image"), Type.Literal("video")])),
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

export function isCanvasAgentQuestionnaire(payload: unknown): payload is CanvasAgentQuestionnaire {
  if (!Value.Check(CanvasAgentQuestionnaire, payload)) return false;
  const { questions } = payload;
  return (
    new Set(questions.map(({ id }) => id)).size === questions.length &&
    questions.every(({ label, options, kind, multi, modelKind }) => {
      const choice = kind ? kind === "choice" : Boolean(options);
      return (
        Boolean(label.trim()) &&
        (kind === "model" ? modelKind !== undefined : modelKind === undefined) &&
        (!multi || choice) &&
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
  if (multi)
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      new Set(value).size === value.length &&
      value.every((option) => options?.includes(option))
    );
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  if (options) return options.includes(value);
  if (kind === "model")
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  if (kind === "number")
    return (
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))
    );
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
      ? [{ provider, kind: plugin.kind }]
      : [];
  });
}

export const CanvasAgentAction = Type.Union([
  Type.Object({ method: Type.Literal("list") }, strict),
  Type.Object({ method: Type.Literal("create") }, strict),
  Type.Object({ method: Type.Literal("state"), sessionId: id, after: cursor }, strict),
  Type.Object({ method: Type.Literal("exportDiagnostics"), sessionId: id, runId: id }, strict),
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
          { maxItems: 4, uniqueItems: true },
        ),
      ),
      runId: Type.Optional(id),
    },
    strict,
  ),
  Type.Object(
    {
      method: Type.Union([Type.Literal("stop"), Type.Literal("continue"), Type.Literal("undo")]),
      sessionId: id,
      runId: id,
    },
    strict,
  ),
  Type.Object(
    { method: Type.Literal("decide"), sessionId: id, approvalId: id, selected: indices },
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
  list: SettingsValues["agentList"];
  create: SettingsValues["agentCreate"];
  state: SettingsValues["agentState"];
  exportDiagnostics: { exported: boolean };
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
export const CanvasAgentGenerate = Type.Object(
  { items: Type.Array(GenerationInput, { minItems: 1, maxItems: 12 }) },
  strict,
);
export const CanvasAgentRead = Type.Object(
  {
    nodeIds: Type.Optional(Type.Array(CanvasId, { maxItems: 20, uniqueItems: true })),
    offset: Type.Optional(cursor),
  },
  strict,
);
