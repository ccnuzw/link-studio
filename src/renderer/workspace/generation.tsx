import type { CreativeOutput } from "@link-studio/core";
import {
  configuredGenerationInput,
  type GenerationInput,
  type GenerationJob,
  isPublicReferenceURL,
  jobFailureReason,
  jobIsTerminal,
  mediaReferenceBytes,
  missingJobBindingMessage,
  modelGenerationOptions,
  modelPriceLabel,
  type ProjectAsset,
  type ProjectCanvasView,
  quoteModel,
  quoteQuantity,
} from "@link-studio/core";
import {
  ArrowUp,
  ChevronDown,
  Loader2,
  Maximize2,
  SlidersHorizontal,
  Sparkle,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CanvasPromptEditor, type CanvasPromptHandle } from "./canvas-prompt-editor";
import { GenerationModelMenu } from "./generation-model-menu";
import { mediaGenerationDraft, type ProviderSettings } from "./media-generation-draft";
import {
  MediaParameterPicker,
  type MediaParameters,
  MediaPopover,
  MediaPresetPicker,
  type PickedPresets,
  presetLabels,
  selectedPresetText,
} from "./media-pickers";
import type { PresetKind } from "./media-presets";
import type { linkedMediaSources } from "./media-references";
import { mentionSources } from "./mention-sources";
import { planModelSwitch } from "./model-switch";
import { ModelSwitchDialog } from "./model-switch-dialog";
import { promptPresets, promptTextLength } from "./prompt-tokens";
import { RefHighlightProvider } from "./ref-highlight";
import { ReferenceMenu } from "./reference-menu";
import { ReferenceStrip } from "./reference-strip";
import { ReferenceTile } from "./reference-tile";
import { VideoModeTabs } from "./video-mode-tabs";
import { mediaModeForSource, referenceUsed } from "./video-modes";

type Picker = "parameters" | PresetKind;

export const generationStatuses: Record<GenerationJob["status"], string> = {
  queued: "排队中",
  submitting: "提交中",
  running: "生成中",
  downloading: "校验并入库",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  outcome_unknown: "结果未知",
};
type Node = Extract<ProjectCanvasView["nodes"][number], { type: "creative" }>;
type NodeSettings = Pick<
  Node["data"],
  "generation" | "videoDuration" | "videoMode" | "manualReferenceIds"
>;
export function isGenerationMedia(kind: string): kind is ProjectAsset["mediaType"] {
  return kind === "audio" || kind === "image" || kind === "video";
}

