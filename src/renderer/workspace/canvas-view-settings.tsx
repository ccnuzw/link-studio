import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Switch } from "@base-ui/react/switch";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  defaultCanvasView,
  type CanvasViewPreferences as ViewPreferences,
} from "@link-studio/core";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Ellipsis,
  Frame,
  Image,
  Keyboard,
  Monitor,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
  Type,
  Video,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import "./canvas-view-settings.css";
import { CanvasAccountPill, fixedMenuSide } from "./canvas-account-pill";
import type { canvasModelGroups } from "./media-node-model";
import { NodeAudioIcon } from "./node-audio-icon";

const backgrounds = [
  ["dots", "点阵"],
  ["lines", "线条"],
  ["cross", "十字"],
  ["none", "无"],
] as const;
const wheels = [
  ["pan", "平移画布"],
  ["zoom", "缩放画布"],
] as const;
const themes = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
] as const;
const themeIcons = { system: Monitor, dark: Moon, light: Sun };
const sections = {
  canvas: ["画布设置", "底纹、对齐与滚轮，改动即时生效。"],
  general: ["通用设置", "外观与界面上的常驻提示。"],
  model: ["新节点默认模型", "新建节点时默认选中的模型。"],
} as const;
const modelKinds = {
  script: ["文本", Type],
  image: ["图片", Image],
  video: ["视频", Video],
  audio: ["音频", NodeAudioIcon],
} as const;

