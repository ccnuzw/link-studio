import type { GenerationInput } from "./generation.ts";
import {
  fanoutFields,
  generationModes,
  includesModelParameter,
  type ModelConfig,
  type ModelParameter,
  maximumModelPromptLength,
  maxModelReferenceMB,
  validCustomName,
  validCustomValue,
} from "./model-config.ts";

type ReferenceKind = "image" | "video" | "audio";
type ReferenceCounts = Partial<Record<ReferenceKind, number>>;

const widescreen = ["16:9", "9:16"];
const commonRatios = [...widescreen, "1:1", "4:3", "3:4", "21:9"];
const photoRatios = [...commonRatios, "2:3", "3:2"];
const hd = ["480p", "720p", "1080p"];
const wanLegacy: Record<string, { resolutions: string[]; durations: number[] }> = {
  "wan2.6-t2v-us": { resolutions: hd.slice(1), durations: [5, 10, 15] },
  "wan2.6-i2v-us": { resolutions: hd.slice(1), durations: [5, 10, 15] },
  "wan2.5-t2v-preview": { resolutions: hd, durations: [5, 10] },
  "wan2.5-i2v-preview": { resolutions: hd, durations: [5, 10] },
  "wan2.2-t2v-plus": { resolutions: ["480p", "1080p"], durations: [5] },
  "wan2.2-i2v-flash": { resolutions: hd, durations: [5] },
  "wan2.2-i2v-plus": { resolutions: ["480p", "1080p"], durations: [5] },
  "wan2.2-kf2v-flash": { resolutions: hd, durations: [5] },
  "wanx2.1-t2v-plus": { resolutions: ["720p"], durations: [5] },
  "wanx2.1-t2v-turbo": { resolutions: hd.slice(0, 2), durations: [5] },
  "wanx2.1-i2v-plus": { resolutions: ["720p"], durations: [5] },
  "wanx2.1-i2v-turbo": { resolutions: hd.slice(0, 2), durations: [3, 4, 5] },
};
const negatives = new Set(["alibaba-image", "alibaba-video", "google", "vertex-ai", "kling"]);
const seeds = new Set([
  "agnes-image",
  "agnes-video",
  "alibaba-image",
  "alibaba-video",
  "doubao-image",
  "doubao-video",
  "google",
  "vertex-ai",
  "jimeng",
  "vidu",
]);

export const mediaReferenceBytes = 10 * 1024 * 1024;

export function isPublicReferenceURL(value: string) {
  if (value !== value.trim() || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    /\.[a-z][a-z0-9-]*$/i.test(url.hostname) &&
    !/\.(?:localhost|local|internal|invalid|test|example)$/i.test(url.hostname)
  );
}

export function providerVendorLabel(vendor?: string) {
  const labels: Record<string, string> = {
    agnes: "Agnes",
    alibaba: "阿里巴巴",
    anthropic: "Anthropic",
    google: "Google",
    incho: "Incho",
    kling: "可灵",
    minimax: "MiniMax",
    openai: "OpenAI",
    "new-api": "New API",
    newapi: "New API",
    sunoapi: "Suno API",
    vidu: "Vidu",
    volcengine: "火山引擎",
    xai: "xAI",
  };
  return vendor && Object.hasOwn(labels, vendor) ? labels[vendor] : (vendor ?? "未声明厂商");
}

