import { type Static, Type } from "@sinclair/typebox";
import { feedbackValue, type RunRating } from "./agent-feedback.ts";
import { CanvasAgentAnswers } from "./canvas-agent.ts";
import { type DramaPromptEntry, PromptLibraryRequest } from "./drama-prompts.ts";
import { GenerationInput } from "./generation.ts";
import { ModelConfig, maximumModelPromptLength } from "./model-config.ts";

const strict = { additionalProperties: false };
const canvasProviderId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const CanvasViewPreferences = Type.Object(
  {
    background: Type.Union([
      Type.Literal("dots"),
      Type.Literal("lines"),
      Type.Literal("cross"),
      Type.Literal("none"),
    ]),
    wheelMode: Type.Union([Type.Literal("pan"), Type.Literal("zoom")]),
    theme: Type.Union([Type.Literal("system"), Type.Literal("light"), Type.Literal("dark")]),
    showHints: Type.Boolean(),
    defaultModels: Type.Partial(
      Type.Object(
        {
          script: canvasProviderId,
          image: canvasProviderId,
          video: canvasProviderId,
          audio: canvasProviderId,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type CanvasViewPreferences = Static<typeof CanvasViewPreferences>;
export const defaultCanvasView: CanvasViewPreferences = {
  background: "dots",
  wheelMode: "pan",
  theme: "dark",
  showHints: true,
  defaultModels: {},
};
const text = (maxLength: number) => Type.String({ maxLength });
const id = Type.String({ pattern: "^[a-zA-Z0-9._:-]{1,128}$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const providerPluginSourceLimit = 512 * 1024;
export const ProviderFields = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 120 }),
    endpoint: Type.String({ minLength: 1, maxLength: 1024 }),
    model: Type.String({ minLength: 1, maxLength: 200 }),
    allowLocal: Type.Boolean(),
    agentEnabled: Type.Boolean(),
    agentVision: Type.Optional(Type.Boolean()),
    channel: Type.Record(
      Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,31}$" }),
      Type.Union([text(256), Type.Number(), Type.Boolean()]),
      { maxProperties: 30 },
    ),
  },
  strict,
);
export type ProviderFields = Static<typeof ProviderFields>;
export const EditableModelDocument = Type.Object(
  {
    config: Type.Object({ ...ModelConfig.properties, name: text(120) }, strict),
    channels: Type.Optional(
      Type.Array(Type.Object({ channel: id, upstream_model: text(200) }, strict), {
        minItems: 1,
        maxItems: 1,
      }),
    ),
    upstreamModel: Type.Optional(text(200)),
    pluginHash: Type.Union([hash, Type.Literal("")]),
    settings: ProviderFields.properties.channel,
  },
  strict,
);
export type ProviderView = ProviderFields & {
  id: string;
  modelKey?: string;
  channelId?: string;
  channelEnabled?: boolean;
  pending?: true;
  hasDocumentDraft?: true;
  draftIssueCount?: number;
  pendingSort?: number;
  pendingDeadlineSeconds?: number;
  config?: ModelConfig;
  connectionId?: string;
  revision: number;
  pluginHash: string;
  enabled: boolean;
  hasSecret: boolean;
  hasSecretKey: boolean;
};
const ChannelFields = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    endpoint: ProviderFields.properties.endpoint,
    allowLocal: Type.Boolean(),
    enabled: Type.Boolean(),
    sort: Type.Integer({ minimum: 0, maximum: 100000 }),
    headers: Type.Array(Type.Object({ name: text(80), value: text(1024) }, strict), {
      maxItems: 32,
    }),
    rps: Type.Optional(Type.Number({ minimum: 0 })),
    concurrent: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    running: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    filing: Type.Optional(
      Type.Object({ enabled: Type.Boolean(), groupId: text(128), projectName: text(64) }, strict),
    ),
  },
  strict,
);
export type ChannelFields = Static<typeof ChannelFields>;
export type ChannelView = Omit<ChannelFields, "headers"> & {
  activeJobs?: number;
  hasFilingKeys?: boolean;
  hasFilingRecords?: boolean;
  headers: { name: string }[];
  id: string;
  revision: number;
  hasSecret: boolean;
  hasSecretKey: boolean;
};
export type PluginView = {
  activeJobs?: number;
  registeredAt?: string;
  hash: string;
  key: string;
  name: string;
  version: string;
  kind: string;
  apiVersion: number;
  mode: "sync" | "async";
  disabled: boolean;
  auth: string;
  authName?: string;
  vendor?: string;
  description?: string;
  endpoint?: { method?: string; path?: string };
  poll?: Partial<Record<"firstDelay" | "interval" | "maxInterval" | "jitter", number>>;
  hooks: string[];
  unknownHooks?: string[];
  origin: "builtin" | "manual" | "agent";
  source: string;
  fields: Record<
    string,
    {
      type: string;
      label: string;
      description?: string;
      required?: boolean;
      default?: string | boolean | number;
      options?: string[];
    }
  >;
};
export const SettingChange = Type.Union([
  Type.Object(
    { field: Type.Literal("label"), value: Type.String({ minLength: 1, maxLength: 120 }) },
    strict,
  ),
  Type.Object(
    { field: Type.Literal("model"), value: Type.String({ minLength: 1, maxLength: 200 }) },
    strict,
  ),
  Type.Object(
    {
      field: Type.Literal("channel"),
      key: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,31}$" }),
      value: Type.Union([text(256), Type.Number(), Type.Boolean(), Type.Null()]),
    },
    strict,
  ),
]);
export const SettingsProposal = Type.Union([
  Type.Object(
    {
      providerId: id,
      expectedRevision: revision,
      changes: Type.Array(SettingChange, { minItems: 1, maxItems: 20 }),
    },
    strict,
  ),
  Type.Object({ pluginSource: text(providerPluginSourceLimit) }, strict),
]);
export type SettingsProposal = Static<typeof SettingsProposal>;
const SaveProvider = Type.Object(
  {
    id: Type.Optional(id),
    expectedRevision: revision,
    pluginHash: hash,
    approve: Type.Boolean(),
    fields: ProviderFields,
    secret: Type.Optional(text(8192)),
    clearSecret: Type.Optional(Type.Boolean()),
    secretKey: Type.Optional(text(8192)),
    clearSecretKey: Type.Optional(Type.Boolean()),
  },
  strict,
);
const coordinate = Type.Number({
  minimum: -Number.MAX_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
});
const AgentLayout = Type.Object(
  {
    mode: Type.Union([Type.Literal("lively"), Type.Literal("quiet"), Type.Literal("hidden")]),
    anchor: Type.Object(
      {
        corner: Type.Union([
          Type.Literal("tl"),
          Type.Literal("tr"),
          Type.Literal("bl"),
          Type.Literal("br"),
        ]),
        dx: coordinate,
        dy: coordinate,
      },
      strict,
    ),
    offset: Type.Object({ x: coordinate, y: coordinate }, strict),
    docked: Type.Boolean(),
    width: Type.Integer({ minimum: 320, maximum: 560 }),
  },
  strict,
);
export type AgentLayout = Static<typeof AgentLayout>;
export const defaultAgentLayout: AgentLayout = {
  mode: "lively",
  anchor: { corner: "br", dx: 12, dy: 12 },
  offset: { x: 0, y: 0 },
  docked: false,
  width: 400,
};

