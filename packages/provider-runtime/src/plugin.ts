import { authNameIssue } from "./auth-name.ts";
import { encoded, LIMITS, type PluginRunner, ProviderError, record, sourceHash } from "./runner.ts";

export type Kind = "text" | "image" | "video" | "audio";
export interface PluginInfo {
  source: string;
  hash: string;
  key: string;
  kind: Kind | "agent";
  mode: "sync" | "async";
  auth: { type: "none" | "bearer" | "header" | "query" | "custom"; name?: string };
  hooks: string[];
  unknownHooks?: string[];
  meta: Record<string, unknown>;
}

type AddIssue = (path: string, message: string) => void;

export function requireGenerationPlugin(
  plugin: PluginInfo,
): asserts plugin is PluginInfo & { kind: Kind } {
  if (plugin.kind === "agent") throw new ProviderError("AGENT_MODEL_INCOMPATIBLE");
}

function objectField(value: unknown, path: string, invalid: AddIssue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "类型不对，应为对象");
    return undefined;
  }
  return value as Record<string, unknown>;
}

function validateSettings(value: unknown, prefix: string, invalid: AddIssue): void {
  const settings = objectField(value, prefix, invalid);
  if (!settings) return;
  for (const key of Object.keys(settings)) {
    const path = `${prefix}.${key}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(key)) {
      invalid(path, "名字只能包含字母、数字和下划线，以字母或下划线开头，最长 32 个字符");
      continue;
    }
    const setting = objectField(settings[key], path, invalid);
    if (!setting) continue;
    const validType =
      typeof setting.type === "string" &&
      ["string", "number", "boolean", "enum"].includes(setting.type);
    if (setting.type != null && typeof setting.type !== "string")
      invalid(`${path}.type`, "类型不对，应为字符串");
    if (setting.label != null && typeof setting.label !== "string")
      invalid(`${path}.label`, "类型不对，应为字符串");
    if (setting.description != null && typeof setting.description !== "string")
      invalid(`${path}.description`, "类型不对，应为字符串");
    if (setting.required != null && typeof setting.required !== "boolean")
      invalid(`${path}.required`, "类型不对，应为布尔值");
    const declaredOptions = setting.options;
    const options = Array.isArray(declaredOptions)
      ? declaredOptions.map((entry) => (typeof entry === "string" ? entry : ""))
      : undefined;
    if (
      declaredOptions != null &&
      (!Array.isArray(declaredOptions) ||
        declaredOptions.some((entry) => entry !== null && typeof entry !== "string"))
    )
      invalid(`${path}.options`, "类型不对，应为字符串数组");
    if (options && Array.isArray(declaredOptions) && declaredOptions.includes(null))
      setting.options = options;
    if (typeof setting.label !== "string" || !setting.label.trim())
      invalid(`${path}.label`, "不能为空");
    if (!validType) invalid(`${path}.type`, "必须是 string / number / boolean / enum 之一");
    if (setting.type === "enum") {
      if (!options?.length) invalid(`${path}.options`, "enum 必须提供非空的 options");
      else {
        const seen = new Set<string>();
        for (const option of options) {
          if (!option.trim()) {
            invalid(`${path}.options`, "可选值不能为空字符串");
            break;
          }
          if (seen.has(option)) {
            invalid(`${path}.options`, `可选值 ${JSON.stringify(option)} 重复`);
            break;
          }
          seen.add(option);
        }
      }
    }
    if (
      validType &&
      setting.default != null &&
      (setting.type === "enum"
        ? typeof setting.default !== "string" || !options?.includes(setting.default)
        : typeof setting.default !== setting.type)
    )
      invalid(`${path}.default`, `默认值与类型 ${setting.type} 不匹配`);
  }
}

export async function inspectPlugin(
  runner: PluginRunner,
  source: string,
  onKey?: (key: string) => void,
): Promise<PluginInfo> {
  const inspected = record(await runner.call(source, "inspect"));
  const issues: { path: string; message: string }[] = [];
  const invalid: AddIssue = (path, message) => {
    issues.push({ path, message });
  };
  if (inspected.metaTooLarge === true && inspected.meta === undefined)
    throw new ProviderError("PLUGIN_MANIFEST_INVALID", [
      { path: "meta", message: "meta 编码后超过 64KB" },
    ]);
  if (!inspected.meta || typeof inspected.meta !== "object" || Array.isArray(inspected.meta))
    throw new ProviderError("PLUGIN_MANIFEST_INVALID", [
      { path: "meta", message: "插件必须导出 meta 对象" },
    ]);
  const meta = inspected.meta as Record<string, unknown>;
  if (typeof meta.key === "string" && meta.key) onKey?.(meta.key);
  if (inspected.metaTooLarge === true || Buffer.byteLength(JSON.stringify(meta)) > LIMITS.meta)
    invalid("meta", "meta 编码后超过 64KB");
  if (meta.apiVersion == null) invalid("meta.apiVersion", "缺少 apiVersion，当前只支持 1");
  else if (!Number.isInteger(meta.apiVersion)) invalid("meta.apiVersion", "类型不对，应为整数");
  else if (meta.apiVersion !== 1)
    invalid("meta.apiVersion", `不支持的 apiVersion：${meta.apiVersion}，当前只支持 1`);
  for (const field of ["key", "name"] as const) {
    if (meta[field] == null) invalid(`meta.${field}`, `缺少 ${field}`);
    else if (typeof meta[field] !== "string") invalid(`meta.${field}`, "类型不对，应为字符串");
  }
  if (typeof meta.key === "string" && !/^[a-z0-9][a-z0-9-]{0,29}$/.test(meta.key))
    invalid("meta.key", "只能包含小写字母、数字和连字符，以字母或数字开头，最长 30 个字符");
  if (typeof meta.name === "string" && !meta.name.trim()) invalid("meta.name", "不能为空");
  else if (typeof meta.name === "string" && Array.from(meta.name).length > 128)
    invalid("meta.name", "最长 128 个字符");
  if (meta.description != null && typeof meta.description !== "string")
    invalid("meta.description", "类型不对，应为字符串");
  const auth = meta.auth == null ? undefined : objectField(meta.auth, "meta.auth", invalid);
  if (meta.auth == null)
    invalid("meta.auth", "缺少 auth，可选：none / bearer / header / query / custom");
  if (auth) {
    if (auth.type != null && typeof auth.type !== "string")
      invalid("meta.auth.type", "类型不对，应为字符串");
    else {
      if (auth.name != null && typeof auth.name !== "string")
        invalid("meta.auth.name", "类型不对，应为字符串");
      const issue = authNameIssue(auth.type, auth.name);
      if (!["none", "bearer", "header", "query", "custom"].includes(String(auth.type)))
        invalid("meta.auth.type", "必须是 none / bearer / header / query / custom 之一");
      else if (issue) invalid("meta.auth.name", issue);
    }
  }
  const endpoints =
    meta.endpoints == null ? undefined : objectField(meta.endpoints, "meta.endpoints", invalid);
  const kinds = Object.keys(endpoints ?? {}).sort();
  const hooks: string[] = Array.isArray(inspected.hooks) ? inspected.hooks : [];
  const endpointKinds = ["video", "image", "audio", "text", "agent"];
  if (meta.endpoints == null || (endpoints && !kinds.length))
    invalid("meta.endpoints", `至少声明一种 endpoint（${endpointKinds.join(" / ")}）`);
  if (kinds.length > 1)
    invalid(
      "meta.endpoints",
      `一个插件只能支持一种类型（现在声明了 ${kinds.join(" / ")}），请按类型拆成多个插件`,
    );
  if (!Array.isArray(inspected.hooks) || !hooks.every((hook) => typeof hook === "string"))
    invalid("hooks", "钩子列表无效");
  const kind = kinds[0] as PluginInfo["kind"];
  let endpoint: Record<string, unknown> | undefined;
  for (const entry of kinds) {
    const path = `meta.endpoints.${entry}`;
    if (!endpointKinds.includes(entry)) {
      invalid(path, `不支持的 kind，只能是 ${endpointKinds.join(" / ")}`);
      continue;
    }
    const descriptor = objectField(endpoints?.[entry], path, invalid);
    if (!descriptor) continue;
    if (entry === kind) endpoint = descriptor;
    if (descriptor.mode != null && typeof descriptor.mode !== "string") {
      invalid(`${path}.mode`, "类型不对，应为字符串");
      continue;
    }
    if (descriptor.method != null && typeof descriptor.method !== "string")
      invalid(`${path}.method`, "类型不对，应为字符串");
    else if (
      typeof descriptor.method === "string" &&
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(descriptor.method)
    )
      invalid(`${path}.method`, "必须是 GET / POST / PUT / PATCH / DELETE");
    if (descriptor.path != null && typeof descriptor.path !== "string")
      invalid(`${path}.path`, "类型不对，应为字符串");
    else if (
      typeof descriptor.path === "string" &&
      (!descriptor.path.startsWith("/") || Buffer.byteLength(descriptor.path) > 200)
    )
      invalid(`${path}.path`, "必须以 / 开头，且不超过 200 个字符（只用于展示）");
    if (descriptor.mode !== "sync" && descriptor.mode !== "async")
      invalid(`${path}.mode`, "必须是 sync 或 async");
    if (descriptor.mode === "async")
      for (const hook of ["buildQueryRequest", "parseQueryResponse"]) {
        if (!hooks.includes(hook))
          invalid(`${path}.mode`, `${entry} 声明为 async，必须导出 ${hook}`);
      }
  }
  for (const hook of ["buildSubmitRequest", "parseSubmitResponse"]) {
    if (!hooks.includes(hook))
      invalid(`exports.${hook}`, `缺少钩子 ${hook}：每种 endpoint 都要实现提交`);
  }
  if (meta.vendor != null && typeof meta.vendor !== "string")
    invalid("meta.vendor", "类型不对，应为字符串");
  else if (typeof meta.vendor === "string" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(meta.vendor))
    invalid("meta.vendor", "只能包含小写字母、数字和连字符，且以字母或数字开头（最长 64 位）");
  if (meta.channelSettings != null)
    validateSettings(meta.channelSettings, "meta.channelSettings", invalid);
  if (meta.import != null) {
    const args = objectField(meta.import, "meta.import", invalid)?.args;
    if (args != null) validateSettings(args, "meta.import.args", invalid);
  }
  if (meta.poll != null) {
    const poll = objectField(meta.poll, "meta.poll", invalid);
    for (const key of ["firstDelay", "interval", "maxInterval", "jitter"]) {
      const value = poll?.[key];
      if (value == null) continue;
      if (typeof value !== "number" || !Number.isFinite(value))
        invalid(`meta.poll.${key}`, "类型不对，应为数字");
      else if (value < 0) invalid(`meta.poll.${key}`, "不能为负数");
      else if (key === "jitter" && value > 1) invalid("meta.poll.jitter", "必须在 0 到 1 之间");
    }
  }
  const required: string[] = [];
  if (hooks.includes("buildPrepareRequests")) required.push("parsePrepareResponses");
  if (hooks.includes("buildImportRequest") || hooks.includes("parseImportResponse"))
    required.push("buildImportRequest", "parseImportResponse");
  const missing = required.filter((hook) => !hooks.includes(hook));
  const errorCode = issues.some((issue) => !issue.path.startsWith("exports."))
    ? "PLUGIN_MANIFEST_INVALID"
    : "PLUGIN_HOOKS_INVALID";
  for (const hook of missing)
    invalid(
      `exports.${hook}`,
      hook === "parsePrepareResponses"
        ? "实现了 buildPrepareRequests 就必须同时实现 parsePrepareResponses"
        : hook.includes("Import")
          ? "buildImportRequest 与 parseImportResponse 必须同时实现"
          : `缺少钩子 ${hook}：每种 endpoint 都要实现提交`,
    );
  if (
    issues.length ||
    typeof meta.key !== "string" ||
    !endpoint ||
    (endpoint.mode !== "sync" && endpoint.mode !== "async")
  )
    throw new ProviderError(errorCode, issues);
  return {
    source,
    hash: sourceHash(source),
    key: meta.key,
    kind,
    mode: endpoint.mode,
    auth: auth as PluginInfo["auth"],
    hooks,
    unknownHooks: Array.isArray(inspected.unknownHooks) ? inspected.unknownHooks : [],
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
  if (!["queued", "running", "succeeded", "failed", "cancelled"].includes(String(result.status)))
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
