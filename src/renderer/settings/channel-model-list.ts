import type { ChannelView, PluginView, ProviderView } from "@link-studio/core";
import { boundPricingIssues, validModelCapabilities } from "@link-studio/core";

const modelSort = (model: ProviderView) => model.config?.sort ?? model.pendingSort ?? 100;

export function compareChannelModels(left: ProviderView, right: ProviderView) {
  const leftKey = left.modelKey ?? left.id;
  const rightKey = right.modelKey ?? right.id;
  return (
    Number(right.enabled) - Number(left.enabled) ||
    modelSort(left) - modelSort(right) ||
    (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
  );
}

function modelProblem(model: ProviderView, channel?: ChannelView, plugin?: PluginView) {
  if (model.draftIssueCount) return `配置正文有 ${model.draftIssueCount} 个问题，请先修复并保存。`;
  if (!model.channelId) return "还没有选择渠道";
  if (!channel) return `渠道 ${model.channelId} 不存在`;
  if (!channel.enabled) return `渠道「${channel.name}」已停用`;
  if (model.pending) return "还没有选择能力";
  if (model.config?.pricing?.pending) return "售价待确认的草稿不能启用，请先完成定价";
  const pricing = boundPricingIssues(
    model.config,
    plugin?.origin === "builtin" ? plugin.key : undefined,
    model.model,
    model.channel,
  )[0];
  if (pricing) return pricing.text;
  if (model.config?.kind === "agent")
    return channel.hasSecret ? "" : `渠道「${channel.name}」还没有设置 Key`;
  if (!model.pluginHash) return "还没有选择调用协议";
  if (!plugin) return "固定的插件版本不存在";
  if (plugin.disabled) return `协议插件「${plugin.name}」已停用`;
  const kind = model.config?.kind;
  if (kind && kind !== plugin.kind) return `协议「${plugin.name}」不支持${kind}类型的模型`;
  if (
    model.config &&
    !validModelCapabilities(
      model.config,
      plugin.origin === "builtin" ? plugin.key : undefined,
      model.model,
      model.channel,
    )
  )
    return "能力或参数超出当前协议与模型支持范围。";
  if (plugin.auth !== "none" && !channel.hasSecret) return `渠道「${channel.name}」还没有设置 Key`;
  return "";
}

export function channelModelHealth(
  model: ProviderView,
  channel?: ChannelView,
  plugin?: PluginView,
) {
  const reason = modelProblem(model, channel, plugin);
  const status = !model.enabled
    ? model.pending || (!model.pluginHash && model.config?.kind !== "agent")
      ? "pending"
      : "offline"
    : reason
      ? "broken"
      : "online";
  return {
    status,
    reason,
    label: { pending: "待配置", offline: "未上线", broken: "不可用", online: "在线" }[status],
  };
}

export function matchesModelQuery(
  query: string,
  model: ProviderView,
  channel?: ChannelView,
  plugin?: PluginView,
) {
  const config = model.config;
  const fields = [
    model.id,
    model.modelKey,
    config?.name,
    model.model,
    config?.logo,
    channel?.name,
    config?.kind === "agent" ? undefined : plugin?.name,
    ...(config?.tags ?? []),
  ];
  return fields.some((field) => field?.toLowerCase().includes(query));
}
