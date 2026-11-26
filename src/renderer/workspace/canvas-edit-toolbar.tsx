import { Menu } from "@base-ui/react/menu";
import { Tooltip } from "@base-ui/react/tooltip";
import { FolderOpen, Hand, History, MousePointer2, Plus, Redo2, Undo2 } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import type { ComponentProps } from "react";
import { AddNodeMenu } from "./add-node-menu";
import { CanvasControlTip } from "./canvas-control-tip";
import { canvasModifier } from "./canvas-keys";
import "./canvas-view-controls.css";

const tools = [
  [false, "选择", "V", MousePointer2],
  [true, "抓手", "H", Hand],
] as const;
const tap = { scale: 0.96 };

export function CanvasEditToolbar({
  orientation = "vertical",
  addMenu,
  locked,
  hand,
  chooseHand,
  canUndo,
  canRedo,
  undo,
  redo,
  openAssets,
  openProjectAssets,
  assetsDisabled,
  openTasks,
  tasksOpen,
}: {
  orientation?: "horizontal" | "vertical";
  addMenu: ComponentProps<typeof AddNodeMenu>;
  locked: boolean;
  hand: boolean;
  chooseHand: (pan: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  openAssets: () => void;
  openProjectAssets?: () => void;
  assetsDisabled: boolean;
  openTasks: () => void;
  tasksOpen: boolean;
}) {
  const side = orientation === "horizontal" ? "top" : "right";
  const divider = orientation === "horizontal" ? "vertical" : "horizontal";
  return (
    <Tooltip.Provider delay={0}>
      <div
        className="canvas-controls canvas-edit-controls"
        role="toolbar"
        aria-orientation={orientation}
        aria-label="画布编辑"
      >
        <div className="canvas-control-pill">
          <AddNodeMenu
            {...addMenu}
            triggerSide={side}
            trigger={
              <motion.button
                type="button"
                whileTap={tap}
                aria-label="添加节点"
                disabled={locked}
                className="canvas-edit-add"
              >
                <Plus size={20} strokeWidth={2.25} />
              </motion.button>
            }
            wrapTrigger={(trigger) => (
              <CanvasControlTip side={side} label="添加节点">
                {trigger}
              </CanvasControlTip>
            )}
          />
          <hr data-ui-divider aria-orientation={divider} />
          <LayoutGroup id="canvas-tool">
            <div role="radiogroup">
              {tools.map(([pan, label, key, Icon]) => (
                <CanvasControlTip key={label} side={side} label={label} shortcut={key}>
                  <motion.button
                    role="radio"
                    type="button"
                    whileTap={tap}
                    aria-checked={pan === hand}
                    aria-label={label}
                    onClick={() => chooseHand(pan)}
                  >
                    {pan === hand && (
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
                </CanvasControlTip>
              ))}
            </div>
          </LayoutGroup>
          <hr data-ui-divider aria-orientation={divider} />
          <CanvasControlTip label="撤销" shortcut={`${canvasModifier}Z`} side={side}>
            <motion.button
              type="button"
              whileTap={tap}
              aria-label="撤销"
              disabled={!canUndo}
              onClick={undo}
            >
              <Undo2 size={16} />
            </motion.button>
          </CanvasControlTip>
          <CanvasControlTip label="重做" shortcut={`⇧${canvasModifier}Z`} side={side}>
            <motion.button
              type="button"
              whileTap={tap}
              aria-label="重做"
              disabled={!canRedo}
              onClick={redo}
            >
              <Redo2 size={16} />
            </motion.button>
          </CanvasControlTip>
          <hr data-ui-divider aria-orientation={divider} className="canvas-edit-wide" />
          {openProjectAssets ? (
            <Menu.Root modal={false}>
              <CanvasControlTip label="素材" side={side}>
                <Menu.Trigger aria-label="素材" disabled={assetsDisabled}>
                  <FolderOpen size={16} />
                </Menu.Trigger>
              </CanvasControlTip>
              <Menu.Portal>
                <Menu.Positioner side={side} sideOffset={8} className="canvas-frame-positioner">
                  <Menu.Popup className="canvas-frame-menu canvas-view-menu" aria-label="素材">
                    <Menu.Item onClick={openProjectAssets}>项目素材</Menu.Item>
                    <Menu.Item onClick={openAssets}>从资产库添加</Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          ) : (
            <CanvasControlTip label="资产库" side={side}>
              <motion.button
                type="button"
                className="canvas-edit-wide"
                whileTap={tap}
                aria-label="资产库"
                disabled={assetsDisabled}
                onClick={openAssets}
              >
                <FolderOpen size={16} />
              </motion.button>
            </CanvasControlTip>
          )}
          <CanvasControlTip label={openProjectAssets ? "任务" : "任务历史"} side={side}>
            <motion.button
              type="button"
              className={openProjectAssets ? undefined : "canvas-edit-wide"}
              whileTap={tap}
              aria-label={openProjectAssets ? "任务" : "任务历史"}
              aria-pressed={tasksOpen}
              onClick={openTasks}
            >
              <History size={16} />
            </motion.button>
          </CanvasControlTip>
        </div>
      </div>
    </Tooltip.Provider>
  );
}
