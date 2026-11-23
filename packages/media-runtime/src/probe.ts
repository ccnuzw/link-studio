import { MediaError, type ProcessOptions, runMediaProcess } from "./process.ts";

export interface MediaStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  side_data_list?: { rotation?: number }[];
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  pix_fmt?: string;
  start_time?: string;
}
export function videoDisplayAspect(stream: MediaStream) {
  if (stream.codec_type !== "video" || !stream.width || !stream.height) return undefined;
  const sample = /^(\d+):(\d+)$/.exec(stream.sample_aspect_ratio ?? "");
  const numerator = Number(sample?.[1]),
    denominator = Number(sample?.[2]);
  const scale = numerator > 0 && denominator > 0 ? numerator / denominator : 1;
  const width = Math.round(stream.width * Math.max(1, scale));
  const height = Math.round(stream.height / Math.min(1, scale));
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
    return undefined;
  const rotation =
    stream.side_data_list?.find((side) => typeof side.rotation === "number")?.rotation ?? 0;
  return Math.abs(rotation) % 180 === 90 ? height / width : width / height;
}
export interface MediaProbe {
  streams: MediaStream[];
  duration: number;
  formatName: string;
}

export async function probeMedia(
  ffprobe: string,
  path: string,
  options: ProcessOptions & { inputFormat?: string } = {},
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
      ...(options.inputFormat ? ["-f", options.inputFormat] : []),
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
