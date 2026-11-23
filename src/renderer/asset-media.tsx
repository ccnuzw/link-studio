import type { ComponentProps } from "react";

type Caption = { src: string; language: string; label: string };

function captionTrack(caption?: Caption) {
  return (
    caption && (
      <track
        kind="captions"
        src={caption.src}
        srcLang={caption.language}
        label={caption.label}
        default
      />
    )
  );
}

export function AssetVideo({
  caption,
  children,
  ...props
}: ComponentProps<"video"> & { caption?: Caption }) {
  return (
    <video {...props}>
      {captionTrack(caption)}
      {children}
    </video>
  );
}

export function AssetAudio({
  caption,
  children,
  ...props
}: ComponentProps<"audio"> & { caption?: Caption }) {
  return (
    <audio {...props}>
      {captionTrack(caption)}
      {children}
    </audio>
  );
}
