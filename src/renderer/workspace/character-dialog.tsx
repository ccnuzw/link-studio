import {
  type CanvasCharacter,
  type ChannelView,
  type GenerationJob,
  jobIsTerminal,
  type ProjectAsset,
  type ProviderView,
  type SettingsValues,
} from "@link-studio/core";
import { Loader2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { BackdropDialog } from "./backdrop-dialog";
import { canvasUploadKind } from "./canvas-upload-file";
import { type CharacterIdentityChange, CharacterIdentityFields } from "./character-identity-fields";
import { CharacterImageGallery } from "./character-image-gallery";
import type { CharacterPick, CharacterPurpose } from "./character-pick";
import { characterVoiceModel } from "./character-voice-model";
import { CharacterVoiceSection } from "./character-voice-section";
import { GenerationModelMenu } from "./generation-model-menu";
import { HumanPicker } from "./human-picker";
import type { ProviderSettings } from "./media-generation-draft";

type GenerationChoice = {
  prompt: string;
  provider: ProviderView;
  afterImageJobId?: string;
  referenceAssetIds?: string[];
};

export function CharacterDialog({
  character,
  episodes,
  changeIdentity,
  changeVoice,
  changeVoicePrompt,
  assetId,
  assets,
  projectHandle,
  uploadMedia,
  removeExtra,
  download,
  jobs,
  settings,
  changeVoiceModel,
  cancelVoice,
  importHuman,
  renderPicker,
  generate,
  close,
}: {
  character: CanvasCharacter;
  episodes?: number[] | null;
  changeIdentity: (patch: CharacterIdentityChange) => void;
  assetId?: string;
  assets: ProjectAsset[];
  projectHandle: string;
  download: (id: string) => void;
  uploadMedia: (slot: CharacterPurpose, file: File) => Promise<string | undefined>;
  changeVoice: (voice: CanvasCharacter["voice"]) => void;
  changeVoicePrompt: (voicePrompt: string) => void;
  removeExtra: (id: string) => void;
  jobs: GenerationJob[];
  settings: ProviderSettings;
  changeVoiceModel: (id: string) => void;
  cancelVoice: (job: GenerationJob) => Promise<string | undefined>;
  renderPicker: (
    request: CharacterPick,
    close: () => void,
    confirmed: (assets: ProjectAsset[]) => void,
  ) => ReactNode;
  importHuman: (channel: ChannelView, images: SettingsValues["filingAssets"]) => Promise<string[]>;
  generate: (voice: GenerationChoice) => Promise<string | undefined>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [purpose, setPurpose] = useState<CharacterPurpose>();
  const [pickingHuman, setPickingHuman] = useState(false);
  const voiceInput = useRef<HTMLInputElement>(null);
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const primary = assetId ?? "";
  const [submitting, setSubmitting] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const { voiceModels, voiceModel, acceptsImage, requiresImageURL } = characterVoiceModel(
    character,
    settings,
  );
  const voiceJobs = jobs.filter(({ purpose }) => purpose === "character-voice");
  const latestJob = voiceJobs[0];
  const voicePrompt = character.voicePrompt ?? "";
  const voiceBusy = submitting || voiceJobs.some(({ status }) => !jobIsTerminal(status));
  const dependency = jobs.find(({ id }) => id === latestJob?.afterImageJobId);
  const source = dependency?.outputs[0];
  const retryImageId =
    latestJob?.status === "failed" &&
    dependency?.bound &&
    source?.kind === "image" &&
    source.assetId === assetId &&
    source.assetId === primary &&
    !requiresImageURL
      ? dependency.id
      : undefined;
  const runningVoice = voiceJobs.find((job) => !jobIsTerminal(job.status));
  useEffect(() => {
    const element = dialog.current;
    element?.setAttribute("closedby", "any");
    element?.showModal();
    if (
      element?.querySelector(".character-detail-columns") === document.activeElement &&
      matchMedia("(pointer: fine)").matches
    ) {
      element
        ?.querySelector<HTMLButtonElement>(".character-image-gallery button:not(:disabled)")
        ?.focus({ preventScroll: true });
    }
    return () => element?.close();
  }, []);

  async function submitVoice() {
    if (voiceBusy || !voiceModel || !voicePrompt.trim() || latestJob?.status === "outcome_unknown")
      return;
    setSubmitting(true);
    setGenerationError("");
    try {
      if (primary && requiresImageURL) {
        setGenerationError("音色模型需要公网参考图地址");
        return;
      }
      const error = await generate({
        prompt: voicePrompt.trim(),
        provider: voiceModel,
        ...(retryImageId
          ? { afterImageJobId: retryImageId }
          : primary && acceptsImage
            ? { referenceAssetIds: [primary] }
            : {}),
      });
      setGenerationError(error ?? "");
    } catch {
      setGenerationError("暂时无法提交生成，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <BackdropDialog
        ref={dialog}
        className="image-doodle-dialog character-detail-dialog"
        aria-labelledby="character-title"
        aria-describedby="character-detail-description"
        isolateClicks
        onDoubleClick={(event) => event.stopPropagation()}
        onCancel={(event) => {
          event.preventDefault();
          if (!submitting) close();
        }}
      >
        <h2 className="character-detail-sr" id="character-title">
          角色卡详情
        </h2>
        <p className="character-detail-sr" id="character-detail-description">
          修改角色名称、形象名称、补充图和音色
        </p>
        <div className="character-detail-columns">
          <CharacterImageGallery
            handle={projectHandle}
            primary={primary}
            extras={character.extraAssetIds}
            name={character.name}
            assets={assets}
            human={() => setPickingHuman(true)}
            library={setPurpose}
            download={download}
            remove={removeExtra}
            upload={async (slot, file) => {
              await uploadMedia(slot, file);
            }}
          />
          <div className="character-detail-properties">
            <CharacterIdentityFields
              name={character.name}
              look={character.look}
              episodes={episodes}
              change={changeIdentity}
            />
            <CharacterVoiceSection
              handle={projectHandle}
              voice={character.voice}
              jobs={voiceJobs}
              assets={assets}
              providers={settings.providers}
              uploading={uploadingVoice}
              upload={() => voiceInput.current?.click()}
              library={() => setPurpose("voice")}
              adopt={(assetId) => changeVoice({ assetId, origin: "generated" })}
            >
              <div className="voice-composer">
                <label htmlFor="character-voice-prompt">AI 生成</label>
                <div className="voice-composer-input">
                  <textarea
                    id="character-voice-prompt"
                    maxLength={500}
                    value={voicePrompt}
                    disabled={voiceBusy}
                    onChange={(event) => changeVoicePrompt(event.target.value)}
                    placeholder="音色描述加一句试音台词，例如：年轻女声，偏低，语速慢，句尾轻：“我回来了。”"
                  />
                  <div className="voice-composer-tools">
                    <GenerationModelMenu
                      current={voiceModel}
                      models={voiceModels}
                      plugins={settings.plugins}
                      disabled={voiceBusy || !voiceModels.length}
                      status={settings.status ?? "ready"}
                      emptyLabel="没有音频模型"
                      container={dialog}
                      offline={false}
                      choose={(id) => {
                        changeVoiceModel(
                          voiceModels.find((model) => model.id === id)?.modelKey ?? id,
                        );
                        return false;
                      }}
                    />
                    {runningVoice ? (
                      <button
                        type="button"
                        className="voice-submit"
                        data-cancel
                        disabled={
                          runningVoice.cancelRequested ||
                          (runningVoice.status !== "queued" && !runningVoice.canCancelRemote)
                        }
                        onClick={async () => {
                          try {
                            setGenerationError((await cancelVoice(runningVoice)) ?? "");
                          } catch {
                            setGenerationError("无法取消生成，请重试。");
                          }
                        }}
                      >
                        <Loader2 />
                        {Number.isFinite(runningVoice.progress)
                          ? `${runningVoice.progress}% · 取消`
                          : "取消"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="voice-submit"
                        disabled={
                          submitting || !voiceModel || latestJob?.status === "outcome_unknown"
                        }
                        onClick={() => {
                          if (!voicePrompt.trim()) setGenerationError("还没有音色描述");
                          else void submitVoice();
                        }}
                      >
                        {latestJob?.status === "failed"
                          ? "重试"
                          : character.voice
                            ? "重新生成"
                            : "生成声音"}
                      </button>
                    )}
                  </div>
                </div>
                {(generationError || latestJob?.status === "failed") && (
                  <p className="voice-error" role="alert">
                    {generationError || latestJob?.errorMessage || "生成失败"}
                  </p>
                )}
              </div>
            </CharacterVoiceSection>
            <output className="character-detail-sr" aria-label="主图" data-asset-id={primary}>
              {assets.find((item) => item.assetId === primary)?.displayName ?? "未绑定"}
            </output>
            <input
              hidden
              type="file"
              ref={voiceInput}
              accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.flac,.opus"
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file || uploadingVoice) return;
                const result = canvasUploadKind(file);
                if ("error" in result || result.kind !== "audio") {
                  setGenerationError("error" in result ? result.error : "音色只能上传音频");
                  return;
                }
                setUploadingVoice(true);
                setGenerationError("");
                try {
                  if (!(await uploadMedia("voice", file)))
                    setGenerationError("无法上传声音，请重试。");
                } catch {
                  setGenerationError("无法上传声音，请重试。");
                } finally {
                  setUploadingVoice(false);
                }
              }}
            />
          </div>
        </div>
        <button
          type="button"
          className="character-detail-close"
          aria-label="关闭角色卡"
          disabled={submitting}
          onClick={close}
        >
          <X size={16} />
        </button>
        {pickingHuman && (
          <HumanPicker
            close={() => setPickingHuman(false)}
            apply={async (channel, images) => {
              const ids = await importHuman(channel, images);
              if (!ids.length) throw new Error("图片不可用");
            }}
          />
        )}
      </BackdropDialog>
      {purpose &&
        renderPicker(
          { purpose, primary, extras: character.extraAssetIds },
          () => setPurpose(undefined),
          () => setPurpose(undefined),
        )}
    </>
  );
}