function videoProfile(adapter: string | undefined, name: string) {
  switch (adapter) {
    case "agnes-video":
      return {
        refs: name.endsWith("-flash") ? { image: 5, audio: 3 } : { image: 8, video: 2, audio: 3 },
        omni: true,
        frames: 2,
        ratios: photoRatios,
        resolutions: name.endsWith("-flash") ? ["720p"] : ["720p", "1080p"],
        durationRange: { min: 4, max: 12 },
      };
    case "alibaba-video": {
      name = name.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/^wan2\.1-/, "wanx2.1-");
      const legacy = wanLegacy[name];
      const modern = name.startsWith("wan3.0-");
      const media = name.startsWith("wan2.7-i2v");
      const speech = name === "wan2.2-s2v";
      const image = /i2v|kf2v|s2v/.test(name);
      return {
        refs: modern
          ? { image: 10, audio: 5, video: 5 }
          : media
            ? { image: 2, audio: 1, video: 1 }
            : speech
              ? { image: 1, audio: 1 }
              : image
                ? { image: name.includes("kf2v") ? 2 : 1 }
                : { audio: 1 },
        omni: modern || media || speech || !image,
        frames: modern || media || name.includes("kf2v") ? 2 : 1,
        ratios: modern
          ? [...commonRatios.slice(0, 5), "adaptive"]
          : image
            ? []
            : commonRatios.slice(0, 5),
        resolutions:
          legacy?.resolutions ??
          (media || /^wan2\.[67]-/.test(name) ? hd.slice(1) : speech ? hd.slice(0, 2) : hd),
        durations: legacy?.durations ?? [],
        durationRange:
          modern || (/^wan2\.[67]-/.test(name) && !legacy)
            ? { min: 2, max: modern ? 30 : 15 }
            : undefined,
        autoDuration: modern,
        audio: modern || /^wan2\.[567]-/.test(name),
        requiresImage: image && !media,
        requiresReference: media || image,
        requiresAudio: speech,
      };
    }
    case "google":
    case "vertex-ai":
      return {
        refs: { image: 1 },
        ratios: widescreen,
        resolutions: ["720p", "1080p", "4k"],
        durations: [4, 6, 8],
        audio: adapter === "vertex-ai",
      };
    case "hailuo":
      return name === "minimax-h3"
        ? {
            refs: { image: 8, video: 2, audio: 2 },
            frames: 2,
            omni: true,
            ratios: [...commonRatios, "adaptive"],
            resolutions: ["768p", "2K"],
          }
        : { refs: { image: 2 }, resolutions: ["512p", "768p", "1080p"] };
    case "jimeng":
      return { refs: {}, ratios: commonRatios, durations: /v30|3\.0/.test(name) ? [5, 10] : [5] };
    case "kling":
      return { refs: { image: 2 }, ratios: [...widescreen, "1:1"], durations: [5, 10] };
    case "new-api-video":
      return {
        refs: { image: 8, video: 2, audio: 2 },
        frames: 2,
        omni: true,
        ratios: commonRatios,
        resolutions: [...hd, "4k"],
        audio: true,
        manualSize: true,
      };
    case "vidu":
      return {
        refs: { image: 7 },
        frames: 2,
        omni: true,
        ratios: commonRatios,
        resolutions:
          name === "viduq1"
            ? ["1080p"]
            : name === "vidu2.0"
              ? ["360p", "720p", "1080p"]
              : ["360p", "540p", "720p", "1080p"],
        durations: name === "viduq1" ? [5] : name === "vidu2.0" ? [4, 8] : [],
        durationRange: name.startsWith("viduq2") ? { min: 1, max: 10 } : undefined,
        requiresImage: name === "vidu2.0",
      };
    case "xai":
      return {
        refs: { image: 7, audio: 3, video: name === "grok-imagine-video" ? 1 : 0 },
        frames: 1,
        omni: true,
        ratios: photoRatios.filter((ratio) => ratio !== "21:9"),
        resolutions: name === "grok-imagine-video" ? hd.slice(0, 2) : hd,
        durationRange: { min: 1, max: 15 },
        audio: true,
      };
    default:
      return undefined;
  }
}

