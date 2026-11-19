import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, stat, statfs } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { type MediaProbe, probeMedia } from "./probe.ts";
import { MediaError, runMediaProcess } from "./process.ts";

export interface MediaBinaries {
  ffmpeg: string;
  ffprobe: string;
}
export interface CompositionInput {
  videos: string[];
  bgm?: string;
  target: string;
  sourceVolume?: number;
  bgmVolume?: number;
  profile?: "m0-360p" | "hd-720p";
}
interface InputSnapshot {
  path: string;
  sha256: string;
  bytes: number;
  probe: MediaProbe;
}
export interface CompositionRecipe {
  exportId: string;
  profile: { id: string; width: number; height: number; fps: number; bitrate: number };
  sourceVolume: number;
  bgmVolume: number;
  sources: { sha256: string; bytes: number; duration: number }[];
  bgm?: { sha256: string; bytes: number };
  duration: number;
}
export interface ExportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onStage?: (stage: "prepared" | "encoding" | "validated") => void | Promise<void>;
  onProgress?: (seconds: number) => void;
}
const PROFILES = {
  "m0-360p": { id: "m0-360p", width: 640, height: 360, fps: 30, bitrate: 1_200_000 },
  "hd-720p": { id: "hd-720p", width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
} as const;
const MAX_INPUT_BYTES = 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const activeTargets = new Set<string>();

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaError("EXPORT_CANCELLED");
}

function gain(value: unknown, fallback: number): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0 || result > 2)
    throw new MediaError("EXPORT_RECIPE_INVALID");
  return result;
}

async function fsyncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash, { signal });
  return hash.digest("hex");
}

async function snapshotInput(
  path: string,
  destination: string,
  ffprobe: string,
  signal?: AbortSignal,
): Promise<InputSnapshot> {
  checkCancelled(signal);
  const descriptor = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await descriptor.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_INPUT_BYTES)
      throw new MediaError("EXPORT_MEDIA_UNSUPPORTED");
    await pipeline(
      descriptor.createReadStream({ autoClose: false, start: 0, end: before.size - 1 }),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    const after = await descriptor.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new MediaError("EXPORT_SOURCE_CHANGED");
    const probe = await probeMedia(ffprobe, destination, { signal });
    if (probe.duration > 600 || probe.streams.length > 16)
      throw new MediaError("EXPORT_MEDIA_UNSUPPORTED");
    return {
      path: destination,
      bytes: before.size,
      sha256: await hashFile(destination, signal),
      probe,
    };
  } finally {
    await descriptor.close();
  }
}

function filters(
  sources: InputSnapshot[],
  bgm: InputSnapshot | undefined,
  recipe: CompositionRecipe,
): string {
  const { width, height, fps } = recipe.profile;
  const graph: string[] = [];
  for (const [index, source] of sources.entries()) {
    const duration = source.probe.duration;
    graph.push(
      `[${index}:v:0]trim=duration=${duration},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${index}]`,
    );
    const audio = source.probe.streams.some((stream) => stream.codec_type === "audio");
    graph.push(
      `${audio ? `[${index}:a:0]` : "anullsrc=r=48000:cl=stereo,"}${audio ? "aresample=48000," : ""}aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`,
    );
  }
  graph.push(
    `${sources.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${sources.length}:v=1:a=1[video][sourceaudio]`,
  );
  graph.push(`[sourceaudio]volume=${recipe.sourceVolume}[sourcegain]`);
  if (bgm) {
    graph.push(
      `[${sources.length}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${recipe.duration},asetpts=PTS-STARTPTS,volume=${recipe.bgmVolume}[bgm]`,
    );
    graph.push(
      "[sourcegain][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[audio]",
    );
  } else graph.push("[sourcegain]anull[audio]");
  return graph.join(";");
}

export class MediaComposer {
  constructor(private readonly binaries: MediaBinaries) {}

