import { Popover } from "@base-ui/react/popover";
import { modelPriceLabel, type ProviderView } from "@link-studio/core";
import { Box, Plus } from "lucide-react";
import { motion } from "motion/react";
import { useId, useState } from "react";
import { ChoiceButton } from "../choice-button";
import { ModelAvatar } from "../settings/model-logo";
import { AssistantInsertPopup } from "./assistant-insert-popup";

type Kind = "image" | "video";

export function AssistantModelMenu({
  models,
  disabled,
  pick,
}: {
  models: { kind: Kind; provider: ProviderView; vendor?: string }[];
  disabled: boolean;
  pick: (provider: ProviderView) => void;
}) {
  const [kind, setKind] = useState<Kind>("image");
  const [open, setOpen] = useState(false);
  const groupId = useId();
  const options = models.filter((model) => model.kind === kind);
  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      <Popover.Trigger
        className="composer-tool"
        type="button"
        aria-label="插入模型"
        title="插入模型"
        disabled={disabled}
      >
        <Box size={17} aria-hidden="true" />
      </Popover.Trigger>
      <AssistantInsertPopup aria-label="插入模型">
        <div className="assistant-model-kinds" role="radiogroup" aria-label="模型种类">
          {(["image", "video"] as const).map((value) => (
            <ChoiceButton
              key={value}
              type="button"
              role="radio"
              aria-checked={value === kind}
              onClick={() => setKind(value)}
            >
              {value === kind && (
                <motion.i
                  aria-hidden
                  layoutId={groupId}
                  transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
                />
              )}
              <span>{value === "image" ? "图片" : "视频"}</span>
            </ChoiceButton>
          ))}
        </div>
        {options.length ? (
          <ul>
            {options.map(({ provider, vendor }) => {
              const name = provider.config?.name || provider.model;
              const price = modelPriceLabel(provider.config?.pricing);
              return (
                <li key={provider.id}>
                  <button type="button" title={name} onClick={() => pick(provider)}>
                    <ModelAvatar
                      name={name}
                      logo={provider.config?.logo || vendor}
                      seed={provider.id}
                    />
                    <span className="assistant-model-copy">
                      <strong>{name}</strong>
                      <small>{provider.config?.description || provider.label}</small>
                    </span>
                    {price && <span className="assistant-model-price">{price}</span>}
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="assistant-model-empty">
            还没有已发布的{kind === "image" ? "图片" : "视频"}模型
          </p>
        )}
        <p>点一行插入到提示词里，可以插入多个。</p>
      </AssistantInsertPopup>
    </Popover.Root>
  );
}
