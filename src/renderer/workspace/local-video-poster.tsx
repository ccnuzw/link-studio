import { useEffect, useState } from "react";

export function LocalVideoPoster({
  assetId,
  projectHandle,
  library = false,
  onSettledChange,
}: {
  assetId: string;
  projectHandle: string;
  library?: boolean;
  onSettledChange?: (settled: boolean) => void;
}) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let current = true;
    setImage(undefined);
    onSettledChange?.(false);
    const settle = (url?: string) => {
      if (!current) return;
      setImage(url);
      if (!url) onSettledChange?.(true);
    };
    void window.desktop.projects
      .getAssetPreview({
        projectHandle,
        assetId,
        variant: "poster",
        ...(library && { library: true }),
      })
      .then(
        (result) => settle(result.ok ? result.value.url : undefined),
        () => settle(),
      );
    return () => {
      current = false;
    };
  }, [assetId, projectHandle, onSettledChange, library]);
  if (image)
    return (
      <img
        className="local-video-poster"
        src={image}
        alt=""
        draggable={false}
        onLoad={() => onSettledChange?.(true)}
        onError={() => {
          setImage(undefined);
          onSettledChange?.(true);
        }}
      />
    );
  return (
    <span className="local-video-placeholder">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h9.6A2.2 2.2 0 0 1 17 7.2v9.6A2.2 2.2 0 0 1 14.8 19H5.2A2.2 2.2 0 0 1 3 16.8V7.2Z" />
        <path d="m19.4 9.3 1.6-1.1v7.6l-1.6-1.1a1.6 1.6 0 0 1-.7-1.3v-2.8c0-.5.3-1 .7-1.3Z" />
      </svg>
    </span>
  );
}
