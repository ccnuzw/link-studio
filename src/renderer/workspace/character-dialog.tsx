import {
  type CanvasCharacter,
  type GenerationJob,
  jobIsTerminal,
  modelGenerationOptions,
  type ProjectAsset,
  type ProviderView,
  type SettingsValues,
} from "@link-studio/core";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { generationStatuses } from "./generation";

type GenerationChoice = { prompt: string; provider: ProviderView; afterImageJobId?: string };

export function CharacterDialog({
  character,
  assetId,
  assets,
  jobs,
  settings,
  preview,
  generate,
  save,
  close,
}: {
  character: CanvasCharacter;
  assetId?: string;
  assets: ProjectAsset[];
  jobs: GenerationJob[];
  settings: SettingsValues["list"];
  preview: (asset: ProjectAsset) => void;
  generate: (image?: GenerationChoice, voice?: GenerationChoice) => Promise<string | undefined>;
  save: (character: CanvasCharacter, assetId?: string) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(character);
  const [primaryOverride, setPrimary] = useState<string>();
  const primary = primaryOverride ?? assetId ?? "";
  const [imagePrompt, setImagePrompt] = useState<string>();
  const [imageModelId, setImageModelId] = useState("");
  const [voicePromptOverride, setVoicePrompt] = useState<string>();
  const [voiceModelId, setVoiceModelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const models = (kind: "image" | "audio") =>
    settings.providers.filter((provider) => {
      const plugin = settings.plugins.find(({ hash }) => hash === provider.pluginHash);
      return (
        provider.enabled &&
        provider.channelEnabled !== false &&
        plugin?.kind === kind &&
        !plugin.disabled &&
        provider.config?.kind !== "agent" &&
        (kind !== "image" || (provider.config?.modes?.includes("t2i") ?? true)) &&
        (plugin.auth === "none" || provider.hasSecret)
      );
    });
  const imageModels = models("image");
  const imageModel = imageModels.find(({ id }) => id === imageModelId) ?? imageModels[0];
  const voiceModels = models("audio");
  const voiceModel = voiceModels.find(({ id }) => id === voiceModelId) ?? voiceModels[0];
  const voiceJobs = jobs.filter(({ purpose }) => purpose === "character-voice");
  const imageJobs = jobs.filter(({ kind }) => kind === "image");
  const latestJob = voiceJobs[0];
  const voicePrompt = voicePromptOverride ?? latestJob?.voicePrompt ?? "";
  const imageJob = imageJobs[0];
  const voiceBusy = submitting || voiceJobs.some(({ status }) => !jobIsTerminal(status));
  const imageBusy = submitting || imageJobs.some(({ status }) => !jobIsTerminal(status));
  const imageText = (imagePrompt ?? draft.description).trim();
  const canGenerateImage = !imageBusy && imageModel && imageText;
  const canGenerateVoice =
    !voiceBusy && voiceModel && voicePrompt.trim() && latestJob?.status !== "outcome_unknown";
  const voicePlugin = settings.plugins.find(({ hash }) => hash === voiceModel?.pluginHash);
  const voiceOptions =
    voiceModel &&
    modelGenerationOptions(
      "audio",
      voicePlugin?.origin === "builtin" ? voicePlugin.key : undefined,
      voiceModel.model,
      voiceModel.channel,
      voiceModel.config,
    );
  const acceptsImage = !!voiceOptions?.references.image && !voiceOptions.referenceNeedsURL("image");
  const dependency = jobs.find(({ id }) => id === latestJob?.afterImageJobId);
  const source = dependency?.outputs[0];
  const retryImageId =
    latestJob?.status === "failed" &&
    dependency?.bound &&
    source?.kind === "image" &&
    source.assetId === assetId &&
    source.assetId === primary &&
    acceptsImage
      ? dependency.id
      : undefined;
  const images = assets.filter(
    (asset) =>
      asset.mediaType === "image" &&
      (asset.availability === "ready" ||
        asset.assetId === primary ||
        draft.extraAssetIds.includes(asset.assetId)),
  );
  const audio = assets.filter(
    (asset) =>
      asset.mediaType === "audio" &&
      (asset.availability === "ready" || asset.assetId === draft.voice?.assetId),
  );
  const valid = Boolean(draft.name.trim() && draft.look.trim());
  const currentVoice = audio.find(
    ({ assetId, availability }) => assetId === draft.voice?.assetId && availability === "ready",
  );
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function submitGeneration(includeImage: boolean, includeVoice: boolean) {
    if (
      (includeImage && !canGenerateImage) ||
      (includeVoice && !canGenerateVoice) ||
      (includeImage && includeVoice && !acceptsImage)
    )
      return;
    setSubmitting(true);
    setGenerationError("");
    try {
      const error = await generate(
        includeImage && imageModel ? { prompt: imageText, provider: imageModel } : undefined,
        includeVoice && voiceModel
          ? {
              prompt: voicePrompt.trim(),
              provider: voiceModel,
              ...(!includeImage && retryImageId ? { afterImageJobId: retryImageId } : {}),
            }
          : undefined,
      );
      setGenerationError(error ?? "");
      if (!error && includeImage) setPrimary(undefined);
    } catch {
      setGenerationError("暂时无法提交生成，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="image-doodle-dialog image-outpaint-dialog"
      aria-labelledby="character-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) close();
      }}
    >
      <header>
        <h2 id="character-title">角色卡</h2>
        <button type="button" aria-label="关闭角色卡" disabled={submitting} onClick={close}>
          <X size={18} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !submitting)
            save(
              { ...draft, name: draft.name.trim(), look: draft.look.trim() },
              primary || undefined,
            );
        }}
      >
        <div className="outpaint-fields">
          <label>
            角色名
            <input
              required
              maxLength={64}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            形象名
            <input
              required
              maxLength={64}
              value={draft.look}
              onChange={(event) => setDraft({ ...draft, look: event.target.value })}
            />
          </label>
          <label className="outpaint-full">
            角色设定
            <textarea
              rows={3}
              maxLength={500}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label>
            主图
            <select
              value={primary}
              onChange={(event) => {
                const next = event.target.value;
                setPrimary(next);
                setDraft({
                  ...draft,
                  extraAssetIds: draft.extraAssetIds.filter((id) => id !== next),
                });
              }}
            >
              <option value="">未绑定</option>
              {images.map((asset) => (
                <option key={asset.assetId} value={asset.assetId}>
                  {asset.displayName}
                  {asset.availability === "missing" ? "（待定位）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            音色
            <select
              value={draft.voice?.assetId ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  voice: event.target.value ? { assetId: event.target.value } : undefined,
                })
              }
            >
              <option value="">未绑定</option>
              {audio.map((asset) => (
                <option key={asset.assetId} value={asset.assetId}>
                  {asset.displayName}
                  {asset.availability === "missing" ? "（待定位）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="outpaint-full">
            补充图（{draft.extraAssetIds.length}/4）
            <select
              value=""
              disabled={draft.extraAssetIds.length >= 4}
              onChange={(event) => {
                if (event.target.value)
                  setDraft({
                    ...draft,
                    extraAssetIds: [...draft.extraAssetIds, event.target.value],
                  });
              }}
            >
              <option value="">添加素材</option>
              {images
                .filter(
                  (asset) =>
                    asset.availability === "ready" &&
                    asset.assetId !== primary &&
                    !draft.extraAssetIds.includes(asset.assetId),
                )
                .map((asset) => (
                  <option key={asset.assetId} value={asset.assetId}>
                    {asset.displayName}
                  </option>
                ))}
            </select>
          </label>
          {draft.extraAssetIds.length > 0 && (
            <ul className="character-extras outpaint-full">
              {draft.extraAssetIds.map((id) => {
                const label =
                  assets.find((asset) => asset.assetId === id)?.displayName ?? "素材缺失";
                return (
                  <li key={id}>
                    <span>{label}</span>
                    <button
                      type="button"
                      aria-label={`移除补充图 ${label}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          extraAssetIds: draft.extraAssetIds.filter((value) => value !== id),
                        })
                      }
                    >
                      <X size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <fieldset className="outpaint-fields storyboard-batch">
          <legend>形象生成</legend>
          <label className="outpaint-full">
            形象提示词
            <textarea
              rows={2}
              maxLength={3000}
              value={imagePrompt ?? draft.description}
              onChange={(event) => setImagePrompt(event.target.value)}
            />
          </label>
          <label>
            形象模型
            <select
              value={imageModel?.id ?? ""}
              disabled={imageBusy}
              onChange={(event) => setImageModelId(event.target.value)}
            >
              {!imageModel && <option value="">请在模型设置中启用图片模型</option>}
              {imageModels.map(({ id, config, label, model }) => (
                <option key={id} value={id}>
                  {config?.name ?? model} · {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!canGenerateImage}
            onClick={() => void submitGeneration(true, false)}
          >
            生成形象
          </button>
          {imageJob && (
            <p className="outpaint-full storyboard-batch-hint" role="status">
              形象 · {generationStatuses[imageJob.status]}
              {imageJob.status === "succeeded" && !imageJob.bound && " · 结果已保留在素材库"}
            </p>
          )}
        </fieldset>
        <fieldset className="outpaint-fields storyboard-batch">
          <legend>音色生成</legend>
          <label className="outpaint-full">
            音色描述或示例台词
            <textarea
              rows={2}
              maxLength={3000}
              value={voicePrompt}
              onChange={(event) => setVoicePrompt(event.target.value)}
            />
          </label>
          <label>
            音色模型
            <select
              value={voiceModel?.id ?? ""}
              disabled={voiceBusy}
              onChange={(event) => setVoiceModelId(event.target.value)}
            >
              {!voiceModel && <option value="">请在模型设置中启用音频模型</option>}
              {voiceModels.map(({ id, config, label, model }) => (
                <option key={id} value={id}>
                  {config?.name ?? model} · {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="settings-primary"
            disabled={!canGenerateVoice}
            onClick={() => void submitGeneration(false, true)}
          >
            {submitting
              ? "正在提交…"
              : latestJob?.status === "failed"
                ? "重试生成音色"
                : "生成音色"}
          </button>
          <button
            type="button"
            className="outpaint-full"
            title={!acceptsImage && voiceModel ? "请选择支持内嵌图片参考的音色模型" : undefined}
            disabled={!canGenerateImage || !canGenerateVoice || !acceptsImage}
            onClick={() => void submitGeneration(true, true)}
          >
            生成形象并生成音色
          </button>
          {voiceModel && !acceptsImage && (
            <small className="outpaint-full storyboard-batch-hint">
              联合生成需要支持内嵌图片参考的音色模型。
            </small>
          )}
          {latestJob && (
            <p className="outpaint-full storyboard-batch-hint" role="status">
              {latestJob.error === "JOB_IMAGE_DEPENDENCY_FAILED"
                ? "本次形象未能用作主图参考，音色未发送。可单独生成音色，或重新联合生成。"
                : latestJob.status === "queued" && latestJob.afterImageJobId
                  ? "等待形象生成并绑定主图"
                  : `音色 · ${generationStatuses[latestJob.status]}`}
              {latestJob.status === "outcome_unknown" && " · 请在生成任务中核对原任务。"}
            </p>
          )}
          {generationError && (
            <p className="outpaint-full image-doodle-error" role="alert">
              {generationError}
            </p>
          )}
          {currentVoice && (
            <button type="button" onClick={() => preview(currentVoice)}>
              试听已选音色
            </button>
          )}
          {voiceJobs.some(({ outputs }) => outputs.length > 0) && (
            <ul className="character-extras outpaint-full" aria-label="音色历史">
              {voiceJobs.flatMap((job) =>
                job.outputs.flatMap((output) => {
                  if (output.kind !== "audio") return [];
                  const asset = audio.find(({ assetId }) => assetId === output.assetId);
                  if (!asset) return [];
                  return [
                    <li key={`${job.id}:${asset.assetId}`}>
                      <span>
                        {job.model} · {asset.displayName}
                      </span>
                      <button
                        type="button"
                        disabled={asset.availability !== "ready"}
                        onClick={() => preview(asset)}
                      >
                        试听
                      </button>
                      <button
                        type="button"
                        disabled={
                          asset.availability !== "ready" || draft.voice?.assetId === asset.assetId
                        }
                        onClick={() =>
                          setDraft((current) => ({ ...current, voice: { assetId: asset.assetId } }))
                        }
                      >
                        {draft.voice?.assetId === asset.assetId ? "已选音色" : "采用音色"}
                      </button>
                    </li>,
                  ];
                }),
              )}
            </ul>
          )}
        </fieldset>
        <footer>
          <button type="button" disabled={submitting} onClick={close}>
            取消
          </button>
          <button type="submit" className="settings-primary" disabled={!valid || submitting}>
            保存角色
          </button>
        </footer>
      </form>
    </dialog>
  );
}