export const settingsRequests = {
  dramaPromptLibrary: PromptLibraryRequest,
  list: Type.Object({}, strict),
  channelList: Type.Object({}, strict),
  channelLoads: Type.Object({}, strict),
  filingStorage: Type.Object({}, strict),
  filingStorageSave: Type.Object(
    {
      endpoint: text(1024),
      region: text(80),
      bucket: text(100),
      provider: Type.Optional(
        Type.Union([
          Type.Literal("s3"),
          Type.Literal("aliyun_oss"),
          Type.Literal("tencent_cos"),
          Type.Literal("r2"),
        ]),
      ),
      addressing: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("virtual"), Type.Literal("path")]),
      ),
      accountId: Type.Optional(text(32)),
      publicBase: text(1024),
      accessKey: text(512),
      secretKey: text(4096),
    },
    strict,
  ),
  filingPreview: Type.Object({ id, expectedRevision: revision, assetId: id }, strict),
  filingAssets: Type.Union([
    Type.Object({ id, expectedRevision: revision, action: Type.Literal("list") }, strict),
    Type.Object(
      { id, expectedRevision: revision, action: Type.Literal("removeHuman"), humanId: id },
      strict,
    ),
    Type.Object(
      {
        id,
        expectedRevision: revision,
        action: Type.Literal("rename"),
        humanId: id,
        name: text(128),
      },
      strict,
    ),
    Type.Object(
      { id, expectedRevision: revision, action: Type.Literal("cover"), humanId: id, assetId: id },
      strict,
    ),
    Type.Object(
      {
        id,
        expectedRevision: revision,
        action: Type.Literal("create"),
        humanId: Type.Optional(id),
        name: text(128),
        url: text(4096),
      },
      strict,
    ),
    Type.Object(
      {
        id,
        expectedRevision: revision,
        action: Type.Union([
          Type.Literal("refresh"),
          Type.Literal("remove"),
          Type.Literal("retry"),
        ]),
        assetId: id,
      },
      strict,
    ),
  ]),
  channelSave: Type.Object(
    {
      id: Type.Optional(id),
      expectedRevision: revision,
      fields: ChannelFields,
      filingKeys: Type.Optional(
        Type.Object({ accessKey: text(8192), secretKey: text(8192) }, strict),
      ),
      approve: Type.Boolean(),
      secret: Type.Optional(text(8192)),
      secretKey: Type.Optional(text(8192)),
    },
    strict,
  ),
  channelKeys: Type.Object(
    {
      id,
      expectedRevision: revision,
      secret: Type.Optional(text(8192)),
      secretKey: Type.Optional(text(8192)),
      clearSecret: Type.Optional(Type.Boolean()),
      clearSecretKey: Type.Optional(Type.Boolean()),
    },
    strict,
  ),
  channelRemove: Type.Object(
    {
      id,
      expectedRevision: revision,
      migration: Type.Optional(
        Type.Object(
          {
            targetId: id,
            targetRevision: revision,
            models: Type.Array(Type.Object({ id, expectedRevision: revision }, strict), {
              minItems: 1,
            }),
          },
          strict,
        ),
      ),
    },
    strict,
  ),
  channelReorder: Type.Object(
    {
      order: Type.Array(Type.Object({ id, expectedRevision: revision }, strict), {
        minItems: 1,
        maxItems: 100001,
      }),
    },
    strict,
  ),
  channelCatalog: Type.Object(
    {
      id,
      expectedRevision: revision,
    },
    strict,
  ),
  modelDraftRead: Type.Object({ id, expectedRevision: revision }, strict),
  modelLimits: Type.Object(
    { id, expectedRevision: revision, name: ProviderFields.properties.model },
    strict,
  ),
  modelSave: Type.Object(
    {
      id: Type.Optional(id),
      expectedRevision: revision,
      channelId: id,
      channelRevision: revision,
      pluginHash: Type.Optional(hash),
      moveFrom: Type.Optional(Type.Object({ id, revision }, strict)),
      documentText: Type.Optional(text(262144)),
      approvedAuthHash: Type.Optional(hash),
      upstreamModel: ProviderFields.properties.model,
      config: ModelConfig,
      settings: ProviderFields.properties.channel,
      enabled: Type.Boolean(),
      approve: Type.Optional(Type.Boolean()),
    },
    strict,
  ),
  modelImport: Type.Object(
    {
      id,
      expectedRevision: revision,
      models: Type.Array(ProviderFields.properties.model, { minItems: 1, maxItems: 500 }),
    },
    strict,
  ),
  modelToggle: Type.Object({ id, expectedRevision: revision, enabled: Type.Boolean() }, strict),
  modelReorder: Type.Object(
    {
      channelId: id,
      channelRevision: revision,
      order: Type.Array(Type.Object({ id, expectedRevision: revision }, strict), {
        minItems: 2,
        maxItems: 100001,
      }),
    },
    strict,
  ),
  modelRemove: Type.Object({ id, expectedRevision: revision }, strict),
  modelPendingEdit: Type.Object(
    {
      id,
      expectedRevision: revision,
      sourceId: id,
      sourceRevision: revision,
      moveTo: Type.Optional(Type.Object({ id, revision }, strict)),
      deadline: ModelConfig.properties.timeoutSeconds,
    },
    strict,
  ),
  modelMove: Type.Object(
    {
      id,
      expectedRevision: revision,
      sourceId: id,
      sourceRevision: revision,
      targetId: id,
      targetRevision: revision,
    },
    strict,
  ),
  draft: Type.Object({ source: text(providerPluginSourceLimit) }, strict),
  pluginUpload: Type.Object({ source: text(providerPluginSourceLimit) }, strict),
  pluginDetail: Type.Object({ key: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }) }, strict),
  pluginPinnedModels: Type.Object(
    { key: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }) },
    strict,
  ),
  pluginDeleteCheck: Type.Object(
    { key: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }) },
    strict,
  ),
  pluginUpgradeOptions: Type.Object(
    { key: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }) },
    strict,
  ),
  pluginCheck: Type.Object(
    {
      source: text(providerPluginSourceLimit),
      sample: Type.Optional(text(64 * 1024)),
    },
    strict,
  ),
  pluginToggle: Type.Union([
    Type.Object({ hash, enabled: Type.Boolean() }, strict),
    Type.Object(
      { key: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }), enabled: Type.Boolean() },
      strict,
    ),
  ]),
  pluginRemove: Type.Union([
    Type.Object({ hash, allVersions: Type.Optional(Type.Boolean()) }, strict),
    Type.Object(
      {
        key: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }),
        allVersions: Type.Literal(true),
      },
      strict,
    ),
    Type.Object(
      {
        key: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }),
        version: Type.String({ pattern: "^[0-9A-Za-z.-]{1,32}$" }),
        allVersions: Type.Literal(false),
      },
      strict,
    ),
  ]),
  pluginUpgradeAll: Type.Object(
    { key: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }), approve: Type.Literal(true) },
    strict,
  ),
  pluginUpgrade: Type.Object(
    {
      fromHash: hash,
      toHash: hash,
      approve: Type.Literal(true),
      models: Type.Optional(
        Type.Array(
          Type.Object(
            { id, expectedRevision: revision, model: ProviderFields.properties.model },
            strict,
          ),
          { minItems: 1 },
        ),
      ),
    },
    strict,
  ),
  catalog: Type.Object({ id, expectedRevision: revision }, strict),
  catalogDraft: Type.Object(
    {
      pluginHash: hash,
      endpoint: ProviderFields.properties.endpoint,
      allowLocal: Type.Boolean(),
      channel: ProviderFields.properties.channel,
      approve: Type.Literal(true),
      secret: Type.Optional(text(8192)),
    },
    strict,
  ),
  addModels: Type.Object(
    {
      id: Type.Optional(id),
      expectedRevision: revision,
      models: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        minItems: 1,
        maxItems: 100,
      }),
      agentEnabled: Type.Boolean(),
      connection: Type.Optional(SaveProvider),
    },
    strict,
  ),
  save: SaveProvider,
  disable: Type.Object({ id, expectedRevision: revision }, strict),
  test: Type.Object({ id, expectedRevision: revision }, strict),
  modelTrialProgress: Type.Object({ runId: id }, strict),
  modelTrialResult: Type.Object(
    { id, expectedRevision: revision, runId: Type.Optional(id) },
    strict,
  ),
  modelTrialTrace: Type.Object({ id, expectedRevision: revision, runId: id }, strict),
  modelTrial: Type.Object(
    {
      id,
      runId: Type.Optional(id),
      expectedRevision: revision,
      dry: Type.Boolean(),
      prompt: Type.String({ minLength: 1, maxLength: 2 * maximumModelPromptLength }),
      params: Type.Pick(
        GenerationInput,
        [
          "size",
          "duration",
          "count",
          "quality",
          "aspectRatio",
          "resolution",
          "generateAudio",
          "seed",
          "negativePrompt",
          "audioFormat",
          "speaker",
          "sampleRate",
          "speechRate",
          "loudnessRate",
          "pitchRate",
          "makeInstrumental",
          "customParams",
        ],
        strict,
      ),
      references: Type.Optional(
        Type.Array(
          Type.Object(
            {
              kind: Type.Union([
                Type.Literal("image"),
                Type.Literal("video"),
                Type.Literal("audio"),
              ]),
              url: Type.Optional(text(4096)),
              file: Type.Optional(
                Type.Object({ mime: text(80), base64: text(14 * 1024 * 1024) }, strict),
              ),
            },
            strict,
          ),
          { maxItems: 12 },
        ),
      ),
      op: Type.Optional(GenerationInput.properties.op),
    },
    strict,
  ),
  agentTestConnection: Type.Object({ id, expectedRevision: revision }, strict),
  agentList: Type.Object({}, strict),
  agentCreate: Type.Object({}, strict),
  agentFeedback: Type.Object({ sessionId: id, runId: id, value: feedbackValue }, strict),
  agentPreferences: Type.Object(
    { showThinking: Type.Optional(Type.Boolean()), modelId: Type.Optional(id) },
    strict,
  ),
  agentNoticePermission: Type.Object({ allow: Type.Optional(Type.Boolean()) }, strict),
  agentLayout: Type.Partial(AgentLayout, strict),
  canvasView: Type.Partial(CanvasViewPreferences, strict),
  agentRename: Type.Object(
    { sessionId: id, title: Type.String({ minLength: 1, maxLength: 40 }) },
    strict,
  ),
  agentRemove: Type.Object({ sessionId: id }, strict),
  agentState: Type.Object(
    { sessionId: id, after: revision, before: Type.Optional(revision) },
    strict,
  ),
  agentSend: Type.Object(
    {
      sessionId: id,
      providerId: id,
      contextId: Type.Optional(id),
      channelId: Type.Optional(id),
      pluginHash: Type.Optional(hash),
      route: Type.Optional(Type.Union([Type.Literal("adapters"), Type.Literal("providers")])),
      message: Type.String({ minLength: 1, maxLength: 24000 }),
      runId: Type.Optional(id),
    },
    strict,
  ),
  agentStop: Type.Object({ sessionId: id, runId: id }, strict),
  agentContinue: Type.Object({ sessionId: id, runId: id }, strict),
  agentConfigureSecret: Type.Object(
    { sessionId: id, approvalId: id, secret: Type.String({ minLength: 1, maxLength: 8192 }) },
    strict,
  ),
  agentDecide: Type.Object(
    {
      sessionId: id,
      approvalId: id,
      selected: Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), {
        maxItems: 20,
        uniqueItems: true,
      }),
      confirmTest: Type.Optional(Type.Boolean()),
      answers: Type.Optional(CanvasAgentAnswers),
      answer: Type.Optional(Type.String({ maxLength: 2000 })),
    },
    strict,
  ),
};
export type SettingsMethod = keyof typeof settingsRequests;
export type SettingsInput<Method extends SettingsMethod> = Static<
  (typeof settingsRequests)[Method]
