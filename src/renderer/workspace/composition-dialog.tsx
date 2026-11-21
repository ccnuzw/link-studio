import type { ProjectAsset, ProjectExportProgress } from "@link-studio/core";
import { ArrowDown, ArrowUp, Music2, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type ExportResult = { asset: ProjectAsset; targetName: string };

export function CompositionDialog({
  assets,
  projectHandle,
  initialVideoIds,
  close,
  done,
}: {
  assets: ProjectAsset[];
  projectHandle: string;
  initialVideoIds: string[];
  close: () => void;
  done: (result: ExportResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [videoIds, setVideoIds] = useState(() =>
    initialVideoIds.filter((id, index) => initialVideoIds.indexOf(id) === index),
  );
  const [bgmAssetId, setBgmAssetId] = useState("");
  const [sourceVolume, setSourceVolume] = useState("1");
  const [bgmVolume, setBgmVolume] = useState("0.25");
  const [profile, setProfile] = useState<"m0-360p" | "hd-720p">("hd-720p");
  const [progress, setProgress] = useState<ProjectExportProgress>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operationId = useRef(crypto.randomUUID());
  const videoAssets = useMemo(
    () => assets.filter((asset) => asset.mediaType === "video" && asset.availability === "ready"),
    [assets],
  );
  const audioAssets = useMemo(
    () => assets.filter((asset) => asset.mediaType === "audio" && asset.availability === "ready"),
    [assets],
  );
  const selected = videoIds
    .map((id) => assets.find((asset) => asset.assetId === id))
    .filter((asset): asset is ProjectAsset => !!asset);

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    const dispose = window.desktop.projectEvents.onExportProgress((event) => {
      if (event.operationId === operationId.current) setProgress(event);
    });
    return dispose;
  }, []);

  const addVideo = (id: string) => {
    if (id && !videoIds.includes(id) && videoIds.length < 16) setVideoIds([...videoIds, id]);
  };
  const move = (index: number, offset: number) => {
    const next = [...videoIds];
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + offset, 0, item);
    setVideoIds(next);
  };
  const exportVideo = async () => {
    if (busy || videoIds.length === 0) return;
    setBusy(true);
    setError("");
    operationId.current = crypto.randomUUID();
    const current = await window.desktop.projects.flush({ projectHandle });
    if (!current.ok) {
      setError(current.error.message ?? "无法保存最新项目状态，请刷新后重试。");
      setBusy(false);
      return;
    }
    const result = await window.desktop.projects.exportComposition({
      projectHandle,
      operationId: operationId.current,
      expectedRevision: current.value.revision,
      videoAssetIds: videoIds,
      ...(bgmAssetId ? { bgmAssetId } : {}),
      sourceVolume: Number(sourceVolume),
      bgmVolume: Number(bgmVolume),
      profile,
    });
    if (result.ok) done({ asset: result.value.asset, targetName: result.value.targetName });
    else if (result.error.code !== "EXPORT_CANCELLED")
      setError(result.error.message ?? "导出未完成，请检查素材和磁盘空间后重试。");
    setBusy(false);
  };
  const cancel = async () => {
    if (!busy) return close();
    await window.desktop.projects.cancelMediaTool({
      projectHandle,
      operationId: operationId.current,
    });
  };
  return (
    <dialog
      ref={dialog}
      className="image-doodle-dialog composition-dialog"
      aria-labelledby="composition-title"
      onCancel={(event) => {
        event.preventDefault();
        void cancel();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">媒体输出</span>
          <h2 id="composition-title">预览与导出成片</h2>
        </div>
        <button type="button" aria-label="关闭导出成片" disabled={busy} onClick={close}>
          <X size={18} />
        </button>
      </header>
      <p className="composition-hint">
        选择视频镜头并调整顺序。导出会保留源素材不变，并把结果写回项目素材库。
      </p>
      <section className="composition-preview" aria-label="成片预览">
        {selected.length ? (
          selected.map((asset, index) => (
            <article key={asset.assetId}>
              <span>{index + 1}</span>
              <strong>{asset.displayName}</strong>
              <small>
                {Math.round(Number(asset.metadata.durationMs ?? 0) / 100) / 10 || "—"} 秒
              </small>
              <div>
                <button
                  type="button"
                  aria-label={`上移${asset.displayName}`}
                  disabled={!index || busy}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`下移${asset.displayName}`}
                  disabled={index === selected.length - 1 || busy}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`移除${asset.displayName}`}
                  disabled={busy}
                  onClick={() => setVideoIds(videoIds.filter((id) => id !== asset.assetId))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))
        ) : (
          <p>暂无视频镜头，请先在画布或素材库中准备视频。</p>
        )}
      </section>
      <label className="composition-add">
        <Plus size={15} />
        添加视频镜头
        <select
          aria-label="添加视频镜头"
          disabled={busy}
          value=""
          onChange={(event) => addVideo(event.target.value)}
        >
          <option value="">选择视频素材</option>
          {videoAssets
            .filter((asset) => !videoIds.includes(asset.assetId))
            .map((asset) => (
              <option key={asset.assetId} value={asset.assetId}>
                {asset.displayName}
              </option>
            ))}
        </select>
      </label>
      <div className="composition-fields">
        <label>
          背景音乐{" "}
          <span>
            <Music2 size={14} />
            <select
              aria-label="背景音乐"
              disabled={busy}
              value={bgmAssetId}
              onChange={(event) => setBgmAssetId(event.target.value)}
            >
              <option value="">不添加 BGM</option>
              {audioAssets.map((asset) => (
                <option key={asset.assetId} value={asset.assetId}>
                  {asset.displayName}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label>
          输出规格{" "}
          <select
            aria-label="输出规格"
            disabled={busy}
            value={profile}
            onChange={(event) => setProfile(event.target.value as typeof profile)}
          >
            <option value="hd-720p">HD · 1280×720</option>
            <option value="m0-360p">轻量 · 640×360</option>
          </select>
        </label>
        <label>
          源音量{" "}
          <input
            aria-label="源音量"
            type="number"
            min="0"
            max="2"
            step="0.05"
            disabled={busy}
            value={sourceVolume}
            onChange={(event) => setSourceVolume(event.target.value)}
          />
        </label>
        <label>
          BGM 音量{" "}
          <input
            aria-label="BGM 音量"
            type="number"
            min="0"
            max="2"
            step="0.05"
            disabled={busy || !bgmAssetId}
            value={bgmVolume}
            onChange={(event) => setBgmVolume(event.target.value)}
          />
        </label>
      </div>
      {progress && (
        <div className="composition-progress" role="status">
          <progress max="100" value={progress.progress} />
          <span>
            {progress.stage === "preparing"
              ? "准备素材…"
              : progress.stage === "encoding"
                ? "正在合成…"
                : progress.stage === "validating"
                  ? "校验输出…"
                  : progress.stage === "importing"
                    ? "写入素材库…"
                    : "已完成"}{" "}
            {progress.progress}%
          </span>
        </div>
      )}
      {error && (
        <p className="image-doodle-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={() => void cancel()}>
          {busy ? "取消导出" : "取消"}
        </button>
        <button
          type="button"
          className="settings-primary"
          disabled={busy || !videoIds.length}
          onClick={() => void exportVideo()}
        >
          {busy ? "正在导出…" : "选择位置并导出 MP4"}
        </button>
      </footer>
    </dialog>
  );
}
