import type { GenerationInput, modelGenerationOptions } from "@link-studio/core";
import { Box, Check, Clock, Film, Grid, History, Sun, User } from "lucide-react";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import {
  MOTION_CATEGORIES,
  MOTION_PRESETS,
  type PresetKind,
  STYLE_CATEGORIES,
  STYLE_PRESETS,
  TEMPLATE_GROUPS,
  TEMPLATE_PRESETS,
} from "./media-presets";

export function MediaPopover({
  anchor,
  label,
  wide = false,
  close,
  children,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  label: string;
  wide?: boolean;
  close: (restoreFocus?: boolean) => void;
  children: ReactNode;
}) {
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
      const margin = 10;
      const gap = 7;
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
      const above = Math.max(0, rect.top - gap - margin);
      const desired = Math.min(360, element.scrollHeight + 2);
      const flip = below < desired && above > below;
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
  }, [anchor]);
  return (
    <section
      ref={panel}
      className="canvas-surface media-popover nodrag nopan nowheel"
      data-wide={wide}
      popover="manual"
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </section>
  );
}

export type MediaParameters = Pick<
  GenerationInput,
  | "size"
  | "duration"
  | "count"
  | "quality"
  | "aspectRatio"
  | "resolution"
  | "generateAudio"
  | "seed"
  | "negativePrompt"
  | "audioFormat"
  | "speaker"
  | "sampleRate"
  | "speechRate"
  | "loudnessRate"
  | "pitchRate"
  | "makeInstrumental"
  | "videoAction"
