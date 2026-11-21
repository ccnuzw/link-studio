import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Value } from "@sinclair/typebox/value";
import { validModelCapabilities } from "../../../packages/link-studio-core/src/media-generation.ts";
import {
  type ChannelFields,
  type ChannelView,
  type PluginView,
  type ProviderFields,
  type ProviderView,
  type SettingsInput,
  SettingsProposal,
} from "../../../packages/link-studio-core/src/settings-api.ts";
import { checkDraft } from "../../../packages/provider-runtime/src/draft.ts";
import { buildHostRequest, ProviderHost } from "../../../packages/provider-runtime/src/host.ts";
import { inspectPlugin, type PluginInfo } from "../../../packages/provider-runtime/src/plugin.ts";
import {
  PluginRunner,
  ProviderError,
  record,
  sourceHash,
} from "../../../packages/provider-runtime/src/runner.ts";
import { canonicalJson } from "../project/encoding.ts";
import { fetchModelCatalog } from "./model-catalog.ts";
import { ChannelLimits, endpointURL, openProviderResponse, providerTransport } from "./network.ts";
import { nextPluginVersion } from "./plugin-version.ts";

export interface SecretStore {
  encrypt(secret: string): Uint8Array;
  decrypt(ciphertext: Uint8Array): string;
}

type Origin = PluginView["origin"];
type ProviderRecord = Omit<ProviderView, "hasSecret" | "hasSecretKey">;
type ChannelRecord = ChannelFields & { id: string; revision: number };
type StoredProvider = {
  profile: ProviderRecord;
  ciphertext: Uint8Array | null;
  secretKeyCiphertext: Uint8Array | null;
};

function digest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function view(row: StoredProvider): ProviderView {
  return {
    ...row.profile,
    hasSecret: row.ciphertext !== null,
    hasSecretKey: row.secretKeyCiphertext !== null,
  };
}

const vertexEndpointDefaults = {
  tokenUrl: "https://oauth2.googleapis.com/token",
  gcsBaseUrl: "https://storage.googleapis.com",
};

function vertexEndpointsChanged(
  before: ProviderFields["channel"],
  after: ProviderFields["channel"],
) {
  return Object.entries(vertexEndpointDefaults).some(
    ([key, fallback]) => (before[key] || fallback) !== (after[key] || fallback),
  );
}

