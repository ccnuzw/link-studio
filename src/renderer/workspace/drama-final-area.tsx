import type { DramaDocument } from "@link-studio/core";
import { Clapperboard, Download, Film } from "lucide-react";
import { useRef, useState } from "react";
import type { DramaAssetEditor } from "./drama-asset-browser";
import { playableClips } from "./drama-playback";
import { TakeVideo } from "./drama-take-carousel";
import { LocalVideoPoster } from "./local-video-poster";

export function DramaFinalArea({
  doc,
  episode,
  editor,
  projectHandle,
  saved,
  studio,
  select,
}: {
  doc: DramaDocument;
  episode: DramaDocument["episodes"][number];
  editor: DramaAssetEditor;
  projectHandle: string;
  saved: (doc: DramaDocument) => void;
  studio: (segmentId?: string) => void;
  select: (no: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submitting = useRef(false);
  const no = episode.episode_no;
  const segments = (doc.segments ?? [])
    .filter((item) => item.episode_no === no)
    .sort((a, b) => a.seq - b.seq);
  const clips = playableClips(segments, editor.jobs, editor.assets);
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const skipped = segments.filter((item) => !item.chosen_task_id).length;
  const invalid = segments.length - skipped - clips.length;
  const seconds = Math.round(clips.reduce((total, clip) => total + clip.duration, 0));
  const latest = doc.jobs
    ?.filter((job) => job.step === "compose" && job.episodes.includes(no))
    .at(-1);
  const running = latest?.status === "queued" || latest?.status === "running";
  const final = episode.final_asset_id;
  const stale = (episode.final_segment_version ?? 0) !== (episode.segment_version ?? 0);
  const others = doc.episodes.filter((item) => item.episode_no !== no && item.final_asset_id);
  const reason = invalid
    ? "采用的视频不可用，请到片场重新采用。"
    : !clips.length
      ? "请先在片场采用至少一个视频版本。"
      : "";
  async function perform(exporting: boolean) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (exporting && final) {
        const result = await window.desktop.projects.saveAssetCopy({
          projectHandle,
          assetId: final,
        });
        if (!result.ok) throw Error(result.error.message || result.error.code);
        if (result.value.saved) setMessage("MP4 已导出");
      } else {
        const result = await window.desktop.projects.drama({
          projectHandle,
          compose: {
            episodeNo: no,
            episodeOrder: doc.episode_order ?? 0,
            operationId: crypto.randomUUID(),
          },
        });
        if (!result.ok || !result.value)
          throw Error(result.ok ? "短剧不存在" : result.error.message || result.error.code);
        saved(result.value);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="dp-final">
      <section className="dp-final-preview" aria-label="本集成片">
        <small>
          第 {no} 集 · {episode.title}
        </small>
        {final ? (
          <>
            <header className="dp-paper-head">
              <h3>{stale ? "成片已过期，可重新合成" : "成片已合成"}</h3>
              <button
                type="button"
                className="dp-action"
                disabled={busy}
                onClick={() => void perform(true)}
              >
                <Download size={15} />
                导出 MP4
              </button>
            </header>
            <div
              className="dp-screen"
              style={{ aspectRatio: (doc.ratio || "9:16").replace(":", " / ") }}
            >
              <TakeVideo key={final} asset={{ projectHandle, assetId: final }} />
            </div>
          </>
        ) : (
          <div className="dp-empty">
            <Film size={36} />
            <h3>第 {no} 集还没有成片</h3>
            <p>
              {clips.length
                ? "已采用的视频可以按片段顺序合成整集。"
                : "先生成分镜，再在片场采用要放进成片的视频。"}
            </p>
            <button type="button" className="dp-action" onClick={() => studio()}>
              去片场
            </button>
          </div>
        )}
        {!!others.length && (
          <div className="dp-other">
            <h4>其他集成片</h4>
            {others.map((item) => (
              <button
                type="button"
                key={item.episode_no}
                className="dp-action"
                aria-label={`第 ${item.episode_no} 集成片`}
                onClick={() => select(item.episode_no)}
              >
                <LocalVideoPoster projectHandle={projectHandle} assetId={item.final_asset_id!} />第{" "}
                {item.episode_no} 集
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="dp-compose" aria-label="合成整集">
        <h3>
          <Clapperboard size={18} /> 合成整集
        </h3>
        <p>按片段顺序拼接采用的版本，统一到项目比例 · 不扣积分</p>
        <div className="dp-compose-body">
          <div className="dp-stats">
            {[
              [`${clips.length}/${segments.length}`, "已采用片段"],
              [`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`, "成片时长"],
              [final ? (stale ? "过期" : "最新") : "—", "成片状态"],
            ].map(([value, label]) => (
              <div key={label}>
                <strong>{value}</strong>
                <small>{label}</small>
              </div>
            ))}
          </div>
          {skipped > 0 && (
            <p className="dp-skipped">
              片段{" "}
              {segments
                .filter((item) => !item.chosen_task_id)
                .map((item) => String(item.seq + 1).padStart(2, "0"))
                .join("、")}{" "}
              尚未采用视频，合成时会跳过。{" "}
              <button
                type="button"
                className="dp-link"
                onClick={() => studio(segments.find((item) => !item.chosen_task_id)?.id)}
              >
                去补齐
              </button>
            </p>
          )}
          <ol>
            {segments.map((segment) => {
              const clip = byId.get(segment.id);
              return (
                <li key={segment.id}>
                  {clip ? (
                    <LocalVideoPoster projectHandle={projectHandle} assetId={clip.assetId} />
                  ) : (
                    <Film size={20} />
                  )}
                  <b>
                    片段 {String(segment.seq + 1).padStart(2, "0")}
                    <small>{segment.seconds}s</small>
                  </b>
                  <span>
                    {clip
                      ? "已采用"
                      : segment.chosen_task_id
                        ? "不可用"
                        : editor.jobs
                              .get(`seg:${segment.id}`)
                              ?.some((job) => ["running", "queued"].includes(job.status))
                          ? "生成中"
                          : "跳过"}
                  </span>
                </li>
              );
            })}
          </ol>
          {!segments.length && <p>这一集还没有片段</p>}
        </div>
        <footer>
          {running && <progress aria-label="合成进度" max={100} value={latest.progress ?? 0} />}
          <button
            type="button"
            className="dp-action dp-primary"
            disabled={busy || running || !!reason}
            onClick={() => void perform(false)}
          >
            {running ? `正在合成 ${latest.progress ?? 0}%` : final ? "重新合成" : `合成第 ${no} 集`}
          </button>
          <p role="status">
            {message ||
              (!running &&
                (latest?.status === "failed"
                  ? latest.error_message || "合成失败，请重试"
                  : reason))}
          </p>
        </footer>
      </section>
    </div>
  );
}
