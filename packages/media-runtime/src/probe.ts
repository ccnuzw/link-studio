import { MediaError, type ProcessOptions, runMediaProcess } from "./process.ts";

export interface MediaStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  pix_fmt?: string;
  start_time?: string;
}
export interface MediaProbe {
  streams: MediaStream[];
  duration: number;
  formatName: string;
}

export async function probeMedia(
  ffprobe: string,
  path: string,
  options: ProcessOptions = {},
): Promise<MediaProbe> {
  const raw = await runMediaProcess(
    ffprobe,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-max_alloc",
      "67108864",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ],
    { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000) },
  );
  try {
    const value = JSON.parse(raw.toString("utf8"));
    const duration = Number(value.format?.duration);
    if (!Array.isArray(value.streams) || !Number.isFinite(duration) || duration <= 0)
      throw new Error();
    return { streams: value.streams, duration, formatName: String(value.format.format_name) };
  } catch {
    throw new MediaError("EXPORT_MEDIA_UNSUPPORTED");
  }
}
