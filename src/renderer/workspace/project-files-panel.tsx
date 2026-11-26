import type { ImportStatus, ProjectAsset } from "@link-studio/core";
import {
  AudioLines,
  CircleAlert,
  Film,
  FolderOpen,
  FolderPlus,
  Image,
  LibraryBig,
  Plus,
  Search,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { previewBytes } from "./canvas-preview-items";
import { useLocalPreviewResult } from "./character-card-body";
import "./project-files-panel.css";

type MediaType = ProjectAsset["mediaType"];
type ImportMode = ProjectAsset["importMode"];
const media = {
  image: { title: "图片", icon: Image },
  video: { title: "视频", icon: Film },
  audio: { title: "音频", icon: AudioLines },
} as const;
const mediaTypes = ["image", "video", "audio"] as const;
const pageSize = 24;

type ItemActions = {
  preview: (asset: ProjectAsset) => void;
  add: (asset: ProjectAsset) => void;
  relocate: (asset: ProjectAsset) => void;
  remove: (asset: ProjectAsset) => void;
  extract: (asset: ProjectAsset) => void;
  enroll: (asset: ProjectAsset) => void;
};

function FileCover({ asset, projectHandle }: { asset: ProjectAsset; projectHandle: string }) {
  const Icon = media[asset.mediaType].icon;
  const ready = asset.availability === "ready";
  const url = useLocalPreviewResult(
    projectHandle,
    ready && asset.mediaType !== "audio" ? asset.assetId : undefined,
    asset.mediaType === "video" ? "poster" : "thumb",
  );
  const [failed, setFailed] = useState<string>();
  return (
    <span className="project-file-cover" data-kind={asset.mediaType} aria-hidden="true">
      <Icon size={21} />
      {ready && url && url !== failed && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(url)}
        />
      )}
    </span>
  );
}

function FileCard({
  asset,
  projectHandle,
  targetKind,
  busy,
  canAdd,
  actions,
}: {
  asset: ProjectAsset;
  projectHandle: string;
  targetKind?: MediaType;
  busy: boolean;
  canAdd: boolean;
  actions: ItemActions;
}) {
  const { displayName, metadata } = asset;
  const ready = asset.availability === "ready";
  const size = previewBytes(asset.sizeBytes) || "0 B";
  const detail =
    metadata.width && metadata.height
      ? `${metadata.width}×${metadata.height}`
      : metadata.durationMs
        ? `${(Number(metadata.durationMs) / 1000).toFixed(1)} 秒`
        : undefined;
  const addLabel = targetKind ? "用于节点" : "加入画布";
  const canEnroll =
    ready && !targetKind && asset.mediaType === "image" && metadata.filingEnabled === true;
  const enrolled =
    canEnroll && typeof metadata.filingHumanName === "string"
      ? metadata.filingHumanName
      : undefined;
  return (
    <article className="asset-item project-file-card" aria-label={displayName}>
      <div className="project-file-overview">
        <FileCover asset={asset} projectHandle={projectHandle} />
        <div className="project-file-details">
          <strong title={displayName}>{displayName}</strong>
          <span>
            {detail ? `${media[asset.mediaType].title} · ${detail}` : media[asset.mediaType].title}
          </span>
        </div>
      </div>
      <div className="project-file-meta">
        <span>
          {asset.importMode === "reference" ? "外部引用" : "项目副本"} · {size}
        </span>
        {!ready && (
          <span className="project-file-unavailable">
            <CircleAlert size={13} />
            文件不可用
          </span>
        )}
        {enrolled && (
          <span>
            <UserRound size={12} />
            真人 · {enrolled}
          </span>
        )}
      </div>
      <div className="project-file-actions">
        {ready && (
          <>
            <button
              type="button"
              data-emphasis="add"
              disabled={busy || !canAdd}
              aria-label={`将${displayName}${addLabel}`}
              onClick={() => actions.add(asset)}
            >
              <Plus size={14} aria-hidden="true" />
              {addLabel}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`预览${displayName}`}
              onClick={() => actions.preview(asset)}
            >
              预览
            </button>
            {asset.mediaType === "video" && (
              <button
                type="button"
                disabled={busy}
                aria-label={`提取${displayName}关键帧`}
                onClick={() => actions.extract(asset)}
              >
                提取帧
              </button>
            )}
            {canEnroll && enrolled === undefined && (
              <button type="button" disabled={busy} onClick={() => actions.enroll(asset)}>
                加入真人库
              </button>
            )}
          </>
        )}
        {asset.importMode === "reference" && (
          <button
            type="button"
            data-emphasis={ready ? undefined : "add"}
            disabled={busy}
            aria-label={`重新定位${displayName}`}
            onClick={() => actions.relocate(asset)}
          >
            重新定位
          </button>
        )}
        <button
          type="button"
          className="project-file-remove"
          disabled={busy}
          aria-label={`移除${displayName}`}
          onClick={() => actions.remove(asset)}
        >
          移除
        </button>
      </div>
    </article>
  );
}

