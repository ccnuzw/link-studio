import type { CreativeOutput } from "@link-studio/core";
import {
  type GenerationInput,
  type GenerationJob,
  isPublicReferenceURL,
  jobIsTerminal,
  modelGenerationOptions,
  type ProjectAsset,
  type ProjectCanvasView,
  type ProviderView,
  providerVendorLabel,
  type SettingsValues,
} from "@link-studio/core";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Film,
  Link2,
  Maximize2,
  Minimize2,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { type linkedMediaSources, mediaReferences } from "./media-references";

type Picker = "references" | "parameters" | "models" | PresetKind;

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
export type VisualMediaKind = "image" | "video";

export function isVisualMedia(kind: string): kind is VisualMediaKind {
  return kind === "image" || kind === "video";
}

export function GenerationForm({
  node,
  settings,
  assets,
  linkedSources = [],
  inline = false,
  blocked = false,
  onPromptChange,
  onUnlinkReference,
  openSettings,
  close,
  submit,
}: {
  node: Node;
  settings: SettingsValues["list"];
  assets: ProjectAsset[];
  linkedSources?: ReturnType<typeof linkedMediaSources>;
  inline?: boolean;
  blocked?: boolean;
  onPromptChange?: (prompt: string) => void;
  onUnlinkReference?: (assetId: string) => void;
  openSettings?: () => void;
  close: () => void;
  submit: (
    input: Omit<GenerationInput, "expectedCanvasRevision">,
    operationId: string,
  ) => Promise<string | undefined>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const parametersButton = useRef<HTMLButtonElement>(null);
  const compatible = settings.providers
    .filter((provider) => {
      const plugin = settings.plugins.find(({ hash }) => hash === provider.pluginHash);
      return (
        provider.enabled &&
        provider.channelEnabled !== false &&
        provider.config?.kind !== "agent" &&
        !plugin?.disabled &&
        plugin?.kind === (node.data.kind === "script" ? "text" : node.data.kind) &&
        (plugin.auth === "none" || provider.hasSecret)
      );
    })
    .sort((left, right) => (left.config?.sort ?? 100) - (right.config?.sort ?? 100));
  const [picked, setPicked] = useState(compatible[0]?.id ?? "");
  const [prompt, setPrompt] = useState(node.data.text.slice(0, 16000));
  const [size, setSize] = useState("");
  const [duration, setDuration] = useState("");
  const [params, setParams] = useState<MediaParameters>({});
  const [presets, setPresets] = useState<PickedPresets>({ style: [], tpl: [], motion: [] });
  const [videoMode, setVideoMode] = useState<GenerationInput["op"]>();
  const [references, setReferences] = useState<string[]>([]);
  const [referenceURLs, setReferenceURLs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState<Picker>();
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const compact = inline && isVisualMedia(node.data.kind);
  const draft = onPromptChange ? node.data.text.slice(0, 16000) : prompt;
  const target = compatible.find(({ id }) => id === picked) ?? compatible[0];
  const plugin = settings.plugins.find(({ hash }) => hash === target?.pluginHash);
  const options = modelGenerationOptions(
    node.data.kind === "script" ? "text" : node.data.kind,
    plugin?.origin === "builtin" ? plugin.key : undefined,
    target?.model ?? "",
    target?.channel,
    target?.config,
  );
  const canReference = !!target && options.referenceLimit > 0;
  const video = node.data.kind === "video";
  const linkedKind = linkedSources.some(({ assetId }) =>
    assets.some(
      (asset) =>
        asset.assetId === assetId &&
        asset.availability === "ready" &&
        asset.mediaType !== "image" &&
        (options.references[asset.mediaType] ?? 0) > 0,
    ),
  );
  const inferredMode =
    options.requiresAudio ||
    (options.omni && (linkedKind || (options.requiresReference && !options.requiresImage)))
      ? "omni"
      : options.requiresImage ||
          (options.references.image &&
            linkedSources.some(({ assetId }) =>
              assets.some(
                (asset) =>
                  asset.assetId === assetId &&
                  asset.availability === "ready" &&
                  asset.mediaType === "image",
              ),
            ))
        ? "i2v"
        : "t2v";
  const preferredMode = videoMode ?? (canReference ? inferredMode : "t2v");
  const op = video
    ? options.modes?.includes(preferredMode) === false
      ? options.modes.find((mode) => mode === "t2v" || mode === "i2v" || mode === "omni")
      : preferredMode
    : undefined;
  const referenceLimit = op === "i2v" ? options.frameLimit : options.referenceLimit;
  const media = mediaReferences({
    assets,
    linked: linkedSources,
    manual: references,
    imageOnly: op === "i2v",
    limit: referenceLimit,
    counts: options.references,
    bytes: options.referenceBytes,
  });
  const usesReferences = canReference && op !== "t2v";
  const chosenReferences = usesReferences ? media.chosen : [];
  const hasImage = chosenReferences.some(({ mediaType }) => mediaType === "image");
  const hasAudio = chosenReferences.some(({ mediaType }) => mediaType === "audio");
  const needsURL = chosenReferences.filter(
    ({ mediaType }) => plugin?.origin === "builtin" && options.referenceNeedsURL(mediaType),
  );
  const invalidURL = needsURL.some(
    ({ assetId }) => !isPublicReferenceURL(referenceURLs[assetId]?.trim() ?? ""),
  );
  const videoInput =
    options.videoAction && chosenReferences.some(({ mediaType }) => mediaType === "video");
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
            (!referenceResolution || resolution !== "1080p") &&
            (plugin?.key !== "vidu" ||
              target?.model !== "vidu2.0" ||
              params.duration !== 8 ||
              resolution === "720p"),
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
  const shownDuration = params.duration ?? (duration || defaultParameters.duration);
  const selectedPresets = selectedPresetText(presets);
  const requestPrompt = [draft.trim(), ...selectedPresets.map(({ prompt }) => prompt)]
    .filter(Boolean)
    .join("\n\n");
  const missingReference =
    (op === "i2v" && !hasImage) ||
    (op === "omni" && chosenReferences.length === 0) ||
    (options.requiresImage && !hasImage) ||
    (node.data.kind === "image" && options.modes?.includes("i2i") === false && hasImage) ||
    (options.requiresAudio && !hasAudio) ||
    (presets.tpl.length > 0 && !hasImage);
  const promptTooLong =
    requestPrompt.length > 16000 || Array.from(requestPrompt).length > options.promptLimit;
  const ready =
    !busy &&
    !blocked &&
    !!target &&
    !!requestPrompt &&
    !missingReference &&
    !invalidURL &&
    !(videoInput && (hasImage || hasAudio)) &&
    !promptTooLong;
  const togglePicker = (next: Picker, button: HTMLButtonElement) => {
    anchor.current = button;
    setPicker(picker === next ? undefined : next);
  };
  const closePicker = (restoreFocus = false) => {
    setPicker(undefined);
    if (restoreFocus) anchor.current?.focus({ preventScroll: true });
  };
  const chooseModel = (id: string) => {
    if (id === target?.id) return;
    setPicked(id);
    setSize("");
    setDuration("");
    setParams({});
    setReferences([]);
    setReferenceURLs({});
    setVideoMode(undefined);
    setError("");
  };
  const choosePreset = (kind: PresetKind, id: string) => {
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
  const presetKinds: PresetKind[] = video ? ["motion"] : ["style", "tpl"];
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
  const form = (
    <form
      className={compact ? "media-generation-form" : undefined}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!target || !ready) return;
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
        const key = JSON.stringify(input);
        if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
        setBusy(true);
        setError("");
        try {
          const failure = await submit(input, attempt.current.id);
          if (failure) setError(failure);
          else close();
        } finally {
          setBusy(false);
        }
      }}
    >
      {compact ? (
        <>
          <div className="media-generation-top">
            {video && (
              <fieldset className="media-video-modes" aria-label="视频生成模式">
                <button
                  type="button"
                  aria-pressed={op === "t2v"}
                  disabled={
                    options.requiresImage ||
                    options.requiresReference ||
                    options.requiresAudio ||
                    options.modes?.includes("t2v") === false
                  }
                  onClick={() => setVideoMode("t2v")}
                >
                  文生视频
                </button>
                <button
                  type="button"
                  aria-pressed={op === "i2v"}
                  disabled={
                    !canReference ||
                    !options.references.image ||
                    options.requiresAudio ||
                    options.modes?.includes("i2v") === false
                  }
                  title={
                    !target
                      ? "请先配置视频模型"
                      : canReference
                        ? "选择图片作为视频参考"
                        : "当前适配器不接收参考图片"
                  }
                  onClick={(event) => {
                    setVideoMode("i2v");
                    if (!media.chosen.length) togglePicker("references", event.currentTarget);
                  }}
                >
                  图生视频
                </button>
                {options.omni && (
                  <button
                    type="button"
                    aria-pressed={op === "omni"}
                    onClick={(event) => {
                      setVideoMode("omni");
                      if (!media.chosen.length) togglePicker("references", event.currentTarget);
                    }}
                  >
                    全能参考
                  </button>
                )}
              </fieldset>
            )}
            {usesReferences && (
              <button
                type="button"
                className="media-reference-add"
                aria-label="添加参考素材"
                title="添加参考素材"
                aria-expanded={picker === "references"}
                onClick={(event) => togglePicker("references", event.currentTarget)}
              >
                <Plus size={20} />
              </button>
            )}
            {chosenReferences.map(({ assetId, displayName }) =>
              media.sources.has(assetId) && !references.includes(assetId) ? (
                <button
                  type="button"
                  key={assetId}
                  className="media-reference-chip media-linked-reference"
                  title={`${displayName} · 点击断开素材连线，可撤销`}
                  aria-label={`断开素材连线 ${media.sources.get(assetId)}`}
                  disabled={busy || blocked}
                  onClick={() => onUnlinkReference?.(assetId)}
                >
                  <Link2 size={14} /> 连线：{media.sources.get(assetId)} <X size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  className="media-reference-chip"
                  key={assetId}
                  title={displayName}
                  aria-label={`移除手动参考素材 ${displayName}`}
                  onClick={() =>
                    setReferences((current) => current.filter((item) => item !== assetId))
                  }
                >
                  {displayName} ×
                </button>
              ),
            )}
            <button
              type="button"
              className="media-generation-expand"
              aria-label={expanded ? "收起提示词编辑区" : "放大提示词编辑区"}
              title={expanded ? "收起提示词编辑区" : "放大提示词编辑区"}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          </div>
          {usesReferences && picker === "references" && (
            <MediaPopover anchor={anchor} label="参考素材" close={closePicker}>
              <div className="media-reference-picker">
                {media.available.length ? (
                  media.available.map(({ assetId, displayName }) => (
                    <label key={assetId}>
                      <input
                        type="checkbox"
                        checked={
                          references.includes(assetId) ||
                          chosenReferences.some((asset) => asset.assetId === assetId)
                        }
                        disabled={
                          (media.sources.has(assetId) &&
                            !references.includes(assetId) &&
                            chosenReferences.some((asset) => asset.assetId === assetId)) ||
                          (references.length >= referenceLimit &&
                            referenceLimit > 1 &&
                            !references.includes(assetId))
                        }
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setReferences((current) =>
                            checked
                              ? referenceLimit === 1
                                ? [assetId]
                                : [...current, assetId]
                              : current.filter((id) => id !== assetId),
                          );
                        }}
                      />
                      {displayName}
                    </label>
                  ))
                ) : (
                  <p className="media-reference-empty">暂无可用参考素材，请先导入素材。</p>
                )}
              </div>
            </MediaPopover>
          )}
          {linkedSources.length > 0 && target && !canReference && (
            <p className="media-popover-hint">当前模型不发送连线素材。</p>
          )}
          {usesReferences && media.unavailable.length > 0 && (
            <p className="media-popover-hint" title={media.unavailable.join("、")}>
              {media.unavailable.length} 个连线来源没有符合当前模型要求的素材。
            </p>
          )}
          {usesReferences && media.overflow > 0 && (
            <p className="media-popover-hint">
              有 {media.overflow} 个素材超出当前模式的数量限制，优先使用手动添加的素材。
            </p>
          )}
          {referenceLinks}
          {videoInput && (hasImage || hasAudio) && (
            <p role="alert">视频编辑或延长只接受一个视频素材。</p>
          )}
          <textarea
            className="media-generation-prompt"
            aria-label="生成提示词"
            value={draft}
            readOnly={busy || blocked}
            onChange={(event) => {
              if (onPromptChange) onPromptChange(event.target.value);
              else setPrompt(event.target.value);
            }}
            placeholder={
              node.data.kind === "video"
                ? "描述想生成的镜头、动作和运镜…"
                : "描述要生成的画面，或写下对参考素材的修改指令…"
            }
            maxLength={16000}
            rows={expanded ? 6 : 3}
          />
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
          {missingReference && (
            <p className="media-popover-hint">
              {presets.tpl.length ? "此模板需要一张参考图。" : "请添加一张参考图。"}
            </p>
          )}
          {promptTooLong && <p role="alert">提示词和预设合计最多 {options.promptLimit} 字符。</p>}
          {picker === "parameters" && (
            <MediaPopover anchor={anchor} label="生成参数" close={closePicker}>
              <MediaParameterPicker
                options={pickerOptions}
                value={params}
                size={size}
                duration={duration}
                setSize={setSize}
                setDuration={setDuration}
                change={(update) => setParams((current) => ({ ...current, ...update }))}
              />
            </MediaPopover>
          )}
          {picker === "models" && (
            <MediaPopover anchor={anchor} label="选择生成模型" close={closePicker}>
              <div className="media-model-options">
                {compatible.map(({ id, label, model, pluginHash, config }) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={target?.id === id}
                    onClick={() => {
                      chooseModel(id);
                      closePicker(true);
                    }}
                  >
                    <span className="media-model-icon">
                      <Film size={17} />
                    </span>
                    <span>
                      <strong>{config?.name ?? model}</strong>
                      <small>
                        {label} ·{" "}
                        {providerVendorLabel(
                          settings.plugins.find(({ hash }) => hash === pluginHash)?.vendor,
                        )}{" "}
                        · {settings.plugins.find(({ hash }) => hash === pluginHash)?.name}
                      </small>
                    </span>
                    {target?.id === id && <Check size={16} />}
                  </button>
                ))}
              </div>
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
                  close={closePicker}
                >
                  <MediaPresetPicker
                    kind={kind}
                    selected={presets[kind]}
                    onPick={(id) => choosePreset(kind, id)}
                    hasReference={hasImage}
                  />
                </MediaPopover>
              ),
          )}
          {error && <p role="alert">{error}</p>}
          <div className="media-generation-toolbar">
            {target ? (
              <button
                className="media-model-trigger"
                type="button"
                aria-label="生成模型"
                title={target.model}
                disabled={busy}
                aria-expanded={picker === "models"}
                onClick={(event) => togglePicker("models", event.currentTarget)}
              >
                <span>{target.config?.name ?? target.model}</span>
                <ChevronDown size={13} />
              </button>
            ) : (
              <button type="button" onClick={openSettings}>
                配置{node.data.kind === "video" ? "视频" : "图片"}模型 <ChevronDown size={13} />
              </button>
            )}
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
                  ? `${params.count ?? defaultParameters.count} 张`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ") || "默认参数"}
              <ChevronDown size={13} />
            </button>
            {presetKinds.map((kind) => (
              <button
                type="button"
                key={kind}
                aria-label={presetLabels[kind]}
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
                target
                  ? `发送提示词${chosenReferences.length ? "和参考素材" : ""}至 ${target.endpoint}，供应商可能计费。`
                  : "请先启用匹配的模型"
              }
            >
              {target && <small>可能计费</small>}
              <button
                className="media-submit"
                type="submit"
                aria-label="确认生成"
                disabled={!ready}
              >
                <ArrowUp size={19} />
              </button>
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
              maxLength={16000}
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
                  setReferences(
                    [...event.target.selectedOptions]
                      .map(({ value }) => value)
                      .slice(0, options.referenceLimit),
                  )
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
          {referenceLinks}
          {node.data.kind === "audio" && target && (
            <MediaParameterPicker
              options={pickerOptions}
              value={params}
              size={size}
              duration={duration}
              change={(update) => setParams({ ...params, ...update })}
              setSize={setSize}
              setDuration={setDuration}
            />
          )}
          {target && (
            <p className="muted">
              将发送提示词
              {canReference && references.length ? `和 ${references.length} 个参考素材` : ""}至{" "}
              {target.endpoint}。供应商可能计费。
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
  if (inline)
    return (
      <section
        className={`canvas-surface nodrag nopan nowheel ${compact ? "media-generation" : "generation-dialog node-generation"}`}
        aria-label="生成确认"
      >
        {form}
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
          {job.status === "succeeded" && job.purpose === "character-voice" && (
            <small>试听后，可在角色卡中采用此音色。</small>
          )}
          {job.status === "succeeded" && !job.bound && !job.purpose && (
            <small>来源节点已修改或移除，结果保留在任务与素材库。</small>
          )}
          {job.error && (
            <small>
              {job.error === "JOB_OUTCOME_UNKNOWN"
                ? "请核对供应商状态，避免重复消费。"
                : job.error === "JOB_IMAGE_DEPENDENCY_FAILED"
                  ? "本次形象未能用作主图参考，音色未发送。"
                  : `任务详情 · ${job.error}`}
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
                  onClick={() => onSelectOutput?.(output)}
                  title={output.id === activeOutputId ? "当前主输出" : "设为当前主输出"}
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
                <button type="button" onClick={() => onBind(asset.assetId)}>
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
  const [settings, setSettings] = useState<{
    providers: ProviderView[];
    plugins: SettingsValues["list"]["plugins"];
  }>({ providers: [], plugins: [] });
  useEffect(() => {
    if (!open) return;
    let current = true;
    void window.desktop.settings.list({}).then((result) => {
      if (result.ok && current) setSettings(result.value);
    });
    return () => {
      current = false;
    };
  }, [open]);
  return settings;
}