>;
export type SettingsEvent = {
  feedback?: RunRating;
  seq: number;
  runId: string;
  approvalId?: string;
  type: string;
  payload: unknown;
  createdAt?: number;
};
export type SettingsApproval = { id: string; kind: string; status: string; payload: unknown };
export type ChangeValue = string | number | boolean | null;
export type SettingsFieldDiff = { field: string; before: ChangeValue; after: ChangeValue };
export type SettingsPluginReview = {
  label: string;
  key: string;
  versionBefore: string | null;
  versionAfter: string;
  lines: number;
  meta: string;
  request?: { method: string; url: string };
  codeDiff: string;
  diff: SettingsFieldDiff[];
};
export type SettingsChangeReceipt = {
  applied: number;
  skipped: number;
  order: string;
  appliedAt: string;
  target: "model" | "plugin";
  key: string;
  navigable: boolean;
  revision?: number;
  reversible: boolean;
  items: (SettingsFieldDiff & {
    status: "applied" | "rejected";
    label?: string;
    diff?: SettingsFieldDiff[];
  })[];
};
export interface CanvasWatchBatch {
  batch_id: string;
  state: "waiting" | "deliverable" | "delivered" | "canceled";
  total: number;
  settled: number;
  tasks: {
    task_id: string;
    node_id: string;
    label: string;
    status: "pending" | "settled";
    task_status?: string;
  }[];
}

