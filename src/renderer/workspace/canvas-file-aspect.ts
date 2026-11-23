export function canvasFileAspect(
  file: File,
  kind: "image" | "video" | "audio",
): Promise<number | undefined> {
  if (kind === "audio") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = kind === "image" ? new Image() : document.createElement("video");
    const finish = (width = 0, height = 0) => {
      clearTimeout(timer);
      media.onerror = null;
      if (media instanceof HTMLVideoElement) {
        media.onloadedmetadata = null;
        media.removeAttribute("src");
        media.load();
      } else {
        media.onload = null;
        media.removeAttribute("src");
      }
      URL.revokeObjectURL(url);
      resolve(width > 0 && height > 0 ? width / height : undefined);
    };
    const timer = window.setTimeout(finish, 3000);
    media.onerror = () => finish();
    if (media instanceof HTMLVideoElement) {
      media.preload = "metadata";
      media.onloadedmetadata = () => finish(media.videoWidth, media.videoHeight);
    } else media.onload = () => finish(media.naturalWidth, media.naturalHeight);
    media.src = url;
  });
}