export function mediaGenerationOptions(
  kind: string,
  adapter: string | undefined,
  model: string,
  channel: Record<string, unknown> = {},
) {
  const name = model.toLowerCase();
  const alibabaImage = adapter === "alibaba-image";
  const imageName = name.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const qwenText = /^(?:z-image-turbo|qwen-image(?:-plus|-max)?)$/.test(imageName);
  const qwenBatch = /^qwen-image-(?:[23]\.0(?:-pro)?|edit-(?:plus|max))$/.test(imageName);
  const openai = kind === "image" && adapter === "openai-image";
  const dalle2 = openai && name.startsWith("dall-e-2");
  const dalle3 = openai && name.startsWith("dall-e-3");
  const gpt = openai && /^(gpt-image-|chatgpt-image-)/.test(name);
  const sora = kind === "video" && adapter === "sora";
  const soraPro = sora && /^sora-2-pro(?:-|$)/.test(name);
  const seedance = kind === "video" && adapter === "doubao-video";
  const seedanceAudio = seedance && /^doubao-seedance-(?:1-5-pro|2-[05])(?:-|$)/.test(name);
  const seedanceKnown = seedance && /^doubao-seedance-(?:1-[05]|2-[05])(?:-|$)/.test(name);
  const seedanceShort = /^doubao-seedance-2-0-(?:mini|fast)(?:-|$)/.test(name);
  const lastDuration = name.startsWith("doubao-seedance-2-5")
    ? 30
    : name.startsWith("doubao-seedance-2-0")
      ? 15
      : 12;
  const video = kind === "video" ? videoProfile(adapter, name) : undefined;
  const imageOnlyEdit =
    alibabaImage && /^(wan2\.6-image|wan2\.5-i2i|wanx2\.1-imageedit|qwen-image-edit)/.test(name);
  const imageLimit =
    dalle3 || (alibabaImage && (qwenText || /t2i|wanx-v1/.test(name)))
      ? 0
      : openai
        ? dalle2
          ? 1
          : 8
        : adapter === "alibaba-image"
          ? name.startsWith("wan2.7-")
            ? 9
            : name.startsWith("wan2.6-image")
              ? 4
              : name.includes("imageedit")
                ? 1
                : 3
          : 4;
  const references: ReferenceCounts =
    kind === "image"
      ? { image: imageLimit }
      : kind === "audio"
        ? adapter === "doubao-audio"
          ? { image: 1 }
          : {}
        : kind === "video"
          ? (video?.refs ??
            (sora
              ? { image: 1 }
              : seedance
                ? { image: 8, ...(name.startsWith("doubao-seedance-2-") && { video: 3, audio: 3 }) }
                : { image: 4 }))
          : {};
  const referenceLimit = Math.min(
    12,
    Object.values(references).reduce((sum, count) => sum + count, 0),
  );

  return {
    promptLimit: adapter === "incho" ? 1000 : maximumModelPromptLength,
    countUnit: kind === "audio" ? "首" : "张",
    sizes: dalle2
      ? ["256x256", "512x512", "1024x1024"]
      : dalle3
        ? ["1024x1024", "1792x1024", "1024x1792"]
        : gpt
          ? ["1024x1024", "1536x1024", "1024x1536"]
          : sora
            ? ["1280x720", "720x1280"]
            : [],
    largeSizes: soraPro ? ["1792x1024", "1024x1792"] : [],
    ratios: seedance
      ? [...commonRatios, "adaptive"]
      : (video?.ratios ??
        (kind === "image" &&
        ["agnes-image", "alibaba-image", "doubao-image", "openai-chat-image"].includes(
          adapter ?? "",
        )
          ? photoRatios
          : [])),
    resolutions: seedanceKnown
      ? [
          ...(seedanceShort ? hd.slice(0, 2) : hd),
          ...(name.startsWith("doubao-seedance-2-0") && !seedanceShort ? ["4k"] : []),
        ]
      : (video?.resolutions ??
        (adapter === "agnes-image"
          ? ["1K", "2K", "3K", "4K"]
          : adapter === "doubao-image"
            ? /seedream-5-0-(?:pro|flash)/.test(name)
              ? ["1K", "1.5K", "2K"]
              : /seedream-4-0/.test(name)
                ? ["1K", "2K", "4K"]
                : ["2K", "4K"]
            : adapter === "alibaba-image" || adapter === "openai-chat-image"
              ? ["1K", "2K", "4K"]
              : [])),
    qualities: gpt
      ? (["low", "medium", "high"] as const)
      : dalle3
        ? (["standard", "hd"] as const)
        : [],
    maxCount:
      adapter === "incho"
        ? 2
        : openai && !dalle3
          ? 8
          : qwenBatch && alibabaImage
            ? 6
            : alibabaImage && (qwenText || /^qwen-image-edit$|imageedit/.test(imageName))
              ? 1
              : alibabaImage || adapter === "agnes-image"
                ? 4
                : 1,
    durations: sora ? [4, 8, 12] : (video?.durations ?? []),
    durationRange: seedanceKnown ? { min: 4, max: lastDuration } : video?.durationRange,
    autoDuration: seedanceAudio || video?.autoDuration === true,
    audio: seedanceAudio || video?.audio === true,
    referenceLimit,
    references,
    referenceNeedsURL: (media: ReferenceKind) =>
      (adapter === "doubao-video" && media === "video") ||
      (adapter === "xai" && media === "audio") ||
      (adapter === "hailuo" && name === "minimax-h3") ||
      (adapter !== undefined &&
        !["openai-image", "sora", "google", "vertex-ai"].includes(adapter) &&
        channel.as !== "dataUrl" &&
        channel.as !== "base64"),
    frameLimit: video?.frames ?? (seedance ? 2 : (references.image ?? 0)),
    omni: video?.omni === true || (seedance && !name.startsWith("doubao-seedance-1-")),
    requiresImage: imageOnlyEdit || video?.requiresImage === true,
    requiresReference: imageOnlyEdit || video?.requiresReference === true,
    requiresAudio: video?.requiresAudio === true,
    negativePrompt: negatives.has(adapter ?? ""),
    seed: seeds.has(adapter ?? ""),
    audioFormats: adapter === "doubao-audio" ? (["mp3", "wav", "ogg_opus"] as const) : [],
    instrumental: adapter === "sunoapi-music",
    speaker: adapter === "doubao-audio",
    videoAction: adapter === "xai" && name === "grok-imagine-video",
    manualSize:
      (kind === "image" && !dalle2 && !dalle3 && !gpt && adapter !== "openai-chat-image") ||
      (kind === "video" && !sora && !seedance && (!video || video.manualSize === true)),
    manualDuration:
      kind === "video" &&
      !sora &&
      !seedanceKnown &&
      !video?.durations?.length &&
      !video?.durationRange &&
      !video?.requiresAudio,
  };
}

