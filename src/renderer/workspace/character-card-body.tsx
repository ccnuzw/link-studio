import { type CanvasCharacter, characterVoice, type GenerationJob } from "@link-studio/core";
import { AudioLines, Ellipsis, FolderOpen, Loader2, Pause, Play, Plus, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { imageTaskTitle, MediaGenerationTask } from "./character-image-task";
import { useCharacterVoice } from "./character-voice-player";
import "./character-card-body.css";

export function useLocalPreviewResult(
  projectHandle?: string,
  assetId?: string,
  variant?: "poster" | "thumb",
) {
  const [preview, setPreview] = useState<{
    projectHandle: string;
    assetId: string;
    variant?: "poster" | "thumb";
    url: string | null;
  }>();
  useEffect(() => {
    if (!projectHandle || !assetId) return;
    let active = true;
    const settle = (url: string | null) => {
      if (active) setPreview({ projectHandle, assetId, variant, url });
    };
    void window.desktop.projects
      .getAssetPreview({ projectHandle, assetId, ...(variant && { variant }) })
      .then(
        (result) => settle(result.ok ? result.value.url : null),
        () => settle(null),
      );
    return () => {
      active = false;
    };
  }, [projectHandle, assetId, variant]);
  return preview &&
    preview.projectHandle === projectHandle &&
    preview.assetId === assetId &&
    preview.variant === variant
    ? preview.url
    : undefined;
}

export function useLocalPreview(projectHandle?: string, assetId?: string) {
  return useLocalPreviewResult(projectHandle, assetId) ?? undefined;
}

function CharacterImage({
  projectHandle,
  assetId,
  alt,
}: {
  projectHandle?: string;
  assetId: string;
  alt: string;
}) {
  const url = useLocalPreview(projectHandle, assetId);
  return url ? <img src={url} alt={alt} draggable={false} /> : null;
}

function VoiceCell({
  projectHandle,
  assetId,
  name,
}: {
  projectHandle?: string;
  assetId: string;
  name?: string;
}) {
  const { playing, toggle } = useCharacterVoice(projectHandle, assetId);
  return (
    <button
      type="button"
      className="character-cell voice nodrag nopan"
      title={name || "声音"}
      aria-label={`${playing ? "暂停试听" : "试听声音"}${name ? `：${name}` : ""}`}
      aria-pressed={playing}
      onClick={(event) => {
        event.stopPropagation();
        void toggle();
      }}
    >
      {playing ? <Pause /> : <Play />}
      {name && <small>{name}</small>}
    </button>
  );
}

export function CharacterCardBody({
  character,
  voiceAssetName,
  projectHandle,
  mainId,
  aspect,
  disabled,
  voicePending,
  upload,
  library,
  edit,
  imageJob,
  taskAction,
}: {
  character: CanvasCharacter;
  voiceAssetName?: string;
  projectHandle?: string;
  mainId?: string;
  aspect: number;
  disabled: boolean;
  voicePending: boolean;
  upload: () => void;
  library: (extra: boolean) => void;
  edit: () => void;
  imageJob?: GenerationJob;
  taskAction: () => Promise<void>;
}) {
  const title = imageTaskTitle(imageJob);
  const tag = title
    ? imageJob?.status === "failed"
      ? "生成失败"
      : "生成中"
    : mainId
      ? undefined
      : "待补充";
  return (
    <div className="character-card-body">
      <div className="character-cover" style={{ aspectRatio: aspect }}>
        {title && imageJob ? (
          <MediaGenerationTask
            key={imageJob.id}
            job={imageJob}
            disabled={disabled}
            action={taskAction}
          />
        ) : mainId ? (
          <CharacterImage projectHandle={projectHandle} assetId={mainId} alt={character.name} />
        ) : (
          <>
            <button type="button" className="nodrag nopan" disabled={disabled} onClick={upload}>
              <Upload />
              上传
            </button>
            <button
              type="button"
              className="nodrag nopan"
              disabled={disabled}
              aria-label="从资产库选主图"
              onClick={() => library(false)}
            >
              <FolderOpen />
              资产库
            </button>
            <span>或选中后在下方直接生成</span>
          </>
        )}
      </div>
      <div className="character-media-row">
        {character.voice && !voicePending ? (
          <VoiceCell
            key={character.voice.assetId}
            projectHandle={projectHandle}
            assetId={character.voice.assetId}
            name={
              character.voice.name ||
              characterVoice(
                character.voice.assetId,
                character.voice.origin ?? "library",
                voiceAssetName,
              ).name
            }
          />
        ) : (
          <button
            type="button"
            className={`character-cell nodrag nopan${voicePending ? " voice" : ""}`}
            title={voicePending ? "声音生成中…" : "还没有声音，点开详情设置"}
            aria-label="声音：打开详情设置"
            onClick={edit}
          >
            {voicePending ? <Loader2 className="shot-split-spinner" /> : <AudioLines />}
          </button>
        )}
        {character.extraAssetIds.map((assetId) => (
          <span className="character-cell" key={assetId}>
            <CharacterImage projectHandle={projectHandle} assetId={assetId} alt="" />
          </span>
        ))}
        {character.extraAssetIds.length < 4 && (
          <button
            type="button"
            className="character-cell nodrag nopan"
            disabled={disabled}
            title={`添加补充图（${character.extraAssetIds.length}/4）`}
            aria-label="添加补充图"
            onClick={() => library(true)}
          >
            <Plus />
          </button>
        )}
      </div>
      <div className="character-look-row">
        <b title={character.look}>{character.look}</b>
        {tag && <span data-task={title && imageJob?.status}>{tag}</span>}
        <button
          type="button"
          className="nodrag nopan"
          title="编辑角色卡（双击节点也可以）"
          aria-label="编辑角色卡"
          onClick={edit}
        >
          <Ellipsis />
        </button>
      </div>
    </div>
  );
}
