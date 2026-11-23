import type { GenerationInput } from "./generation.ts";
import type { modelGenerationOptions } from "./media-generation.ts";
import type { ProjectAsset } from "./projects-api.ts";
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
  | "customParams"
>;

type Options = ReturnType<typeof modelGenerationOptions>;
type Operation = GenerationInput["op"];
type Draft = {
  params: MediaParameters;
  size: string;
  duration: string;
  mode: Operation;
  references: string[];
};
type Field = { kind: string; label: string; accepts: (value: unknown) => boolean };

function fields(options: Options) {
  const result = new Map<string, Field>();
  const add = (name: string, label: string, kind: string, accepts: Field["accepts"]) => {
    if (!options.parameterOrder || options.parameterOrder.includes(name))
      result.set(name, { label: options.parameterLabels[name] || label, kind, accepts });
  };
  const choices = (name: string, label: string, values: readonly (string | number)[]) => {
    if (values.length)
      add(name, label, "enum", (value) =>
        values.some((choice) => String(choice) === String(value)),
      );
  };
  const number = (name: string, label: string, min: number, max: number) =>
    add(
      name,
      label,
      "number",
      (value) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max,
    );
  const flag = (name: string, label: string) =>
    add(name, label, "boolean", (value) => typeof value === "boolean");
  const text = (name: string, label: string, limit: number) =>
    add(name, label, "text", (value) => typeof value === "string" && value.length <= limit);
  if (options.manualSize)
    add("size", "尺寸", "size", (value) => /^[1-9]\d{1,3}x[1-9]\d{1,3}$/.test(String(value)));
  else choices("size", "尺寸", [...options.sizes, ...options.largeSizes]);
  choices("aspectRatio", "画面比例", options.ratios);
  choices("resolution", "清晰度", options.resolutions);
  choices("quality", "画质", options.qualities);
  choices("count", options.countUnit === "首" ? "生成首数" : "生成张数", options.counts);
  choices("audioFormat", "音频格式", options.audioFormats);
  if (options.durationRange || options.manualDuration) {
    const range = options.durationRange ?? { min: 1, max: 30 };
    add(
      "duration",
      "时长",
      "number",
      (value) =>
        Number.isInteger(Number(value)) &&
        ((options.autoDuration && Number(value) === -1) ||
          (Number(value) >= range.min && Number(value) <= range.max)),
    );
  } else choices("duration", "时长", [...options.durations, ...(options.autoDuration ? [-1] : [])]);
  if (options.audio) flag("generateAudio", options.audioLabel || "声音");
  if (options.seed) number("seed", "随机种子", -1, 4294967295);
  if (options.negativePrompt) text("negativePrompt", "负面提示词", 2000);
  if (options.instrumental) flag("makeInstrumental", "纯音乐");
  if (options.speaker) text("speaker", "音色 ID", 200);
  if (options.audioFormats.length) {
    number("sampleRate", "采样率（Hz）", 8000, 48000);
    number("speechRate", "语速", -50, 100);
    number("loudnessRate", "音量", -50, 100);
    number("pitchRate", "音调", -12, 12);
  }
  if (options.videoAction) choices("videoAction", "视频操作", ["edit", "extend"]);
  for (const [name, field] of Object.entries(options.customParameters)) {
    if (field.type === "number") number(name, field.label, field.min, field.max);
    else if (field.type === "boolean") flag(name, field.label);
    else choices(name, field.label, field.values);
  }
  return result;
}

export function planModelSwitch(
  previous: Options,
  next: Options,
  draft: Draft,
  assets: readonly Pick<ProjectAsset, "assetId" | "mediaType">[],
  video: boolean,
) {
  const before = fields(previous);
  const after = fields(next);
  const droppedLabels: string[] = [];
  const keep = (name: string, value: unknown) => {
    if (value == null || (typeof value === "string" && !value.trim())) return false;
    const oldField = before.get(name);
    const field = after.get(name);
    if (field && (!oldField || field.kind === oldField.kind) && field.accepts(value)) return true;
    droppedLabels.push(oldField?.label ?? name);
    return false;
  };
  const { customParams, ...standard } = draft.params;
  const params: MediaParameters = Object.fromEntries(
    Object.entries(standard).filter(
      ([name, value]) =>
        !((name === "size" && draft.size) || (name === "duration" && draft.duration)) &&
        keep(name, value),
    ),
  );
  const custom = Object.entries(customParams ?? {}).filter(([name, value]) => keep(name, value));
  if (custom.length) params.customParams = Object.fromEntries(custom);
  const size = keep("size", draft.size) ? draft.size : "";
  const duration = keep("duration", draft.duration) ? draft.duration : "";
  if (duration && !next.manualDuration) params.duration = Number(duration);
  if (size && !next.manualSize) params.size = size;
  const supported = (mode: Operation) =>
    mode &&
    (!next.modes || next.modes.includes(mode)) &&
    (mode === "omni"
      ? next.omni
      : mode === "i2v"
        ? !!next.references.image && !next.requiresAudio
        : !next.requiresImage && !next.requiresReference && !next.requiresAudio);
  const mode = supported(draft.mode) ? draft.mode : undefined;
  const effectiveMode = video
    ? (mode ??
      (next.modes ?? (["t2v", "i2v", "omni"] as const)).find(
        (item): item is NonNullable<Operation> =>
          (item === "t2v" || item === "i2v" || item === "omni") && !!supported(item),
      ))
    : undefined;
  const droppedKinds = new Set<ProjectAsset["mediaType"]>();
  const references = draft.references.filter((id) => {
    const kind = assets.find((asset) => asset.assetId === id)?.mediaType;
    if (
      !kind ||
      (next.references[kind] &&
        (!video || effectiveMode === "omni" || (effectiveMode === "i2v" && kind === "image")))
    )
      return true;
    droppedKinds.add(kind);
    return false;
  });
  for (const kind of droppedKinds)
    droppedLabels.push({ image: "参考图片", video: "参考视频", audio: "参考音频" }[kind]);
  return {
    params,
    size: next.manualSize ? size : "",
    duration: next.manualDuration ? duration : "",
    mode,
    effectiveMode,
    references,
    droppedLabels,
  };
}
