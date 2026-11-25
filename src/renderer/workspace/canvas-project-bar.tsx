import { Menu } from "@base-ui/react/menu";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CloudAlert,
  Ellipsis,
  FileDown,
  LoaderCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import brandIcon from "../../../resources/brand/icon.svg";
import { fixedMenuSide } from "./canvas-account-pill";
import { CanvasControlTip } from "./canvas-control-tip";
import "./canvas-project-bar.css";

const saveLabels = {
  loading: "加载中",
  saving: "正在保存",
  saved: "已保存",
  error: "保存失败 · 重试",
  conflict: "存在冲突",
};
type SaveState = keyof typeof saveLabels;
type Action = { label: string; run: () => void; disabled?: boolean };

function SaveIndicator({ state, retry }: { state: SaveState; retry: () => void }) {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    if (state === "saved") {
      const timer = setTimeout(() => setQuiet(true), 2000);
      return () => clearTimeout(timer);
    }
  }, [state]);
  const Icon =
    state === "saving"
      ? LoaderCircle
      : state === "error"
        ? CloudAlert
        : state === "conflict"
          ? RefreshCw
          : Check;
  const content = (
    <>
      <Icon size={14} />
      <AnimatePresence>
        {!quiet && (
          <motion.span
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: "auto" }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
          >
            {saveLabels[state]}
          </motion.span>
        )}
      </AnimatePresence>
    </>
  );
  const props = {
    className: "canvas-save-indicator",
    "data-state": state,
    "aria-label": saveLabels[state],
  };
  return state === "error" ? (
    <button type="button" {...props} onClick={retry}>
      {content}
    </button>
  ) : (
    <output {...props}>{content}</output>
  );
}

export function CanvasProjectBar({
  title,
  rename,
  state,
  retry,
  leave,
  create,
  exportGraph,
  extras,
  locked,
}: {
  title: string;
  rename: (name: string) => void;
  state: SaveState;
  retry: () => void;
  leave: () => void;
  create: () => void;
  exportGraph: () => void;
  extras: Action[];
  locked: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancel = useRef(false);
  const shown = draft ?? title;
  return (
    <header className="canvas-controls canvas-project-zone">
      <div className="canvas-control-pill">
        <Menu.Root modal={false}>
          <Tooltip.Provider delay={0}>
            <CanvasControlTip label="画布菜单" side="bottom">
              <Menu.Trigger
                aria-label="画布菜单"
                className="canvas-brand-trigger"
                render={<motion.button type="button" whileTap={{ scale: 0.96 }} />}
              >
                <img src={brandIcon} width={30} height={30} alt="" />
                <ChevronDown size={12} />
              </Menu.Trigger>
            </CanvasControlTip>
          </Tooltip.Provider>
          <Menu.Portal>
            <Menu.Positioner
              sideOffset={10}
              className="canvas-frame-positioner"
              collisionAvoidance={fixedMenuSide}
            >
              <Menu.Popup
                className="canvas-frame-menu canvas-view-menu canvas-brand-menu"
                aria-label="画布菜单"
              >
                <Menu.Item disabled={locked} onClick={leave}>
                  <ArrowLeft size={16} />
                  返回项目列表
                </Menu.Item>
                <Menu.Separator />
                <Menu.Item disabled={locked} onClick={create}>
                  <Plus size={16} />
                  新建画布项目
                </Menu.Item>
                <Menu.Separator />
                <Menu.Item disabled={locked} onClick={exportGraph}>
                  <FileDown size={16} />
                  导出画布
                </Menu.Item>
                <Menu.Separator />
                <Menu.SubmenuRoot>
                  <Menu.SubmenuTrigger>
                    <Ellipsis size={16} />
                    桌面项目操作
                  </Menu.SubmenuTrigger>
                  <Menu.Portal>
                    <Menu.Positioner
                      className="canvas-frame-positioner"
                      side="right"
                      align="start"
                      alignOffset={-3}
                    >
                      <Menu.Popup
                        className="canvas-frame-menu canvas-view-menu canvas-brand-extras"
                        aria-label="桌面项目操作"
                      >
                        {extras.map((action) => (
                          <Menu.Item
                            key={action.label}
                            disabled={action.disabled}
                            onClick={action.run}
                          >
                            {action.label}
                          </Menu.Item>
                        ))}
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.SubmenuRoot>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <label className="canvas-inline-title">
          <span aria-hidden="true">{shown || " "}</span>
          <input
            aria-label="画布名称"
            maxLength={60}
            value={shown}
            spellCheck={false}
            disabled={locked}
            onFocus={(event) => {
              cancel.current = false;
              setDraft(title);
              event.currentTarget.select();
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              const name = draft?.trim().slice(0, 60);
              setDraft(null);
              if (!cancel.current && name && name !== title) rename(name);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape" || event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                cancel.current = event.key === "Escape";
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <SaveIndicator key={state} state={state} retry={retry} />
      </div>
    </header>
  );
}