  async export(input: CompositionInput, options: ExportOptions = {}) {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new MediaError("EXPORT_PLATFORM_UNSUPPORTED");
    const request = structuredClone(input);
    if (
      !Array.isArray(request.videos) ||
      !request.videos.length ||
      request.videos.length > 16 ||
      request.videos.some((path) => typeof path !== "string")
    )
      throw new MediaError("EXPORT_RECIPE_INVALID");
    const profile = structuredClone(PROFILES[request.profile ?? "hd-720p"]);
    if (
      !profile ||
      typeof request.target !== "string" ||
      extname(request.target).toLowerCase() !== ".mp4"
    )
      throw new MediaError("EXPORT_RECIPE_INVALID");
    const sourceVolume = gain(request.sourceVolume, 1);
    const bgmVolume = gain(request.bgmVolume, 0.25);
    const parent = await realpath(dirname(resolve(request.target)));
    const parentIdentity = await stat(parent);
    const target = join(parent, basename(request.target));
    if (activeTargets.has(target)) throw new MediaError("EXPORT_TARGET_BUSY");
    activeTargets.add(target);
    const localController = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, localController.signal])
      : localController.signal;
    const timer = setTimeout(() => localController.abort(), options.timeoutMs ?? 120_000);
    let temporary: string | undefined;
    let published = false;
    try {
      checkCancelled(signal);
      if (
        await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        })
      )
        throw new MediaError("EXPORT_TARGET_EXISTS");
      const filesystem = await statfs(parent);
      if (filesystem.type !== 26) throw new MediaError("EXPORT_FILESYSTEM_UNSUPPORTED");
      const freeBytes = filesystem.bavail * filesystem.bsize;
      let sourceBytes = 0;
      for (const path of [...request.videos, ...(request.bgm ? [request.bgm] : [])]) {
        const entry = await lstat(resolve(path)).catch(() => null);
        if (!entry) throw new MediaError("EXPORT_SOURCE_MISSING");
        if (!entry.isFile() || entry.size > MAX_INPUT_BYTES)
          throw new MediaError("EXPORT_MEDIA_UNSUPPORTED");
        sourceBytes += entry.size;
      }
      if (freeBytes < sourceBytes + 512 * 1024 * 1024) throw new MediaError("EXPORT_DISK_FULL");
      temporary = await mkdtemp(join(parent, ".link-studio-export-"));
      await mkdir(join(temporary, "inputs"));
      const sources: InputSnapshot[] = [];
      for (const [index, path] of request.videos.entries()) {
        const source = await snapshotInput(
          path,
          join(temporary, "inputs", `${index}.media`),
          this.binaries.ffprobe,
          signal,
        );
        const video = source.probe.streams.find((stream) => stream.codec_type === "video");
        if (!video?.width || !video.height || video.width * video.height > 3840 * 2160)
          throw new MediaError("EXPORT_MEDIA_UNSUPPORTED");
        const videoDuration = Number(video.duration);
        if (!Number.isFinite(videoDuration) || videoDuration <= 0 || videoDuration > 600)
          throw new MediaError("EXPORT_MEDIA_UNSUPPORTED");
        source.probe.duration = videoDuration;
        sources.push(source);
      }
      const bgm = request.bgm
        ? await snapshotInput(
            request.bgm,
            join(temporary, "inputs", "bgm.media"),
            this.binaries.ffprobe,
            signal,
          )
        : undefined;
      if (bgm && !bgm.probe.streams.some((stream) => stream.codec_type === "audio"))
        throw new MediaError("EXPORT_MEDIA_UNSUPPORTED");
      const duration = sources.reduce((sum, source) => sum + source.probe.duration, 0);
      if (
        duration > 600 ||
        freeBytes < sourceBytes + ((duration * profile.bitrate) / 8) * 2 + 64 * 1024 * 1024
      )
        throw new MediaError("EXPORT_RESOURCE_LIMIT");
      const recipe: CompositionRecipe = {
        exportId: randomUUID(),
        profile,
        sourceVolume,
        bgmVolume,
        duration,
        sources: sources.map((source) => ({
          sha256: source.sha256,
          bytes: source.bytes,
          duration: source.probe.duration,
        })),
        ...(bgm ? { bgm: { sha256: bgm.sha256, bytes: bgm.bytes } } : {}),
      };
      await options.onStage?.("prepared");
      checkCancelled(signal);
      const output = join(temporary, "output.mp4");
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-n",
        "-max_alloc",
        "67108864",
        "-filter_complex_threads",
        "1",
      ];
      for (const source of [...sources, ...(bgm ? [bgm] : [])])
        args.push("-protocol_whitelist", "file,pipe", "-threads", "2", "-i", source.path);
      args.push(
        "-filter_complex",
        filters(sources, bgm, recipe),
        "-map",
        "[video]",
        "-map",
        "[audio]",
        "-map_metadata",
        "-1",
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        "-b:v",
        String(profile.bitrate),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-t",
        String(duration),
        "-fs",
        String(MAX_OUTPUT_BYTES),
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-f",
        "mp4",
        output,
      );
      await options.onStage?.("encoding");
      let pendingProgress = "";
      await runMediaProcess(this.binaries.ffmpeg, args, {
        signal,
        timeoutMs: options.timeoutMs ?? 120_000,
        onProgress: (text) => {
          const lines = `${pendingProgress}${text}`.split("\n");
          pendingProgress = lines.pop() ?? "";
          for (const line of lines) {
            const match = /^out_time_us=(\d+)$/.exec(line.trim());
            if (match) options.onProgress?.(Number(match[1]) / 1_000_000);
          }
        },
      });
      const probe = await probeMedia(this.binaries.ffprobe, output, { signal });
      const video = probe.streams.find((stream) => stream.codec_type === "video");
      const audio = probe.streams.find((stream) => stream.codec_type === "audio");
      if (
        !probe.formatName.includes("mp4") ||
        video?.codec_name !== "h264" ||
        video.width !== profile.width ||
        video.height !== profile.height ||
        video.pix_fmt !== "yuv420p" ||
        audio?.codec_name !== "aac" ||
        audio.sample_rate !== "48000" ||
        audio.channels !== 2 ||
        Math.abs(Number(video.duration) - duration) > 0.15 ||
        Math.abs(Number(audio.duration) - duration) > 0.15 ||
        !Number.isFinite(Number(video.duration)) ||
        !Number.isFinite(Number(audio.duration)) ||
        Math.abs(probe.duration - duration) > 0.15 ||
        (await stat(output)).size >= MAX_OUTPUT_BYTES
      )
        throw new MediaError("EXPORT_MEDIA_INVALID");
      await runMediaProcess(
        this.binaries.ffmpeg,
        [
          "-v",
          "error",
          "-xerror",
          "-nostdin",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          output,
          "-f",
          "null",
          "-",
        ],
        { signal },
      );
      const sha256 = await hashFile(output, signal);
      await options.onStage?.("validated");
      checkCancelled(signal);
      const currentParent = await lstat(parent);
      if (
        currentParent.dev !== parentIdentity.dev ||
        currentParent.ino !== parentIdentity.ino ||
        currentParent.isSymbolicLink()
      )
        throw new MediaError("EXPORT_TARGET_CHANGED");
      const descriptor = await open(output, "r");
      try {
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      checkCancelled(signal);
      try {
        await link(output, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new MediaError("EXPORT_TARGET_EXISTS");
        throw error;
      }
      published = true;
      await fsyncDirectory(parent);
      return { target, sha256, recipe, probe };
    } catch (error) {
      if (published) throw new MediaError("EXPORT_COMMIT_UNKNOWN");
      if (signal.aborted)
        throw new MediaError(options.signal?.aborted ? "EXPORT_CANCELLED" : "EXPORT_TIMEOUT");
      if (error instanceof MediaError) throw error;
      throw new MediaError(
        (error as NodeJS.ErrnoException).code === "ENOSPC"
          ? "EXPORT_DISK_FULL"
          : "EXPORT_WORKER_FAILED",
      );
    } finally {
      clearTimeout(timer);
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      activeTargets.delete(target);
    }
  }
}
