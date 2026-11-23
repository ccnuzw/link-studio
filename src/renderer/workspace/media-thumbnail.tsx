import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useLocalPreviewResult } from "./character-card-body";
import { ImagePlaceholderShape, VideoPlaceholderShape } from "./media-node-placeholder";
import "./media-thumbnail.css";

export function MediaThumbnail({
  handle,
  assetId,
  video,
}: {
  handle: string;
  assetId?: string;
  video: boolean;
}) {
  const url = useLocalPreviewResult(handle, assetId, video ? "poster" : undefined),
    reduce = useReducedMotion();
  const [state, setState] = useState<"pending" | "loaded" | "failed">("pending");
  const ease = [0.2, 0, 0, 1] as const;
  if (!assetId || url === null || state === "failed")
    return video ? (
      <span className="version-image-error version-poster-error">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <VideoPlaceholderShape />
        </svg>
      </span>
    ) : (
      <div className="version-image-error" role="img" aria-label="图片加载失败">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <ImagePlaceholderShape />
        </svg>
      </div>
    );
  return (
    <div className={video ? "version-image version-poster" : "version-image"}>
      {url && (
        <motion.img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          initial={false}
          animate={{ opacity: state === "loaded" ? 1 : 0 }}
          transition={{ duration: reduce && !video ? 0 : 0.18, ease }}
          onError={() => setState("failed")}
          onLoad={() => setState("loaded")}
          ref={(element) => {
            if (element?.complete && element.naturalWidth) setState("loaded");
          }}
        />
      )}
      <AnimatePresence>
        {state === "pending" && (
          <motion.div
            data-slot="media-skeleton"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.18, ease, delay: 0.15 } }}
            exit={{ opacity: 0, transition: { duration: 0.126, ease } }}
          >
            {!reduce && <div className="version-image-sheen" />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
