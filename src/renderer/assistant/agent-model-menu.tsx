import { Popover } from "@base-ui/react/popover";
import type { ProviderView } from "@link-studio/core";
import { Bot, Check, ChevronDown } from "lucide-react";
import { ModelAvatar } from "../settings/model-logo";
import { vendors } from "../settings/model-logos/vendors";
import { CanvasControlTip } from "../workspace/canvas-control-tip";

function vendorOf(model: ProviderView) {
  const logo = model.config?.logo;
  return logo && Object.hasOwn(vendors, logo) ? (logo as keyof typeof vendors) : undefined;
}

export function AgentModelMenu({
  current,
  models,
  locked,
  select,
}: {
  current: ProviderView;
  models: ProviderView[];
  locked: boolean;
  select: (id: string) => void;
}) {
  const name = current.config?.name || current.model;
  const vendor = vendorOf(current);
  return (
    <Popover.Root>
      <CanvasControlTip label={locked ? "运行中不能换模型" : "Agent 模型"}>
        <Popover.Trigger
          type="button"
          className="composer-model-choice"
          aria-label="Agent 模型"
          disabled={locked}
        >
          {vendor ? <ModelAvatar name={name} logo={vendor} /> : <Bot size={16} aria-hidden />}
          <span className="composer-model-name">{name}</span>
          <ChevronDown size={14} aria-hidden />
        </Popover.Trigger>
      </CanvasControlTip>
      <Popover.Portal>
        <Popover.Positioner
          className="assistant-model-position"
          side="top"
          align="end"
          sideOffset={8}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        >
          <Popover.Popup
            className="assistant-model-menu agent-model-picker"
            aria-label="选择 Agent 模型"
          >
            <p>Agent 模型</p>
            <div role="radiogroup" aria-label="Agent 模型">
              {models.map((model) => {
                const label = model.config?.name || model.model;
                const logo = vendorOf(model);
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="radio"
                    aria-checked={model.id === current.id}
                    disabled={locked}
                    value={model.id}
                    onClick={() => select(model.id)}
                  >
                    {logo ? (
                      <ModelAvatar name={label} logo={logo} />
                    ) : (
                      <Bot size={16} aria-hidden />
                    )}
                    <span className="agent-model-option-name">
                      <span>{label}</span>
                      {logo && <small>{vendors[logo]}</small>}
                    </span>
                    {!model.agentVision && <small>不能看图</small>}
                    {model.id === current.id && <Check size={16} aria-hidden />}
                  </button>
                );
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
