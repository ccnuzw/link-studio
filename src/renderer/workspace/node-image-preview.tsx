import { useStore } from "@xyflow/react";
import { useState } from "react";
import { useLocalPreviewResult } from "./character-card-body";

export function NodeImagePreview({
  handle,
  id,
  selected,
  alt,
}: {
  handle: string;
  id: string;
  selected: boolean;
  alt: string;
}) {
  const band = useStore((state) =>
    !state.panZoom
      ? "initial"
      : state.transform[2] < 0.55
        ? "low"
        : state.transform[2] >= 0.65
          ? "high"
          : "hold",
  );
  const [low, setLow] = useState(band === "low");
  if ((band === "low" || band === "high") && low !== (band === "low")) setLow(band === "low");
  const thumb = useLocalPreviewResult(handle, id, "thumb");
  const [thumbState, setThumbState] = useState("pending"),
    [fullState, setFullState] = useState("pending");
  const showFull =
    selected || (band !== "initial" && !low) || thumb === null || thumbState === "failed";
  const full = useLocalPreviewResult(showFull ? handle : undefined, id);
  const broken =
    (full === null || fullState === "failed") && (thumb === null || thumbState === "failed");
  return (
    <div
      role="img"
      aria-label={alt}
      className="canvas-image-layers"
      aria-busy={!broken && thumbState !== "loaded" && (!showFull || fullState !== "loaded")}
    >
      {broken ? (
        "图片加载失败"
      ) : (
        <>
          {thumb && thumbState !== "failed" && !(showFull && full && fullState === "loaded") && (
            <img
              src={thumb}
              alt={showFull && full && fullState !== "failed" ? "" : alt}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setThumbState("failed")}
              onLoad={() => setThumbState("loaded")}
            />
          )}
          {showFull && full && fullState !== "failed" && (
            <img
              src={full}
              style={{ opacity: fullState === "loaded" ? 1 : 0 }}
              alt={alt}
              loading="lazy"
              decoding="async"
              draggable={false}
              onLoad={() => setFullState("loaded")}
              onError={() => setFullState("failed")}
            />
          )}
        </>
      )}
    </div>
  );
}
