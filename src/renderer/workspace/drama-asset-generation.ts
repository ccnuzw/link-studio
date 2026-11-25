import type { CreativeData, GenerationInput, ProviderView } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import { characterVoiceModel } from "./character-voice-model";
import { mediaGenerationDraft, type ProviderSettings } from "./media-generation-draft";
import { promptPresets } from "./prompt-tokens";

export function assetUnit(provider?: ProviderView) {
  const price = provider?.config?.pricing;
  return !price || price.unit === "token" || price.pending
    ? 0
    : Math.min(
        price.input,
        ...(price.tiers ?? []).filter((tier) => tier.on).map((tier) => tier.unit),
      );
}

export function assetImageInput(
  options: Omit<Parameters<typeof mediaGenerationDraft>[0], "draft" | "template">,
): { error: string } | { input: Omit<GenerationInput, "expectedCanvasRevision"> } {
  const { id, data } = options;
  const draft = mediaGenerationDraft({
    ...options,
    draft: data.text,
    template: promptPresets(data.text).some((item) => item.kind === "tpl"),
  });
  if (draft.blockedReason || !draft.target) return { error: draft.blockedReason ?? "暂无可用模型" };
  const size = data.generation?.sizeInput;
  if (size && !/^[1-9][0-9]{1,3}x[1-9][0-9]{1,3}$/.test(size))
    return { error: "请输入有效的尺寸，例如 1024x1024。" };
  const params = { ...data.generation?.params };
  if (size) {
    delete params.aspectRatio;
    delete params.resolution;
  }
  if (params.resolution && !draft.options.resolutions.includes(params.resolution))
    delete params.resolution;
  delete params.videoAction;
  return {
    input: {
      nodeId: id,
      providerId: draft.target.id,
      expectedProviderRevision: draft.target.revision,
      prompt: draft.requestPrompt,
      referenceAssetIds: draft.chosenReferences.map((asset) => asset.assetId),
      ...params,
      ...(size && { size }),
    },
  };
}

export function assetVoiceInput(data: CreativeData, settings: ProviderSettings) {
  const prompt = data.character?.voicePrompt?.trim();
  if (!prompt) return { error: "还没有音色描述" } as const;
  const { voiceModel: provider, requiresImageURL } = characterVoiceModel(
    requirePresent(data.character, "data.character"),
    settings,
  );
  if (!provider) return { error: "暂无可用音频模型" } as const;
  if (requiresImageURL) return { error: "音色模型需要公网参考图地址" } as const;
  return { provider, prompt } as const;
}
