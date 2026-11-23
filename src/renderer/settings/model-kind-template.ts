import {
  type ModelConfig,
  type ModelKind,
  mediaGenerationOptions,
  modelGenerationModes,
  modelParameterChoices,
} from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";

export type TemplateBinding = {
  adapter?: string;
  model: string;
  settings?: Record<string, unknown>;
};

function mediaTemplate(kind: ModelKind, binding: TemplateBinding) {
  const options = mediaGenerationOptions(kind, binding.adapter, binding.model, binding.settings);
  const choices = modelParameterChoices(options);
  const video = kind === "video";
  const params: NonNullable<ModelConfig["params"]> = {};
  const tiers: NonNullable<NonNullable<ModelConfig["pricing"]>["tiers"]> = [];
  const modes = modelGenerationModes(kind, options);
  const refs: NonNullable<ModelConfig["refs"]> = {};
  for (const key of ["image", "video", "audio"] as const) {
    const count = options.references[key];
    if (count)
      refs[key] = {
        max: kind === "audio" ? 0 : Math.min(count, key === "image" ? 4 : 1),
        mb: key === "image" ? 10 : key === "audio" ? 15 : 100,
      };
  }
  if (kind === "image" || video) {
    const ratios = (
      video
        ? ["Auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]
        : ["Auto", "1:1", "16:9", "9:16", "4:3", "3:4"]
    ).filter((value) => choices.aspectRatio.includes(value));
    if (ratios[0])
      params.aspectRatio = {
        values: ratios,
        default: ratios[0],
        open: true,
        label: "比例",
        spec: false,
      };
    const resolutions = (video ? ["720P", "1080P", "4K"] : ["1K", "2K", "4K"]).filter((value) =>
      choices.resolution.some((choice) => choice.toLowerCase() === value.toLowerCase()),
    );
    if (resolutions[0])
      params.resolution = {
        values: resolutions,
        default: resolutions[0],
        open: true,
        label: "清晰度",
        spec: true,
      };
    const seconds = choices.duration.filter((value) => value >= 5 && value <= 10);
    const duration = seconds.length ? seconds : choices.duration.filter((value) => value > 0);
    const first = duration[0],
      last = duration.at(-1);
    if (video && first !== undefined && last !== undefined) {
      params.duration = {
        values: duration.map(String),
        default: String(first),
        label: "视频时长",
        unit: "秒",
        open: true,
        spec: false,
      };
      if (options.durationRange && duration.every((value, index) => value === first + index))
        params.duration.range = {
          min: first,
          max: last,
          step: 1,
          open: true,
          label: "视频时长",
          unit: "秒",
        };
    }
    if (video && options.audio) tiers.push({ on: true, when: { generate_audio: true }, unit: 3 });
    if (resolutions.includes("1080P")) {
      tiers.push({ on: true, when: { resolution: "1080P" }, unit: 4 });
      if (options.audio)
        tiers.push({ on: true, when: { resolution: "1080P", generate_audio: true }, unit: 5 });
    }
    if (resolutions.includes("2K")) tiers.push({ on: true, when: { resolution: "2K" }, unit: 8 });
    if (resolutions.includes("4K"))
      tiers.push({ on: true, when: { resolution: "4K" }, unit: video ? 8 : 16 });
    params.count = {
      values: ["1", "2", "4"],
      default: "1",
      open: true,
      label: "生成数量",
      unit: video ? "个" : "张",
      fanout: true,
    };
  }
  const pricing: ModelConfig["pricing"] = {
    unit: video && params.duration?.range ? "second" : "request",
    input: kind === "image" ? 4 : 2,
    ...(tiers.length && { tiers }),
  };
  return {
    promptLimit: Math.min(20000, options.promptLimit),
    refs,
    ...(modes.length && { modes }),
    params,
    ...(video &&
      options.audio && {
        generateAudio: { open: true, default: true, spec: true, label: "生成音频" },
      }),
    pricing,
  };
}

export function applyKindTemplate(
  base: ModelConfig,
  kind: ModelKind,
  batch = false,
  binding: TemplateBinding = { model: "" },
): ModelConfig {
  const language = kind === "text" || kind === "agent";
  const previousDeadline = base.kind === "agent" ? base.agentDeadlineSeconds : base.timeoutSeconds;
  const deadline = previousDeadline ?? (language ? 300 : kind === "image" ? 600 : 1800);
  const template = language
    ? {
        pricing: {
          unit: "token" as const,
          input: kind === "agent" ? 3 : 2,
          output: kind === "agent" ? 15 : 8,
        },
        promptLimit: 20000,
        maxOutputTokens: 8192,
        contextWindow: kind === "agent" ? 200000 : 128000,
      }
    : mediaTemplate(kind, binding);
  return {
    kind,
    name: base.name,
    description: base.description,
    sort: base.sort,
    logo: base.logo,
    tags: base.tags,
    ...template,
    ...(kind === "agent"
      ? { agentDeadlineSeconds: deadline, vision: true }
      : { timeoutSeconds: deadline }),
    pricing: batch ? (base.pricing ?? template.pricing) : template.pricing,
  };
}

export function rebindTemplate(
  config: ModelConfig,
  previous: TemplateBinding,
  next: TemplateBinding,
): ModelConfig {
  if (config.kind === "text" || config.kind === "agent") return config;
  const old = mediaTemplate(config.kind, previous);
  const fresh = mediaTemplate(config.kind, next);
  const rebound = { ...config };
  for (const key of [
    "promptLimit",
    "refs",
    "modes",
    "params",
    "generateAudio",
    "pricing",
  ] as const) {
    if (!Value.Equal(config[key], old[key])) continue;
    if (fresh[key] === undefined) delete rebound[key];
    else Object.assign(rebound, { [key]: fresh[key] });
  }
  return rebound;
}
