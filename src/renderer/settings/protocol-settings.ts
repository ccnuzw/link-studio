import {
  type ModelKind,
  modelKindLabels,
  type PluginView,
  type ProviderFields,
} from "@link-studio/core";

type Values = ProviderFields["channel"];
export type ProtocolLoadState = "loading" | "ready" | "error";

export function protocolSwitchNotice(
  currentHash: string,
  plugin: PluginView | undefined,
  next: ModelKind,
) {
  if (!currentHash) return "";
  if (next === "agent") return "Agent 模型不需要选择协议，已清空已选协议";
  return plugin?.kind === next ? "" : `已选协议不支持${modelKindLabels[next]}，请重新选择`;
}

const authLabels: Record<string, string> = {
  none: "无需鉴权",
  bearer: "Bearer（宿主注入 Authorization 头）",
  header: "请求头",
  query: "查询参数",
  custom: "插件自行签名（该协议会读取渠道的 API Key 与 Secret Key 自行签名）",
};

export function protocolAuth(plugin: PluginView) {
  const label = authLabels[plugin.auth] ?? plugin.auth;
  return ["header", "query"].includes(plugin.auth) && plugin.authName
    ? `${label}（${plugin.authName}）`
    : label;
}

export function submittedSettings(draft: Values): Values {
  const entries = Object.entries(draft).map(
    ([name, raw]) => [name, typeof raw === "string" ? raw.trim() : raw] as const,
  );
  return Object.fromEntries(entries.filter(([, value]) => value !== ""));
}

function compatibleValue(field: PluginView["fields"][string], value: unknown) {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "enum":
      return typeof value === "string" && field.options?.includes(value) ? value : undefined;
    default:
      return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
  }
}

export function protocolValues(fields: PluginView["fields"], current: Values = {}): Values {
  const entries: [string, Values[string]][] = [];
  for (const [name, field] of Object.entries(fields)) {
    const existing = Object.hasOwn(current, name) ? current[name] : undefined;
    const value =
      compatibleValue(field, existing) ??
      compatibleValue(field, field.default) ??
      (field.type === "boolean" ? false : undefined);
    if (value !== undefined) entries.push([name, value]);
  }
  return submittedSettings(Object.fromEntries(entries));
}
