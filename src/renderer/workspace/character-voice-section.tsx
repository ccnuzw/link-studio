import type { CanvasCharacter, GenerationJob, ProjectAsset, ProviderView } from "@link-studio/core";
import {
  AlertCircle,
  AudioLines,
  Check,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  Upload,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useCharacterVoice } from "./character-voice-player";
import "./character-voice-section.css";

function shortTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || "-";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const bars = [0.45, 0.8, 0.55, 1, 0.65, 0.9, 0.4, 0.7, 0.5];

function PlayButton({
  handle,
  id,
  primary,
  disabled,
}: {
  handle: string;
  id: string;
  primary?: boolean;
  disabled?: boolean;
}) {
  const { playing, toggle } = useCharacterVoice(handle, id);
  return (
    <motion.button
      type="button"
      className="voice-chrome-button"
      data-primary={primary}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      aria-label={playing ? "暂停" : "试听"}
      aria-pressed={playing}
      onClick={() => void toggle()}
    >
      {playing ? <Pause /> : <Play />}
    </motion.button>
  );
}

function HistoryRow({
  handle,
  job,
  voice,
  assets,
  model,
  use,
}: {
  handle: string;
  job: GenerationJob;
  voice?: string;
  assets: ProjectAsset[];
  model: string;
  use: (id: string) => void;
}) {
  const output =
    job.status === "succeeded" && job.outputs.find((output) => output.kind === "audio");
  const assetId = output && output.kind === "audio" && output.assetId;
  const disabled =
    !!assetId &&
    !assets.some((asset) => asset.assetId === assetId && asset.availability === "ready");
  const current = !!assetId && assetId === voice;
  const failed =
    job.status === "failed" ||
    job.status === "outcome_unknown" ||
    (job.status === "succeeded" && !assetId);
  const busy = !failed && !assetId && job.status !== "cancelled";
  const status = failed
    ? job.errorMessage ||
      (job.status === "succeeded"
        ? "没有生成出音频"
        : job.status === "outcome_unknown"
          ? "生成结果待核对"
          : "生成失败")
    : busy
      ? `生成中${Number.isFinite(job.progress) ? ` ${job.progress}%` : ""}`
      : job.status === "cancelled"
        ? "已取消"
        : "";
  const chars = [...(job.voicePrompt ?? "").replace(/\s+/g, " ").trim()];
  const prompt = chars.slice(0, 40).join("") + (chars.length > 40 ? "…" : "");
  return (
    <li data-current={current || undefined}>
      {assetId ? (
        <PlayButton handle={handle} id={assetId} disabled={disabled} />
      ) : (
        <span className="voice-history-icon" data-failed={failed || undefined}>
          {busy ? <Loader2 /> : <AlertCircle />}
        </span>
      )}
      <div className="voice-history-info">
        {prompt && <p title={prompt}>{prompt}</p>}
        <small>
          {model} · {shortTime(job.createdAt)}
        </small>
        {status && (
          <small data-failed={failed || undefined} title={status}>
            {status}
          </small>
        )}
      </div>
      {current ? (
        <span className="voice-current-mark">
          <Check />
          当前
        </span>
      ) : (
        assetId && (
          <motion.button
            type="button"
            disabled={disabled}
            whileTap={disabled ? undefined : { scale: 0.96 }}
            className="voice-chrome-button"
            onClick={() => use(assetId)}
          >
            设为音色
          </motion.button>
        )
      )}
    </li>
  );
}

export function CharacterVoiceSection({
  handle,
  voice,
  jobs,
  assets,
  providers,
  uploading,
  upload,
  library,
  adopt,
  children,
}: {
  handle: string;
  voice?: CanvasCharacter["voice"];
  jobs: GenerationJob[];
  assets: ProjectAsset[];
  providers: ProviderView[];
  uploading: boolean;
  upload: () => void;
  library: () => void;
  adopt: (id: string) => void;
  children?: ReactNode;
}) {
  const { playing } = useCharacterVoice(handle, voice?.assetId);
  const current = voice && assets.find((asset) => asset.assetId === voice.assetId);
  return (
    <section className="character-voice-section" aria-label="声音">
      <div className="voice-panel-heading">
        <AudioLines />
        <h3>声音</h3>
        <div className="character-image-actions">
          <button type="button" disabled={uploading} aria-label="上传声音" onClick={upload}>
            {uploading ? <Loader2 /> : <Upload />}
            {uploading ? "上传中" : "上传"}
          </button>
          <span aria-hidden="true" />
          <button type="button" onClick={library}>
            <FolderOpen />
            绑定已有
          </button>
        </div>
      </div>
      <div className="voice-version-card">
        <div className="voice-current-wrap">
          <div className="voice-current-row" data-asset-id={voice?.assetId}>
            {voice ? (
              <>
                <PlayButton
                  handle={handle}
                  id={voice.assetId}
                  primary
                  disabled={current?.availability !== "ready"}
                />
                <span
                  className="voice-current-bars"
                  aria-hidden="true"
                  data-playing={playing || undefined}
                >
                  {bars.map((height, index) => (
                    <i
                      key={height}
                      style={{ height: `${height * 100}%`, animationDelay: `${index * 90}ms` }}
                    />
                  ))}
                </span>
                <span className="voice-origin">
                  {voice.origin
                    ? { upload: "上传", generated: "AI 生成", library: "素材库" }[voice.origin]
                    : "音频"}
                </span>
              </>
            ) : (
              <p>还没有声音</p>
            )}
          </div>
        </div>
        {jobs.length > 0 && (
          <ul aria-label="历史版本">
            {jobs.map((job) => (
              <HistoryRow
                key={job.id}
                handle={handle}
                job={job}
                voice={voice?.assetId}
                assets={assets}
                model={
                  providers.find((provider) => provider.id === job.providerId)?.config?.name ||
                  job.model
                }
                use={adopt}
              />
            ))}
          </ul>
        )}
      </div>
      {children}
    </section>
  );
}
