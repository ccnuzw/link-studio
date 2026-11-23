import { Popover } from "@base-ui/react/popover";
import type { ProviderView, SettingsValues } from "@link-studio/core";
import { Bot, Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { vendors } from "../settings/model-logos/vendors";

const preferenceKey = "storyboard-split-model";
const vendorGraphics = import.meta.glob<string>("../settings/model-logos/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});
export function ShotModelLogo({ logo }: { logo?: string }) {
  if (!logo || !Object.hasOwn(vendors, logo)) return <Bot size={16} aria-hidden="true" />;
  const graphic = vendorGraphics[`../settings/model-logos/${logo}.svg`];
  if (!graphic) return <Bot size={16} aria-hidden="true" />;
  const label = vendors[logo as keyof typeof vendors];
  return (
    <span className="model-avatar" data-vendor={logo} role="img" aria-label={label} title={label}>
      <img src={graphic} alt="" />
    </span>
  );
}
type Preference = { id: string; name: string };

export function readShotModel(): Preference | null {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
    return typeof saved?.id === "string" && typeof saved?.name === "string" ? saved : null;
  } catch {
    return null;
  }
}

export function splitModels(settings: SettingsValues["list"]) {
  return settings.providers.filter((provider) => {
    const plugin = settings.plugins.find((item) => item.hash === provider.pluginHash);
    return (
      provider.agentEnabled &&
      provider.enabled &&
      provider.channelEnabled !== false &&
      (provider.channelId && provider.config?.kind === "agent"
        ? provider.hasSecret
        : plugin?.origin === "builtin" &&
          plugin.key === "openai" &&
          !plugin.disabled &&
          provider.hasSecret)
    );
  });
}

export function splitPrompt(script: string) {
  return [
    "请把下面的剧本按叙事顺序拆成分镜，严格只输出 JSON 数组，不要 Markdown、解释或代码围栏。",
    "每项字段必须是 scene、shot、camera、action、dialogue、duration；duration 为 1 到 60 的数字，最多一位小数；shot 和 camera 使用常见中文术语。",
    "剧本：",
    script,
  ].join("\n");
}

export function useShotModel(models: ProviderView[]) {
  const [picked, setPicked] = useState(readShotModel);
  const model = picked ? models.find((item) => item.id === picked.id) : models[0];
  const label = model
    ? (model.config?.name ?? model.model)
    : picked
      ? `${picked.name}（已停用）`
      : "Agent 模型";
  const choose = (item: ProviderView) => {
    const next =
      item.id === models[0]?.id ? null : { id: item.id, name: item.config?.name ?? item.model };
    setPicked(next);
    try {
      if (next) localStorage.setItem(preferenceKey, JSON.stringify(next));
      else localStorage.removeItem(preferenceKey);
    } catch {
      /* The selection still applies to this dialog. */
    }
  };
  return { model, label, choose };
}

export function ShotModelPicker({
  models,
  selection,
  busy,
}: {
  models: ProviderView[];
  selection: ReturnType<typeof useShotModel>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="shot-model-trigger">
        {selection.model && <ShotModelLogo logo={selection.model.config?.logo} />}
        <span>{selection.label}</span>
        <ChevronDown size={16} />
      </Popover.Trigger>
      <Popover.Portal className="storyboard-layer">
        <Popover.Positioner
          className="shot-model-positioner"
          align="start"
          sideOffset={6}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        >
          <Popover.Popup className="shot-model-popup" aria-label="拆镜模型">
            {models.length === 0 && <p>暂无可用的 Agent 模型</p>}
            {models.map((item, index) => {
              const name = item.config?.name ?? item.model;
              const active = item.id === selection.model?.id;
              return (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={active}
                  disabled={busy}
                  title={busy ? "正在拆分镜" : undefined}
                  onClick={() => {
                    selection.choose(item);
                    setOpen(false);
                  }}
                >
                  <ShotModelLogo logo={item.config?.logo} />
                  <span>{name}</span>
                  {busy && <small>不可选</small>}
                  {index === 0 && <small className="shot-model-default">默认</small>}
                  {active && <Check size={16} />}
                </button>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
