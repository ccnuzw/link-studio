import { Popover } from "@base-ui/react/popover";
import { type GroupHue, groupHues } from "@link-studio/core";
import { motion } from "motion/react";
import { fixedMenuSide } from "./canvas-account-pill";

const labels = {
  red: "红",
  orange: "橙",
  yellow: "黄",
  green: "绿",
  cyan: "青",
  blue: "蓝",
  purple: "紫",
  pink: "粉",
};
type Colors = { color?: GroupHue; labelColor?: GroupHue };
export function GroupColors({
  colors,
  setColor,
}: {
  colors: Colors;
  setColor: (field: keyof Colors, hue?: GroupHue) => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="颜色"
        render={<motion.button type="button" whileTap={{ scale: 0.96 }} />}
      >
        <span aria-hidden="true" className="group-color-icon" />
        <span>颜色</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={10}
          collisionAvoidance={fixedMenuSide}
          className="group-color-position"
        >
          <Popover.Popup className="group-color-picker" aria-label="分组颜色" data-canvas-space-pan>
            {(["color", "labelColor"] as const).map((field) => {
              const label = field === "color" ? "背景颜色" : "标签颜色";
              return (
                <section key={field} aria-label={label}>
                  <h4>{label}</h4>
                  <div>
                    {[undefined, ...groupHues].map((hue) => (
                      <button
                        type="button"
                        key={hue ?? "none"}
                        aria-label={`${label}：${hue ? labels[hue] : "无"}`}
                        aria-pressed={colors[field] === hue}
                        onClick={() => setColor(field, hue)}
                        style={{
                          background: hue
                            ? field === "color"
                              ? `color-mix(in oklch,var(--group-${hue}) 38%,var(--group-popover))`
                              : `var(--group-${hue})`
                            : undefined,
                        }}
                      >
                        {!hue && <span aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
