import { Menu } from "@base-ui/react/menu";
import type { ArrangeMode } from "@link-studio/core";
import { ChevronDown, Columns3, Grid2X2, LayoutGrid, Rows3 } from "lucide-react";
import { motion } from "motion/react";
import { fixedMenuSide } from "./canvas-account-pill";

const choices = [
  { mode: "row", label: "横向排列", Icon: Columns3 },
  { mode: "column", label: "纵向排列", Icon: Rows3 },
  { mode: "grid", label: "网格排列", Icon: Grid2X2 },
] as const;

export function ArrangeMenu({
  disabled,
  choose,
}: {
  disabled: boolean;
  choose: (mode: ArrangeMode) => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        disabled={disabled}
        aria-label="整理布局"
        render={<motion.button type="button" whileTap={disabled ? undefined : { scale: 0.96 }} />}
      >
        <LayoutGrid size={16} />
        <span>整理布局</span>
        <ChevronDown size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="canvas-frame-positioner"
          side="bottom"
          align="start"
          sideOffset={10}
          collisionAvoidance={fixedMenuSide}
        >
          <Menu.Popup
            className="canvas-frame-menu canvas-view-menu canvas-arrange-menu"
            aria-label="整理布局"
          >
            {choices.map(({ mode, label, Icon }) => (
              <Menu.Item key={mode} onClick={() => choose(mode)}>
                <Icon size={16} />
                {label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
