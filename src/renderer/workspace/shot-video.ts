import {
  type CanvasShot,
  type CreativeData,
  modelGenerationModes,
  modelGenerationOptions,
  type SettingsValues,
} from "@link-studio/core";

const trimStop = (text: string) => text.trim().replace(/[。.]+$/, "");

export function shotImagePrompt(shot: CanvasShot) {
  return [
    [shot.shot, shot.camera].filter(Boolean).join("，"),
    trimStop(shot.scene),
    trimStop(shot.action),
  ]
    .filter(Boolean)
    .map((sentence) => `${sentence}。`)
    .join("");
}

export function shotVideoOptions(settings: SettingsValues["list"], preferredId?: string) {
  const candidates = settings.providers
    .filter((candidate) => {
      const plugin = settings.plugins.find((item) => item.hash === candidate.pluginHash);
      return (
        candidate.enabled &&
        candidate.channelEnabled !== false &&
        candidate.config?.kind !== "agent" &&
        plugin?.kind === "video" &&
        !plugin.disabled &&
        (plugin.auth === "none" || candidate.hasSecret)
      );
    })
    .sort((left, right) => (left.config?.sort ?? 100) - (right.config?.sort ?? 100));
  const provider = candidates.find((candidate) => candidate.id === preferredId) ?? candidates[0];
  const plugin = settings.plugins.find((item) => item.hash === provider?.pluginHash);
  return (
    provider &&
    modelGenerationOptions(
      "video",
      plugin?.origin === "builtin" ? plugin.key : undefined,
      provider.model,
      provider.channel,
      provider.config,
    )
  );
}

type DurationOptions = Pick<
  ReturnType<typeof modelGenerationOptions>,
  "durations" | "durationRange" | "durationStep" | "manualDuration"
>;

export function shotDuration(seconds: number, options?: DurationOptions) {
  if (!options) return undefined;
  const rounded = Math.max(1, Math.round(seconds));
  const range = options.durationRange;
  if (range) {
    const bounded = Math.min(range.max, Math.max(range.min, rounded));
    const step = Math.max(1, options.durationStep);
    return Math.min(range.max, range.min + Math.round((bounded - range.min) / step) * step);
  }
  const choices = options.durations.filter((value) => value > 0);
  if (!choices.length) return options.manualDuration ? rounded : undefined;
  return choices.reduce((best, choice) => {
    const difference = Math.abs(choice - seconds) - Math.abs(best - seconds);
    return difference < 0 || (difference === 0 && choice < best) ? choice : best;
  });
}

export function shotDurationTitle(options?: DurationOptions) {
  const range = options?.durationRange;
  const supported = range
    ? `${range.min}–${range.max}s`
    : options?.durations
        .filter((value) => value > 0)
        .map((value) => `${value}s`)
        .join(" / ");
  return supported ? `所选视频模型只支持 ${supported}` : "视频时长和这一行的时长不一样";
}

export function seedShotVideo(
  shot: CanvasShot,
  settings: SettingsValues["list"],
  image?: { id: string; data: CreativeData },
  preferredId?: string,
) {
  const options = shotVideoOptions(settings, preferredId);
  const modes = options && (options.modes ?? modelGenerationModes("video", options));
  const duration = shotDuration(shot.duration, options);
  const hasImage = image?.data.assetId || shot.imageAssetId;
  const mode =
    hasImage && options?.references.image && modes
      ? modes.includes("i2v")
        ? "i2v"
        : modes.includes("omni")
          ? "omni"
          : undefined
      : undefined;
  const dialogue = trimStop(shot.dialogue);
  const prompt = shotImagePrompt(shot) + (dialogue ? `对白：${dialogue}。` : "");
  const data: Pick<CreativeData, "text" | "videoDuration" | "videoMode" | "manualReferenceIds"> = {
    text: prompt,
    ...(duration && { videoDuration: duration }),
    ...(mode && { videoMode: mode }),
    ...(mode &&
      !image?.data.assetId &&
      shot.imageAssetId && { manualReferenceIds: [shot.imageAssetId] }),
  };
  return { data, imageSource: mode && image?.data.assetId ? image.id : undefined };
}
