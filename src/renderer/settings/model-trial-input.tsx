import { Menu } from "@base-ui/react/menu";
import {
  type ModelKind,
  mediaReferenceBytes,
  modelGenerationModes,
  type modelGenerationOptions,
  modelModeLabels,
} from "@link-studio/core";
import { Link2, Upload, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { ChoiceButton } from "../choice-button";
import { MediaParameterPicker, type MediaParameters } from "../workspace/media-pickers";
import { KindMark } from "./model-editor";
import { ModelAvatar } from "./model-logo";
import { type OfficialVoice, OfficialVoicePicker } from "./official-voice-picker";
export const referenceLabels = { image: "图片", video: "视频", audio: "音频" } as const;
export type ReferenceKind = keyof typeof referenceLabels;

export function trialPromptError(prompt: string, maximum: number) {
  const text = prompt.trim();
  if (!text) return "请填写提示词";
  return Array.from(text).length > maximum ? `提示词不能超过 ${maximum} 个字` : undefined;
}

function ReferenceActions({
  kind,
  maximum,
  disabled,
  choose,
  addVoice,
}: {
  kind: ReferenceKind;
  maximum: number;
  disabled: boolean;
  choose: () => void;
  addVoice: (voice: OfficialVoice) => void;
}) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  return (
    <div className="trial-ref-actions">
      <button type="button" disabled={disabled} onClick={choose}>
        <Upload size={14} />
        上传
      </button>
      {kind === "audio" && <OfficialVoicePicker disabled={disabled} onPick={addVoice} />}
      <Menu.Root modal={false}>
        <Menu.Trigger ref={setTrigger} disabled={disabled}>
          <Link2 size={14} />
          画布素材
        </Menu.Trigger>
        <Menu.Portal container={trigger?.closest("dialog")}>
          <Menu.Positioner align="start" sideOffset={6} className="trial-ref-position">
            <Menu.Popup className="trial-ref-menu">
              <Menu.Group>
                <Menu.GroupLabel>选择画布里已有的素材</Menu.GroupLabel>
                <p>画布里还没有可用的参考{referenceLabels[kind]}</p>
              </Menu.Group>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <small>单个 ≤ {maximum / 1024 / 1024} MB</small>
    </div>
  );
}

function ImageThumbnail({ file }: { file: File }) {
  const [url, setURL] = useState("");
  useEffect(() => {
    const src = URL.createObjectURL(file);
    setURL(src);
    return () => URL.revokeObjectURL(src);
  }, [file]);
  return url ? <img alt={file.name} src={url} width={36} height={36} /> : null;
}

