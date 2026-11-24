import { Menu } from "@base-ui/react/menu";
import { modelPriceLabel, type ProviderView, type SettingsValues } from "@link-studio/core";
import { Bot, Check, ChevronDown } from "lucide-react";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { ModelAvatar } from "../settings/model-logo";
import { vendors } from "../settings/model-logos/vendors";
import "./reference-menu.css";

export function GenerationModelMenu({
  models,
  plugins,
  current,
  status,
  offline,
  choose,
  disabled,
  container,
  emptyLabel,
}: {
  models: ProviderView[];
  plugins: SettingsValues["list"]["plugins"];
  current?: ProviderView;
  emptyLabel?: string;
  offline: boolean;
  status: "loading" | "ready" | "error";
  choose: (id: string) => boolean;
  disabled: boolean;
  container?: RefObject<HTMLDialogElement | null>;
}) {
  const vendor = (provider: ProviderView) =>
    provider.config?.logo || plugins.find((plugin) => plugin.hash === provider.pluginHash)?.vendor;
  const name = (provider: ProviderView) => provider.config?.name || provider.model;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const dialog = container?.current;
    if (!open || !dialog) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    dialog.addEventListener("keydown", handleEscape, true);
    return () => dialog.removeEventListener("keydown", handleEscape, true);
  }, [open, container]);
  return (
    <Menu.Root
      open={open}
      modal={false}
      onOpenChange={(open, details) => {
        setOpen(open);
        if (!open && details.reason === "escape-key") {
          details.event.preventDefault();
          details.event.stopPropagation();
        }
      }}
    >
      <Menu.Trigger
        ref={trigger}
        type="button"
        className="media-model-trigger"
        aria-label="选择模型"
        data-invalid={offline || status === "error" || undefined}
        disabled={disabled}
      >
        {current &&
          (Object.hasOwn(vendors, vendor(current) ?? "") ? (
            <ModelAvatar name={name(current)} logo={vendor(current)} />
          ) : (
            <Bot size={12} />
          ))}
        <span>
          {current
            ? name(current)
            : offline
              ? "模型已下线"
              : status === "loading"
                ? "加载模型…"
                : status === "error"
                  ? "模型加载失败"
                  : (emptyLabel ?? "暂无可用模型")}
        </span>
        <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Positioner
          className="reference-menu-positioner"
          align="start"
          sideOffset={8}
          positionMethod="fixed"
          collisionBoundary={document.documentElement}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        >
          <Menu.Popup
            className="reference-menu generation-model-menu nodrag nopan nowheel"
            aria-label="选择模型"
          >
            <Menu.Group>
              <Menu.GroupLabel className="reference-menu-label">选择模型</Menu.GroupLabel>
              <Menu.Separator className="reference-menu-separator" />
              <Menu.RadioGroup
                value={current?.id ?? ""}
                onValueChange={(id) => {
                  if (!choose(id)) setOpen(false);
                }}
              >
                {models.map((provider) => (
                  <Menu.RadioItem
                    key={provider.id}
                    value={provider.id}
                    className="generation-model-option"
                  >
                    <ModelAvatar name={name(provider)} logo={vendor(provider)} seed={provider.id} />
                    <span className="generation-model-copy">
                      <span>
                        <span>{name(provider)}</span>
                        {provider.config?.tags?.map((tag) => (
                          <small key={tag}>{tag}</small>
                        ))}
                      </span>
                      <span>{provider.config?.description || provider.label}</span>
                    </span>
                    <span className="generation-model-price">
                      {provider.config?.pricing ? modelPriceLabel(provider.config.pricing) : "—"}
                    </span>
                    <Menu.RadioItemIndicator className="generation-model-check">
                      <Check size={16} />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
