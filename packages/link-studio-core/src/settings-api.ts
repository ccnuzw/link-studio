import { type Static, Type } from "@sinclair/typebox";
import { GenerationInput } from "./generation.ts";
import { ModelConfig } from "./model-config.ts";

const strict = { additionalProperties: false };
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
export type ProviderView = ProviderFields & {
  id: string;
  channelId?: string;
  channelEnabled?: boolean;
  pending?: true;
  pendingSort?: number;
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
    name: Type.String({ minLength: 1, maxLength: 120 }),
    endpoint: ProviderFields.properties.endpoint,
    allowLocal: Type.Boolean(),
    enabled: Type.Boolean(),
    sort: Type.Integer({ minimum: 0, maximum: 100000 }),
    headers: Type.Array(Type.Object({ name: text(80), value: text(1024) }, strict), {
      maxItems: 32,
    }),
    rps: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    concurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    running: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  strict,
);
export type ChannelFields = Static<typeof ChannelFields>;
export type ChannelView = Omit<ChannelFields, "headers"> & {
  headers: { name: string }[];
  id: string;
  revision: number;
  hasSecret: boolean;
  hasSecretKey: boolean;
};
export type PluginView = {
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
      value: Type.Union([text(256), Type.Number(), Type.Boolean()]),
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
export const settingsRequests = {
  list: Type.Object({}, strict),
  channelList: Type.Object({}, strict),
  channelSave: Type.Object(
    {
      id: Type.Optional(id),
      expectedRevision: revision,
      fields: ChannelFields,
      approve: Type.Boolean(),
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
  channelRemove: Type.Object({ id, expectedRevision: revision }, strict),
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
  modelSave: Type.Object(
    {
      id: Type.Optional(id),
      expectedRevision: revision,
      channelId: id,
      channelRevision: revision,
      pluginHash: Type.Optional(hash),
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
  draft: Type.Object({ source: text(providerPluginSourceLimit) }, strict),
  pluginCheck: Type.Object(
    {
      source: text(providerPluginSourceLimit),
      sample: Type.Optional(text(64 * 1024)),
    },
    strict,
  ),
  pluginToggle: Type.Object({ hash, enabled: Type.Boolean() }, strict),
  pluginRemove: Type.Object({ hash }, strict),
  pluginUpgrade: Type.Object({ fromHash: hash, toHash: hash, approve: Type.Literal(true) }, strict),
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
  modelTrial: Type.Object(
    {
      id,
      expectedRevision: revision,
      dry: Type.Boolean(),
      prompt: Type.String({ minLength: 1, maxLength: 16000 }),
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
  agentState: Type.Object({ sessionId: id, after: revision }, strict),
  agentSend: Type.Object(
    {
      sessionId: id,
      providerId: id,
      contextId: Type.Optional(id),
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
    },
    strict,
  ),
};
export type SettingsMethod = keyof typeof settingsRequests;
export type SettingsInput<Method extends SettingsMethod> = Static<
  (typeof settingsRequests)[Method]
>;
export type SettingsEvent = { seq: number; runId: string; type: string; payload: unknown };
export type SettingsApproval = { id: string; kind: string; status: string; payload: unknown };
export interface SettingsValues {
  list: { providers: ProviderView[]; plugins: PluginView[] };
  channelList: ChannelView[];
  channelSave: ChannelView;
  channelKeys: ChannelView;
  channelRemove: { removed: true };
  channelReorder: ChannelView[];
  channelCatalog: { models: { id: string; exists: boolean }[] };
  modelSave: ProviderView;
  modelImport: { added: number };
  modelToggle: ProviderView;
  modelReorder: { saved: true };
  modelRemove: { removed: true };
  draft: PluginView;
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
  catalog: { models: string[] };
  catalogDraft: { models: string[] };
  addModels: { added: number; anchor: ProviderView };
  save: ProviderView;
  disable: ProviderView;
  test: { tested: true };
  modelTrial: {
    status: "preview" | "succeeded" | "failed" | "unknown";
    request?: { method: string; endpoint: string; body?: string; responseType: string };
    trace: { id: string; phase: string; method: string; endpoint: string; status?: number }[];
    logs: string[];
    outputs: { id: string; text?: string; mediaType?: string; image?: string }[];
    error?: string;
  };
  agentTestConnection: { tested: true; durationMs: number };
  agentList: { id: string; title: string }[];
  agentCreate: { sessionId: string };
  agentState: {
    events: SettingsEvent[];
    title: string;
    activeRun?: string;
    activeStatus?: string;
    otherActiveSession?: string;
    approvals: SettingsApproval[];
    partial?: { runId: string; text: string };
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
  ) => Promise<{ ok: true; value: SettingsValues[Method] } | { ok: false; code: string }>;
};