export function ProjectFilesPanel({
  projectHandle,
  assets,
  hidden,
  targetKind,
  importMode,
  busy,
  importing,
  canAdd,
  changeImportMode,
  importFiles,
  close,
  actions,
  createFolder,
  manageLibrary,
  progress,
  duplicate,
  notice,
  error,
  children,
}: {
  projectHandle: string;
  assets: ProjectAsset[];
  hidden?: boolean;
  targetKind?: MediaType;
  importMode: ImportMode;
  busy: boolean;
  importing: boolean;
  canAdd: boolean;
  changeImportMode: (mode: ImportMode) => void;
  importFiles: () => void;
  close: () => void;
  actions: ItemActions;
  createFolder: () => void;
  manageLibrary: () => void;
  progress?: { name: string; status: ImportStatus; cancelling: boolean; cancel: () => void };
  duplicate?: {
    displayName: string;
    resolve: (choice: "reuse" | "independent" | "cancel") => void;
  } | null;
  notice?: string;
  error?: string;
  children?: ReactNode;
}) {
  const [filter, setFilter] = useState<MediaType | "all">("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(pageSize);
  const available = targetKind ? assets.filter((asset) => asset.mediaType === targetKind) : assets;
  const kind = targetKind ?? filter;
  const query = search.trim().toLowerCase();
  const visible = available.filter(
    (asset) =>
      (kind === "all" || asset.mediaType === kind) &&
      (!query || asset.displayName.toLowerCase().includes(query)),
  );
  const importState = progress?.status;
  const active = importState?.phase === "copying" || importState?.phase === "committing";

  return (
    <section className="project-files-panel" aria-label="项目文件" hidden={hidden}>
      {!hidden && (
        <>
          <header className="project-files-header">
            <span className="project-files-mark" aria-hidden="true">
              <FolderOpen size={19} />
            </span>
            <div>
              <h2>项目文件</h2>
              <p>{targetKind ? `选择${media[targetKind].title}素材` : "此画布项目中的本地文件"}</p>
            </div>
            <button
              type="button"
              className="project-files-close"
              aria-label="关闭项目文件"
              title="关闭项目文件"
              disabled={importing}
              onClick={close}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </header>
          <div className="project-files-toolbar">
            <label className="project-files-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索项目素材"
                placeholder="按文件名搜索"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setLimit(pageSize);
                }}
              />
            </label>
            <div className="project-files-import">
              <select
                aria-label="导入方式"
                title="导入方式"
                value={importMode}
                disabled={busy}
                onChange={(event) =>
                  changeImportMode(event.target.value === "reference" ? "reference" : "copy")
                }
              >
                <option value="copy">复制到项目</option>
                <option value="reference">引用外部文件</option>
              </select>
              <button type="button" data-emphasis="primary" disabled={busy} onClick={importFiles}>
                <Upload size={15} aria-hidden="true" />
                {importing ? "正在导入…" : "导入素材"}
              </button>
            </div>
          </div>
          <div className="project-files-filter">
            {!targetKind && (
              <fieldset data-ui-group className="project-files-types" aria-label="素材类型">
                <button
                  type="button"
                  aria-pressed={filter === "all"}
                  onClick={() => {
                    setFilter("all");
                    setLimit(pageSize);
                  }}
                >
                  全部
                </button>
                {mediaTypes.map((type) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={filter === type}
                    onClick={() => {
                      setFilter(type);
                      setLimit(pageSize);
                    }}
                  >
                    {media[type].title}
                  </button>
                ))}
              </fieldset>
            )}
            <span className="project-files-count" role="status">
              {visible.length === available.length
                ? `${available.length} 项`
                : `${visible.length} / ${available.length} 项`}
            </span>
          </div>
          {(notice || error || active || duplicate) && (
            <div className="project-files-feedback">
              {notice && (
                <p className="project-files-message" role="status">
                  {notice}
                </p>
              )}
              {error && (
                <p className="project-files-message" role="alert">
                  {error}
                </p>
              )}
              {progress && active && (
                <div className="project-files-message project-files-progress">
                  <span>
                    {progress.name} ·{" "}
                    {importState.phase === "committing"
                      ? "正在提交"
                      : importMode === "reference"
                        ? "正在校验"
                        : "正在复制"}
                  </span>
                  <progress
                    aria-label="素材导入进度"
                    max={importState.totalBytes || 1}
                    value={importState.totalBytes ? importState.copiedBytes : undefined}
                  />
                  <button type="button" disabled={progress.cancelling} onClick={progress.cancel}>
                    {progress.cancelling ? "正在取消…" : "取消此文件"}
                  </button>
                </div>
              )}
              {duplicate && (
                <fieldset
                  data-ui-group
                  className="project-files-message project-files-duplicate"
                  aria-label="处理重复素材"
                >
                  <strong role="status">{duplicate.displayName} 已存在</strong>
                  <div>
                    <button
                      type="button"
                      data-emphasis="add"
                      onClick={() => duplicate.resolve("reuse")}
                    >
                      复用现有素材
                    </button>
                    <button type="button" onClick={() => duplicate.resolve("independent")}>
                      保留独立记录
                    </button>
                    <button type="button" onClick={() => duplicate.resolve("cancel")}>
                      跳过此文件
                    </button>
                  </div>
                </fieldset>
              )}
            </div>
          )}
          <div className="project-files-body">
            {visible.length > 0 ? (
              <div className="project-files-grid">
                {visible.slice(0, limit).map((asset) => (
                  <FileCard
                    key={asset.assetId}
                    asset={asset}
                    projectHandle={projectHandle}
                    targetKind={targetKind}
                    canAdd={canAdd}
                    busy={busy}
                    actions={actions}
                  />
                ))}
              </div>
            ) : (
              !importing && (
                <div className="project-files-empty">
                  {available.length ? (
                    <Search size={21} aria-hidden="true" />
                  ) : (
                    <FolderOpen size={21} aria-hidden="true" />
                  )}
                  <strong>
                    {available.length
                      ? "没有匹配的素材"
                      : `还没有${targetKind ? media[targetKind].title : "项目"}素材`}
                  </strong>
                  <p>
                    {available.length
                      ? "试试其他文件名，或切换素材类型。"
                      : `导入本地${targetKind ? media[targetKind].title : "图片、视频或音频"}后，即可在画布中使用。`}
                  </p>
                </div>
              )
            )}
            {visible.length > limit && (
              <button
                type="button"
                className="project-files-more"
                onClick={() => setLimit((current) => current + pageSize)}
              >
                显示更多素材
              </button>
            )}
          </div>
          {!targetKind && (
            <footer className="project-files-footer">
              <button type="button" onClick={manageLibrary}>
                <LibraryBig size={15} aria-hidden="true" />
                管理个人资产库
              </button>
              <button type="button" onClick={createFolder}>
                <FolderPlus size={15} aria-hidden="true" />
                新建资产库文件夹
              </button>
            </footer>
          )}
        </>
      )}
      {children}
    </section>
  );
}
