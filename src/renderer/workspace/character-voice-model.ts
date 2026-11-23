import { type CanvasCharacter, modelGenerationOptions } from "@link-studio/core";
import type { ProviderSettings } from "./media-generation-draft";
import { nodeModels } from "./media-node-model";

export function characterVoiceModel(character: CanvasCharacter, settings: ProviderSettings) {
  const voiceModels = nodeModels(settings, "audio");
  const key = character.voiceModel;
  const voiceModel =
    voiceModels.find((model) => model.id === key) ??
    voiceModels.find((model) => !!key && model.modelKey === key) ??
    voiceModels.find((model) => model.model === key) ??
    voiceModels[0];
  const plugin = settings.plugins.find((plugin) => plugin.hash === voiceModel?.pluginHash);
  const options =
    voiceModel &&
    modelGenerationOptions(
      "audio",
      plugin?.origin === "builtin" ? plugin.key : undefined,
      voiceModel.model,
      voiceModel.channel,
      voiceModel.config,
    );
  const requiresImageURL = !!options?.references.image && options.referenceNeedsURL("image");
  const acceptsImage = !!options?.references.image && !requiresImageURL;
  const pricing = voiceModel?.config?.pricing;
  const credits =
    pricing && pricing.unit !== "token" && !pricing.pending
      ? Math.min(
          pricing.input,
          ...(pricing.tiers ?? []).filter((tier) => tier.on).map((tier) => tier.unit),
        )
      : 0;
  return { voiceModels, voiceModel, acceptsImage, requiresImageURL, credits };
}
