import {
  type CreativeData,
  configuredGenerationInput,
  imageDisplaySize,
  modelPriceLabel,
  parseCanvasAspect,
  type SettingsValues,
} from "@link-studio/core";
import { imageFrameSize } from "./grid-placement";

export function nodeModels(settings: SettingsValues["list"], kind: CreativeData["kind"]) {
  return settings.providers
    .filter((provider) => {
      if (provider.config?.kind === "agent")
        return (
          kind === "script" &&
          provider.enabled &&
          provider.agentEnabled &&
          provider.hasSecret &&
          provider.channelEnabled !== false
        );
      const plugin = settings.plugins.find((entry) => entry.hash === provider.pluginHash);
      return (
        provider.enabled &&
        provider.channelEnabled !== false &&
        !plugin?.disabled &&
        plugin?.kind === (kind === "script" ? "text" : kind) &&
        (plugin.auth === "none" || provider.hasSecret)
      );
    })
    .sort((left, right) => (left.config?.sort ?? 100) - (right.config?.sort ?? 100));
}

export function canvasModelGroups(settings: SettingsValues["list"]) {
  return (["script", "image", "video", "audio"] as const)
    .map((kind) => ({
      kind,
      models: nodeModels(settings, kind).map((provider) => ({
        id: provider.id,
        label: provider.config?.name || provider.model,
        hint: provider.config?.description || "",
        price: modelPriceLabel(provider.config?.pricing),
      })),
    }))
    .filter((group) => group.models.length > 0);
}

export function defaultNodeGeneration(
  kind: string,
  defaults: SettingsValues["canvasView"]["defaultModels"],
  groups: ReturnType<typeof canvasModelGroups>,
) {
  const group = groups.find((entry) => entry.kind === kind);
  const providerId = group && defaults[group.kind];
  return providerId && group?.models.some((model) => model.id === providerId)
    ? { generation: { providerId } }
    : {};
}

function modelFrameSize(data: CreativeData, models: ReturnType<typeof nodeModels>) {
  const draft = data.generation;
  const key = draft?.providerId ?? draft?.modelKey;
  const target = key ? models.find((entry) => entry.id === key) : models[0];
  const input = {
    ...draft?.params,
    ...(draft?.sizeInput && { size: draft.sizeInput }),
  };
  const effective = target ? configuredGenerationInput(target.config, input) : input;
  const ratio =
    parseCanvasAspect(input.aspectRatio) ??
    parseCanvasAspect(input.customParams?.aspect_ratio) ??
    parseCanvasAspect(input.customParams?.ratio) ??
    parseCanvasAspect(effective.aspectRatio) ??
    parseCanvasAspect(effective.customParams?.ratio);
  if (ratio) return imageFrameSize(ratio, 1);
  const match = /^(\d+)x(\d+)$/.exec(effective.size ?? "");
  return match ? imageFrameSize(Number(match[1]), Number(match[2])) : undefined;
}

export function mediaNodeFrame(
  data: CreativeData,
  models: ReturnType<typeof nodeModels>,
  metadata?: Record<string, unknown>,
  pending?: { width: number; height: number },
) {
  if (data.kind === "audio") return { width: 324, height: 324 };
  if (data.kind !== "image" && data.kind !== "video") return;
  if (data.kind === "video" && data.assetId) {
    const display = imageFrameSize(
      Number(metadata?.displayAspect ?? (data.uploaded ? data.mediaAspect : undefined)),
      1,
    );
    if (display) return display;
  }
  const dimensions = imageDisplaySize(metadata ?? {});
  return (
    imageFrameSize(dimensions.width, dimensions.height) ??
    pending ??
    imageFrameSize(Number(data.mediaAspect), 1) ??
    modelFrameSize(data, models) ?? { width: 576, height: 324 }
  );
}
