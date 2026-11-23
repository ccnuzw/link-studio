import { Menu } from "@base-ui/react/menu";
import { Tooltip } from "@base-ui/react/tooltip";
import NumberFlow from "@number-flow/react";
import { useStore } from "@xyflow/react";
import { CircleDashed, createLucideIcon, Grip, Map as MapIcon, Search } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import { fixedMenuSide } from "./canvas-account-pill";
import { CanvasControlTip as Tip } from "./canvas-control-tip";
import { canvasModifier } from "./canvas-keys";
import type { ViewPreferences } from "./canvas-view-preferences";
import "./canvas-view-controls.css";

const actions = [
  ["in", "放大", `${canvasModifier}+`],
  ["out", "缩小", `${canvasModifier}−`],
  ["fit", "适应画布", "⇧1"],
  ["reset", "缩放到 100%", "⇧0"],
] as const;
const backgrounds = [
  ["dots", "点阵背景", Grip],
  ["none", "无背景", CircleDashed],
] as const;
const tap = { scale: 0.96 };
const CanvasHelpIcon = createLucideIcon("circle-question-mark", [
  ["circle", { cx: 12, cy: 12, r: 10, key: "circle" }],
  ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", key: "hook" }],
  ["path", { d: "M12 17h.01", key: "dot" }],
]);

export function CanvasViewControls({
  background,
  setBackground,
  changeView,
  minimap,
  toggleMap,
  openShortcuts,
}: {
  background: ViewPreferences["background"];
  setBackground: (value: "dots" | "none") => void;
  changeView: (action: (typeof actions)[number][0]) => void;
  minimap: boolean;
  toggleMap: () => void;
  openShortcuts: () => void;
}) {
  const zoom = useStore((state) => state.transform[2]);
  return (
    <Tooltip.Provider delay={0}>
      <div role="toolbar" aria-label="画布视图" className="canvas-controls">
        <div className="canvas-control-pill">
          <LayoutGroup id="canvas-background">
            <div role="radiogroup">
              {backgrounds.map(([key, label, Icon]) => (
                <Tip key={key} label={label}>
                  <motion.button
                    type="button"
                    role="radio"
                    aria-checked={key === background}
                    aria-label={label}
                    whileTap={tap}
                    onClick={() => setBackground(key)}
                  >
                    {key === background && (
                      <motion.span
                        className="canvas-control-indicator"
                        layoutId="segment-indicator"
                        transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
                      />
                    )}
                    <span>
                      <Icon size={16} />
                    </span>
                  </motion.button>
                </Tip>
              ))}
            </div>
          </LayoutGroup>
          <div role="separator" aria-orientation="vertical" />
          <Menu.Root modal={false}>
            <Menu.Trigger
              render={<motion.button type="button" whileTap={tap} />}
              className="canvas-zoom-trigger"
              aria-label="缩放"
            >
              <Search size={14} />
              <NumberFlow value={Math.round(zoom * 100)} suffix="%" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                className="canvas-frame-positioner"
                side="top"
                align="start"
                sideOffset={12}
                collisionAvoidance={fixedMenuSide}
              >
                <Menu.Popup className="canvas-frame-menu canvas-view-menu canvas-zoom-menu">
                  {actions.map(([action, label, shortcut]) => (
                    <ZoomItem
                      key={action}
                      label={label}
                      shortcut={shortcut}
                      separated={action === "fit"}
                      choose={() => changeView(action)}
                    />
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <Tip label={minimap ? "收起小地图" : "显示小地图"}>
            <motion.button
              type="button"
              whileTap={tap}
              aria-label="小地图"
              aria-pressed={minimap}
              onClick={toggleMap}
            >
              <MapIcon size={16} />
            </motion.button>
          </Tip>
        </div>
        <div className="canvas-control-pill">
          <Tip label="快捷键" shortcut="?">
            <motion.button type="button" whileTap={tap} aria-label="快捷键" onClick={openShortcuts}>
              <CanvasHelpIcon size={16} />
            </motion.button>
          </Tip>
        </div>
      </div>
    </Tooltip.Provider>
  );
}

function ZoomItem({
  label,
  shortcut,
  separated,
  choose,
}: {
  label: string;
  shortcut: string;
  separated: boolean;
  choose: () => void;
}) {
  return (
    <>
      {separated && <Menu.Separator />}
      <Menu.Item onClick={choose}>
        {label}
        <small>{shortcut}</small>
      </Menu.Item>
    </>
  );
}