export function GenerationForm({
  formRef,
  reportDraft,
  node,
  settings,
  assets,
  linkedSources = [],
  graph,
  projectHandle,
  runningNodes,
  runningReferenceNodes,
  onMentionLink,
  inline = false,
  dialogOnly = false,
  blocked = false,
  generating = false,
  onPromptChange,
  onSettingsChange,
  onUnlinkReference,
  onLocateReference,
  onManualReferencesChange,
  onUploadReference,
  voiceSubmission,
  editCharacter,
  close,
  submit,
}: {
  formRef?: Ref<HTMLFormElement>;
  reportDraft?: (draft?: { id: string; reason?: string }) => void;
  node: Node;
  settings: ProviderSettings;
  assets: ProjectAsset[];
  linkedSources?: ReturnType<typeof linkedMediaSources>;
  graph?: ProjectCanvasView;
  projectHandle?: string;
  runningNodes?: ReadonlySet<string>;
  runningReferenceNodes?: ReadonlySet<string>;
  onMentionLink?: (id: string, withTyping?: boolean) => void;
  inline?: boolean;
  dialogOnly?: boolean;
  blocked?: boolean;
  generating?: boolean;
  onPromptChange?: (prompt: string) => void;
  onSettingsChange?: (patch: Partial<NodeSettings>) => void;
  onUnlinkReference?: (nodeId: string) => void;
  onLocateReference?: (nodeId: string) => void;
  onManualReferencesChange?: (ids: string[]) => void;
  onUploadReference?: (file: File) => Promise<void>;
  voiceSubmission?: {
    reason?: string;
    credits: number;
    input?: Pick<GenerationInput, "prompt" | "providerId" | "expectedProviderRevision">;
  };
  editCharacter?: () => void;
  close: () => void;
  submit: (
    input: Omit<GenerationInput, "expectedCanvasRevision">,
    operationId: string,
    voice?: {
      id: string;
      input: Pick<GenerationInput, "prompt" | "providerId" | "expectedProviderRevision">;
    },
  ) => Promise<string | undefined>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const anchor = useRef<HTMLElement>(null);
  const editorHandle = useRef<CanvasPromptHandle>(null);
  const presetIndex = useRef<number>(undefined);
  const parametersButton = useRef<HTMLButtonElement>(null);
  const [localSettings, setLocalSettings] = useState<NodeSettings>(() => node.data);
  const stored = onSettingsChange ? node.data : localSettings;
  const settingsChanged = (patch: Partial<NodeSettings>) => {
    if (patch.generation) {
      const { providerId, modelKey, params, sizeInput, durationInput } = patch.generation;
      const entries = Object.entries(params ?? {}).filter(
        ([, value]) => value !== undefined && (typeof value !== "number" || Number.isFinite(value)),
      );
      patch = {
        ...patch,
        generation: {
          ...(providerId && { providerId }),
          ...(modelKey && { modelKey }),
          ...(entries.length && { params: Object.fromEntries(entries) }),
          ...(sizeInput && { sizeInput }),
          ...(durationInput && { durationInput }),
        },
      };
    }
    if (onSettingsChange) onSettingsChange(patch);
    else setLocalSettings((current) => ({ ...current, ...patch }));
  };
  const config = stored.generation;
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string; labels: string[] }>();
  const [prompt, setPrompt] = useState(node.data.text);
  const params = config?.params ?? {};
  const size = config?.sizeInput ?? "";
  const duration =
    config?.durationInput ??
    (params.duration === undefined ? stored.videoDuration?.toString() : "") ??
    "";
  const setSize = (value: string) =>
    settingsChanged({ generation: { ...config, sizeInput: value || undefined } });
  const setDuration = (value: string) =>
    settingsChanged({
      generation: {
        ...config,
        durationInput: value || undefined,
        params: { ...params, duration: undefined },
      },
      videoDuration: undefined,
    });
  const changeParams = (update: MediaParameters) => {
    const changed = { ...params, ...update };
    if ("duration" in update)
      settingsChanged({
        generation: { ...config, params: changed, durationInput: undefined },
        videoDuration: undefined,
      });
    else
      settingsChanged({
        generation: {
          ...config,
          params: changed,
          ...("size" in update && { sizeInput: undefined }),
        },
      });
  };
  const [detachedPresets, setPresets] = useState<PickedPresets>({ style: [], tpl: [], motion: [] });
  const videoMode = stored.videoMode;
  const setVideoMode = (value: GenerationInput["op"]) => settingsChanged({ videoMode: value });
  const references = (onManualReferencesChange ? node.data : stored).manualReferenceIds ?? [];
  const setReferences =
    onManualReferencesChange ?? ((ids: string[]) => settingsChanged({ manualReferenceIds: ids }));
  const [referenceURLs, setReferenceURLs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [referenceError, setReferenceError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const expandedDialog = useRef<HTMLDialogElement>(null);
  const menuContainer = expanded ? expandedDialog : dialogOnly ? settingsDialog : undefined;
  const expandButton = useRef<HTMLButtonElement>(null);
  const panelHeight = useRef<number>(0);
  const restorePrompt = () => {
    setPicker(undefined);
    setExpanded(false);
    requestAnimationFrame(() => expandButton.current?.focus({ preventScroll: true }));
  };
  useLayoutEffect(() => {
    if (!dialogOnly) return;
    const element = settingsDialog.current;
    element?.showModal();
    return () => element?.close();
  }, [dialogOnly]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const element = expandedDialog.current;
    element?.showModal();
    const focus = requestAnimationFrame(() => editorHandle.current?.focus());
    return () => {
      cancelAnimationFrame(focus);
      element?.close();
    };
  }, [expanded]);
  const [picker, setPicker] = useState<Picker>();
  const attempt = useRef<{ key: string; id: string; voiceId?: string } | undefined>(undefined);
  const compact = inline && isGenerationMedia(node.data.kind);
  const draft = onPromptChange ? node.data.text : prompt;
  const inlinePresets = !!(graph && onPromptChange && onMentionLink);
  const presets = inlinePresets
    ? promptPresets(draft).reduce<PickedPresets>(
        (picked, item) => {
          picked[item.kind].push(item.id);
          return picked;
        },
        { style: [], tpl: [], motion: [] },
      )
    : detachedPresets;
  const selectedPresets = inlinePresets ? [] : selectedPresetText(presets);
  const {
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
    needsURL,
    videoInput,
    hasAudio,
    requestPrompt,
    referenceIssue,
    voiceNeedsSound,
    promptTooLong,
    blockedReason,
  } = mediaGenerationDraft({
    id: node.id,
    data: { ...node.data, generation: config, videoMode, manualReferenceIds: references },
    settings,
    assets,
    graph,
    runningNodes,
    referenceRunningNodes: runningReferenceNodes,
    linked: linkedSources,
    draft,
    template: !!presets.tpl.length,
    extraPrompts: selectedPresets.map((item) => item.prompt),
    urls: referenceURLs,
  });
  const showModes = !expanded && modes.length > 1;
  const uploadKinds = (["image", "video", "audio"] as const)
    .filter(
      (kind) =>
        usesReferences && (op !== "i2v" || kind === "image") && (options.references[kind] ?? 0) > 0,
    )
    .map((kind) => ({
      kind,
      label: { image: "图片", video: "视频", audio: "音频" }[kind],
      maxBytes: options.referenceBytes[kind] ?? mediaReferenceBytes,
    }));
  const manualTiles = references.flatMap((id) => {
    const asset = assets.find((candidate) => candidate.assetId === id);
    return asset && uploadKinds.some((type) => type.kind === asset.mediaType) ? [asset] : [];
  });
  const sources =
    graph &&
    mentionSources(
      graph,
      node.id,
      assets,
      runningNodes ?? new Set(),
      (kind) => !target || mediaModeForSource(kind, node.data.kind, options, op) !== false,
    );
  const hasRefNodes =
    references.length > 0 ||
    (sources
      ? [...sources.linked].some((id) => {
          const kind = sources.byId.get(id)?.kind;
          return kind === "character" || kind === "image" || kind === "video" || kind === "audio";
        })
      : linkedSources.length > 0);
  const hasImageBinding =
    node.data.kind === "image" &&
    (sources
      ? [...sources.linked].some((id) => {
          const source = sources.byId.get(id);
          return source?.assetId && (source.kind === "image" || source.kind === "character");
        }) ||
        assets.some((asset) => asset.mediaType === "image" && references.includes(asset.assetId))
      : hasImage);
  const referenceMode =
    node.data.kind === "image"
      ? options.requiresImage || (options.references.image && hasImageBinding)
        ? "i2i"
        : "t2i"
      : op;
  const referenceResolution =
    plugin?.key === "xai" && (op === "omni" || chosenReferences.length > 1);
  const pickerOptions = {
    ...options,
    durations: videoInput ? [] : options.durations,
    defaultParameters: videoInput ? {} : options.defaultParameters,
    ratios: videoInput ? [] : options.ratios,
    resolutions: videoInput
      ? []
      : options.resolutions.filter(
          (resolution) =>
            (!referenceResolution || resolution.toLowerCase() !== "1080p") &&
            (plugin?.key !== "vidu" ||
              target?.model !== "vidu2.0" ||
              params.duration !== 8 ||
              resolution.toLowerCase() === "720p"),
        ),
    audio: options.audio && !videoInput,
    speaker: options.speaker && !hasImage,
    videoAction: videoInput,
    durationRange: videoInput
      ? params.videoAction === "extend"
        ? { min: 2, max: 10 }
        : undefined
      : options.durationRange,
    autoDuration: options.autoDuration && !videoInput,
  };
  const defaultParameters = pickerOptions.defaultParameters;
  const price = target?.config?.pricing;
  const quoteParams = configuredGenerationInput(videoInput ? undefined : target?.config, {
    ...params,
    ...(size && { size }),
    ...(duration && { duration: Number(duration) }),
  });
  const shownDuration = quoteParams.duration;
  const quote =
    price && (price.unit !== "second" || Number(shownDuration) > 0)
      ? quoteModel(
          price,
          {
            op: referenceMode,
            params: {
              ...quoteParams,
              ...quoteParams.customParams,
              aspect_ratio: quoteParams.aspectRatio,
              generate_audio: quoteParams.generateAudio,
              audio_format: quoteParams.audioFormat,
            },
            refVideo: chosenReferences.some(({ mediaType }) => mediaType === "video"),
            promptChars: Array.from(requestPrompt).length,
            outputTokens: target?.config?.maxOutputTokens,
          },
          quoteQuantity(target?.config, { ...quoteParams, ...quoteParams.customParams }),
        )
      : undefined;
  const locked = busy || blocked || generating;
  const ready = !locked && !blockedReason;
  useLayoutEffect(() => {
    reportDraft?.({ id: node.id, reason: blockedReason });
    return () => reportDraft?.(undefined);
  }, [node.id, blockedReason, reportDraft]);
  const togglePicker = (next: Picker, button: HTMLButtonElement) => {
    presetIndex.current = undefined;
    anchor.current = button;
    setPicker(picker === next ? undefined : next);
  };
  const closePicker = (restoreFocus = false) => {
    setPicker(undefined);
    if (restoreFocus) anchor.current?.focus({ preventScroll: true });
  };
  const chooseModel = (id: string, approved?: string[]) => {
    const next = compatible.find((provider) => provider.id === id);
    if (!next || id === target?.id) {
      setPendingSwitch(undefined);
      return true;
    }
    const adapter = settings.plugins.find((entry) => entry.hash === next.pluginHash);
    const nextOptions = modelGenerationOptions(
      node.data.kind === "script" ? "text" : node.data.kind,
      adapter?.origin === "builtin" ? adapter.key : undefined,
      next.model,
      next.channel,
      next.config,
    );
    const plan = planModelSwitch(
      options,
      nextOptions,
      { params, size, duration, mode: videoMode ?? op, references },
      assets,
      video,
    );
    if (
      plan.droppedLabels.length &&
      (!approved || plan.droppedLabels.some((label) => !approved.includes(label)))
    ) {
      setPendingSwitch({ id, labels: plan.droppedLabels });
      return false;
    }
    setPendingSwitch(undefined);
    const lostReferences = plan.references.length !== references.length;
    settingsChanged({
      generation: {
        providerId: id,
        params: plan.params,
        sizeInput: plan.size || undefined,
        durationInput: plan.duration || undefined,
      },
      videoMode: plan.effectiveMode,
      videoDuration: undefined,
      ...(lostReferences && { manualReferenceIds: plan.references }),
    });
    if (lostReferences && !onSettingsChange) onManualReferencesChange?.(plan.references);
    setReferenceURLs((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([assetId]) =>
            plan.references.includes(assetId) ||
            linkedSources.some((link) => link.assetId === assetId),
        ),
      ),
    );
    setError("");
    return true;
  };
  const choosePreset = (kind: PresetKind, id: string) => {
    if (inlinePresets) {
      if (!editorHandle.current?.applyPreset(kind, id, presetIndex.current)) return;
      closePicker();
      editorHandle.current.focus();
      return;
    }
    setPresets((current) => ({
      ...current,
      [kind]: current[kind].includes(id)
        ? current[kind].filter((item) => item !== id)
        : kind === "motion"
          ? [...current.motion, id]
          : [id],
    }));
    if (kind !== "motion") closePicker(true);
  };
  const audio = node.data.kind === "audio";
  const promptLength = promptTextLength(draft);
  const presetKinds: PresetKind[] = video ? ["motion"] : audio ? [] : ["style", "tpl"];
  const textBinding = sources?.entries.find(
    (entry) => entry.linked && entry.source.kind === "script",
  );
  const placeholder = textBinding
    ? `上游「${textBinding.source.label}」的文字会自动并入，输入 @ 引用素材`
    : `${audio ? "写下要念的台词，或想要的配乐氛围。例如：低沉男声，念一段独白。" : video ? "描述镜头怎么动、画面里发生什么。例如：镜头缓缓推近，海浪拍上礁石。" : "描述要生成的画面，或对已有画面下修改指令。例如：把背景改为雪夜。"}输入 @ 引用画布里的素材。`;
  const referenceLinks = needsURL.map(({ assetId, displayName }) => (
    <label className="media-manual-param" key={assetId}>
      公网 HTTPS 链接 · {displayName}
      <input
        type="url"
        maxLength={4096}
        value={referenceURLs[assetId] ?? ""}
        aria-invalid={
          Boolean(referenceURLs[assetId]) &&
          !isPublicReferenceURL(referenceURLs[assetId]?.trim() ?? "")
        }
        onChange={(event) => setReferenceURLs({ ...referenceURLs, [assetId]: event.target.value })}
      />
    </label>
  ));
  useEffect(() => {
    if (inline) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [inline]);
  const expandControl = (
    <button
      type="button"
      ref={expandButton}
      className="media-generation-expand"
      aria-label="放大编辑提示词"
      title="放大编辑"
      aria-haspopup="dialog"
      onClick={(event) => {
        panelHeight.current =
          event.currentTarget
            .closest(dialogOnly ? ".asset-prompt-body" : "section.media-generation")
            ?.getBoundingClientRect().height ?? 0;
        setPicker(undefined);
        setExpanded(true);
      }}
    >
      <Maximize2 size={14} />
    </button>
  );
  const referenceTiles = compact
    ? [
        ...(sources
          ? [...sources.linked].flatMap((id) => {
              const source = sources.byId.get(id);
              return source
                ? [
                    <ReferenceTile
                      key={id}
                      source={source}
                      projectHandle={projectHandle}
                      used={referenceUsed(source.kind, target ? options : undefined, referenceMode)}
                      running={runningReferenceNodes?.has(id)}
                      disabled={locked}
                      locate={onLocateReference}
                      remove={() => onUnlinkReference?.(id)}
                    />,
                  ]
                : [];
            })
          : []),
        ...manualTiles.map((asset) => (
          <ReferenceTile
            key={`manual:${asset.assetId}`}
            source={{
              id: asset.assetId,
              assetId: asset.assetId,
              kind: asset.mediaType,
              label: asset.displayName,
            }}
            projectHandle={projectHandle}
            used
            disabled={locked}
            remove={() => setReferences(references.filter((id) => id !== asset.assetId))}
          />
        )),
      ]
    : [];
  const form = (
    <form
      ref={formRef}
      data-generation-node={node.id}
      className={compact ? "media-generation-form" : undefined}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || generating) return;
        const withVoice = (event.nativeEvent as SubmitEvent).submitter?.hasAttribute(
          "data-with-voice",
        );
        if (withVoice && (!voiceSubmission?.input || voiceSubmission.reason)) return;
        if (!target || !ready) {
          if (!referenceIssue && !voiceNeedsSound)
            setError(blockedReason ?? "此节点暂时无法提交任务。");
          return;
        }
        if (expanded) restorePrompt();
        if (size && !/^[1-9][0-9]{1,3}x[1-9][0-9]{1,3}$/.test(size)) {
          setError("请输入有效的尺寸，例如 1024x1024。");
          if (compact && parametersButton.current && picker !== "parameters")
            togglePicker("parameters", parametersButton.current);
          return;
        }
        if (
          duration &&
          (!/^\d+$/.test(duration) || Number(duration) < 1 || Number(duration) > 30)
        ) {
          setError("时长须为 1 到 30 秒的整数。");
          if (compact && parametersButton.current && picker !== "parameters")
            togglePicker("parameters", parametersButton.current);
          return;
        }
        const input = {
          nodeId: node.id,
          providerId: target.id,
          expectedProviderRevision: target.revision,
          prompt: requestPrompt,
          referenceAssetIds: chosenReferences.map(({ assetId }) => assetId),
          ...Object.fromEntries(
            Object.entries(params).filter(([key, value]) => {
              if (value === undefined || (key === "speaker" && hasImage)) return false;
              if (size && (key === "aspectRatio" || key === "resolution")) return false;
              if (key === "videoAction") return videoInput;
              if (key === "resolution" && !pickerOptions.resolutions.includes(String(value)))
                return false;
              if (videoInput && ["aspectRatio", "generateAudio"].includes(key)) return false;
              if (videoInput && key === "duration")
                return params.videoAction === "extend" && Number(value) >= 2 && Number(value) <= 10;
              return true;
            }),
          ),
          ...(op && { op }),
          ...(needsURL.length > 0 && {
            referenceURLs: Object.fromEntries(
              needsURL
                .map(({ assetId }) => [assetId, (referenceURLs[assetId] ?? "").trim()] as const)
                .filter(([, url]) => url),
            ) as Record<string, string>,
          }),
          ...(size ? { size } : {}),
          ...(duration ? { duration: Number(duration) } : {}),
          ...(plugin?.key === "vidu" &&
            target.model === "vidu2.0" &&
            params.duration === 8 && { resolution: "720p" }),
        };
        const voice = withVoice ? voiceSubmission?.input : undefined;
        const key = JSON.stringify([input, voice]);
        if (attempt.current?.key !== key)
          attempt.current = {
            key,
            id: crypto.randomUUID(),
            ...(voice && { voiceId: crypto.randomUUID() }),
          };
        setBusy(true);
        setError("");
        try {
          const failure = await submit(
            input,
            attempt.current.id,
            voice && attempt.current.voiceId
              ? { id: attempt.current.voiceId, input: voice }
              : undefined,
          );
          if (failure) setError(failure);
          else {
            attempt.current = undefined;
            if (!dialogOnly) close();
          }
        } finally {
          setBusy(false);
        }
      }}
    >
      {compact ? (
        <>
          {showModes && (
            <div className="media-generation-top">
              <VideoModeTabs
                id={node.id}
                value={op}
                options={options}
                hasRefs={hasRefNodes}
                disabled={locked}
                choose={(mode) => {
                  setError("");
                  setVideoMode(mode);
                }}
              />
              {expandControl}
            </div>
          )}
          <div className="media-reference-row">
            <ReferenceStrip
              error={referenceError || referenceIssue}
              notices={media.notices}
              tiles={referenceTiles}
              menu={
                sources &&
                onMentionLink &&
                onUploadReference && (
                  <ReferenceMenu
                    setError={setReferenceError}
                    container={menuContainer}
                    candidates={sources.entries
                      .filter((entry) => !entry.linked)
                      .map((entry) => entry.source)}
                    handle={projectHandle}
                    disabled={locked}
                    link={(id) => onMentionLink(id)}
                    kinds={uploadKinds}
                    upload={onUploadReference}
                  />
                )
              }
            />
            {!expanded && !showModes && expandControl}
          </div>
          {referenceLinks}
          {videoInput && (hasImage || hasAudio) && (
            <p role="alert">视频编辑或延长只接受一个视频素材。</p>
          )}
          {sources && onMentionLink && onPromptChange ? (
            <CanvasPromptEditor
              ref={editorHandle}
              openPreset={(kind, index, element) => {
                presetIndex.current = index;
                anchor.current = element;
                setPicker(kind);
              }}
              value={draft}
              change={onPromptChange}
              disabled={busy || blocked}
              expanded={expanded}
              projectHandle={projectHandle}
              sources={sources}
              link={(id) => {
                onMentionLink(id, true);
              }}
              placeholder={placeholder}
            />
          ) : (
            <textarea
              className="media-generation-prompt"
              aria-label="生成提示词"
              value={draft}
              readOnly={busy || blocked}
              onChange={(event) => {
                if (onPromptChange) onPromptChange(event.target.value);
                else setPrompt(event.target.value);
              }}
              placeholder={placeholder}
              maxLength={Math.min(options.promptLimit, 40000)}
              rows={expanded ? 6 : 3}
            />
          )}
          <span
            className="media-prompt-count"
            data-empty={!expanded && promptLength === 0}
            data-warning={promptLength > 16000 * 0.94}
          >
            {promptLength}/16000
          </span>
          {selectedPresets.length > 0 && (
            <section className="media-applied-presets" aria-label="已选预设">
              {presetKinds.flatMap((kind) =>
                selectedPresets
                  .filter(({ id }) => presets[kind].includes(id))
                  .map(({ id, name, prompt }) => (
                    <button
                      type="button"
                      key={id}
                      title={prompt}
                      aria-label={`移除预设 ${name}`}
                      onClick={() =>
                        setPresets((current) => ({
                          ...current,
                          [kind]: current[kind].filter((item) => item !== id),
                        }))
                      }
                    >
                      {name}
                      <X size={12} />
                    </button>
                  )),
              )}
            </section>
          )}
          {voiceNeedsSound && <p role="alert">使用角色音色时请开启声音生成</p>}
          {promptTooLong && <p role="alert">提示词和预设合计最多 {options.promptLimit} 字符。</p>}
          {picker === "parameters" && (
            <MediaPopover anchor={anchor} label="生成参数" close={closePicker}>
              <fieldset className="media-parameter-fields" disabled={locked}>
                <MediaParameterPicker
                  options={pickerOptions}
                  value={params}
                  size={size}
                  duration={duration}
                  setSize={setSize}
                  setDuration={setDuration}
                  change={changeParams}
                />
              </fieldset>
            </MediaPopover>
          )}
          {presetKinds.map(
            (kind) =>
              picker === kind && (
                <MediaPopover
                  key={kind}
                  anchor={anchor}
                  label={presetLabels[kind]}
                  wide={kind !== "tpl"}
                  presetPanel
                  close={closePicker}
                >
                  <MediaPresetPicker
                    kind={kind}
                    selected={presets[kind]}
                    onPick={(id) => choosePreset(kind, id)}
                    hasReference={hasImage}
                    maxLength={target ? options.promptLimit : undefined}
                  />
                </MediaPopover>
              ),
          )}
          {(error || offline) && (
            <p role="alert">{error || "这个模型已经下线，请换一个模型后再生成"}</p>
          )}
          <div className="media-generation-toolbar">
            <GenerationModelMenu
              models={compatible}
              plugins={settings.plugins}
              current={target}
              status={modelsStatus}
              offline={offline}
              choose={chooseModel}
              disabled={busy}
              container={menuContainer}
            />
            {(!audio ||
              (target &&
                (pickerOptions.speaker ||
                  pickerOptions.instrumental ||
                  pickerOptions.audioFormats.length > 0 ||
                  pickerOptions.durationRange ||
                  pickerOptions.durations.length > 0 ||
                  pickerOptions.counts.some((count) => count > 1) ||
                  Object.values(pickerOptions.customParameters).some((field) => field.open)))) && (
              <button
                type="button"
                ref={parametersButton}
                aria-label="生成参数"
                aria-expanded={picker === "parameters"}
                onClick={(event) => togglePicker("parameters", event.currentTarget)}
              >
                <SlidersHorizontal size={14} />
                {[
                  params.aspectRatio ??
                    params.size ??
                    (size || defaultParameters.size || defaultParameters.aspectRatio),
                  params.resolution ??
                    (params.size || size ? undefined : defaultParameters.resolution),
                  shownDuration === -1 ? "智能时长" : shownDuration ? `${shownDuration} 秒` : "",
                  (params.count ?? defaultParameters.count)
                    ? `${params.count ?? defaultParameters.count} ${options.countUnit}`
                    : "",
                  audio ? (params.audioFormat ?? defaultParameters.audioFormat) : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "默认参数"}
                <ChevronDown size={13} />
              </button>
            )}
            {presetKinds.map((kind) => (
              <button
                type="button"
                key={kind}
                aria-label={presetLabels[kind]}
                disabled={locked}
                aria-expanded={picker === kind}
                onClick={(event) => togglePicker(kind, event.currentTarget)}
              >
                {presetLabels[kind]}
                {presets[kind].length > 0 && (
                  <span className="media-preset-count">{presets[kind].length}</span>
                )}
                <ChevronDown size={13} />
              </button>
            ))}
            <span
              className="media-generation-send"
              title={
                blockedReason ??
                (target
                  ? `发送提示词${chosenReferences.length ? "和参考素材" : ""}至 ${target.endpoint}，供应商可能计费。`
                  : "请先启用匹配的模型")
              }
            >
              <span
                className="media-credit"
                data-blocked={!ready}
                aria-label={quote === undefined ? "积分未知" : `预估 ${quote} 积分`}
              >
                <Sparkle size={14} strokeWidth={0} />
                {quote ?? "—"}
              </span>
              <motion.button
                className="media-submit"
                type="submit"
                whileTap={ready ? { scale: 0.92 } : undefined}
                whileHover={ready ? { scale: 1.05 } : undefined}
                aria-label={busy || generating ? "生成中" : "开始生成"}
                disabled={!ready}
              >
                {busy || generating ? (
                  <Loader2 size={16} className="shot-split-spinner" />
                ) : (
                  <ArrowUp size={16} strokeWidth={2.5} />
                )}
              </motion.button>
              {voiceSubmission && (
                <span
                  className="media-with-voice"
                  title={
                    busy || generating
                      ? "生成中"
                      : (blockedReason ??
                        voiceSubmission.reason ??
                        `形象 ${quote ?? "—"} 积分，音色约 ${voiceSubmission.credits} 积分`)
                  }
                >
                  <span className="media-credit" data-blocked={!ready || !!voiceSubmission.reason}>
                    <Sparkle size={14} strokeWidth={0} />
                    {quote === undefined ? "—" : quote + voiceSubmission.credits}
                  </span>
                  <motion.button
                    className="media-submit"
                    data-with-voice
                    type="submit"
                    disabled={!ready || !!voiceSubmission.reason}
                    aria-label={busy || generating ? "生成中" : "含音色"}
                    whileTap={ready && !voiceSubmission.reason ? { scale: 0.92 } : undefined}
                    whileHover={ready && !voiceSubmission.reason ? { scale: 1.05 } : undefined}
                  >
                    含音色
                    {busy || generating ? (
                      <Loader2 size={16} className="shot-split-spinner" />
                    ) : (
                      <ArrowUp size={16} strokeWidth={2.5} />
                    )}
                  </motion.button>
                </span>
              )}
            </span>
          </div>
        </>
      ) : (
        <>
          <h2>生成 · {node.data.label}</h2>
          {compatible.length === 0 && <p>请先在模型设置中启用匹配的模型。</p>}
          <label>
            生成模型
            <select
              value={target?.id ?? ""}
              disabled={busy}
              onChange={(event) => chooseModel(event.target.value)}
            >
              {compatible.map(({ id, label, model, config }) => (
                <option key={id} value={id}>
                  {config?.name ?? model} · {label}
                  {!!config?.tags?.length && ` · ${config.tags.join(" · ")}`}
                  {config?.pricing && ` · ${modelPriceLabel(config.pricing)}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            生成提示词
            <textarea
              value={draft}
              onChange={(event) => setPrompt(event.target.value)}
              required
              maxLength={options.promptLimit}
              rows={4}
            />
          </label>
          {promptTooLong && <p role="alert">当前模型的提示词最多 {options.promptLimit} 字符。</p>}
          {canReference && (
            <label>
              参考素材（可选）
              <select
                multiple
                size={Math.min(4, Math.max(2, assets.length))}
                value={references}
                onChange={(event) =>
                  setReferences([...event.target.selectedOptions].map(({ value }) => value))
                }
              >
                {media.available.map(({ assetId, displayName }) => (
                  <option key={assetId} value={assetId}>
                    {displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {referenceIssue && <p role="alert">{referenceIssue}</p>}
          {referenceLinks}
          {(node.data.kind === "audio" || Object.keys(options.customParameters).length > 0) &&
            target && (
              <MediaParameterPicker
                options={pickerOptions}
                value={params}
                size={size}
                duration={duration}
                change={changeParams}
                setSize={setSize}
                setDuration={setDuration}
              />
            )}
          {target && (
            <p className="muted">
              将发送提示词
              {canReference && references.length ? `和 ${references.length} 个参考素材` : ""}至{" "}
              {target.endpoint}。供应商可能计费。
              {quote !== undefined && `本次预估 ${quote} 积分。`}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="settings-actions">
            <button type="button" disabled={busy} onClick={close}>
              返回
            </button>
            <button className="settings-primary" type="submit" disabled={!ready}>
              {busy ? "正在提交…" : "确认生成"}
            </button>
          </div>
        </>
      )}
    </form>
  );
  const switchDialog = pendingSwitch && (
    <ModelSwitchDialog
      labels={pendingSwitch.labels}
      cancel={() => setPendingSwitch(undefined)}
      confirm={() => chooseModel(pendingSwitch.id, pendingSwitch.labels)}
    />
  );
  if (inline)
    return (
      <section
        className={`canvas-surface nodrag nopan nowheel ${compact ? "media-generation" : "generation-dialog node-generation"}`}
        style={expanded ? { height: panelHeight.current, visibility: "hidden" } : undefined}
        aria-label="生成确认"
      >
        <RefHighlightProvider>
          {dialogOnly && (
            <dialog
              ref={settingsDialog}
              className="asset-prompt-settings nodrag nopan nowheel"
              aria-labelledby={`asset-prompt-title-${node.id}`}
              aria-describedby={`asset-prompt-help-${node.id}`}
              onCancel={(event) => {
                event.preventDefault();
                if (!expanded && !picker) close();
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (event.target !== event.currentTarget) return;
                const box = event.currentTarget.getBoundingClientRect();
                if (
                  event.clientX < box.left ||
                  event.clientX > box.right ||
                  event.clientY < box.top ||
                  event.clientY > box.bottom
                )
                  close();
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <header>
                <div>
                  <h2 id={`asset-prompt-title-${node.id}`}>{node.data.label}</h2>
                  <p id={`asset-prompt-help-${node.id}`}>提示词与生成设置</p>
                </div>
                {editCharacter && (
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      editCharacter();
                    }}
                  >
                    角色详情与音色
                  </button>
                )}
                <button type="button" aria-label="关闭" onClick={close}>
                  <X size={16} />
                </button>
              </header>
              <div
                className="asset-prompt-body"
                style={expanded ? { height: panelHeight.current } : undefined}
              >
                {!expanded && form}
              </div>
            </dialog>
          )}
          {!expanded ? (
            !dialogOnly && form
          ) : (
            <dialog
              ref={expandedDialog}
              className="media-prompt-dialog nodrag nopan nowheel"
              aria-label="编辑提示词"
              onCancel={(event) => {
                event.preventDefault();
                restorePrompt();
              }}
              onKeyDownCapture={(event) => {
                if (
                  event.key !== "Escape" ||
                  event.nativeEvent.isComposing ||
                  picker ||
                  event.currentTarget.querySelector(
                    "[role=listbox], [aria-haspopup=menu][aria-expanded=true], .canvas-ref-peek",
                  )
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                restorePrompt();
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (event.target !== event.currentTarget) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                if (
                  event.clientX < bounds.left ||
                  event.clientX > bounds.right ||
                  event.clientY < bounds.top ||
                  event.clientY > bounds.bottom
                )
                  restorePrompt();
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.stopPropagation()}
            >
              {form}
              <button
                className="media-prompt-close"
                type="button"
                onClick={restorePrompt}
                aria-label="关闭编辑提示词"
              >
                <X size={16} />
              </button>
            </dialog>
          )}
          {switchDialog}
        </RefHighlightProvider>
      </section>
    );
  return (
    <dialog
      ref={dialog}
      className="generation-dialog"
      aria-label="生成确认"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      {form}
      {switchDialog}
    </dialog>
  );
}

export function JobCenter({
  jobs,
  assets,
  onPreview,
  onAction,
  onRetry,
}: {
  jobs: GenerationJob[];
  assets: ProjectAsset[];
  onPreview: (asset: ProjectAsset) => void;
  onAction: (action: "cancelJob" | "recheckJob", jobId: string) => Promise<string | undefined>;
  onRetry: (nodeId: string, purpose?: GenerationJob["purpose"]) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (action: "cancelJob" | "recheckJob", id: string) => {
    setBusy(true);
    try {
      setError((await onAction(action, id)) ?? "");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="job-center" aria-label="生成任务中心">
      <header>
        <h2>生成任务</h2>
        <span>{jobs.filter(({ status }) => !jobIsTerminal(status)).length} 项进行中</span>
      </header>
      {!jobs.length && <p className="muted">选择创作节点，打开生成面板。</p>}
      {error && <p role="alert">{error}</p>}
      {jobs.map((job) => (
        <article key={job.id} className="job-row">
          <strong>
            {job.purpose === "character-voice" ? "角色音色 · " : ""}
            {job.providerLabel} · {job.model}
          </strong>
          <small>
            {new Date(job.createdAt).toLocaleString()} · {job.nodeId}
          </small>
          <span>
            {job.cancelRequested
              ? "正在请求取消"
              : job.status === "queued" && job.afterImageJobId
                ? "等待形象生成并绑定主图"
                : generationStatuses[job.status]}
          </span>
          {!jobIsTerminal(job.status) && (
            <progress aria-label="生成进度" value={job.progress} max={100} />
          )}
          {job.status === "succeeded" && job.purpose === "character-voice" && !job.bound && (
            <small>试听后，可在角色卡中采用此音色。</small>
          )}
          {job.status === "succeeded" && !job.bound && !job.purpose && (
            <small>来源节点已修改或移除，结果保留在任务与素材库。</small>
          )}
          {job.error && (
            <small>
              {job.error === "JOB_ORIGINAL_BINDING_MISSING"
                ? missingJobBindingMessage
                : job.error === "JOB_OUTCOME_UNKNOWN"
                  ? "请核对供应商状态，避免重复消费。"
                  : job.error === "JOB_QUEUE_TIMEOUT"
                    ? "排队超时，任务未提交给供应商。"
                    : job.error === "JOB_IMAGE_DEPENDENCY_FAILED"
                      ? "本次形象未能用作主图参考，音色未发送。"
                      : `任务详情 · ${jobFailureReason(job)}`}
            </small>
          )}
          {job.outputs.map((output) => {
            if ("text" in output)
              return (
                <details key={`text:${output.text}`}>
                  <summary>生成文本</summary>
                  <p>{output.text}</p>
                </details>
              );
            const asset = assets.find(({ assetId }) => assetId === output.assetId);
            return (
              asset?.availability === "ready" && (
                <button type="button" key={asset.assetId} onClick={() => onPreview(asset)}>
                  预览{asset.displayName}
                </button>
              )
            );
          })}
          {(job.status === "queued" ||
            (job.status === "running" && job.canCancelRemote && !job.cancelRequested)) && (
            <button type="button" disabled={busy} onClick={() => void act("cancelJob", job.id)}>
              请求取消
            </button>
          )}
          {job.status === "running" && !job.canCancelRemote && <small>供应商未确认可取消。</small>}
          {job.status === "outcome_unknown" && job.canRecheck && (
            <button type="button" disabled={busy} onClick={() => void act("recheckJob", job.id)}>
              查询原任务
            </button>
          )}
          {job.status === "failed" && (
            <button type="button" onClick={() => onRetry(job.nodeId, job.purpose)}>
              重新配置并生成
            </button>
          )}
        </article>
      ))}
    </section>
  );
}

export function NodeGenerationHistory({
  nodeId,
  jobs,
  assets,
  onPreview,
  onBind,
  onRetry,
  onOpenJobs,
  outputs = [],
  activeOutputId,
  versionLocked = false,
  onSelectOutput,
  onAddAll,
  onDownloadAll,
}: {
  nodeId: string;
  jobs: GenerationJob[];
  assets: ProjectAsset[];
  onPreview: (asset: ProjectAsset) => void;
  onBind: (assetId: string) => void;
  onRetry: () => void;
  onOpenJobs: () => void;
  outputs?: CreativeOutput[];
  activeOutputId?: string;
  versionLocked?: boolean;
  onSelectOutput?: (output: CreativeOutput) => void;
  onAddAll?: () => void;
  onDownloadAll?: () => void;
}) {
  const history = jobs
    .filter(({ nodeId: jobNodeId, purpose }) => jobNodeId === nodeId && !purpose)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (!history.length && !outputs.length) return null;
  return (
    <section className="node-generation-history" aria-label="节点历史输出">
      <header>
        <strong>历史输出</strong>
        <button type="button" onClick={onOpenJobs}>
          查看全部
        </button>
      </header>
      {outputs.length > 0 && (
        <>
          <section className="node-output-grid" aria-label="历史产物">
            {[...outputs].reverse().map((output, index) => {
              const asset = output.assetId
                ? assets.find(({ assetId }) => assetId === output.assetId)
                : undefined;
              return (
                <button
                  type="button"
                  key={output.id}
                  className={output.id === activeOutputId ? "is-active" : ""}
                  disabled={versionLocked}
                  onClick={() => onSelectOutput?.(output)}
                  title={
                    versionLocked
                      ? "生成中，出第一张后可切换"
                      : output.id === activeOutputId
                        ? "当前主输出"
                        : "设为当前主输出"
                  }
                >
                  {asset
                    ? asset.displayName
                    : output.kind === "text"
                      ? "文本结果"
                      : `第 ${outputs.length - index} 版`}
                  {output.id === activeOutputId && <small>当前</small>}
                </button>
              );
            })}
          </section>
          <div className="node-generation-output">
            <button type="button" disabled={!onDownloadAll} onClick={onDownloadAll}>
              下载全部
            </button>
            <button type="button" disabled={!onAddAll} onClick={onAddAll}>
              全部添加到画布
            </button>
          </div>
        </>
      )}
      {history.map((job) => (
        <article key={job.id} className="node-generation-history-row">
          <div>
            <strong>{job.model || job.providerLabel}</strong>
            <small>
              {new Date(job.createdAt).toLocaleString()} ·{" "}
              {job.status === "succeeded" ? "已完成" : job.status}
            </small>
          </div>
          {job.outputs.map((output) => {
            if ("text" in output)
              return (
                <details key={`${job.id}:text:${output.text}`}>
                  <summary>查看文本结果</summary>
                  <p>{output.text}</p>
                </details>
              );
            const asset = assets.find(({ assetId }) => assetId === output.assetId);
            if (!asset) return null;
            return (
              <div className="node-generation-output" key={`${job.id}:${output.assetId}`}>
                <button type="button" onClick={() => onPreview(asset)}>
                  预览 {asset.displayName}
                </button>
                <button
                  type="button"
                  disabled={versionLocked}
                  title={versionLocked ? "生成中，出第一张后可切换" : undefined}
                  onClick={() => onBind(asset.assetId)}
                >
                  设为当前素材
                </button>
              </div>
            );
          })}
          {job.status === "failed" && (
            <button type="button" onClick={onRetry}>
              重新配置并生成
            </button>
          )}
        </article>
      ))}
    </section>
  );
}

export function useGenerationProviders(open: boolean) {
  const [settings, setSettings] = useState<ProviderSettings>({
    providers: [],
    plugins: [],
    status: "loading",
  });
  useEffect(() => {
    if (!open) return;
    let current = true;
    setSettings({ providers: [], plugins: [], status: "loading" });
    void window.desktop.settings
      .list({})
      .then((result) => {
        if (current)
          setSettings(
            result.ok
              ? { ...result.value, status: "ready" }
              : { providers: [], plugins: [], status: "error" },
          );
      })
      .catch(() => {
        if (current) setSettings({ providers: [], plugins: [], status: "error" });
      });
    return () => {
      current = false;
    };
  }, [open]);
  return settings;
}