function ChoiceRow<Value extends string>({
  title,
  hint,
  options,
  value,
  choose,
}: {
  title: string;
  hint: string;
  options: readonly (readonly [Value, string])[];
  value: Value;
  choose: (value: Value) => void;
}) {
  return (
    <div className="canvas-preference-row">
      <div>
        <strong>{title}</strong>
        <p>{hint}</p>
      </div>
      <fieldset className="canvas-preference-options" data-ui-group aria-label={title}>
        {options.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={value === key} onClick={() => choose(key)}>
            {label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

type DialogOptions = {
  preferences: ViewPreferences;
  change: (next: Partial<ViewPreferences>) => void;
  failed: boolean;
  modelGroups?: ReturnType<typeof canvasModelGroups>;
};

function DefaultModelRows({
  preferences,
  change,
  modelGroups = [],
}: Pick<DialogOptions, "preferences" | "change" | "modelGroups">) {
  return modelGroups.map(({ kind, models }) => {
    const selected =
      models.find((model) => model.id === preferences.defaultModels[kind]) ?? models[0];
    if (!selected) return null;
    const [label, Icon] = modelKinds[kind];
    return (
      <div key={kind} className="canvas-preference-row">
        <div>
          <strong>{label}节点</strong>
          <p>{selected.price ? `新建时默认用 ${selected.price}的模型` : "新建时默认选用此模型"}</p>
        </div>
        <Menu.Root>
          <Menu.Trigger className="canvas-model-choice" aria-label={`选择${label}节点的默认模型`}>
            <Icon size={16} />
            <span>{selected.label}</span>
            <ChevronDown size={16} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              className="canvas-frame-positioner canvas-model-positioner"
              align="end"
              sideOffset={6}
              collisionAvoidance={fixedMenuSide}
            >
              <Menu.Popup className="canvas-frame-menu canvas-view-menu canvas-model-options">
                <Menu.RadioGroup
                  value={selected.id}
                  onValueChange={(id) =>
                    change({ defaultModels: { ...preferences.defaultModels, [kind]: id } })
                  }
                >
                  {models.map((model) => (
                    <Menu.RadioItem key={model.id} value={model.id}>
                      <span className="canvas-model-label">
                        <span>{model.label}</span>
                        {model.hint && <small>{model.hint}</small>}
                      </span>
                      <small>{model.price || "—"}</small>
                      <Menu.RadioItemIndicator className="canvas-model-check">
                        <Check size={16} />
                      </Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    );
  });
}

export function CanvasViewSettings({
  openGuide,
  ...options
}: DialogOptions & { openGuide: () => void }) {
  const [open, setOpen] = useState(false);
  const { preferences, change } = options;
  const ThemeIcon = themeIcons[preferences.theme];
  return (
    <>
      <div className="canvas-view-zone">
        <div className="canvas-view-more">
          <Menu.Root modal={false}>
            <Tooltip.Provider delay={0}>
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Menu.Trigger
                      render={<motion.button type="button" whileTap={{ scale: 0.96 }} />}
                      aria-label="更多"
                    />
                  }
                >
                  <Ellipsis size={16} />
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Positioner className="strip-tip-pos" side="bottom" sideOffset={8}>
                    <Tooltip.Popup className="strip-tip canvas-more-tip">
                      更多
                      <Tooltip.Arrow />
                    </Tooltip.Popup>
                  </Tooltip.Positioner>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
            <Menu.Portal>
              <Menu.Positioner
                className="canvas-frame-positioner"
                align="end"
                sideOffset={10}
                collisionAvoidance={fixedMenuSide}
              >
                <Menu.Popup aria-label="更多" className="canvas-frame-menu canvas-view-menu">
                  <Menu.Item onClick={() => setOpen(true)}>
                    <Settings size={16} />
                    画布设置
                  </Menu.Item>
                  <Menu.Item onClick={openGuide}>
                    <Keyboard size={16} />
                    快捷键<small>?</small>
                  </Menu.Item>
                  <Menu.Separator />
                  <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger>
                      <ThemeIcon size={16} />
                      主题
                      <ChevronRight size={16} />
                    </Menu.SubmenuTrigger>
                    <Menu.Portal>
                      <Menu.Positioner
                        className="canvas-frame-positioner"
                        side="right"
                        align="start"
                        alignOffset={-3}
                        sideOffset={0}
                        collisionAvoidance={fixedMenuSide}
                      >
                        <Menu.Popup
                          className="canvas-frame-menu canvas-theme-menu"
                          aria-label="主题"
                        >
                          <Menu.RadioGroup
                            value={preferences.theme}
                            onValueChange={(theme) => change({ theme })}
                          >
                            {(["system", "dark", "light"] as const).map((theme) => {
                              const Icon = themeIcons[theme];
                              return (
                                <Menu.RadioItem key={theme} value={theme}>
                                  <Icon size={16} />
                                  {themes.find(([value]) => value === theme)?.[1]}
                                  <Menu.RadioItemIndicator>
                                    <Check size={16} />
                                  </Menu.RadioItemIndicator>
                                </Menu.RadioItem>
                              );
                            })}
                          </Menu.RadioGroup>
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.SubmenuRoot>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
        <CanvasAccountPill />
      </div>
      <CanvasPreferencesDialog {...options} open={open} setOpen={setOpen} />
    </>
  );
}

export function CanvasPreferencesDialog({
  open,
  setOpen,
  preferences,
  change,
  failed,
  modelGroups,
}: DialogOptions & { open: boolean; setOpen: (open: boolean) => void }) {
  const [section, setSection] = useState<keyof typeof sections>("canvas");
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal className="storyboard-layer">
        <Dialog.Backdrop className="storyboard-backdrop" />
        <Dialog.Popup className="canvas-preferences">
          <div className="canvas-preferences-layout">
            <nav aria-label="设置分类">
              <button
                type="button"
                aria-pressed={section === "canvas"}
                onClick={() => setSection("canvas")}
              >
                <Frame size={16} />
                画布设置
              </button>
              <button
                type="button"
                aria-pressed={section === "general"}
                onClick={() => setSection("general")}
              >
                <SlidersHorizontal size={16} />
                通用设置
              </button>
              <button
                type="button"
                aria-pressed={section === "model"}
                onClick={() => setSection("model")}
              >
                <Cpu size={16} />
                新节点默认模型
              </button>
            </nav>
            <section>
              <header>
                <Dialog.Title>{sections[section][0]}</Dialog.Title>
                <Dialog.Description>{sections[section][1]}</Dialog.Description>
              </header>
              <div className="canvas-preferences-body">
                <div className="canvas-preferences-rows">
                  {section === "canvas" ? (
                    <>
                      <ChoiceRow
                        title="背景网格"
                        hint="画布底纹的样式"
                        options={backgrounds}
                        value={preferences.background}
                        choose={(background) => change({ background })}
                      />
                      <ChoiceRow
                        title="滚轮行为"
                        hint="滚轮直接平移，还是直接缩放"
                        options={wheels}
                        value={preferences.wheelMode}
                        choose={(wheelMode) => change({ wheelMode })}
                      />
                    </>
                  ) : section === "model" ? (
                    <DefaultModelRows
                      preferences={preferences}
                      change={change}
                      modelGroups={modelGroups}
                    />
                  ) : (
                    <>
                      <ChoiceRow
                        title="主题"
                        hint="锁定后不再跟随系统深浅色"
                        options={themes}
                        value={preferences.theme}
                        choose={(theme) => change({ theme })}
                      />
                      <div className="canvas-preference-row">
                        <div>
                          <strong>操作提示</strong>
                          <p>空画布时顶部那条快捷键提示</p>
                        </div>
                        <Switch.Root
                          aria-label="操作提示"
                          className="canvas-hint-switch"
                          checked={preferences.showHints}
                          onCheckedChange={(showHints) => change({ showHints })}
                        >
                          <Switch.Thumb />
                        </Switch.Root>
                      </div>
                    </>
                  )}
                  {failed && <p role="alert">画布偏好未同步，请重新选择。</p>}
                </div>
              </div>
              <footer>
                <button type="button" onClick={() => change(defaultCanvasView)}>
                  恢复默认
                </button>
              </footer>
            </section>
          </div>
          <Dialog.Close aria-label="关闭" className="storyboard-close">
            <X size={16} />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