type MediaOptions = ReturnType<typeof mediaGenerationOptions>;

export function modelParameterChoices(
  options: Pick<MediaOptions, "durationRange" | "maxCount" | "autoDuration"> & {
    durations: readonly number[];
    sizes: readonly string[];
    largeSizes: readonly string[];
    ratios: readonly string[];
    resolutions: readonly string[];
    qualities: readonly string[];
    audioFormats: readonly string[];
  },
) {
  const range = options.durationRange;
  const durations = options.durations.length
    ? options.durations
    : range
      ? Array.from({ length: range.max - range.min + 1 }, (_, index) => range.min + index)
      : [];
  return {
    size: [...options.sizes, ...options.largeSizes],
    aspectRatio: options.ratios,
    resolution: options.resolutions,
    quality: options.qualities,
    duration: options.autoDuration ? [...durations, -1] : durations,
    count: Array.from({ length: options.maxCount }, (_, index) => index + 1),
    audioFormat: options.audioFormats,
  } satisfies Record<ModelParameter, readonly (string | number)[]>;
}

export function modelGenerationModes(
  kind: string,
  options: Pick<
    MediaOptions,
    | "requiresImage"
    | "requiresAudio"
    | "requiresReference"
    | "references"
    | "referenceLimit"
    | "frameLimit"
    | "omni"
  >,
) {
  return generationModes.filter((mode) => {
    if (kind === "image")
      return mode === "t2i" ? !options.requiresImage : mode === "i2i" && !!options.references.image;
    if (kind !== "video") return false;
    if (mode === "t2v") return !options.requiresReference && !options.requiresImage;
    if (mode === "i2v")
      return !!options.frameLimit && !!options.references.image && !options.requiresAudio;
    return (
      mode === "omni" &&
      options.omni &&
      options.referenceLimit > 0 &&
      (!options.requiresImage || !!options.references.image) &&
      (!options.requiresAudio || !!options.references.audio)
    );
  });
}

