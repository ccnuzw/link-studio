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
  addMenu,
  locked,
  hand,
  chooseHand,
  canUndo,
  canRedo,
  undo,
  redo,
  openAssets,
  assetsDisabled,
  openTasks,
  tasksOpen,
}: {
  addMenu: ComponentProps<typeof AddNodeMenu>;
  locked: boolean;
  hand: boolean;
  chooseHand: (pan: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  openAssets: () => void;
  assetsDisabled: boolean;
  openTasks: () => void;
  tasksOpen: boolean;
}) {
  return (
    <Tooltip.Provider delay={0}>
      <div className="canvas-controls canvas-edit-controls" role="toolbar" aria-label="画布编辑">
        <div className="canvas-control-pill">
          <AddNodeMenu
            {...addMenu}
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
              <CanvasControlTip side="right" label="添加节点">
                {trigger}
              </CanvasControlTip>
            )}
          />
          <hr data-ui-divider aria-orientation="horizontal" />
          <LayoutGroup id="canvas-tool">
            <div role="radiogroup">
              {tools.map(([pan, label, key, Icon]) => (
                <CanvasControlTip key={label} side="right" label={label} shortcut={key}>
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
          <hr data-ui-divider aria-orientation="horizontal" />
          <CanvasControlTip label="撤销" shortcut={`${canvasModifier}Z`} side="right">
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
          <CanvasControlTip label="重做" shortcut={`⇧${canvasModifier}Z`} side="right">
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
          <hr data-ui-divider aria-orientation="horizontal" className="canvas-edit-wide" />
          <CanvasControlTip label="资产库" side="right">
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
          <CanvasControlTip label="任务历史" side="right">
            <motion.button
              type="button"
              className="canvas-edit-wide"
              whileTap={tap}
              aria-label="任务历史"
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
