import { Popover } from "@base-ui/react/popover";
import type { ModelConfig, modelGenerationOptions } from "@link-studio/core";
import type { MediaParameters } from "./model-switch";

export type { MediaParameters } from "./model-switch";

import { Box, Check, Clock, Film, History, LayoutGrid, Sun, User } from "lucide-react";
import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  MOTION_CATEGORIES,
  MOTION_PRESETS,
  type PresetKind,
  STYLE_CATEGORIES,
  STYLE_PRESETS,
  TEMPLATE_GROUPS,
  TEMPLATE_PRESETS,
} from "./media-presets";

import { RatioIcon } from "./ratio-icon";
import "./image-node-popover.css";

export const MediaPanel = createContext(false);

type MediaPopoverProps = {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  wide?: boolean;
  presetPanel?: boolean;
  mediaPanel?: boolean;
  close: (restoreFocus?: boolean) => void;
  children: ReactNode;
};

export function MediaPopover(props: MediaPopoverProps) {
  if (!props.mediaPanel) return <LegacyMediaPopover {...props} />;
  const { anchor, label, presetPanel, close, children } = props;
  return (
    <Popover.Root
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (
          details.reason === "outside-press" &&
          anchor.current &&
          details.event.composedPath().includes(anchor.current)
        )
          return;
        close(details.reason === "escape-key");
      }}
    >
      <Popover.Portal container={anchor.current?.closest("dialog") ?? undefined}>
        <Popover.Positioner
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={10}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className="image-node-positioner"
        >
          <Popover.Popup
            role="region"
            aria-label={label}
            finalFocus={false}
            className="image-node-popover nodrag nopan nowheel"
            data-preset-panel={presetPanel || undefined}
          >
            <MediaPanel.Provider value>{children}</MediaPanel.Provider>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LegacyMediaPopover({
  anchor,
  label,
  wide = false,
  presetPanel = false,
  close,
  children,
}: MediaPopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  }, [close]);
  useLayoutEffect(() => {
    const button = anchor.current;
    const element = panel.current;
    if (!button || !element) return;
    const position = () => {
      const rect = button.getBoundingClientRect();
      const margin = presetPanel ? 8 : 10;
      const gap = presetPanel ? 10 : 7;
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
      const above = Math.max(0, rect.top - gap - margin);
      const desired = Math.min(360, element.scrollHeight + 2);
      const flip = presetPanel
        ? above >= desired || above >= below
        : below < desired && above > below;
      element.style.maxHeight = `${Math.min(360, flip ? above : below)}px`;
      element.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - element.offsetWidth - margin))}px`;
      element.style.top = `${flip ? rect.top - gap - element.offsetHeight : rect.bottom + gap}px`;
    };
    element.showPopover();
    position();
    element.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!event.composedPath().includes(element) && !event.composedPath().includes(button))
        closeRef.current();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    };
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("wheel", outside, true);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("wheel", outside, true);
      document.removeEventListener("keydown", onEscape, true);
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [anchor, presetPanel]);
  return (
    <section
      ref={panel}
      className="canvas-surface media-popover nodrag nopan nowheel"
      data-wide={wide}
      data-preset-panel={presetPanel || undefined}
      popover="manual"
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </section>
  );
}

type Options = ReturnType<typeof modelGenerationOptions>;

function selectionProps(mediaPanel: boolean, selected: boolean) {
  return mediaPanel ? { role: "radio", "aria-checked": selected } : { "aria-pressed": selected };
}

function Choices<T extends string | number | boolean>({
  label,
  values,
  current,
  defaultValue,
  onPick,
}: {
  label: string;
  values: ReadonlyArray<{ value: T; label: string }>;
  current?: T;
  defaultValue?: T;
  onPick: (value: T | undefined) => void;
}) {
  const mediaPanel = useContext(MediaPanel);
  const effective = current ?? defaultValue;
  const ratioChoices =
    mediaPanel && values.every(({ value }) => /^(?:\d+:\d+|auto)$/i.test(String(value)));
  if (mediaPanel && values.length > 6 && !ratioChoices)
    return (
      <label className="image-param-row">
        {label}
        <select
          value={String(effective ?? "")}
          onChange={(event) =>
            onPick(values.find(({ value }) => String(value) === event.target.value)?.value)
          }
        >
          {effective === undefined && <option value="">请选择</option>}
          {values.map(({ value, label }) => (
            <option key={String(value)} value={String(value)}>
              {label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <fieldset className="media-options" role={mediaPanel ? "radiogroup" : undefined}>
      <legend>{label}</legend>
      <div className={`media-option-row${ratioChoices ? " media-ratios" : ""}`}>
        {!mediaPanel && (
          <button
            type="button"
            aria-pressed={current === undefined}
            onClick={() => onPick(undefined)}
          >
            {defaultValue === undefined
              ? "默认"
              : `默认 · ${values.find(({ value }) => value === defaultValue)?.label ?? defaultValue}`}
          </button>
        )}
        {values.map(({ value, label }) => (
          <button
            type="button"
            key={String(value)}
            {...selectionProps(mediaPanel, value === (mediaPanel ? effective : current))}
            onClick={() => onPick(value)}
          >
            {ratioChoices && <RatioIcon ratio={String(value)} />}
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const qualityLabels = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
  standard: "标准",
  hd: "高清",
};

function OrderedControls({
  order,
  children,
}: {
  order: ModelConfig["parameterOrder"];
  children: ReactNode;
}) {
  const controls = new Map<string, ReactNode[]>();
  const unkeyed: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const key = child.key === null ? undefined : String(child.key);
    if (!key) {
      unkeyed.push(child);
      return;
    }
    controls.set(key, [...(controls.get(key) ?? []), child]);
  });
  if (!order) return [...controls.values()].flat().concat(unkeyed);
  const ordered = order.flatMap((key) => controls.get(key) ?? []);
  const orderedKeys = new Set(order);
  return [
    ...ordered,
    ...[...controls.entries()]
      .filter(([key]) => !orderedKeys.has(key))
      .flatMap(([, nodes]) => nodes),
    ...unkeyed,
  ];
}

function PanelNumber({
  label,
  min,
  max,
  step,
  unit,
  value,
  select,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  value?: number;
  select: (next: number | undefined) => void;
}) {
  return (
    <div className="image-param-row">
      <span>{label}</span>
      <div className="image-number-inputs">
        <input
          aria-label={label}
          type="range"
          min={min}
          max={max}
          step={step ?? 1}
          value={value ?? min}
          onChange={(event) => select(event.target.valueAsNumber)}
        />
        <input
          aria-label={`${label}（数值）`}
          type="number"
          min={min}
          max={max}
          step={step ?? 1}
          value={value ?? ""}
          onChange={(event) => select(event.target.value ? event.target.valueAsNumber : undefined)}
        />
        {unit && <span>{unit}</span>}
      </div>
      <div className="image-number-bounds">
        <span>
          最短 {min}
          {unit}
        </span>
        <span>
          最长 {max}
          {unit}
        </span>
      </div>
    </div>
  );
}

export function MediaParameterPicker({
  options,
  value,
  size,
  duration,
  change,
  setSize,
  setDuration,
}: {
  options: Options;
  value: MediaParameters;
  size: string;
  duration: string;
  change: (update: MediaParameters) => void;
  setSize: (value: string) => void;
  setDuration: (value: string) => void;
}) {
  const mediaPanel = useContext(MediaPanel);
  const counts = options.counts;
  const showProtocolExtras = !mediaPanel || !options.hasParameterDefinitions;
  const allSizes = [...options.sizes, ...options.largeSizes];
  const defaults = options.defaultParameters;
  const visible = (name: (typeof options.hiddenParameters)[number]) =>
    !options.hiddenParameters.includes(name);
  const configuredSize = typeof defaults.size === "string" ? defaults.size : undefined;
  const independentRatio = options.nativeImageSize && defaults.aspectRatio !== undefined;
  const ratios = options.ratios.length
    ? options.ratios
    : options.sizes.map((item) => {
        const [width = 1, height = 1] = item.split("x").map(Number);
        const divisor =
          [1024, 512, 256, 80].find((value) => width % value === 0 && height % value === 0) ?? 1;
        return `${width / divisor}:${height / divisor}`;
      });
  const currentIndex = allSizes.indexOf(value.size ?? "");
  const ratioIndex =
    currentIndex < 0 || options.sizes.length === 0 ? -1 : currentIndex % options.sizes.length;
  const large = currentIndex >= options.sizes.length && options.largeSizes.length > 0;
  return (
    <div className="media-parameter-stack">
      <OrderedControls
        order={
          options.parameterOrder ??
          (mediaPanel
            ? ["aspectRatio", "size", "resolution", "quality", "duration", "generateAudio", "count"]
            : undefined)
        }
      >
        {Object.entries(options.customParameters).map(([key, field]) => {
          if (!field.open) return null;
          const selected = value.customParams?.[key];
          const select = (next: string | number | boolean | undefined) => {
            const customParams = { ...value.customParams };
            if (next === undefined) delete customParams[key];
            else customParams[key] = next;
            change({ customParams });
          };
          if (mediaPanel && field.type === "number")
            return (
              <PanelNumber
                key={key}
                {...field}
                label={field.label}
                value={Number(selected ?? field.default)}
                select={select}
              />
            );
          if (field.type === "number")
            return (
              <label key={key} className="media-manual-param">
                {field.label}
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step ?? 1}
                  value={Number(selected ?? field.default)}
                  onChange={(event) => select(Number(event.target.value))}
                />
                <output>
                  {String(selected ?? field.default)} {field.unit}
                </output>
              </label>
            );
          return (
            <Choices
              key={key}
              label={field.label}
              current={selected}
              defaultValue={field.default}
              values={(field.type === "enum" ? field.values : [true, false]).map((value) => ({
                value,
                label:
                  typeof value === "boolean"
                    ? value
                      ? "开启"
                      : "关闭"
                    : `${value}${mediaPanel && field.type === "enum" ? (field.unit ?? "") : ""}`,
              }))}
              onPick={select}
            />
          );
        })}
        {configuredSize && visible("size") && (
          <Choices
            key="size"
            label={options.parameterLabels.size || "尺寸"}
            current={value.size}
            defaultValue={value.aspectRatio ? undefined : configuredSize}
            values={allSizes.map((item) => ({ value: item, label: item }))}
            onPick={(size) => change({ size, aspectRatio: undefined, resolution: undefined })}
          />
        )}
        {(!configuredSize || independentRatio) && visible("aspectRatio") && !!ratios.length && (
          <fieldset
            key="aspectRatio"
            className="media-options"
            role={mediaPanel ? "radiogroup" : undefined}
          >
            <legend>{options.parameterLabels.aspectRatio || "画面比例"}</legend>
            <div className="media-option-row media-ratios">
              {!mediaPanel && (
                <button
                  type="button"
                  aria-pressed={value.aspectRatio === undefined && ratioIndex < 0}
                  onClick={() => change({ size: undefined, aspectRatio: undefined })}
                >
                  {defaults.aspectRatio ? `默认 · ${defaults.aspectRatio}` : "默认"}
                </button>
              )}
              {ratios.map((ratio, index) => {
                const [width = 1, height = 1] = ratio.split(":").map(Number);
                const longest = Math.max(width, height);
                return (
                  <button
                    type="button"
                    key={options.ratios.length ? ratio : options.sizes[index]}
                    {...selectionProps(
                      mediaPanel,
                      (value.aspectRatio ??
                        (mediaPanel &&
                        ratioIndex < 0 &&
                        (!configuredSize || configuredSize === "auto")
                          ? defaults.aspectRatio
                          : undefined)) === ratio ||
                        (!options.ratios.length && index === ratioIndex),
                    )}
                    onClick={() =>
                      change(
                        options.ratios.length
                          ? { aspectRatio: ratio, size: undefined }
                          : {
                              size: (large ? options.largeSizes : options.sizes)[index],
                              aspectRatio: undefined,
                            },
                      )
                    }
                  >
                    {mediaPanel ? (
                      <RatioIcon ratio={ratio} />
                    ) : (
                      Number.isFinite(longest) &&
                      longest > 0 && (
                        <span
                          className="media-ratio-outline"
                          style={{ width: (28 * width) / longest, height: (28 * height) / longest }}
                        />
                      )
                    )}
                    {ratio === "adaptive"
                      ? "自适应"
                      : ratios.indexOf(ratio) !== ratios.lastIndexOf(ratio)
                        ? options.sizes[index]
                        : ratio}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
        {showProtocolExtras &&
          options.manualSize &&
          visible("aspectRatio") &&
          visible("resolution") && (
            <label className="media-manual-param">
              尺寸
              <input
                value={size}
                maxLength={64}
                onChange={(event) => setSize(event.target.value)}
                placeholder="例如 1024x1024"
              />
            </label>
          )}
        {!!options.qualities.length && visible("quality") && (
          <Choices
            key="quality"
            label={options.parameterLabels.quality || "画质"}
            current={value.quality}
            defaultValue={options.qualities.find((item) => item === defaults.quality)}
            values={options.qualities.map((item) => ({ value: item, label: qualityLabels[item] }))}
            onPick={(quality) => change({ quality })}
          />
        )}
        {!!options.resolutions.length && visible("resolution") && (
          <Choices
            key="resolution"
            label={options.parameterLabels.resolution || "清晰度"}
            current={value.resolution}
            defaultValue={options.resolutions.find((item) => item === defaults.resolution)}
            values={options.resolutions.map((item) => ({ value: item, label: item }))}
            onPick={(resolution) =>
              change(resolution ? { resolution, size: undefined } : { resolution })
            }
          />
        )}
        {!configuredSize &&
          !options.resolutions.length &&
          visible("resolution") &&
          !!options.largeSizes.length && (
            <Choices
              key="resolution"
              label={options.parameterLabels.resolution || "清晰度"}
              current={currentIndex < 0 ? undefined : large}
              values={[
                { value: false, label: "720p" },
                { value: true, label: "高分辨率" },
              ]}
              onPick={(high) =>
                change({
                  size:
                    high === undefined
                      ? undefined
                      : (high ? options.largeSizes : options.sizes)[Math.max(0, ratioIndex)],
                })
              }
            />
          )}
        {(options.hasConfiguredCount || options.counts.some((count) => count > 1)) &&
          counts.length > 0 &&
          visible("count") && (
            <Choices
              key="count"
              label={
                options.parameterLabels.count ||
                (mediaPanel ? "生成数量" : options.countUnit === "首" ? "生成首数" : "生成张数")
              }
              current={value.count}
              defaultValue={
                counts.find((item) => item === defaults.count) ??
                (mediaPanel ? counts[0] : undefined)
              }
              values={counts.map((count) => ({
                value: count,
                label: `${count}${mediaPanel ? "" : " "}${options.countUnit}`,
              }))}
              onPick={(count) => change({ count })}
            />
          )}
        {!!options.durations.length && !options.durationRange && visible("duration") && (
          <Choices
            key="duration"
            label={options.parameterLabels.duration || "时长"}
            current={value.duration}
            defaultValue={options.durations.find((item) => item === defaults.duration)}
            values={options.durations.map((item) => ({
              value: item,
              label: `${item}${mediaPanel ? "" : " "}${options.durationUnit}`,
            }))}
            onPick={(seconds) => change({ duration: seconds })}
          />
        )}
        {options.durationRange &&
          options.durationControl &&
          (mediaPanel ? (
            <PanelNumber
              key="duration"
              label={options.parameterLabels.duration || "视频时长"}
              {...options.durationRange}
              step={options.durationStep}
              unit={options.durationUnit}
              value={
                value.duration === -1
                  ? options.durationRange.min
                  : (value.duration ?? Number(defaults.duration ?? options.durationRange.min))
              }
              select={(duration) => change({ duration })}
            />
          ) : (
            <fieldset key="duration" className="media-options">
              <legend>{options.parameterLabels.duration || "时长"}</legend>
              <label className="media-duration-slider">
                <input
                  type="range"
                  aria-label={options.parameterLabels.duration || "视频时长"}
                  min={options.durationRange.min}
                  max={options.durationRange.max}
                  step={options.durationStep}
                  value={
                    value.duration === -1
                      ? options.durationRange.min
                      : (value.duration ?? Number(defaults.duration ?? options.durationRange.min))
                  }
                  onChange={(event) => change({ duration: Number(event.target.value) })}
                />
                <output>
                  {value.duration === -1
                    ? "智能时长"
                    : value.duration === undefined
                      ? defaults.duration === undefined
                        ? "默认"
                        : `默认 · ${defaults.duration} 秒`
                      : `${value.duration} 秒`}
                </output>
                <button type="button" onClick={() => change({ duration: undefined })}>
                  重置
                </button>
              </label>
            </fieldset>
          ))}
        {options.manualDuration && (
          <label className="media-manual-param">
            时长（秒）
            <input
              type="number"
              min={1}
              max={30}
              value={duration}
              onChange={(event) => setDuration(event.target.value.slice(0, 64))}
              placeholder="由模型决定"
            />
          </label>
        )}
        {options.audio && options.audioControl && (
          <Choices
            key="generateAudio"
            label={options.audioLabel ?? "声音"}
            current={value.generateAudio}
            defaultValue={defaults.generateAudio}
            values={[
              { value: true, label: mediaPanel ? "开启" : "生成声音" },
              { value: false, label: mediaPanel ? "关闭" : "静音" },
            ]}
            onPick={(generateAudio) => change({ generateAudio })}
          />
        )}
        {options.autoDuration && visible("duration") && (
          <button
            key="duration"
            type="button"
            aria-pressed={value.duration === -1}
            onClick={() => change({ duration: value.duration === -1 ? undefined : -1 })}
          >
            智能时长
          </button>
        )}
        {options.videoAction && (
          <Choices
            label="视频操作"
            current={value.videoAction ?? "edit"}
            values={
              [
                { value: "edit", label: "编辑" },
                { value: "extend", label: "延长" },
              ] as const
            }
            onPick={(videoAction) => change({ videoAction, duration: undefined })}
          />
        )}
        {showProtocolExtras && options.seed && (
          <label className="media-manual-param">
            随机种子
            <input
              type="number"
              min={-1}
              max={4294967295}
              step={1}
              value={value.seed ?? ""}
              onChange={(event) =>
                change({ seed: event.target.value === "" ? undefined : event.target.valueAsNumber })
              }
            />
          </label>
        )}
        {showProtocolExtras && options.negativePrompt && (
          <label className="media-manual-param">
            负面提示词
            <input
              maxLength={2000}
              value={value.negativePrompt ?? ""}
              onChange={(event) => change({ negativePrompt: event.target.value || undefined })}
            />
          </label>
        )}
        {options.audioFormats.length > 0 && visible("audioFormat") && (
          <Choices
            key="audioFormat"
            label={options.parameterLabels.audioFormat || "音频格式"}
            current={value.audioFormat}
            defaultValue={options.audioFormats.find((item) => item === defaults.audioFormat)}
            values={options.audioFormats.map((format) => ({
              value: format,
              label: format === "ogg_opus" ? "OGG / Opus" : format.toUpperCase(),
            }))}
            onPick={(audioFormat) => change({ audioFormat })}
          />
        )}
        {options.speaker && (
          <label className="media-manual-param">
            音色 ID
            <input
              maxLength={200}
              value={value.speaker ?? ""}
              onChange={(event) => change({ speaker: event.target.value || undefined })}
            />
          </label>
        )}
        {options.audioFormats.length > 0 && (
          <details>
            <summary>音频高级参数</summary>
            {(
              [
                ["sampleRate", "采样率（Hz）", 8000, 48000],
                ["speechRate", "语速", -50, 100],
                ["loudnessRate", "音量", -50, 100],
                ["pitchRate", "音调", -12, 12],
              ] as const
            ).map(([key, label, min, max]) => (
              <label className="media-manual-param" key={key}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  value={value[key] ?? ""}
                  onChange={(event) =>
                    change({ [key]: event.target.value ? event.target.valueAsNumber : undefined })
                  }
                />
              </label>
            ))}
          </details>
        )}
        {options.instrumental && (
          <label className="settings-check">
            <input
              type="checkbox"
              checked={value.makeInstrumental ?? false}
              onChange={(event) => change({ makeInstrumental: event.target.checked })}
            />
            纯音乐
          </label>
        )}
      </OrderedControls>
    </div>
  );
}

const templateIcons = {
  film: Film,
  grid: LayoutGrid,
  clock: Clock,
  history: History,
  sun: Sun,
  user: User,
  box: Box,
};
export const presetLabels = { style: "风格", tpl: "提示词模板", motion: "运镜" };
export type PickedPresets = Record<PresetKind, string[]>;

export function selectedPresetText(picked: PickedPresets) {
  return [
    ...TEMPLATE_PRESETS.filter(({ id }) => picked.tpl.includes(id)),
    ...STYLE_PRESETS.filter(({ id }) => picked.style.includes(id)),
    ...picked.motion.flatMap((id) => MOTION_PRESETS.filter((preset) => preset.id === id)),
  ];
}

export function MediaPresetPicker({
  kind,
  selected,
  onPick,
  maxLength,
}: {
  kind: PresetKind;
  selected: string[];
  onPick: (id: string) => void;
  maxLength?: number;
}) {
  const [category, setCategory] = useState("all");
  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!event.key.startsWith("Arrow")) return;
    const container = event.currentTarget.closest(".media-template-groups, .media-preset-grid");
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLButtonElement>("[data-preset-item]")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const columns =
      kind === "tpl" ? 1 : getComputedStyle(container).gridTemplateColumns.split(" ").length;
    const step = { ArrowDown: columns, ArrowUp: -columns, ArrowLeft: -1, ArrowRight: 1 }[event.key];
    const next = step && items[index + step];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
  const itemProps = (item: { id: string; name: string; usage?: string; prompt: string }) => {
    const length = Array.from(item.prompt.trim()).length;
    const overLimit = !!maxLength && length > maxLength;
    const title = item.usage ? `${item.name} · ${item.usage}` : item.name;
    return {
      "aria-pressed": selected.includes(item.id),
      "data-preset-item": true,
      onKeyDown: moveFocus,
      "aria-disabled": overLimit || undefined,
      title: overLimit
        ? `${title}\n展开后约 ${length} 字，超过当前模型的 ${maxLength} 字上限，不能选`
        : title,
      onClick: () => {
        if (!overLimit) onPick(item.id);
      },
    };
  };
  if (kind === "tpl")
    return (
      <div className="media-template-groups">
        {[[TEMPLATE_GROUPS[0]], [TEMPLATE_GROUPS[1], TEMPLATE_GROUPS[2]], [TEMPLATE_GROUPS[3]]].map(
          (groups) => (
            <div key={groups[0]}>
              {groups.map((group) => (
                <section key={group}>
                  <h4>{group}</h4>
                  {TEMPLATE_PRESETS.filter((item) => item.group === group).map((item) => {
                    const Icon = templateIcons[item.icon];
                    return (
                      <button type="button" key={item.id} {...itemProps(item)}>
                        <span className="template-icon">
                          <Icon size={18} />
                        </span>
                        <span className="template-name">{item.name}</span>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          ),
        )}
      </div>
    );
  const categories = kind === "style" ? STYLE_CATEGORIES : MOTION_CATEGORIES;
  const presets = kind === "style" ? STYLE_PRESETS : MOTION_PRESETS;
  return (
    <>
      <fieldset
        className="media-option-row media-preset-tabs"
        aria-label={`${presetLabels[kind]}分类`}
      >
        {[{ id: "all", label: "全部" }, ...categories].map(({ id, label }) => (
          <button
            type="button"
            key={id}
            aria-pressed={id === category}
            onClick={() => setCategory(id)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <div className="media-preset-grid" data-kind={kind}>
        {presets
          .filter((item) => category === "all" || item.category === category)
          .map((preset) => (
            <button type="button" key={preset.id} {...itemProps(preset)}>
              <img src={preset.cover} loading="lazy" alt="" />
              <span>{preset.name}</span>
              {selected.includes(preset.id) && (
                <i className="style-selected">
                  <Check size={12} strokeWidth={3} />
                </i>
              )}
            </button>
          ))}
      </div>
    </>
  );
}
