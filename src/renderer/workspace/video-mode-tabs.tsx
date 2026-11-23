import type { CreativeData, modelGenerationOptions } from "@link-studio/core";
import { LayoutGroup, motion } from "motion/react";
import { modeHint, videoModeLabels, videoModes } from "./video-modes";

export function VideoModeTabs({
  id,
  value,
  options,
  hasRefs,
  disabled,
  choose,
}: {
  id: string;
  value: CreativeData["videoMode"];
  options: ReturnType<typeof modelGenerationOptions>;
  hasRefs: boolean;
  disabled: boolean;
  choose: (mode: NonNullable<CreativeData["videoMode"]>) => void;
}) {
  return (
    <LayoutGroup id={`op-tabs-${id}`}>
      <div className="video-mode-tabs" role="tablist" aria-label="生成方式">
        {videoModes(options).map((mode) => {
          const hint = modeHint(mode, options, hasRefs);
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={mode === value}
              aria-disabled={!!hint}
              disabled={disabled}
              title={hint}
              onClick={() => {
                if (!hint) choose(mode);
              }}
            >
              {mode === value && (
                <motion.span
                  className="video-mode-slider"
                  layoutId="op-tab"
                  transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
                />
              )}
              <span>{videoModeLabels[mode]}</span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