export interface SettingsValues {
  dramaPromptLibrary: { entries: DramaPromptEntry[]; saved?: string };
  list: { providers: ProviderView[]; plugins: PluginView[] };
  channelList: ChannelView[];
  channelLoads: { channel: string; running: number; waiting: number }[];
  filingStorage: Omit<SettingsInput<"filingStorageSave">, "accessKey" | "secretKey"> | null;
  filingStorageSave: NonNullable<SettingsValues["filingStorage"]>;
  filingPreview: string | null;
  filingAssets: {
    id: string;
    name: string;
    humanId: string;
    humanName: string;
    cover: boolean;
    hasSource: boolean;
    order: number;
    refs: { project: string; node: string; title: string; name: string }[];
    canRetry: boolean;
    error?: string;
    status: "processing" | "active" | "failed";
  }[];
  channelSave: ChannelView;
  channelKeys: ChannelView;
  channelRemove: { removed: true };
  channelReorder: ChannelView[];
  channelCatalog: { models: { id: string; exists: boolean }[] };
  modelSave: ProviderView & { issues?: { field: string; text: string }[] };
  modelDraftRead: { text: string; document: string };
  modelLimits: (
    | { found: false }
    | { found: true; source: "builtin" | "upstream"; window: number; output: number }
  ) & { vision?: boolean; video?: boolean };
  modelImport: { added: number; prefixed?: number };
  modelToggle: ProviderView;
  modelReorder: { saved: true };
  modelRemove: { removed: true };
  modelMove: ProviderView;
  modelPendingEdit: { issues: { path: string; message: string }[] };
  draft: PluginView;
  pluginUpload: { plugin: PluginView; requestedVersion?: string };
  pluginDetail: (PluginView & { modelCount: number })[];
  pluginPinnedModels: {
    id: string;
    modelKey?: string;
    name: string;
    hash: string;
    channelId?: string;
  }[];
  pluginDeleteCheck: {
    builtin: boolean;
    models: { id: string; modelKey?: string; name: string }[];
    jobs: number;
  };
  pluginUpgradeOptions: {
    id: string;
    model: string;
    name: string;
    channel: string;
    version: string;
  }[];
  pluginCheck: {
    ok: boolean;
    checkedHooks: string[];
    inputMedia: Record<string, number>;
    issues: string[];
    logs: string[];
    unknownHooks: string[];
  };
  pluginToggle: PluginView;
  pluginRemove: { removed: true };
  pluginUpgrade: { upgraded: number; failed: { id: string; model: string; code: string }[] };
  pluginUpgradeAll: {
    upgraded: number;
    toVersion: string;
    failed: { id: string; model: string; code: string; reason?: string }[];
  };
  catalog: { models: string[] };
  catalogDraft: { models: string[] };
  addModels: { added: number; anchor: ProviderView };
  save: ProviderView;
  disable: ProviderView;
  test: { tested: true };
  modelTrialProgress: {
    phase: string;
    percent?: number;
    trace: SettingsValues["modelTrial"]["trace"];
  } | null;
  modelTrialTrace: SettingsValues["modelTrial"]["trace"] | null;
  modelTrialResult: {
    runId: string;
    expiresAt: number;
    progress?: NonNullable<SettingsValues["modelTrialProgress"]>;
    result?: SettingsValues["modelTrial"];
  } | null;
  modelTrial: {
    status: "preview" | "succeeded" | "failed" | "unknown";
    request?: { method: string; endpoint: string; body?: string; responseType: string };
    trace: {
      id: string;
      phase: string;
      kind: "http" | "hook";
      hook?: string;
      responseBody?: { text: string; truncated: boolean };
      requestHeaders?: { text: string; truncated: boolean };
      requestBody?: { text: string; truncated: boolean };
      hookInput?: { text: string; truncated: boolean };
      hookOutput?: { text: string; truncated: boolean };
      hookLogs?: { text: string; truncated: boolean };
      method?: string;
      endpoint?: string;
      error?: string;
      seq: number;
      status?: number;
      durationMs?: number;
    }[];
    logs: string[];
    outputs: {
      id: string;
      text?: string;
      mediaType?: string;
      image?: string;
      previewUrl?: string;
    }[];
    error?: string;
    errorMessage?: string;
  };
  agentTestConnection: { tested: true; durationMs: number };
  agentList: { id: string; title: string }[];
  agentCreate: { sessionId: string };
  agentFeedback: { saved: true };
  agentPreferences: { showThinking: boolean; modelId: string };
  agentNoticePermission: { permission: "default" | "granted" | "denied" };
  agentLayout: AgentLayout;
  canvasView: CanvasViewPreferences;
  agentRename: { title: string };
  agentRemove: { removed: boolean };
  agentState: {
    watches?: CanvasWatchBatch[];
    hasMoreOlder?: boolean;
    events: SettingsEvent[];
    title: string;
    activeRun?: string;
    activeStatus?: string;
    otherActiveSession?: string;
    approvals: SettingsApproval[];
    partial?: { runId: string; text: string; hasThinking?: boolean };
    compacting?: boolean;
  };
  agentSend: { sent: true };
  agentStop: { stopped: true };
  agentContinue: { continued: true };
  agentConfigureSecret: { decided: true };
  agentDecide: { decided: true };
}
export type SettingsAPI = {
  [Method in SettingsMethod]: (
    input: SettingsInput<Method>,
  ) => Promise<
    | { ok: true; value: SettingsValues[Method] }
    | { ok: false; code: string; issues?: { path: string; message: string }[] }
  >;
};