>;
type Options = ReturnType<typeof modelGenerationOptions>;

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
  return (
    <fieldset className="media-options">
      <legend>{label}</legend>
      <div className="media-option-row">
        <button
          type="button"
          aria-pressed={current === undefined}
          onClick={() => onPick(undefined)}
        >
          {defaultValue === undefined
            ? "默认"
            : `默认 · ${values.find(({ value }) => value === defaultValue)?.label ?? defaultValue}`}
        </button>
        {values.map(({ value, label }) => (
          <button
            type="button"
            key={String(value)}
            aria-pressed={value === current}
            onClick={() => onPick(value)}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const qualityLabels = { low: "低", medium: "中", high: "高", standard: "标准", hd: "高清" };

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
  const allSizes = [...options.sizes, ...options.largeSizes];
  const defaults = options.defaultParameters;
  const configuredSize = typeof defaults.size === "string" ? defaults.size : undefined;
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
      {configuredSize && (
        <Choices
          label="尺寸"
          current={value.size}
          defaultValue={configuredSize}
          values={allSizes.map((item) => ({ value: item, label: item }))}
          onPick={(size) => change({ size, aspectRatio: undefined, resolution: undefined })}
        />
      )}
      {!configuredSize && !!ratios.length && (
        <fieldset className="media-options">
          <legend>画面比例</legend>
          <div className="media-option-row media-ratios">
            <button
              type="button"
              aria-pressed={value.aspectRatio === undefined && ratioIndex < 0}
              onClick={() => change({ size: undefined, aspectRatio: undefined })}
            >
              {defaults.aspectRatio ? `默认 · ${defaults.aspectRatio}` : "默认"}
            </button>
            {ratios.map((ratio, index) => {
              const [width = 1, height = 1] = ratio.split(":").map(Number);
              const longest = Math.max(width, height);
              return (
                <button
                  type="button"
                  key={options.ratios.length ? ratio : options.sizes[index]}
                  aria-pressed={value.aspectRatio === ratio || index === ratioIndex}
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
                  {ratio !== "adaptive" && (
                    <span
                      className="media-ratio-outline"
                      style={{ width: (28 * width) / longest, height: (28 * height) / longest }}
                    />
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
      {options.manualSize && (
        <label className="media-manual-param">
          尺寸
          <input
            value={size}
            onChange={(event) => setSize(event.target.value)}
            placeholder="例如 1024x1024"
          />
        </label>
      )}
      {!!options.qualities.length && (
        <Choices
          label="画质"
          current={value.quality}
          defaultValue={options.qualities.find((item) => item === defaults.quality)}
          values={options.qualities.map((item) => ({ value: item, label: qualityLabels[item] }))}
          onPick={(quality) => change({ quality })}
        />
      )}
      {!!options.resolutions.length && (
        <Choices
          label="清晰度"
          current={value.resolution}
          defaultValue={options.resolutions.find((item) => item === defaults.resolution)}
          values={options.resolutions.map((item) => ({ value: item, label: item }))}
          onPick={(resolution) => change({ resolution })}
        />
      )}
      {!configuredSize && !!options.largeSizes.length && (
        <Choices
          label="清晰度"
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
      {options.maxCount > 1 && (
        <Choices
          label={options.countUnit === "首" ? "生成首数" : "生成张数"}
          current={value.count}
          defaultValue={options.counts.find((item) => item === defaults.count)}
          values={options.counts.map((count) => ({
            value: count,
            label: `${count} ${options.countUnit}`,
          }))}
          onPick={(count) => change({ count })}
        />
      )}
      {!!options.durations.length && (
        <Choices
          label="时长"
          current={value.duration}
          defaultValue={options.durations.find((item) => item === defaults.duration)}
          values={options.durations.map((item) => ({ value: item, label: `${item} 秒` }))}
          onPick={(seconds) => change({ duration: seconds })}
        />
      )}
      {options.durationRange && (
        <fieldset className="media-options">
          <legend>时长</legend>
          <label className="media-duration-slider">
            <input
              type="range"
              aria-label="视频时长"
              min={options.durationRange.min}
              max={options.durationRange.max}
              value={
                value.duration === -1
                  ? options.durationRange.min
                  : (value.duration ?? options.durationRange.min)
              }
              onChange={(event) => change({ duration: Number(event.target.value) })}
            />
            <output>
              {value.duration === -1
                ? "智能时长"
                : value.duration === undefined
                  ? "默认"
                  : `${value.duration} 秒`}
            </output>
            <button type="button" onClick={() => change({ duration: undefined })}>
              重置
            </button>
          </label>
        </fieldset>
      )}
      {options.manualDuration && (
        <label className="media-manual-param">
          时长（秒）
          <input
            type="number"
            min={1}
            max={30}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            placeholder="由模型决定"
          />
        </label>
      )}
      {options.audio && (
        <Choices
          label="声音"
          current={value.generateAudio}
          values={[
            { value: true, label: "生成声音" },
            { value: false, label: "静音" },
          ]}
          onPick={(generateAudio) => change({ generateAudio })}
        />
      )}
      {options.autoDuration && (
        <button
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
      {options.seed && (
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
      {options.negativePrompt && (
        <label className="media-manual-param">
          负面提示词
          <input
            maxLength={2000}
            value={value.negativePrompt ?? ""}
            onChange={(event) => change({ negativePrompt: event.target.value || undefined })}
          />
        </label>
      )}
      {options.audioFormats.length > 0 && (
        <Choices
          label="音频格式"
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
    </div>
  );
}

const templateIcons = {
  film: Film,
  grid: Grid,
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
  hasReference,
}: {
  kind: PresetKind;
  selected: string[];
  onPick: (id: string) => void;
  hasReference: boolean;
}) {
  const [category, setCategory] = useState("");
  if (kind === "tpl")
    return (
      <div className="media-template-groups">
        {!hasReference && (
          <p className="media-popover-hint">
            模板需要一张参考图。请选择支持参考图的模型并添加素材。
          </p>
        )}
        {TEMPLATE_GROUPS.map((group) => (
          <section key={group}>
            <h4>{group}</h4>
            {TEMPLATE_PRESETS.filter((item) => item.group === group).map(
              ({ id, name, usage, icon }) => {
                const Icon = templateIcons[icon];
                return (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={selected.includes(id)}
                    onClick={() => onPick(id)}
                  >
                    <Icon size={17} />{" "}
                    <span>
                      <strong>{name}</strong>
                      <small>{usage}</small>
                    </span>
                    {selected.includes(id) && <Check size={15} />}
                  </button>
                );
              },
            )}
          </section>
        ))}
      </div>
    );
  const categories = kind === "style" ? STYLE_CATEGORIES : MOTION_CATEGORIES;
  const presets = kind === "style" ? STYLE_PRESETS : MOTION_PRESETS;
  const initial =
    presets.find(({ id }) => selected.includes(id))?.category ?? categories[0]?.id ?? "";
  const active = category || initial;
  return (
    <>
      <fieldset
        className="media-option-row media-preset-tabs"
        aria-label={`${presetLabels[kind]}分类`}
      >
        {categories.map(({ id, label }) => (
          <button
            type="button"
            key={id}
            aria-pressed={id === active}
            onClick={() => setCategory(id)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <div className="media-preset-grid">
        {presets
          .filter((item) => item.category === active)
          .map((preset) => (
            <button
              type="button"
              key={preset.id}
              aria-pressed={selected.includes(preset.id)}
              onClick={() => onPick(preset.id)}
              title={"usage" in preset ? String(preset.usage) : preset.name}
            >
              <img src={preset.cover} loading="lazy" alt="" />
              <span>
                {preset.name}
                {selected.includes(preset.id) && <Check size={13} />}
              </span>
            </button>
          ))}
      </div>
    </>
  );
}
