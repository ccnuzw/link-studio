import { type Static, Type } from "@sinclair/typebox";
import { GenerationParameters } from "./generation-parameters.ts";
import { modelGenerationOptions } from "./media-generation.ts";
import { includesModelParameter } from "./model-config.ts";
import type { PluginView, ProviderView } from "./settings-api.ts";

export const dramaAssetSlots = ["character", "scene", "prop"] as const;
export type DramaAssetSlot = (typeof dramaAssetSlots)[number];
const slotParams = Type.Object(
  {
    aspectRatio: GenerationParameters.properties.aspectRatio,
    resolution: GenerationParameters.properties.resolution,
  },
  { additionalProperties: false },
);
export const DramaImageParams = Type.Object(
  {
    character: Type.Optional(slotParams),
    scene: Type.Optional(slotParams),
    prop: Type.Optional(slotParams),
  },
  { additionalProperties: false },
);
export type DramaImageParams = Static<typeof DramaImageParams>;
export function dramaImageFields(
  model: Pick<ProviderView, "config" | "pluginHash" | "model" | "channel"> | undefined,
  plugins: Pick<PluginView, "hash" | "origin" | "key">[],
) {
  const plugin = plugins.find((entry) => entry.hash === model?.pluginHash);
  const config = model?.config;
  const options =
    model &&
    modelGenerationOptions(
      "image",
      plugin?.origin === "builtin" ? plugin.key : undefined,
      model.model,
      model.channel,
      config,
    );
  function choices(key: "aspectRatio" | "resolution", supported: readonly string[] = []) {
    const field = config?.params?.[key];
    if (!includesModelParameter(config, key) || field?.open === false || (config?.params && !field))
      return [];
    return field ? field.values.filter((value) => supported.includes(value)) : [...supported];
  }
  const ratio = config?.params?.aspectRatio,
    resolution = config?.params?.resolution;
  return {
    ratios: choices("aspectRatio", options?.ratios),
    resolutions: choices("resolution", options?.resolutions),
    defaultRatio: ratio?.default,
    defaultResolution: resolution?.default,
    ...(ratio?.label && { ratioLabel: ratio.label }),
    ...(resolution?.label && { resolutionLabel: resolution.label }),
    ...(resolution?.unit && { resolutionUnit: resolution.unit }),
  };
}
export function settleDramaImageParams(
  fields: ReturnType<typeof dramaImageFields>,
  slot: DramaAssetSlot,
  picks: Static<typeof slotParams> = {},
) {
  const want = picks.aspectRatio || (slot === "scene" ? "21:9" : "16:9");
  function aspect(value: string) {
    const [width, height] = value.split(":").map(Number);
    return width && height && width > 0 && height > 0 ? width / height : NaN;
  }
  let ratio = fields.ratios.find((value) => value === want);
  if (!ratio) {
    let gap = Infinity;
    for (const value of fields.ratios) {
      const delta = Math.abs(Math.log(aspect(value) / aspect(want)));
      if (delta < gap) {
        gap = delta;
        ratio = value;
      }
    }
  }
  ratio ??= fields.ratios.find((value) => value === fields.defaultRatio);
  const resolution =
    fields.resolutions.find((value) => value.toLowerCase() === picks.resolution?.toLowerCase()) ??
    fields.resolutions.find((value) => value === fields.defaultResolution);
  return { ...(ratio && { aspectRatio: ratio }), ...(resolution && { resolution }) };
}
