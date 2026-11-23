import { useEffect, useState } from "react";

export function framePreview(video: HTMLVideoElement, height: number) {
  if (!video.videoWidth || !video.videoHeight) throw new Error("读不出视频画面");
  const canvas = document.createElement("canvas");
  canvas.height = Math.min(height, video.videoHeight);
  canvas.width = Math.max(
    1,
    Math.min(1024, Math.round((canvas.height * video.videoWidth) / video.videoHeight)),
  );
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法读取视频帧");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}

type FilmCell = { slot: number; src: string };
const strips = new Map<string, FilmCell[]>();
export function useFrameFilmstrip(url: string) {
  const [thumbs, setThumbs] = useState<FilmCell[]>(() => strips.get(url) ?? []);
  useEffect(() => {
    const cached = strips.get(url);
    if (cached) {
      setThumbs(cached);
      return;
    }
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    const result: FilmCell[] = [];
    const next = () => {
      video.currentTime = Math.min(
        video.duration - 0.001,
        Math.max(0, Math.round(((video.duration * (result.length + 0.5)) / 16) * 100) / 100),
      );
    };
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0.001) next();
    };
    video.onseeked = () => {
      try {
        result.push({ slot: result.length, src: framePreview(video, 96) });
      } catch {
        return;
      }
      if (result.length < 16) next();
      else {
        strips.set(url, result);
        const oldest = strips.keys().next().value;
        if (strips.size > 8 && oldest) strips.delete(oldest);
        setThumbs(result);
      }
    };
    video.src = url;
    return () => {
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [url]);
  return thumbs;
}

export function frameClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
