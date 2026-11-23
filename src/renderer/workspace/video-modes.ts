import {
  type CreativeData,
  modelGenerationModes,
  modelGenerationOptions,
  type SettingsValues,
} from "@link-studio/core";
import type { LinkKind } from "./link-rules";
import { nodeModels } from "./media-node-model";

type VideoMode = NonNullable<CreativeData["videoMode"]>;
type Options = ReturnType<typeof modelGenerationOptions>;
const ports = { t2v: [], i2v: ["image"], omni: ["image", "video", "audio"] } as const;
export const videoModeLabels = { t2v: "文生视频", i2v: "图生视频", omni: "全能参考" };
const portLabels = { image: "图片", video: "视频", audio: "音频" };

export function videoModes(options: Options) {
  return (options.modes ?? modelGenerationModes("video", options)).filter(
    (mode): mode is VideoMode => mode === "t2v" || mode === "i2v" || mode === "omni",
  );
}

export function modeHint(mode: VideoMode, options: Options, hasRefs: boolean) {
  if (mode === "t2v") return hasRefs ? "已有参考素材，文生视频不可用" : undefined;
  const kinds = ports[mode].filter((kind) => options.references[kind]);
  return !hasRefs && kinds.length
    ? `需要连接${kinds.map((kind) => portLabels[kind]).join("/")}节点`
    : undefined;
}

export function referenceUsed(
  source: LinkKind,
  options: Pick<Options, "references"> | undefined,
  mode: VideoMode | "t2i" | "i2i" | undefined,
) {
  if (!options || source === "script") return true;
  const kinds = mode === "t2i" || mode === "t2v" ? [] : mode === "omni" ? ports.omni : ports.i2v;
  return kinds.some(
    (kind) =>
      !!options.references[kind] &&
      (source === kind || (source === "character" && (kind === "image" || kind === "audio"))),
  );
}

export function modeForSource(
  source: LinkKind,
  options: Options,
  selected?: VideoMode,
): VideoMode | false | undefined {
  if (source === "script" || source === "storyboard") return;
  const modes = videoModes(options);
  const accepts = (mode: VideoMode) =>
    ports[mode].some(
      (kind) =>
        options.references[kind] &&
        (source === "character" ? kind === "image" || kind === "audio" : kind === source),
    );
  const current = selected && modes.includes(selected) ? selected : modes[0];
  if (current && accepts(current)) return;
  return (modes.includes("omni") && accepts("omni") ? "omni" : modes.find(accepts)) ?? false;
}

export function mediaModeForSource(
  source: LinkKind,
  target: CreativeData["kind"],
  options: Options,
  selected?: VideoMode,
) {
  if (target === "video") return modeForSource(source, options, selected);
  if (source === "script" || source === "storyboard") return;
  if (target !== "audio" && target !== "image") return false;
  const acceptsImage =
    options.references.image &&
    (target === "audio" ||
      (options.modes ?? modelGenerationModes("image", options)).includes("i2i"));
  if (!acceptsImage || (source !== "character" && source !== "image")) return false;
}

export function mediaLinkMode(
  source: LinkKind,
  target: LinkKind,
  settings: SettingsValues["list"],
  data?: Pick<CreativeData, "videoMode" | "generation">,
) {
  if (target !== "video" && target !== "audio" && target !== "image") return;
  const models = nodeModels(settings, target);
  const key = data?.generation?.providerId ?? data?.generation?.modelKey;
  const model = models.find((entry) => entry.id === key) ?? models[0];
  if (!model) return;
  const plugin = settings.plugins.find((entry) => entry.hash === model.pluginHash);
  const options = modelGenerationOptions(
    target,
    plugin?.origin === "builtin" ? plugin.key : undefined,
    model.model,
    model.channel,
    model.config,
  );
  return mediaModeForSource(source, target, options, data?.videoMode);
}