export class SettingsRegistry {
  get pluginRunner() {
    return this.runner;
  }
  private readonly requestLimits = new ChannelLimits();
  private readonly generationLimits = new ChannelLimits();
  private constructor(
    private readonly database: DatabaseSync,
    private readonly secrets: SecretStore,
    private readonly runner: PluginRunner,
  ) {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 3000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS plugin_versions(hash TEXT PRIMARY KEY, manifest TEXT NOT NULL, origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS disabled_plugins(hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS provider_profiles(id TEXT PRIMARY KEY, profile TEXT NOT NULL, ciphertext BLOB);
      CREATE TABLE IF NOT EXISTS provider_secret_keys(id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS model_channels(id TEXT PRIMARY KEY, config TEXT NOT NULL, ciphertext BLOB);
      CREATE TABLE IF NOT EXISTS settings_receipts(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
    `);
  }

  static async open(
    directory: string,
    pluginDirectory: string,
    runner: string,
    secrets: SecretStore,
  ) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(join(directory, "settings.sqlite"));
    const registry = new SettingsRegistry(database, secrets, new PluginRunner(runner));
    try {
      for (const name of [
        "agnes-image",
        "agnes-video",
        "alibaba-image",
        "alibaba-video",
        "anthropic",
        "doubao-audio",
        "doubao-image",
        "doubao-video",
        "google",
        "hailuo",
        "incho",
        "jimeng",
        "kling",
        "new-api-video",
        "openai-chat-image",
        "openai-image",
        "openai",
        "sora",
        "sunoapi-lyrics",
        "sunoapi-music",
        "vertex-ai",
        "vidu",
        "xai",
      ]) {
        const source = await readFile(join(pluginDirectory, `${name}.js`), "utf8");
        if (!registry.lookupPlugin(sourceHash(source))) await registry.draft(source, "builtin");
      }
      return registry;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close() {
    this.database.close();
  }

  redactor() {
    const secrets = this.database
      .prepare(`SELECT ciphertext FROM provider_profiles WHERE ciphertext IS NOT NULL
        UNION ALL SELECT ciphertext FROM provider_secret_keys
        UNION ALL SELECT ciphertext FROM model_channels WHERE ciphertext IS NOT NULL`)
      .all()
      .map(({ ciphertext }) => this.secrets.decrypt(ciphertext as Uint8Array))
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    const redact = (value: string) => {
      let clean = value;
      for (const secret of secrets) clean = clean.replaceAll(secret, "[凭证已移除]");
      return clean.replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[A-Za-z0-9._~-]{10,})/gi, "[凭证已移除]");
    };
    return { secrets, redact };
  }

  redact(value: string) {
    return this.redactor().redact(value);
  }

  private lookupPlugin(hash: string) {
    const row = this.database
      .prepare("SELECT manifest, origin FROM plugin_versions WHERE hash = ?")
      .get(hash);
    return row
      ? {
          info: JSON.parse(String(row.manifest)) as PluginInfo,
          origin: String(row.origin) as Origin,
        }
      : undefined;
  }

  private plugin(hash: string) {
    const row = this.lookupPlugin(hash);
    if (!row || sourceHash(row.info.source) !== hash)
      throw new ProviderError("PLUGIN_VERSION_MISSING");
    return row;
  }

  private pluginView({ info, origin }: { info: PluginInfo; origin: Origin }): PluginView {
    return {
      hash: info.hash,
      key: info.key,
      name: String(info.meta.name),
      version: String(info.meta.version ?? "1"),
      kind: info.kind,
      apiVersion: Number(info.meta.apiVersion),
      mode: info.mode,
      disabled: this.pluginDisabled(info.hash),
      auth: info.auth.type,
      authName: info.auth.name,
      poll: info.meta.poll as PluginView["poll"],
      vendor: typeof info.meta.vendor === "string" ? info.meta.vendor : undefined,
      description: typeof info.meta.description === "string" ? info.meta.description : undefined,
      endpoint: (() => {
        const endpoint = record(info.meta.endpoints)[info.kind];
        const details = endpoint && typeof endpoint === "object" ? record(endpoint) : undefined;
        return details
          ? {
              ...(typeof details.method === "string" ? { method: details.method } : {}),
              ...(typeof details.path === "string" ? { path: details.path } : {}),
            }
          : undefined;
      })(),
      hooks: info.hooks,
      unknownHooks: info.unknownHooks,
      origin,
      source: info.source,
      fields: (info.meta.channelSettings ?? {}) as PluginView["fields"],
    };
  }

  async inspect(source: string) {
    return inspectPlugin(this.runner, source);
  }

  pluginCheck({ source, sample }: SettingsInput<"pluginCheck">) {
    return checkDraft(this.runner, source, sample);
  }

  private insertPlugin(info: PluginInfo, origin: Origin) {
    const existing = this.lookupPlugin(info.hash);
    if (existing && origin !== "builtin") throw new ProviderError("PLUGIN_VERSION_DUPLICATE");
    const versions = this.database
      .prepare(
        "SELECT json_extract(manifest, '$.meta.version') AS version FROM plugin_versions WHERE json_extract(manifest, '$.key') = ?",
      )
      .all(info.key);
    info = {
      ...info,
      meta: {
        ...info.meta,
        version: nextPluginVersion(
          info.meta.version,
          versions.map(({ version }) => version),
        ),
      },
    };
    this.database
      .prepare("INSERT OR IGNORE INTO plugin_versions VALUES (?, ?, ?)")
      .run(info.hash, JSON.stringify(info), origin);
    return this.pluginView(this.plugin(info.hash));
  }

  async draft(source: string, origin: Origin = "manual") {
    return this.insertPlugin(await this.inspect(source), origin);
  }

  private pluginDisabled(hash: string) {
    return Boolean(
      this.database.prepare("SELECT 1 FROM disabled_plugins WHERE hash = ?").get(hash),
    );
  }

  private pluginReferences(hash: string) {
    return this.database
      .prepare(
        "SELECT profile FROM provider_profiles WHERE json_extract(profile, '$.pluginHash') = ?",
      )
      .all(hash)
      .map(({ profile }) => JSON.parse(String(profile)) as ProviderRecord);
  }

  pluginToggle({ hash, enabled }: SettingsInput<"pluginToggle">) {
    const plugin = this.plugin(hash);
    if (!enabled && this.pluginReferences(hash).some((profile) => profile.enabled))
      throw new ProviderError("PLUGIN_ACTIVE_REFERENCES");
    if (enabled) this.database.prepare("DELETE FROM disabled_plugins WHERE hash = ?").run(hash);
    else this.database.prepare("INSERT OR IGNORE INTO disabled_plugins VALUES (?)").run(hash);
    return this.pluginView(plugin);
  }

  pluginRemove({ hash }: SettingsInput<"pluginRemove">) {
    const plugin = this.plugin(hash);
    if (plugin.origin === "builtin") throw new ProviderError("PLUGIN_BUILTIN_LOCKED");
    if (this.pluginReferences(hash).length) throw new ProviderError("PLUGIN_REFERENCED");
    this.database.prepare("DELETE FROM plugin_versions WHERE hash = ?").run(hash);
    this.database.prepare("DELETE FROM disabled_plugins WHERE hash = ?").run(hash);
    return { removed: true } as const;
  }

  pluginUpgrade({ fromHash, toHash, approve }: SettingsInput<"pluginUpgrade">) {
    if (!approve) throw new ProviderError("PLUGIN_APPROVAL_REQUIRED");
    const from = this.plugin(fromHash);
    const to = this.plugin(toHash);
    if (this.pluginDisabled(toHash)) throw new ProviderError("PLUGIN_DISABLED");
    if (
      fromHash === toHash ||
      from.info.key !== to.info.key ||
      from.info.kind !== to.info.kind ||
      from.info.auth.type !== to.info.auth.type ||
      from.info.auth.name !== to.info.auth.name ||
      (from.info.auth.type === "custom" && (from.origin !== "builtin" || to.origin !== "builtin"))
    )
      throw new ProviderError("PLUGIN_UPGRADE_INCOMPATIBLE");
    const references = this.pluginReferences(fromHash);
    const roots = new Set(references.map((profile) => profile.connectionId ?? profile.id));
    const declared = this.pluginView(to).fields;
    let upgraded = 0;
    const failed: { id: string; model: string; code: string }[] = [];
    for (const id of roots) {
      const root = this.lookup(id);
      const group = references.filter((profile) => (profile.connectionId ?? profile.id) === id);
      try {
        if (
          !root ||
          root.profile.pluginHash !== fromHash ||
          this.connectionModels(id).some((child) => child.pluginHash !== fromHash)
        )
          throw new ProviderError("PROVIDER_SHARED_CONNECTION");
        this.atomic(() => {
          for (const profile of group) {
            const fields = this.fields(
              {
                ...profile,
                channel: Object.fromEntries(
                  Object.entries(profile.channel).filter(([key]) => Object.hasOwn(declared, key)),
                ),
                agentEnabled: profile.agentEnabled && to.origin === "builtin",
              },
              to.info,
              to.origin,
            );
            if (
              from.info.key === "vertex-ai" &&
              vertexEndpointsChanged(profile.channel, fields.channel)
            )
              throw new ProviderError("PLUGIN_UPGRADE_INCOMPATIBLE");
            this.write(
              { ...profile, ...fields, pluginHash: toHash, revision: profile.revision + 1 },
              root.ciphertext,
            );
          }
        });
        upgraded += group.length;
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "SETTINGS_ACTION_FAILED";
        failed.push(...group.map(({ id, model }) => ({ id, model, code })));
      }
    }
    return { upgraded, failed };
  }

  private lookup(id: string): StoredProvider | undefined {
    const row = this.database
      .prepare("SELECT profile, ciphertext FROM provider_profiles WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    let profile = JSON.parse(String(row.profile)) as ProviderRecord;
    const channel = profile.channelId ? this.readChannel(profile.channelId) : undefined;
    if (channel) {
      const { name, endpoint, allowLocal, enabled } = channel.fields;
      profile = { ...profile, label: name, endpoint, allowLocal, channelEnabled: enabled };
    }
    const ciphertext = channel
      ? channel.ciphertext
      : profile.connectionId
        ? this.database
            .prepare("SELECT ciphertext FROM provider_profiles WHERE id = ?")
            .get(profile.connectionId)?.ciphertext
        : row.ciphertext;
    const secretKey = this.database
      .prepare("SELECT ciphertext FROM provider_secret_keys WHERE id = ?")
      .get(profile.channelId ?? profile.connectionId ?? id);
    return {
      profile,
      ciphertext: (ciphertext as Uint8Array | null | undefined) ?? null,
      secretKeyCiphertext: (secretKey?.ciphertext as Uint8Array | undefined) ?? null,
    };
  }

  provider(id: string) {
    const row = this.lookup(id);
    if (!row) throw new ProviderError("PROVIDER_NOT_FOUND");
    return view(row);
  }

  list() {
    const providers = this.database
      .prepare("SELECT id FROM provider_profiles ORDER BY rowid")
      .all()
      .map(({ id }) => this.provider(String(id)));
    const plugins = this.database
      .prepare("SELECT hash FROM plugin_versions ORDER BY rowid")
      .all()
      .map(({ hash }) => this.pluginView(this.plugin(String(hash))));
    return { providers, plugins };
  }

  private fields(fields: ProviderFields, plugin: PluginInfo, origin: Origin): ProviderFields {
    const endpoint = endpointURL(fields.endpoint, fields.allowLocal).href.replace(/\/$/, "");
    if (!fields.label.trim() || !fields.model.trim() || /[\p{Cc}]/u.test(fields.model))
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    const channel: ProviderFields["channel"] = {};
    const declared = this.pluginView({ info: plugin, origin }).fields;
    const vertex = origin === "builtin" && plugin.key === "vertex-ai";
    const vertexEndpoints = Object.keys(vertexEndpointDefaults);
    for (const [name, value] of Object.entries(fields.channel)) {
      const field = Object.hasOwn(declared, name) ? declared[name] : undefined;
      if (
        !field ||
        (/(?:secret|password|token|api_?key|authorization)/i.test(name) &&
          !(vertex && vertexEndpoints.includes(name))) ||
        !(field.type === "enum"
          ? typeof value === "string" && field.options?.includes(value)
          : field.type === typeof value)
      )
        throw new ProviderError("PROVIDER_CONFIG_INVALID");
    }
    for (const [name, field] of Object.entries(declared)) {
      const value =
        (Object.hasOwn(fields.channel, name) ? fields.channel[name] : undefined) ?? field.default;
      if (field.required && (value === undefined || (typeof value === "string" && !value.trim())))
        throw new ProviderError("PROVIDER_CONFIG_INVALID");
      if (value === undefined) continue;
      if (vertex && vertexEndpoints.includes(name) && value) endpointURL(String(value), false);
      Object.defineProperty(channel, name, { value, enumerable: true });
    }
    if (fields.agentEnabled && (origin !== "builtin" || plugin.key !== "openai"))
      throw new ProviderError("AGENT_MODEL_INCOMPATIBLE");
    return {
      ...fields,
      agentVision: fields.agentEnabled && fields.agentVision === true,
      endpoint,
      label: fields.label.trim(),
      model: fields.model.trim(),
      channel,
    };
  }

  validateFields(fields: ProviderFields, hash: string) {
    const { info, origin } = this.plugin(hash);
    return this.fields(fields, info, origin);
  }

  private validateModelChange(previous: ProviderRecord, model: string) {
    if (model === previous.model) return;
    const rootId = previous.connectionId ?? previous.id;
    const models = previous.channelId
      ? this.modelsInChannel(previous.channelId)
      : [this.provider(rootId), ...this.connectionModels(rootId)];
    if (models.some((entry) => entry.id !== previous.id && entry.model === model))
      throw new ProviderError("PROVIDER_DUPLICATE_MODEL");
  }

  private write(profile: ProviderRecord, ciphertext: Uint8Array | null) {
    this.database
      .prepare(
        "INSERT INTO provider_profiles VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, ciphertext = excluded.ciphertext",
      )
      .run(
        profile.id,
        JSON.stringify(profile),
        profile.connectionId || profile.channelId ? null : ciphertext,
      );
    return this.provider(profile.id);
  }

  save(input: SettingsInput<"save">) {
    const previous = input.id ? this.lookup(input.id) : undefined;
    if (previous?.profile.channelId) throw new ProviderError("PROVIDER_SHARED_CONNECTION");
    if ((input.id && !previous) || (previous?.profile.revision ?? 0) !== input.expectedRevision)
      throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    const { info, origin } = this.plugin(input.pluginHash);
    if (this.pluginDisabled(info.hash)) throw new ProviderError("PLUGIN_DISABLED");
    const fields = this.fields(input.fields, info, origin);
    const vertex = origin === "builtin" && info.key === "vertex-ai";
    const changedVertexEndpoint =
      vertex && previous && vertexEndpointsChanged(previous.profile.channel, fields.channel);
    const changedTarget =
      !previous ||
      previous.profile.pluginHash !== info.hash ||
      previous.profile.endpoint !== fields.endpoint ||
      previous.profile.allowLocal !== fields.allowLocal ||
      changedVertexEndpoint;
    if ((changedTarget || !previous?.profile.enabled) && !input.approve)
      throw new ProviderError("PLUGIN_APPROVAL_REQUIRED");
    if (
      input.secret &&
      (input.clearSecret ||
        (!vertex && /[\r\n]/u.test(input.secret)) ||
        input.secret.includes(String.fromCharCode(0)))
    )
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    if (input.secret && info.auth.type === "none")
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    const secretKeyChanged = Boolean(input.secretKey || input.clearSecretKey);
    if (
      (secretKeyChanged && info.auth.type !== "custom") ||
      (input.secretKey &&
        (input.clearSecretKey ||
          /[\r\n]/u.test(input.secretKey) ||
          input.secretKey.includes(String.fromCharCode(0))))
    )
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    const parentId = previous?.profile.connectionId;
    if (
      parentId &&
      (changedTarget ||
        input.secret ||
        input.clearSecret ||
        secretKeyChanged ||
        fields.label !== previous?.profile.label)
    )
      throw new ProviderError("PROVIDER_SHARED_CONNECTION");
    const children = previous && !parentId ? this.connectionModels(previous.profile.id) : [];
    const adapterChanged = Boolean(previous && previous.profile.pluginHash !== info.hash);
    if (
      children.length &&
      previous &&
      adapterChanged &&
      this.plugin(previous.profile.pluginHash).info.kind !== info.kind
    )
      throw new ProviderError("PROVIDER_SHARED_ADAPTER");
    if (previous) this.validateModelChange(previous.profile, fields.model);
    const ciphertext = input.secret
      ? this.secrets.encrypt(input.secret)
      : input.clearSecret || changedTarget
        ? null
        : (previous?.ciphertext ?? null);
    const profile = {
      ...fields,
      id: input.id ?? randomUUID(),
      ...(parentId && { connectionId: parentId }),
      pluginHash: info.hash,
      enabled: true,
      revision: input.expectedRevision + 1,
    };
    if (
      !changedTarget &&
      !secretKeyChanged &&
      (!children.length ||
        (!input.secret && !input.clearSecret && fields.label === previous?.profile.label))
    )
      return this.write(profile, ciphertext);
    return this.atomic(() => {
      if (input.secretKey) {
        this.database
          .prepare(
            "INSERT INTO provider_secret_keys VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext",
          )
          .run(profile.id, this.secrets.encrypt(input.secretKey));
      } else if (input.clearSecretKey || (previous && changedTarget)) {
        this.database.prepare("DELETE FROM provider_secret_keys WHERE id = ?").run(profile.id);
      }
      const saved = this.write(profile, ciphertext);
      for (const child of children) {
        this.write(
          {
            ...child,
            label: fields.label,
            endpoint: fields.endpoint,
            allowLocal: fields.allowLocal,
            ...(changedVertexEndpoint && {
              channel: {
                ...child.channel,
                tokenUrl: fields.channel.tokenUrl ?? vertexEndpointDefaults.tokenUrl,
                gcsBaseUrl: fields.channel.gcsBaseUrl ?? vertexEndpointDefaults.gcsBaseUrl,
              },
            }),
            ...(adapterChanged && {
              pluginHash: info.hash,
              channel: fields.channel,
              agentEnabled: false,
              agentVision: false,
            }),
            revision: child.revision + 1,
          },
          ciphertext,
        );
      }
      return saved;
    });
  }

  private atomic<Result>(action: () => Result) {
    const nested = this.database.isTransaction;
    if (!nested) this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      if (!nested) this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (!nested) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readChannel(id: string) {
    const row = this.database
      .prepare("SELECT config, ciphertext FROM model_channels WHERE id = ?")
      .get(id);
    if (!row) throw new ProviderError("CHANNEL_NOT_FOUND");
    return {
      fields: JSON.parse(String(row.config)) as ChannelRecord,
      ciphertext: row.ciphertext as Uint8Array | null,
    };
  }

  private channelView(id: string): ChannelView {
    const { fields, ciphertext } = this.readChannel(id);
    return {
      ...fields,
      headers: fields.headers.map(({ name }) => ({ name })),
      hasSecret: ciphertext !== null,
      hasSecretKey: Boolean(
        this.database.prepare("SELECT 1 FROM provider_secret_keys WHERE id = ?").get(id),
      ),
    };
  }

  channelList() {
    return this.database
      .prepare("SELECT id FROM model_channels ORDER BY json_extract(config, '$.sort'), rowid")
      .all()
      .map(({ id }) => this.channelView(String(id)));
  }

  private checkedChannel(id: string, revision: number) {
    const current = this.readChannel(id);
    if (current.fields.revision !== revision) throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    return current;
  }

  private modelsInChannel(id: string) {
    return this.database
      .prepare(
        "SELECT profile FROM provider_profiles WHERE json_extract(profile, '$.channelId') = ?",
      )
      .all(id)
      .map(({ profile }) => JSON.parse(String(profile)) as ProviderRecord);
  }

  private saveChannel(fields: ChannelRecord, ciphertext: Uint8Array | null) {
    this.database
      .prepare(
        "INSERT INTO model_channels VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, ciphertext = excluded.ciphertext",
      )
      .run(fields.id, JSON.stringify(fields), ciphertext);
    return this.channelView(fields.id);
  }

  private touchChannelModels(id: string) {
    for (const profile of this.modelsInChannel(id))
      this.write({ ...profile, revision: profile.revision + 1 }, null);
  }

  channelSave({ id, expectedRevision, fields, approve }: SettingsInput<"channelSave">) {
    const previous = id ? this.checkedChannel(id, expectedRevision) : undefined;
    const endpoint = endpointURL(fields.endpoint, fields.allowLocal).href.replace(/\/$/, "");
    const changed =
      previous?.fields.endpoint !== endpoint || previous.fields.allowLocal !== fields.allowLocal;
    const name = fields.name.trim();
    if (!name || (changed && !approve)) throw new ProviderError("PLUGIN_APPROVAL_REQUIRED");
    const names = new Set<string>();
    const headers = fields.headers.map(({ name, value }) => {
      const key = name.trim().toLowerCase();
      if (
        !/^[a-z0-9-]+$/.test(key) ||
        /^(?:host|connection|content-.*|transfer-encoding|expect|upgrade|cookie|.*(?:auth|secret|token|api-key).*)$/.test(
          key,
        ) ||
        /[^\t\x20-\x7e]/.test(value) ||
        names.has(key)
      )
        throw new ProviderError("CHANNEL_HEADERS_INVALID");
      names.add(key);
      const retained = previous?.fields.headers.find((header) => header.name === key);
      return { name: key, value: value || (!changed ? retained?.value : undefined) || "" };
    });
    return this.atomic(() => {
      const channelId = id ?? randomUUID();
      const sort = previous?.fields.sort ?? Math.min(100000, this.channelList().at(-1)?.sort ?? 0);
      if (changed && previous)
        this.database.prepare("DELETE FROM provider_secret_keys WHERE id = ?").run(channelId);
      const result = this.saveChannel(
        { ...fields, name, endpoint, headers, sort, id: channelId, revision: expectedRevision + 1 },
        changed ? null : (previous?.ciphertext ?? null),
      );
      if (id) this.touchChannelModels(id);
      return result;
    });
  }

  channelKeys(input: SettingsInput<"channelKeys">) {
    const current = this.checkedChannel(input.id, input.expectedRevision);
    if (
      [input.secret, input.secretKey].some((value) => value?.includes("\0")) ||
      (input.secret && input.clearSecret) ||
      (input.secretKey && (input.clearSecretKey || /[\r\n]/.test(input.secretKey)))
    )
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    return this.atomic(() => {
      if (input.secretKey)
        this.database
          .prepare("INSERT OR REPLACE INTO provider_secret_keys VALUES (?, ?)")
          .run(input.id, this.secrets.encrypt(input.secretKey));
      else if (input.clearSecretKey)
        this.database.prepare("DELETE FROM provider_secret_keys WHERE id = ?").run(input.id);
      const result = this.saveChannel(
        { ...current.fields, revision: input.expectedRevision + 1 },
        input.secret
          ? this.secrets.encrypt(input.secret)
          : input.clearSecret
            ? null
            : current.ciphertext,
      );
      this.touchChannelModels(input.id);
      return result;
    });
  }

  channelRemove({ id, expectedRevision }: SettingsInput<"channelRemove">) {
    this.checkedChannel(id, expectedRevision);
    if (this.modelsInChannel(id).length) throw new ProviderError("CHANNEL_REFERENCED");
    return this.atomic(() => {
      this.database.prepare("DELETE FROM model_channels WHERE id = ?").run(id);
      this.database.prepare("DELETE FROM provider_secret_keys WHERE id = ?").run(id);
      return { removed: true } as const;
    });
  }

  channelReorder({ order }: SettingsInput<"channelReorder">) {
    return this.atomic(() => {
      const current = this.channelList();
      if (
        order.length !== current.length ||
        new Set(order.map(({ id }) => id)).size !== order.length
      )
        throw new ProviderError("SETTINGS_REVISION_CONFLICT");
      return order.map(({ id, expectedRevision }, sort) => {
        const { fields, ciphertext } = this.checkedChannel(id, expectedRevision);
        return fields.sort === sort
          ? this.channelView(id)
          : this.saveChannel({ ...fields, sort, revision: fields.revision + 1 }, ciphertext);
      });
    });
  }

  async channelCatalog({ id, expectedRevision }: SettingsInput<"channelCatalog">) {
    const { fields, ciphertext } = this.checkedChannel(id, expectedRevision);
    if (!fields.enabled) throw new ProviderError("CHANNEL_TARGET_UNAVAILABLE");
    if (!ciphertext) throw new ProviderError("PROVIDER_SECRET_MISSING");
    const secret = this.secrets.decrypt(ciphertext);
    const { models } = await fetchModelCatalog(
      {
        label: fields.name,
        model: "catalog",
        endpoint: fields.endpoint,
        allowLocal: fields.allowLocal,
        agentEnabled: false,
        channel: {},
      },
      { auth: { type: "bearer" } },
      secret,
      this.channelTransport(id),
    );
    this.checkedChannel(id, expectedRevision);
    const existing = new Set(this.modelsInChannel(id).map(({ model }) => model));
    const { redact } = this.redactor();
    return {
      models: models
        .filter((model) => redact(model) === model)
        .map((id) => ({ id, exists: existing.has(id) })),
    };
  }

  modelSave(input: SettingsInput<"modelSave">) {
    const { fields: channel, ciphertext } = this.checkedChannel(
      input.channelId,
      input.channelRevision,
    );
    const current = input.id ? this.lookup(input.id) : undefined;
    if (
      (input.id && current?.profile.channelId !== channel.id) ||
      (current?.profile.revision ?? 0) !== input.expectedRevision
    )
      throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    const config = { ...input.config, name: input.config.name.trim() };
    const agent = config.kind === "agent";
    const gateway = agent
      ? this.agentGateway(current?.profile.agentEnabled ? current.profile.pluginHash : undefined)
      : undefined;
    const pluginHash = agent ? gateway?.hash : input.pluginHash;
    if (!pluginHash) throw new ProviderError(agent ? "AGENT_MODEL_INCOMPATIBLE" : "MODEL_PENDING");
    const { info, origin } = this.plugin(pluginHash);
    if (
      !config.name ||
      (agent && input.pluginHash !== undefined) ||
      info.kind !== (agent ? "text" : config.kind) ||
      (input.enabled &&
        (this.pluginDisabled(info.hash) || (info.auth.type !== "none" && !ciphertext))) ||
      (config.maxOutputTokens &&
        config.contextWindow &&
        config.maxOutputTokens > config.contextWindow) ||
      (agent && config.timeoutSeconds && config.timeoutSeconds > 600)
    )
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    if (
      origin === "builtin" &&
      info.key === "vertex-ai" &&
      vertexEndpointsChanged(
        current?.profile.pluginHash === info.hash ? current.profile.channel : {},
        input.settings,
      ) &&
      !input.approve
    )
      throw new ProviderError("MODEL_ENDPOINT_APPROVAL_REQUIRED");
    if (agent && Object.keys(input.settings).some((key) => !["api", "pathPrefix"].includes(key)))
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    const fields = this.fields(
      {
        label: channel.name,
        endpoint: channel.endpoint,
        allowLocal: channel.allowLocal,
        model: input.upstreamModel,
        agentEnabled: agent,
        agentVision: config.vision,
        channel: agent ? { api: "chat_completions", ...input.settings } : input.settings,
      },
      info,
      origin,
    );
    if (
      !validModelCapabilities(
        config,
        origin === "builtin" ? info.key : undefined,
        fields.model,
        fields.channel,
      )
    )
      throw new ProviderError("MODEL_CAPABILITIES_INVALID");
    if (
      this.modelsInChannel(channel.id).some(
        (entry) =>
          entry.id !== input.id &&
          entry.model === fields.model &&
          (entry.pending || this.modelKind(entry) === config.kind),
      )
    )
      throw new ProviderError("PROVIDER_DUPLICATE_MODEL");
    return this.write(
      {
        ...fields,
        config,
        id: input.id ?? randomUUID(),
        channelId: channel.id,
        pluginHash: info.hash,
        enabled: input.enabled,
        revision: input.expectedRevision + 1,
      },
      null,
    );
  }

  private agentGateway(previousHash?: string) {
    const gateways = this.database
      .prepare("SELECT hash FROM plugin_versions WHERE origin = 'builtin' ORDER BY rowid DESC")
      .all()
      .map(({ hash }) => this.plugin(String(hash)).info)
      .filter(({ key, kind }) => key === "openai" && kind === "text");
    return (
      gateways.find(({ hash }) => hash === previousHash) ??
      gateways.find(({ hash }) => !this.pluginDisabled(hash)) ??
      gateways[0]
    );
  }

  modelImport(input: SettingsInput<"modelImport">) {
    const { fields } = this.checkedChannel(input.id, input.expectedRevision);
    const models = this.modelsInChannel(input.id);
    const existing = new Set(models.map(({ model }) => model));
    const lastSort = models.reduce(
      (max, model) => Math.max(max, model.config?.sort ?? model.pendingSort ?? 100),
      0,
    );
    const names = new Set(input.models.map((model) => model.trim()));
    const { redact } = this.redactor();
    if ([...names].some((name) => !name || /[\p{Cc}\p{Cf}]/u.test(name) || redact(name) !== name))
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    return this.atomic(() => {
      let added = 0;
      for (const name of names) {
        if (existing.has(name)) continue;
        this.write(
          {
            id: randomUUID(),
            revision: 1,
            pending: true,
            pendingSort: Math.min(100000, lastSort + added + 1),
            channelId: input.id,
            label: fields.name,
            endpoint: fields.endpoint,
            allowLocal: fields.allowLocal,
            pluginHash: "",
            model: name,
            channel: {},
            agentEnabled: false,
            enabled: false,
          },
          null,
        );
        added++;
      }
      return { added };
    });
  }

  modelToggle({ id, expectedRevision, enabled }: SettingsInput<"modelToggle">) {
    const current = this.lookup(id);
    if (!current?.profile.channelId || current.profile.revision !== expectedRevision)
      throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    if (current.profile.pending) {
      if (enabled) throw new ProviderError("MODEL_PENDING");
      return view(current);
    }
    const { info } = this.plugin(current.profile.pluginHash);
    if (
      enabled &&
      (this.pluginDisabled(info.hash) || (info.auth.type !== "none" && !current.ciphertext))
    )
      throw new ProviderError("PROVIDER_SECRET_MISSING");
    return this.write({ ...current.profile, enabled, revision: expectedRevision + 1 }, null);
  }

  modelReorder({ channelId, channelRevision, order }: SettingsInput<"modelReorder">) {
    return this.atomic(() => {
      this.checkedChannel(channelId, channelRevision);
      const profiles = new Map(this.modelsInChannel(channelId).map((model) => [model.id, model]));
      if (
        order.length !== profiles.size ||
        new Set(order.map(({ id }) => id)).size !== order.length
      )
        throw new ProviderError("SETTINGS_REVISION_CONFLICT");
      for (const [sort, { id, expectedRevision }] of order.entries()) {
        const profile = profiles.get(id);
        if (!profile || profile.revision !== expectedRevision)
          throw new ProviderError("SETTINGS_REVISION_CONFLICT");
        if ((profile.config?.sort ?? profile.pendingSort) === sort) continue;
        const position = profile.config
          ? { config: { ...profile.config, sort } }
          : { pendingSort: sort };
        this.write({ ...profile, ...position, revision: expectedRevision + 1 }, null);
      }
      return { saved: true } as const;
    });
  }

  modelRemove({ id, expectedRevision }: SettingsInput<"modelRemove">) {
    const current = this.lookup(id);
    if (
      !current?.profile.channelId ||
      current.profile.revision !== expectedRevision ||
      current.profile.enabled
    )
      throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    this.database.prepare("DELETE FROM provider_profiles WHERE id = ?").run(id);
    return { removed: true } as const;
  }

  private modelKind(profile: ProviderRecord) {
    if (profile.pending) return undefined;
    return (
      profile.config?.kind ??
      (profile.agentEnabled ? "agent" : this.plugin(profile.pluginHash).info.kind)
    );
  }

  channelTransport(
    id: string | undefined,
    normalize?: Parameters<typeof providerTransport>[2],
    binary?: Parameters<typeof providerTransport>[3],
  ) {
    if (!id) return undefined;
    const channel = this.readChannel(id).fields;
    const send = providerTransport(channel.endpoint, channel.allowLocal, normalize, binary);
    return this.wrapChannelTransport(id, send);
  }

  private channelRequest(
    channel: ChannelRecord,
    request: Parameters<typeof openProviderResponse>[2],
  ) {
    if (new URL(channel.endpoint).origin !== new URL(request.url).origin) return request;
    const headers = Object.fromEntries(channel.headers.map(({ name, value }) => [name, value]));
    for (const [name, value] of Object.entries(request.headers))
      headers[name.toLowerCase()] = value;
    return { ...request, headers };
  }

  wrapChannelTransport(
    id: string | undefined,
    send: ReturnType<typeof providerTransport>,
  ): ReturnType<typeof providerTransport> {
    if (!id) return send;
    const channel = this.readChannel(id).fields;
    return async (request, signal) => {
      const deadline = AbortSignal.timeout(request.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const release = await this.requestLimits.acquire(
        id,
        channel.concurrent,
        channel.rps,
        combined,
      );
      try {
        return await send(this.channelRequest(channel, request), combined);
      } finally {
        release();
      }
    };
  }

  async openChannelResponse(
    profile: ProviderRecord,
    request: Parameters<typeof openProviderResponse>[2],
    signal: AbortSignal,
  ) {
    if (!profile.channelId)
      return openProviderResponse(profile.endpoint, profile.allowLocal, request, signal);
    const channel = this.readChannel(profile.channelId).fields;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]);
    const release = await this.requestLimits.acquire(
      channel.id,
      channel.concurrent,
      channel.rps,
      combined,
    );
    try {
      const response = await openProviderResponse(
        profile.endpoint,
        profile.allowLocal,
        this.channelRequest(channel, request),
        combined,
      );
      if (response.destroyed) release();
      else response.once("close", release);
      return response;
    } catch (error) {
      release();
      throw error;
    }
  }

  acquireGeneration(id: string) {
    return this.generationLimits.tryAcquire(id, this.readChannel(id).fields.running);
  }

  private connectionModels(id: string) {
    return this.database
      .prepare(
        "SELECT profile FROM provider_profiles WHERE json_extract(profile, '$.connectionId') = ?",
      )
      .all(id)
      .map(({ profile }) => JSON.parse(String(profile)) as ProviderRecord);
  }

  async catalog({ id, expectedRevision }: SettingsInput<"catalog">) {
    const { profile, plugin, secret } = this.binding(id, expectedRevision);
    const result = await fetchModelCatalog(profile, plugin, secret);
    this.binding(id, expectedRevision);
    return result;
  }

  catalogDraft({
    pluginHash,
    endpoint,
    allowLocal,
    channel,
    secret,
  }: SettingsInput<"catalogDraft">) {
    const { info, origin } = this.plugin(pluginHash);
    if (this.pluginDisabled(pluginHash)) throw new ProviderError("PLUGIN_DISABLED");
    if (info.auth.type !== "none" && !secret) throw new ProviderError("PROVIDER_SECRET_MISSING");
    const fields = this.fields(
      { label: "catalog", model: "catalog", endpoint, allowLocal, channel, agentEnabled: false },
      info,
      origin,
    );
    return fetchModelCatalog(fields, info, info.auth.type === "none" ? undefined : secret);
  }

  addModels({
    id,
    expectedRevision,
    models,
    agentEnabled,
    connection,
  }: SettingsInput<"addModels">) {
    return this.atomic(() => {
      if (connection && (connection.id !== id || connection.expectedRevision !== expectedRevision))
        throw new ProviderError("SETTINGS_REVISION_CONFLICT");
      const saved = connection && this.save(connection);
      const anchorId = saved?.id ?? id;
      if (!anchorId) throw new ProviderError("PROVIDER_NOT_FOUND");
      const { profile, plugin, origin } = this.binding(
        anchorId,
        saved?.revision ?? expectedRevision,
      );
      const rootId = profile.connectionId ?? profile.id;
      const existing = new Set([
        this.provider(rootId).model,
        ...this.connectionModels(rootId).map(({ model }) => model),
      ]);
      let added = saved && !id ? 1 : 0;
      for (const model of models) {
        const {
          id: _,
          revision: _revision,
          enabled: _enabled,
          pluginHash: _pluginHash,
          connectionId: _connectionId,
          ...base
        } = profile;
        const fields = this.fields(
          { ...base, model, agentEnabled, agentVision: false },
          plugin,
          origin,
        );
        if (existing.has(fields.model)) continue;
        existing.add(fields.model);
        this.write(
          {
            ...fields,
            id: randomUUID(),
            connectionId: rootId,
            revision: 1,
            pluginHash: plugin.hash,
            enabled: true,
          },
          null,
        );
        added++;
      }
      return { added, anchor: this.provider(anchorId) };
    });
  }

  disable({ id, expectedRevision }: SettingsInput<"disable">) {
    const current = this.lookup(id);
    if (!current || current.profile.revision !== expectedRevision)
      throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    return this.write(
      { ...current.profile, enabled: false, revision: expectedRevision + 1 },
      current.ciphertext,
    );
  }

  binding(id: string, revision: number) {
    return this.resolveBinding(id, revision, false);
  }

  trialBinding(id: string, revision: number) {
    return this.resolveBinding(id, revision, true);
  }

  private resolveBinding(id: string, revision: number, trial: boolean) {
    const row = this.lookup(id);
    if (
      !row ||
      row.profile.pending ||
      (!row.profile.enabled && !(trial && row.profile.channelId)) ||
      row.profile.channelEnabled === false ||
      row.profile.revision !== revision
    )
      throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    const { info: plugin, origin } = this.plugin(row.profile.pluginHash);
    if (this.pluginDisabled(plugin.hash)) throw new ProviderError("PLUGIN_DISABLED");
    const secret = row.ciphertext ? this.secrets.decrypt(row.ciphertext) : undefined;
    if (plugin.auth.type !== "none" && !secret) throw new ProviderError("PROVIDER_SECRET_MISSING");
    const secretKey =
      plugin.auth.type === "custom" && row.secretKeyCiphertext
        ? this.secrets.decrypt(row.secretKeyCiphertext)
        : undefined;
    return {
      profile: row.profile,
      plugin,
      origin,
      secret,
      secretKey,
      openResponse: (request: Parameters<typeof openProviderResponse>[2], signal: AbortSignal) =>
        this.openChannelResponse(row.profile, request, signal),
    };
  }

  actionTarget(kind: "admin_secret" | "admin_test_run", id: string, expectedRevision: number) {
    const profile = this.provider(id);
    if (!profile.enabled || profile.revision !== expectedRevision)
      throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    const { info } = this.plugin(profile.pluginHash);
    if (kind === "admin_secret" && (profile.connectionId || profile.channelId))
      throw new ProviderError("PROVIDER_SHARED_CONNECTION");
    if (kind === "admin_secret" && info.auth.type === "none")
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    if (kind === "admin_test_run") {
      if (info.kind !== "text" || info.mode !== "sync")
        throw new ProviderError("PROVIDER_TEXT_TEST_REQUIRED");
      this.binding(id, expectedRevision);
    }
    return {
      kind,
      id,
      expectedRevision,
      label: profile.label,
      endpoint: profile.endpoint,
      model: profile.model,
      pluginHash: profile.pluginHash,
      hasSecret: profile.hasSecret,
    };
  }

  configureSecret(
    approvalId: string,
    target: ReturnType<SettingsRegistry["actionTarget"]>,
    secret: string,
  ) {
    if (target.kind !== "admin_secret" || !secret.trim())
      throw new ProviderError("PROVIDER_CONFIG_INVALID");
    const receiptId = `secret:${approvalId}`;
    const fingerprint = digest(target);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.receipt(receiptId, fingerprint);
      if (!receipt) {
        const current = this.actionTarget("admin_secret", target.id, target.expectedRevision);
        if (digest(current) !== fingerprint) throw new ProviderError("SETTINGS_REVISION_CONFLICT");
        const { hasSecret: _, hasSecretKey: _key, ...fields } = this.provider(target.id);
        this.save({ ...target, fields, approve: false, secret });
        this.database
          .prepare("INSERT INTO settings_receipts VALUES (?, ?, ?)")
          .run(receiptId, fingerprint, JSON.stringify({ configured: true }));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private receipt(id: string, fingerprint: string) {
    const row = this.database
      .prepare("SELECT fingerprint, result FROM settings_receipts WHERE id = ?")
      .get(id);
    if (row && row.fingerprint !== fingerprint) throw new ProviderError("SETTINGS_DECISION_REUSED");
    return row && String(row.result);
  }

  hasSecretReceipt(approvalId: string, target: ReturnType<SettingsRegistry["actionTarget"]>) {
    return Boolean(this.receipt(`secret:${approvalId}`, digest(target)));
  }

  async approvedTest(
    approvalId: string,
    target: ReturnType<SettingsRegistry["actionTarget"]>,
    recovery: boolean,
  ) {
    const receiptId = `trial:${approvalId}`;
    const fingerprint = digest(target);
    const prior = this.receipt(receiptId, fingerprint);
    if (prior) return JSON.parse(prior) as { tested?: true; code?: string };
    if (recovery) return { code: "PROVIDER_OUTCOME_UNKNOWN" };
    const current = this.actionTarget("admin_test_run", target.id, target.expectedRevision);
    if (digest(current) !== fingerprint) throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    this.database
      .prepare("INSERT INTO settings_receipts VALUES (?, ?, ?)")
      .run(receiptId, fingerprint, JSON.stringify({ code: "PROVIDER_OUTCOME_UNKNOWN" }));
    let result: { tested?: true; code?: string };
    try {
      result = await this.test(target);
    } catch (error) {
      result = { code: error instanceof ProviderError ? error.code : "PROVIDER_OUTCOME_UNKNOWN" };
    }
    this.database
      .prepare("UPDATE settings_receipts SET result = ? WHERE id = ?")
      .run(JSON.stringify(result), receiptId);
    return result;
  }

  async test({ id, expectedRevision }: SettingsInput<"test">) {
    const { profile, plugin, origin, secret, secretKey } = this.binding(id, expectedRevision);
    const transport =
      this.channelTransport(profile.channelId) ??
      providerTransport(profile.endpoint, profile.allowLocal);
    const binding = {
      source: plugin.source,
      approvedHash: profile.pluginHash,
      baseUrl: profile.endpoint,
      builtin: origin === "builtin",
      secret,
      secretKey,
    };
    if (plugin.kind !== "text" || plugin.mode !== "sync") {
      if (
        !profile.channelId ||
        plugin.auth.type === "custom" ||
        !plugin.hooks.includes("buildCheckRequest")
      )
        throw new ProviderError("PROVIDER_CHECK_UNSUPPORTED");
      const signal = AbortSignal.timeout(20000);
      const context = {
        kind: plugin.kind,
        channel: { baseUrl: profile.endpoint, settings: profile.channel },
        model: { upstreamModel: profile.model },
      };
      const descriptor = await this.runner.call(
        plugin.source,
        "buildCheckRequest",
        [context],
        signal,
      );
      const request = await buildHostRequest(descriptor, plugin, binding, context);
      if (
        request.method !== "GET" ||
        request.body !== undefined ||
        new URL(request.url).origin !== new URL(profile.endpoint).origin
      )
        throw new ProviderError("PROVIDER_CHECK_UNSUPPORTED");
      const response = await transport(request, signal);
      if (response.status < 200 || response.status >= 300)
        throw new ProviderError("PROVIDER_CHECK_FAILED");
      this.binding(id, expectedRevision);
      return { tested: true } as const;
    }
    const host = new ProviderHost(this.runner, transport);
    const result = await host.invoke(binding, "submit", {
      kind: "text",
      channel: { baseUrl: profile.endpoint, settings: profile.channel },
      model: { upstreamModel: profile.model },
      input: {
        prompt: "Reply with OK.",
        ...(profile.config?.systemPrompt && { system: profile.config.systemPrompt }),
        ...(profile.config?.maxOutputTokens && { max_tokens: profile.config.maxOutputTokens }),
      },
    });
    if (record(result.immediate).status !== "succeeded")
      throw new ProviderError("PROVIDER_TEST_FAILED");
    return { tested: true } as const;
  }

  createHost(transport: ConstructorParameters<typeof ProviderHost>[1]) {
    return new ProviderHost(this.runner, transport);
  }

  async preview(value: unknown) {
    if (!Value.Check(SettingsProposal, value)) throw new ProviderError("SETTINGS_PROPOSAL_INVALID");
    if ("pluginSource" in value) {
      const info = await this.inspect(value.pluginSource);
      return {
        kind: "plugin" as const,
        plugin: this.pluginView({ info, origin: "agent" }),
        items: [{ field: "插件草稿", before: null, after: info.hash }],
      };
    }
    const provider = this.provider(value.providerId);
    if (provider.revision !== value.expectedRevision)
      throw new ProviderError("SETTINGS_REVISION_CONFLICT");
    const fields = {
      label: provider.label,
      model: provider.model,
      endpoint: provider.endpoint,
      allowLocal: provider.allowLocal,
      agentEnabled: provider.agentEnabled,
      channel: { ...provider.channel },
    };
    const keys = new Set<string>();
    const items = value.changes.map((change) => {
      if (provider.connectionId && change.field === "label")
        throw new ProviderError("PROVIDER_SHARED_CONNECTION");
      const field = change.field === "channel" ? `channel.${change.key}` : change.field;
      if (keys.has(field)) throw new ProviderError("SETTINGS_PROPOSAL_INVALID");
      keys.add(field);
      const before = change.field === "channel" ? fields.channel[change.key] : fields[change.field];
      if (change.field === "channel")
        Object.defineProperty(fields.channel, change.key, {
          value: change.value,
          enumerable: true,
          configurable: true,
        });
      else fields[change.field] = change.value;
      return { field, before: before ?? null, after: change.value };
    });
    this.validateModelChange(provider, this.validateFields(fields, provider.pluginHash).model);
    return {
      kind: "fields" as const,
      providerId: provider.id,
      expectedRevision: provider.revision,
      request: value,
      items,
    };
  }

  async applyProposal(
    id: string,
    proposal: Awaited<ReturnType<SettingsRegistry["preview"]>>,
    selected: number[],
  ) {
    const ordered = [...new Set(selected)].sort((left, right) => left - right);
    if (
      ordered.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= proposal.items.length,
      )
    )
      throw new ProviderError("SETTINGS_PROPOSAL_INVALID");
    const fingerprint = digest({ proposal, ordered });
    const plugin =
      proposal.kind === "plugin" && ordered.length
        ? await this.inspect(proposal.plugin.source)
        : undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.database
        .prepare("SELECT fingerprint, result FROM settings_receipts WHERE id = ?")
        .get(id);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new ProviderError("SETTINGS_DECISION_REUSED");
        this.database.exec("COMMIT");
        return JSON.parse(String(receipt.result)) as { applied: number; skipped: number };
      }
      if (plugin) this.insertPlugin(plugin, "agent");
      if (proposal.kind === "fields" && ordered.length) {
        const current = this.lookup(proposal.providerId);
        if (!current || current.profile.revision !== proposal.expectedRevision)
          throw new ProviderError("SETTINGS_REVISION_CONFLICT");
        const profile = current.profile;
        const fields = { ...profile, channel: { ...profile.channel } };
        for (const index of ordered) {
          const change = proposal.request.changes[index];
          if (!change) throw new ProviderError("SETTINGS_PROPOSAL_INVALID");
          if (change.field === "channel")
            Object.defineProperty(fields.channel, change.key, {
              value: change.value,
              enumerable: true,
              configurable: true,
            });
          else fields[change.field] = change.value;
        }
        const validated = this.validateFields(fields, profile.pluginHash);
        if (
          this.plugin(profile.pluginHash).info.key === "vertex-ai" &&
          vertexEndpointsChanged(profile.channel, validated.channel)
        )
          throw new ProviderError("PLUGIN_APPROVAL_REQUIRED");
        this.validateModelChange(profile, validated.model);
        if (profile.connectionId && validated.label !== profile.label)
          throw new ProviderError("PROVIDER_SHARED_CONNECTION");
        this.write(
          {
            ...profile,
            ...validated,
            revision: profile.revision + 1,
          },
          current.ciphertext,
        );
        if (validated.label !== profile.label) {
          for (const child of this.connectionModels(profile.id)) {
            this.write(
              { ...child, label: validated.label, revision: child.revision + 1 },
              current.ciphertext,
            );
          }
        }
      }
      const result = { applied: ordered.length, skipped: proposal.items.length - ordered.length };
      this.database
        .prepare("INSERT INTO settings_receipts VALUES (?, ?, ?)")
        .run(id, fingerprint, JSON.stringify(result));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