export function useTrialInputs() {
  const [prompt, setPrompt] = useState("");
  const [params, setParams] = useState<MediaParameters>({});
  const [size, setSize] = useState("");
  const [duration, setDuration] = useState("");
  const [mode, setMode] = useState<ReturnType<typeof modelGenerationModes>[number]>();
  const [references, setReferences] = useState<Partial<Record<ReferenceKind, string>>>({});
  const [attachments, setAttachments] = useState<
    Partial<
      Record<ReferenceKind, ({ id: string; file: File } | { id: string; voice: OfficialVoice })[]>
    >
  >({});
  const [fileError, setFileError] = useState<Partial<Record<ReferenceKind, string>>>({});

  return {
    prompt,
    setPrompt,
    params,
    setParams,
    size,
    setSize,
    duration,
    setDuration,
    mode,
    setMode,
    references,
    setReferences,
    attachments,
    setAttachments,
    fileError,
    setFileError,
  };
}
type Options = ReturnType<typeof modelGenerationOptions>;
export function trialCapabilities(
  kind: ModelKind,
  options: Options,
  inputs: ReturnType<typeof useTrialInputs>,
) {
  const { mode, references, attachments } = inputs;
  const supportedModes = modelGenerationModes(kind, options);
  const modes = options.modes?.filter((entry) => supportedModes.includes(entry)) ?? supportedModes;
  const selectedMode = mode && modes.includes(mode) ? mode : modes[0];
  const op = selectedMode === "i2i" || selectedMode === "t2i" ? undefined : selectedMode;
  const refKinds = (Object.keys(referenceLabels) as ReferenceKind[]).filter(
    (entry) =>
      (options.references[entry] ?? 0) > 0 &&
      selectedMode !== "t2i" &&
      op !== "t2v" &&
      (op !== "i2v" || entry === "image"),
  );
  const urls = (kind: ReferenceKind) =>
    (references[kind] ?? "")
      .split("\n")
      .map((url) => url.trim())
      .filter(Boolean);
  const refCount = (kind: ReferenceKind) => urls(kind).length + (attachments[kind]?.length ?? 0);
  const limit = (kind: ReferenceKind) =>
    Math.min(
      options.references[kind] ?? 0,
      op === "i2v" ? options.frameLimit : options.referenceLimit,
    );
  const totalRefs = refKinds.reduce((sum, kind) => sum + refCount(kind), 0);
  const referenceErrors: Partial<Record<ReferenceKind, string>> = {};
  for (const kind of refKinds) {
    if (refCount(kind) > limit(kind))
      referenceErrors[kind] = `参考${referenceLabels[kind]}最多 ${limit(kind)} 个，请移除多余的`;
  }
  if (!totalRefs && (selectedMode === "i2i" || selectedMode === "i2v"))
    referenceErrors.image = "图生方式需要至少 1 张参考图片";
  if (!totalRefs && selectedMode === "omni" && refKinds[0])
    referenceErrors[refKinds[0]] = "全能参考需要至少 1 个参考素材";
  if (totalRefs > options.referenceLimit && !Object.keys(referenceErrors).length && refKinds[0])
    referenceErrors[refKinds[0]] = "参考素材数量超出当前生成方式的限制。";

  return { modes, selectedMode, op, refKinds, urls, refCount, limit, totalRefs, referenceErrors };
}
export function TrialInputCard({
  name,
  seed,
  logo,
  kind,
  options,
  inputs,
  preview = false,
  busy = false,
  attempted = false,
  promptInput,
  children,
}: {
  name: string;
  seed?: string;
  logo?: string;
  kind: ModelKind;
  options: Options;
  inputs: ReturnType<typeof useTrialInputs>;
  preview?: boolean;
  busy?: boolean;
  attempted?: boolean;
  promptInput?: RefObject<HTMLTextAreaElement | null>;
  children?: ReactNode;
}) {
  const {
    prompt,
    setPrompt,
    params,
    setParams,
    size,
    setSize,
    duration,
    setDuration,
    setMode,
    references,
    setReferences,
    attachments,
    setAttachments,
    fileError,
    setFileError,
  } = inputs;
  const { modes, selectedMode, refKinds, refCount, limit, totalRefs, referenceErrors } =
    trialCapabilities(kind, options, inputs);
  const fileInputs = useRef<Partial<Record<ReferenceKind, HTMLInputElement | null>>>({});
  const promptError = attempted && trialPromptError(prompt, options.promptLimit);
  return (
    <section className="model-trial-card">
      <header>
        <ModelAvatar name={name} seed={seed} logo={logo} />
        <strong>{name}</strong>
        <KindMark kind={kind} />
      </header>
      {modes.length > 1 && (
        <div className="trial-modes" role="radiogroup" aria-label="生成方式">
          {modes.map((entry) => (
            <ChoiceButton
              type="button"
              key={entry}
              disabled={busy}
              role="radio"
              aria-checked={selectedMode === entry}
              onClick={() => setMode(entry)}
            >
              {modelModeLabels[entry]}
            </ChoiceButton>
          ))}
        </div>
      )}
      <label className="model-trial-prompt">
        <textarea
          ref={promptInput}
          aria-invalid={Boolean(promptError)}
          aria-label={preview ? "预览提示词" : "测试提示词"}
          placeholder={kind === "audio" ? "输入要朗读的文本…" : "描述你想生成的内容…"}
          rows={5}
          value={prompt}
          disabled={busy}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
        {promptError && <small role="alert">{promptError}</small>}
        <small>
          {Array.from(prompt).length} / {options.promptLimit}
        </small>
      </label>
      {selectedMode && !refKinds.length && (
        <p className="trial-text-only">当前方式只用文字，不使用参考素材</p>
      )}
      {refKinds.map((kind) => (
        <fieldset className="model-trial-params trial-ref" key={kind}>
          <legend>
            <span>参考{referenceLabels[kind]}</span>
            <span>
              {refCount(kind)} / {limit(kind)}
            </span>
          </legend>
          <input
            type="file"
            hidden
            aria-label={`选择本地${referenceLabels[kind]}`}
            ref={(field) => {
              fileInputs.current[kind] = field;
            }}
            accept={`${kind}/*`}
            multiple
            disabled={busy || refCount(kind) >= limit(kind) || totalRefs >= options.referenceLimit}
            onChange={(event) => {
              const added = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (!added.length) return;
              const maximum = options.referenceBytes[kind] ?? mediaReferenceBytes;
              const totalBytes = refKinds
                .flatMap((entry) =>
                  (attachments[entry] ?? []).flatMap((item) => ("file" in item ? [item.file] : [])),
                )
                .concat(added)
                .reduce((sum, file) => sum + file.size, 0);
              const reason =
                refCount(kind) + added.length > limit(kind) ||
                totalRefs + added.length > options.referenceLimit
                  ? "参考素材数量已达上限"
                  : added.some((file) => !file.size || file.size > maximum)
                    ? `单个参考文件须大于零且不超过 ${maximum / (1024 * 1024)} MB`
                    : totalBytes > mediaReferenceBytes
                      ? "试跑参考文件总计最多 10 MB"
                      : "";
              setFileError({ ...fileError, [kind]: reason });
              if (!reason) {
                setAttachments({
                  ...attachments,
                  [kind]: [
                    ...(attachments[kind] ?? []),
                    ...added.map((file) => ({ id: crypto.randomUUID(), file })),
                  ],
                });
              }
            }}
          />
          {attachments[kind]?.map((item) => {
            const name = "file" in item ? item.file.name : item.voice.name;
            return (
              <div className="trial-file" key={item.id}>
                {kind === "image" && "file" in item && <ImageThumbnail file={item.file} />}
                <span>{name}</span>
                <button
                  type="button"
                  aria-label={`移除素材 ${name}`}
                  disabled={busy}
                  onClick={() => {
                    setAttachments({
                      ...attachments,
                      [kind]: attachments[kind]?.filter((other) => other.id !== item.id),
                    });
                    setFileError({ ...fileError, [kind]: "" });
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          <ReferenceActions
            kind={kind}
            maximum={options.referenceBytes[kind] ?? mediaReferenceBytes}
            addVoice={(voice) => {
              if (refCount(kind) >= limit(kind) || totalRefs >= options.referenceLimit) return;
              setAttachments((current) =>
                current.audio?.some((item) => item.id === voice.url)
                  ? current
                  : { ...current, audio: [...(current.audio ?? []), { id: voice.url, voice }] },
              );
              setFileError({ ...fileError, audio: "" });
            }}
            disabled={
              !!busy || refCount(kind) >= limit(kind) || totalRefs >= options.referenceLimit
            }
            choose={() => fileInputs.current[kind]?.click()}
          />
          <details>
            <summary>使用公开链接</summary>
            <label>
              参考{referenceLabels[kind]}链接
              <textarea
                rows={2}
                placeholder="公开 HTTPS 链接，每行一个"
                value={references[kind] ?? ""}
                disabled={busy}
                onChange={(event) => setReferences({ ...references, [kind]: event.target.value })}
              />
            </label>
          </details>
          {(fileError[kind] || (attempted && referenceErrors[kind])) && (
            <small role="alert">{fileError[kind] || referenceErrors[kind]}</small>
          )}
        </fieldset>
      ))}
      {(kind !== "text" || Object.keys(options.customParameters).length > 0) &&
        kind !== "agent" && (
          <fieldset disabled={busy} className="model-trial-params">
            <legend>生成参数</legend>
            <MediaParameterPicker
              options={{ ...options, videoAction: false }}
              value={params}
              size={size}
              duration={duration}
              setSize={setSize}
              setDuration={setDuration}
              change={(values) => setParams((previous) => ({ ...previous, ...values }))}
            />
          </fieldset>
        )}
      {children}
    </section>
  );
}