export function validModelCapabilities(
  config: ModelConfig,
  adapter: string | undefined,
  model: string,
  channel?: Record<string, unknown>,
) {
  const base = mediaGenerationOptions(config.kind, adapter, model, channel);
  const defined = new Set(
    config.parameterOrder ?? [
      ...Object.keys(config.params ?? {}),
      ...Object.keys(config.customParams ?? {}),
      ...(config.generateAudio ? ["generateAudio"] : []),
    ],
  );
  if (defined.size > 20) return false;
  const quantities = fanoutFields(config);
  if (
    quantities.length > 1 ||
    quantities.some(
      ([, field]) =>
        !("values" in field) || field.values.some((value) => !/^[1-8]$/.test(String(value))),
    )
  )
    return false;
  for (const [key, field] of Object.entries(config.customParams ?? {})) {
    if (
      config.kind === "agent" ||
      !validCustomName(key) ||
      !field.label?.trim() ||
      !validCustomValue(field, field.default)
    )
      return false;
    if (field.type === "number" && (field.min < 1 || field.max > 3600 || (field.step ?? 1) < 1))
      return false;
    if (
      field.type === "enum" &&
      (field.values.length > 20 ||
        field.values.some((value) => !String(value).trim()) ||
        new Set(field.values.map(String)).size !== field.values.length)
    )
      return false;
  }
  if (config.generateAudio && !base.audio) return false;
  const duration = config.params?.duration;
  const range = duration?.range;
  if (range && duration) {
    const expected = Array.from(
      { length: Math.floor((range.max - range.min) / range.step) + 1 },
      (_, index) => String(range.min + index * range.step),
    );
    if (
      expected.length !== duration.values.length ||
      !expected.every((value, index) => value === duration.values[index])
    )
      return false;
  }
  if (config.promptLimit !== undefined && config.promptLimit > base.promptLimit) return false;
  const options = modelGenerationOptions(config.kind, adapter, model, channel, config);
  const modes = modelGenerationModes(config.kind, options);
  if (config.modes?.some((mode) => !modes.includes(mode))) return false;
  if (options.requiresImage && !options.references.image) return false;
  if (options.requiresAudio && !options.references.audio) return false;
  if (options.requiresReference && !options.referenceLimit) return false;
  if (
    Object.entries(config.refs ?? {}).some(
      ([kind, ref]) =>
        !base.references[kind as ReferenceKind] ||
        ref.max > (base.references[kind as ReferenceKind] ?? 0) ||
        ref.mb > maxModelReferenceMB,
    )
  )
    return false;
  if (config.promptFormat && config.kind !== "video") return false;
  const choices = modelParameterChoices(base);
  const language = config.kind === "text" || config.kind === "agent";
  if (
    !language &&
    (config.contextWindow !== undefined ||
      config.maxOutputTokens !== undefined ||
      config.systemPrompt !== undefined ||
      config.vision !== undefined)
  )
    return false;
  if (config.kind !== "agent" && config.vision !== undefined) return false;
  if (config.video && (config.kind !== "agent" || channel?.api !== "gemini")) return false;
  if (config.params?.size && (config.params.aspectRatio || config.params.resolution)) return false;
  return Object.entries(config.params ?? {}).every(
    ([key, parameter]) =>
      !language &&
      parameter.values.includes(parameter.default) &&
      ((key === "count" && parameter.fanout) ||
        parameter.values.every((value) =>
          choices[key as ModelParameter].some((choice) =>
            key === "resolution"
              ? String(choice).toLowerCase() === value.toLowerCase()
              : String(choice) === value,
          ),
        )),
  );
}

export function modelGenerationOptions(
  kind: string,
  adapter: string | undefined,
  model: string,
  channel?: Record<string, unknown>,
  config?: ModelConfig,
) {
  const base = mediaGenerationOptions(kind, adapter, model, channel);
  const filter = <Choice extends string | number>(values: readonly Choice[], key: ModelParameter) =>
    values.filter((value) => config?.params?.[key]?.values.includes(String(value)) ?? true);
  const references = { ...base.references };
  const referenceBytes: Partial<Record<ReferenceKind, number>> = {};
  for (const kind of ["image", "video", "audio"] as const) {
    const ref = config?.refs?.[kind];
    if (!ref) continue;
    references[kind] = Math.min(ref.max, base.references[kind] ?? 0);
    referenceBytes[kind] = ref.mb * 1024 * 1024;
  }
  const modes = config?.modes;
  if (kind === "image" && modes && !modes.includes("i2i")) references.image = 0;
  if (kind === "video" && modes && !modes.includes("omni")) {
    references.video = 0;
    references.audio = 0;
    references.image = modes.includes("i2v") ? (references.image ?? 0) : 0;
  }
  const durations = config?.params?.duration
    ? modelParameterChoices(base).duration
    : base.durations;
  const counts = filter(
    Array.from(
      { length: config?.params?.count?.fanout ? 8 : base.maxCount },
      (_, index) => index + 1,
    ),
    "count",
  );
  const defaultParameters: Partial<Record<ModelParameter, string | number>> = {};
  for (const [name, param] of Object.entries(config?.params ?? {})) {
    const key = name as ModelParameter;
    if (!includesModelParameter(config, key)) continue;
    defaultParameters[key] =
      key === "duration" || key === "count" ? Number(param.default) : param.default;
  }
  return {
    ...base,
    modes,
    defaultParameters: {
      ...defaultParameters,
      ...(config?.generateAudio && { generateAudio: config.generateAudio.default }),
    },
    audioControl:
      includesModelParameter(config, "generateAudio") && (config?.generateAudio?.open ?? true),
    parameterOrder: config?.parameterOrder,
    hiddenParameters: (Object.keys(modelParameterChoices(base)) as ModelParameter[]).filter(
      (key) => !includesModelParameter(config, key) || config?.params?.[key]?.open === false,
    ),
    audioLabel: config?.generateAudio?.label,
    parameterLabels: Object.fromEntries(
      Object.entries(config?.params ?? {}).map(([key, field]) => [
        key,
        (key === "duration" ? config?.params?.duration?.range?.label : undefined) ?? field.label,
      ]),
    ),
    customParameters: Object.fromEntries(
      Object.entries(config?.customParams ?? {})
        .filter(([key]) => !config?.parameterOrder || config.parameterOrder.includes(key))
        .map(([key, field]) => [
          key,
          { ...field, open: field.open ?? true, label: field.label ?? key },
        ]),
    ),
    referenceBytes,
    references,
    counts,
    promptLimit: Math.min(config?.promptLimit ?? 20000, base.promptLimit),
    referenceLimit: Math.min(
      base.referenceLimit,
      Object.values(references).reduce((sum, count) => sum + count, 0),
    ),
    frameLimit: Math.min(base.frameLimit, references.image ?? 0),
    omni: base.omni && (modes?.includes("omni") ?? true),
    requiresImage: base.requiresImage || (kind === "image" && modes?.includes("t2i") === false),
    sizes: filter(base.sizes, "size"),
    largeSizes: filter(base.largeSizes, "size"),
    ratios: filter(base.ratios, "aspectRatio"),
    resolutions:
      config?.params?.resolution?.values.filter((value) =>
        base.resolutions.some((supported) => supported.toLowerCase() === value.toLowerCase()),
      ) ?? base.resolutions,
    qualities: filter(base.qualities, "quality"),
    audioFormats: filter(base.audioFormats, "audioFormat"),
    durations: filter(durations, "duration").filter((duration) => duration !== -1),
    durationRange: config?.params?.duration ? config.params.duration.range : base.durationRange,
    durationControl:
      includesModelParameter(config, "duration") && (config?.params?.duration?.range?.open ?? true),
    durationStep: config?.params?.duration?.range?.step ?? 1,
    autoDuration: base.autoDuration && (config?.params?.duration?.values.includes("-1") ?? true),
    manualDuration:
      base.manualDuration &&
      includesModelParameter(config, "duration") &&
      !config?.params?.duration,
    manualSize: base.manualSize && includesModelParameter(config, "size") && !config?.params?.size,
  };
}

