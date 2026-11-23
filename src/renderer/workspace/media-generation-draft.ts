import {
  type CreativeData,
  isPublicReferenceURL,
  mediaReferenceBytes,
  modelGenerationOptions,
  type ProjectAsset,
  type ProjectCanvasView,
  type SettingsValues,
} from "@link-studio/core";
import { composeCanvasPrompt } from "./compose-canvas-prompt";
import { nodeModels } from "./media-node-model";
import { hasPendingReference, linkedMediaSources, mediaReferences } from "./media-references";
import { videoModes } from "./video-modes";

export type ProviderSettings = SettingsValues["list"] & { status?: "loading" | "ready" | "error" };

export function mediaGenerationDraft({
  id,
  data,
  settings,
  assets,
  linked,
  graph,
  runningNodes,
  referenceRunningNodes,
  pendingVoices,
  draft,
  template,
  extraPrompts = [],
  urls = {},
}: {
  id: string;
  data: CreativeData;
  settings: ProviderSettings;
  assets: ProjectAsset[];
  linked?: ReturnType<typeof linkedMediaSources>;
  graph?: ProjectCanvasView;
  runningNodes?: ReadonlySet<string>;
  referenceRunningNodes?: ReadonlySet<string>;
  pendingVoices?: ReadonlySet<string>;
  draft: string;
  template: boolean;
  extraPrompts?: string[];
  urls?: Record<string, string>;
}) {
  const compatible = nodeModels(settings, data.kind);
  const picked = data.generation?.providerId ?? data.generation?.modelKey;
  const target = picked ? compatible.find((provider) => provider.id === picked) : compatible[0];
  const modelsStatus = settings.status ?? "ready";
  const offline = !!picked && !target && modelsStatus === "ready";
  const plugin = settings.plugins.find((adapter) => adapter.hash === target?.pluginHash);
  const options = modelGenerationOptions(
    data.kind === "script" ? "text" : data.kind,
    plugin?.origin === "builtin" ? plugin.key : undefined,
    target?.model ?? "",
    target?.channel,
    target?.config,
  );
  const video = data.kind === "video",
    modes = video && target ? videoModes(options) : [];
  const op = data.videoMode && modes.includes(data.videoMode) ? data.videoMode : modes[0];
  const canReference = !!target && options.referenceLimit > 0,
    usesReferences = canReference && op !== "t2v";
  const inputLinks =
    linked ?? (graph ? linkedMediaSources(graph, id, referenceRunningNodes, pendingVoices) : []);
  const media = mediaReferences({
    assets,
    linked: inputLinks,
    manual: data.manualReferenceIds ?? [],
    imageOnly: op !== "omni",
    video,
    limit: op === "i2v" ? options.frameLimit : options.referenceLimit,
    counts: usesReferences ? options.references : {},
    bytes: options.referenceBytes,
  });
  const chosenReferences = usesReferences ? media.chosen : [];
  const hasImage = chosenReferences.some((asset) => asset.mediaType === "image"),
    hasAudio = chosenReferences.some((asset) => asset.mediaType === "audio");
  const needsURL = chosenReferences.filter(
    ({ mediaType, sizeBytes, metadata }) =>
      !(
        plugin?.origin === "builtin" &&
        plugin.key === "doubao-video" &&
        target?.channelId &&
        mediaType === "image" &&
        ((metadata.filingChannel === target.channelId && metadata.filingImage) ||
          metadata.filingSourceChannel === target.channelId)
      ) &&
      (sizeBytes > mediaReferenceBytes ||
        (plugin?.origin === "builtin" && options.referenceNeedsURL(mediaType))),
  );
  const videoInput =
    options.videoAction && chosenReferences.some((asset) => asset.mediaType === "video");
  const requestPrompt = [
    graph
      ? composeCanvasPrompt(draft, graph, id, chosenReferences, runningNodes, referenceRunningNodes)
      : draft.trim(),
    ...extraPrompts,
  ]
    .filter(Boolean)
    .join("\n\n");
  const promptTooLong = Array.from(requestPrompt).length > options.promptLimit;
  const pending = hasPendingReference(
    inputLinks,
    video ? op : data.kind === "image" && options.requiresImage ? "i2i" : undefined,
    options.references,
  );
  const requiredReference =
    op === "omni" && !chosenReferences.length && !pending
      ? "全能参考需要至少 1 个参考素材"
      : (op === "i2v" || options.requiresImage) && !hasImage && !pending
        ? "图生方式需要至少 1 张参考图片"
        : undefined;
  const referenceIssue =
    target &&
    (requiredReference ??
      media.error ??
      (template && !hasImage
        ? "此模板需要一张参考图。"
        : (data.kind === "image" && options.modes?.includes("i2i") === false && hasImage) ||
            (options.requiresAudio && !hasAudio)
          ? "请检查模型要求的参考素材。"
          : undefined));
  const sound = target?.config?.generateAudio;
  const voiceNeedsSound =
    video &&
    inputLinks.some((link) => link.part === "voice" && link.assetId) &&
    (sound?.open ? (data.generation?.params?.generateAudio ?? sound.default) : sound?.default) ===
      false;
  const blockedReason =
    modelsStatus === "loading"
      ? "正在加载模型清单"
      : modelsStatus === "error"
        ? "模型清单加载失败，请稍后重试"
        : offline
          ? "该模型已下线，请换一个模型"
          : !target
            ? "暂无可用模型"
            : !requestPrompt
              ? "请先填写提示词。"
              : promptTooLong
                ? "提示词超过模型长度限制。"
                : referenceIssue ||
                  (voiceNeedsSound ? "使用角色音色时请开启声音生成" : undefined) ||
                  (needsURL.some(
                    (asset) => !isPublicReferenceURL(urls[asset.assetId]?.trim() ?? ""),
                  )
                    ? "请检查参考素材地址。"
                    : videoInput && (hasImage || hasAudio)
                      ? "视频编辑不能同时引用图片或音频。"
                      : undefined);
  return {
    compatible,
    target,
    modelsStatus,
    offline,
    plugin,
    options,
    canReference,
    usesReferences,
    video,
    modes,
    op,
    media,
    chosenReferences,
    hasImage,
    hasAudio,
    needsURL,
    videoInput,
    requestPrompt,
    referenceIssue,
    voiceNeedsSound,
    promptTooLong,
    blockedReason,
  };
}
