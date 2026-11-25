export const settingsPaths = {
  providers: "/admin/ai/channels",
  adapters: "/admin/ai/plugins",
  skills: "/admin/agent/skills",
} as const;
export type SettingsPage = keyof typeof settingsPaths;
const pageLabels = {
  [settingsPaths.providers]: "模型渠道",
  [settingsPaths.adapters]: "插件",
  [settingsPaths.skills]: "技能",
} as const;
export type SettingsPageContext = {
  route: (typeof settingsPaths)[SettingsPage];
  channel_key?: string;
  model_key?: string;
  plugin_key?: string;
};
export type SettingsRefId = "page" | "channel" | "model" | "plugin";
export type SettingsRef = { id: SettingsRefId; label: string; title: string };

export function settingsRefs(context: SettingsPageContext): SettingsRef[] {
  const refs: SettingsRef[] = [
    {
      id: "page",
      label: pageLabels[context.route],
      title: context.route,
    },
  ];
  if (context.channel_key)
    refs.push({ id: "channel", label: `渠道：${context.channel_key}`, title: context.channel_key });
  if (context.model_key)
    refs.push({ id: "model", label: `模型：${context.model_key}`, title: context.model_key });
  if (context.plugin_key)
    refs.push({ id: "plugin", label: `插件：${context.plugin_key}`, title: context.plugin_key });
  return refs;
}

export function historyPageContext(raw: unknown): SettingsPageContext | undefined {
  if (!raw || typeof raw !== "object") return;
  const data = raw as Record<string, unknown>;
  const legacy = (field: string, key: string) => {
    const entry = data[field];
    return entry && typeof entry === "object" ? (entry as Record<string, unknown>)[key] : undefined;
  };
  const channel = data.channel_key ?? legacy("channel", "id"),
    model = data.model_key ?? legacy("provider", "id"),
    plugin = data.plugin_key ?? legacy("plugin", "key");
  const route =
    data.route === "adapters" || data.route === settingsPaths.adapters || (!data.route && plugin)
      ? settingsPaths.adapters
      : data.route === "providers" ||
          data.route === settingsPaths.providers ||
          (!data.route && (channel || model))
        ? settingsPaths.providers
        : data.route === settingsPaths.skills || data.route === "skills"
          ? settingsPaths.skills
          : undefined;
  if (!route) return;
  return {
    route,
    ...(typeof channel === "string" && { channel_key: channel }),
    ...(typeof model === "string" && { model_key: model }),
    ...(typeof plugin === "string" && { plugin_key: plugin }),
  };
}
