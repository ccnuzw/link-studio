import type { ProjectAsset } from "@link-studio/core";
import { FolderOpen, Upload } from "lucide-react";

export function ImagePlaceholderShape() {
  return (
    <>
      <circle cx="7.5" cy="8" r="2" />
      <path d="M14.2 8.6 21 18H9.6l4.6-9.4Z" />
      <path d="M6.6 12.4 10.5 18H3l3.6-5.6Z" />
    </>
  );
}

export function VideoPlaceholderShape() {
  return (
    <>
      <path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h9.6A2.2 2.2 0 0 1 17 7.2v9.6A2.2 2.2 0 0 1 14.8 19H5.2A2.2 2.2 0 0 1 3 16.8V7.2Z" />
      <path d="m19.4 9.3 1.6-1.1v7.6l-1.6-1.1a1.6 1.6 0 0 1-.7-1.3v-2.8c0-.5.3-1 .7-1.3Z" />
    </>
  );
}

export function MediaNodePlaceholder({ kind }: { kind: ProjectAsset["mediaType"] }) {
  const label = `选中后输入提示词生成${{ image: "图片", video: "视频", audio: "音频" }[kind]}`;
  return (
    <div className="media-node-placeholder" role="img" aria-label={label}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        {kind === "image" ? (
          <ImagePlaceholderShape />
        ) : kind === "video" ? (
          <VideoPlaceholderShape />
        ) : (
          <>
            <rect x="2.6" y="10" width="2.4" height="4" rx="1.2" />
            <rect x="7" y="7" width="2.4" height="10" rx="1.2" />
            <rect x="11.4" y="4.2" width="2.4" height="15.6" rx="1.2" />
            <rect x="15.8" y="7" width="2.4" height="10" rx="1.2" />
            <rect x="20.2" y="10" width="2.4" height="4" rx="1.2" />
          </>
        )}
      </svg>
      <span>{label}</span>
    </div>
  );
}

export function MediaFillActions({
  disabled,
  upload,
  library,
}: {
  disabled: boolean;
  upload: () => void;
  library: () => void;
}) {
  return (
    <div className="media-fill-actions nodrag nopan">
      <button
        type="button"
        className="media-fill-button"
        disabled={disabled}
        aria-label="导入素材到节点"
        onClick={upload}
      >
        <Upload size={14} />
        上传
      </button>
      <span className="media-fill-divider" aria-hidden="true" />
      <button
        type="button"
        className="media-fill-button"
        disabled={disabled}
        aria-label="从资产库选取素材"
        onClick={library}
      >
        <FolderOpen size={14} />
        资产库
      </button>
    </div>
  );
}