export function configuredGenerationInput<Input extends Partial<GenerationInput>>(
  config: ModelConfig | undefined,
  input: Input,
): Input & Partial<GenerationInput> {
  const params: ModelConfig["params"] =
    config?.parameterOrder && config.params
      ? Object.fromEntries(
          Object.entries(config.params).filter(([key]) => config.parameterOrder!.includes(key)),
        )
      : config?.params;
  const next = { ...input };
  if (config?.generateAudio && !input.videoAction) {
    next.generateAudio =
      (config.generateAudio.open ? input.generateAudio : undefined) ?? config.generateAudio.default;
  }
  if (config?.parameterOrder) {
    for (const key of [
      "size",
      "aspectRatio",
      "resolution",
      "quality",
      "duration",
      "count",
      "audioFormat",
      "generateAudio",
    ] as const) {
      if (!includesModelParameter(config, key)) delete next[key];
    }
  }
  delete next.customParams;
  for (const [key, field] of Object.entries(config?.customParams ?? {})) {
    if (!validCustomName(key) || (config?.parameterOrder && !config.parameterOrder.includes(key)))
      continue;
    const value =
      field.open === false ? field.default : (input.customParams?.[key] ?? field.default);
    next.customParams ??= {};
    next.customParams[key] = value;
  }
  if (!params) return next;
  if (params.size?.open === false) {
    next.size = params.size.default;
    delete next.aspectRatio;
    delete next.resolution;
  }
  if (params.aspectRatio?.open === false || params.resolution?.open === false) delete next.size;
  for (const key of [
    "aspectRatio",
    "resolution",
    "duration",
    "count",
    "quality",
    "audioFormat",
  ] as const) {
    if (params[key]?.open === false) delete next[key];
  }
  if (!next.size && !next.aspectRatio && !next.resolution && params.size)
    next.size = params.size.default;
  if (!next.size && !next.videoAction) {
    if (params.aspectRatio) next.aspectRatio ??= params.aspectRatio.default;
    if (params.resolution) next.resolution ??= params.resolution.default;
  }
  if (
    !next.videoAction &&
    params.duration &&
    (next.duration === undefined || params.duration.range?.open === false)
  )
    next.duration = Number(params.duration.default);
  if (params.count) next.count ??= Number(params.count.default);
  if (params.quality)
    next.quality ??= params.quality.default as NonNullable<GenerationInput["quality"]>;
  if (params.audioFormat)
    next.audioFormat ??= params.audioFormat.default as NonNullable<GenerationInput["audioFormat"]>;
  return next;
}
