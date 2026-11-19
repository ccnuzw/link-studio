import { encoded, LIMITS, type PluginRunner, ProviderError, record, sourceHash } from "./runner.ts";

export type Kind = "text" | "image" | "video" | "audio";
export interface PluginInfo {
  source: string;
  hash: string;
  key: string;
  kind: Kind;
  mode: "sync" | "async";
  auth: { type: "none" | "bearer" | "header" | "query"; name?: string };
  hooks: string[];
  meta: Record<string, unknown>;
}

function validateSettings(value: unknown): void {
  for (const [key, raw] of Object.entries(record(value))) {
    const setting = record(raw);
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(key) ||
      !["string", "number", "boolean", "enum"].includes(String(setting.type)) ||
      typeof setting.label !== "string" ||
      !setting.label.trim()
    )
      throw new ProviderError("PLUGIN_MANIFEST_INVALID");
    if (
      setting.type === "enum" &&
      (!Array.isArray(setting.options) ||
        !setting.options.length ||
        !setting.options.every((entry) => typeof entry === "string"))
    )
      throw new ProviderError("PLUGIN_MANIFEST_INVALID");
    if (
      setting.default !== undefined &&
      (setting.type === "enum"
        ? !(setting.options as string[]).includes(String(setting.default))
        : typeof setting.default !== setting.type)
    )
      throw new ProviderError("PLUGIN_MANIFEST_INVALID");
  }
}

export async function inspectPlugin(runner: PluginRunner, source: string): Promise<PluginInfo> {
  const inspected = record(await runner.call(source, "inspect"));
  const meta = record(inspected.meta);
  encoded(meta, LIMITS.meta);
  const auth = record(meta.auth);
  const endpoints = record(meta.endpoints);
  const kinds = Object.keys(endpoints);
  const hooks = inspected.hooks;
  if (
    meta.apiVersion !== 1 ||
    typeof meta.key !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,29}$/.test(meta.key) ||
    typeof meta.name !== "string" ||
    !meta.name.trim() ||
    kinds.length !== 1 ||
    !["text", "image", "video", "audio"].includes(kinds[0] ?? "") ||
    !Array.isArray(hooks) ||
    !hooks.every((hook) => typeof hook === "string")
  )
    throw new ProviderError("PLUGIN_MANIFEST_INVALID");
  const kind = kinds[0] as Kind;
  const endpoint = record(endpoints[kind]);
  if (
    meta.vendor !== undefined &&
    (typeof meta.vendor !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(meta.vendor))
  )
    throw new ProviderError("PLUGIN_MANIFEST_INVALID");
  if (
    endpoint.method !== undefined &&
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(endpoint.method))
  )
    throw new ProviderError("PLUGIN_MANIFEST_INVALID");
  if (
    endpoint.path !== undefined &&
    (typeof endpoint.path !== "string" ||
      !endpoint.path.startsWith("/") ||
      endpoint.path.length > 200)
  )
    throw new ProviderError("PLUGIN_MANIFEST_INVALID");
  if (meta.channelSettings !== undefined) validateSettings(meta.channelSettings);
  if (meta.poll !== undefined) {
    for (const [key, value] of Object.entries(record(meta.poll))) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (key === "jitter" && value > 1)
      )
        throw new ProviderError("PLUGIN_MANIFEST_INVALID");
    }
  }
  if (endpoint.mode !== "sync" && endpoint.mode !== "async")
    throw new ProviderError("PLUGIN_MANIFEST_INVALID");
  if (auth.type === "custom") throw new ProviderError("PLUGIN_CUSTOM_AUTH_UNSUPPORTED");
  if (!["none", "bearer", "header", "query"].includes(String(auth.type)))
    throw new ProviderError("PLUGIN_MANIFEST_INVALID");
  if (
    (auth.type === "header" || auth.type === "query") &&
    (typeof auth.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(auth.name))
  ) {
    throw new ProviderError("PLUGIN_MANIFEST_INVALID");
  }
  const required = ["buildSubmitRequest", "parseSubmitResponse"];
  if (endpoint.mode === "async") required.push("buildQueryRequest", "parseQueryResponse");
  if (
    required.some((hook) => !hooks.includes(hook)) ||
    hooks.includes("buildPrepareRequests") !== hooks.includes("parsePrepareResponses") ||
    hooks.includes("buildImportRequest") !== hooks.includes("parseImportResponse")
  ) {
    throw new ProviderError("PLUGIN_HOOKS_INVALID");
  }
  return {
    source,
    hash: sourceHash(source),
    key: meta.key,
    kind,
    mode: endpoint.mode,
    auth: auth as PluginInfo["auth"],
    hooks,
    meta,
  };
}

export function validateContext(context: unknown): Record<string, unknown> {
  const checked = record(context);
  const allowed = ["channel", "model", "input", "task", "prepared", "now", "kind"];
  if (Object.keys(checked).some((key) => !allowed.includes(key)))
    throw new ProviderError("PLUGIN_CONTEXT_INVALID");
  const channel = record(checked.channel);
  if (Object.keys(channel).some((key) => !["baseUrl", "settings"].includes(key))) {
    throw new ProviderError("PLUGIN_CONTEXT_INVALID");
  }
  if (checked.task !== undefined) {
    const task = record(checked.task);
    if (task.state !== undefined) encoded(task.state, LIMITS.state);
  }
  encoded(checked, LIMITS.payload);
  return structuredClone(checked);
}

export function validateResult(value: unknown, kind: Kind): Record<string, unknown> {
  const result = record(value);
  if (!["queued", "running", "succeeded", "failed"].includes(String(result.status)))
    throw new ProviderError("PLUGIN_RESULT_INVALID");
  if (result.state !== undefined) encoded(result.state, LIMITS.state);
  if (result.progress !== undefined) {
    if (typeof result.progress !== "number" || !Number.isFinite(result.progress))
      throw new ProviderError("PLUGIN_RESULT_INVALID");
    result.progress = Math.max(0, Math.min(100, result.progress));
  }
  if (result.status === "succeeded") {
    if (!Array.isArray(result.outputs) || !result.outputs.length)
      throw new ProviderError("PLUGIN_RESULT_INVALID");
    result.outputs = result.outputs.map((output: unknown) => {
      const item =
        typeof output === "string"
          ? kind === "text"
            ? { type: "text", text: output }
            : { type: "url", url: output }
          : record(output);
      if (item.type === undefined)
        item.type = item.url !== undefined ? "url" : item.text !== undefined ? "text" : undefined;
      if (kind === "text") {
        if (
          item.type !== "text" ||
          typeof item.text !== "string" ||
          Buffer.byteLength(item.text) > 256 * 1024
        )
          throw new ProviderError("PLUGIN_RESULT_INVALID");
      } else if (item.type === "url") {
        let url: URL;
        try {
          url = new URL(String(item.url));
        } catch {
          throw new ProviderError("PLUGIN_RESULT_INVALID");
        }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new ProviderError("PLUGIN_RESULT_INVALID");
      } else if (item.type !== "asset") throw new ProviderError("PLUGIN_RESULT_INVALID");
      return item;
    });
  }
  if (result.status === "failed") {
    const error =
      typeof result.error === "string" && result.error
        ? { class: "terminal", message: result.error }
        : record(result.error);
    if (error.class === undefined) error.class = "terminal";
    if (
      !["retryable", "terminal", "moderation", "provider_balance"].includes(String(error.class)) ||
      typeof error.message !== "string" ||
      !error.message
    )
      throw new ProviderError("PLUGIN_RESULT_INVALID");
    result.error = error;
  }
  return result;
}
