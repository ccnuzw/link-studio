import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { DramaJobRecord } from "../../../packages/link-studio-core/src/drama.ts";
import {
  evenGridLines,
  GRID_MAX,
  gridBounds,
  validGridLines,
} from "../../../packages/link-studio-core/src/grid-split.ts";
import { imageDisplaySize } from "../../../packages/link-studio-core/src/image-display-size.ts";
import { probeMedia } from "../../../packages/media-runtime/src/probe.ts";
import { runMediaProcess } from "../../../packages/media-runtime/src/process.ts";
import type { AssetFiles, AssetRecord, MediaLocation } from "./asset-files.ts";
import type { AssetService } from "./assets.ts";
import { dramaDocument } from "./drama.ts";
import { recordDramaProgress } from "./drama-job.ts";
import { ProjectError } from "./errors.ts";
import { jpegDimensions } from "./jpeg-dimensions.ts";
import type { ProjectStore } from "./store.ts";

const imageLimit = 384 * 1024;
const videoLimit = 64 * 1024 * 1024;
const trimInputLimit = 512 * 1024 * 1024;
const trimOutputLimit = 256 * 1024 * 1024;
const imageMediaLimit = 64 * 1024 * 1024;
const annotationLimit = 64 * 1024 * 1024;
const splitPixelLimit = 24_000_000;
const splitFormats: Record<string, string> = {
  "image/png": "png_pipe",
  "image/jpeg": "jpeg_pipe",
  "image/webp": "webp_pipe",
};
const frameSide = 320;
const orientationFilters: Record<number, string> = {
  2: "hflip",
  3: "hflip,vflip",
  4: "vflip",
  5: "transpose=cclock_flip",
  6: "transpose=clock",
  7: "transpose=clock_flip",
  8: "transpose=cclock",
};

function pngChunk(type: string, bytes: Buffer) {
  const chunk = Buffer.alloc(bytes.length + 12);
  chunk.writeUInt32BE(bytes.length);
  chunk.write(type, 4, "ascii");
  bytes.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, bytes.length + 8)), bytes.length + 8);
  return chunk;
}

function encodeFrame(rgb: Buffer) {
  const stride = frameSide * 3;
  if (rgb.length !== frameSide * stride)
    throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "没有取到完整视频帧");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(frameSide);
  header.writeUInt32BE(frameSide, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc((stride + 1) * frameSide);
  for (let row = 0; row < frameSide; row++)
    rgb.copy(scanlines, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export class CanvasMedia {
  private readonly posterQueue = [Promise.resolve(), Promise.resolve()];
  private posterSlot = 0;
  private readonly posterCache = new Map<string, string>();
  private readonly pendingPosters = new Map<string, Promise<string>>();

  poster(
    store: Pick<ProjectStore, "directory" | "projectId">,
    asset: AssetRecord,
    variant: "poster" | "thumb" = "poster",
  ) {
    const thumbnail = variant === "thumb";
    if (
      (thumbnail
        ? asset.mediaType !== "image" || !splitFormats[asset.mimeType]
        : asset.mediaType !== "video") ||
      asset.availability !== "ready" ||
      asset.sizeBytes > (thumbnail ? imageMediaLimit : trimInputLimit)
    )
      throw new ProjectError("ASSET_READ_FAILED", "无法读取视频封面");
    const key = `${variant}:${asset.sha256}`;
    const existing = this.posterCache.get(key) ?? this.pendingPosters.get(key);
    if (existing) return existing;
    const slot = this.posterSlot++ % this.posterQueue.length;
    const task = this.posterQueue[slot]!.then(async () => {
      const directory = await mkdtemp(join(tmpdir(), "link-studio-poster-"));
      try {
        const source = join(directory, "source");
        await this.files.materialize(store, asset, source);
        const image = join(directory, "poster.png");
        await runMediaProcess(
          this.ffmpeg,
          [
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-max_alloc",
            "67108864",
            "-f",
            thumbnail
              ? splitFormats[asset.mimeType]!
              : asset.mimeType === "video/webm"
                ? "matroska"
                : "mov",
            "-i",
            source,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=w='min(576,iw)':h='min(576,ih)':force_original_aspect_ratio=decrease",
            "-threads",
            "1",
            "-c:v",
            "png",
            "-f",
            "image2",
            "-update",
            "1",
            image,
          ],
          { timeoutMs: 15000, maxStdoutBytes: 2 * 1024 * 1024, maxRssMiB: 384 },
        );
        const frame = await readFile(image);
        if (!frame.length) throw new ProjectError("ASSET_READ_FAILED", "无法读取视频封面");
        const url = `data:image/png;base64,${frame.toString("base64")}`;
        if (this.posterCache.size >= 32)
          this.posterCache.delete(this.posterCache.keys().next().value!);
        this.posterCache.set(key, url);
        return url;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }).finally(() => this.pendingPosters.delete(key));
    this.pendingPosters.set(key, task);
    this.posterQueue[slot] = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  constructor(
    private readonly files: AssetFiles,
    private readonly assets: AssetService,
    private readonly ffmpeg: string,
  ) {}

  async composeDrama(store: ProjectStore, job: DramaJobRecord, session: AbortSignal) {
    const input = job.compose_input;
    if (!input?.asset_ids.length) throw Error("转码失败：合成输入不可用");
    const signal = AbortSignal.any([session, AbortSignal.timeout(600_000)]);
    const directory = await mkdtemp(join(tmpdir(), "link-drama-compose-"));
    const args = ["-nostdin", "-v", "error"];
    const filters: string[] = [];
    const pads: string[] = [];
    const ratio = dramaDocument(store.snapshot)?.ratio;
    let dimensions =
      ratio === "9:16"
        ? "720:1280"
        : ratio === "16:9"
          ? "1280:720"
          : ratio === "4:3"
            ? "960:720"
            : "";
    try {
      for (const [index, assetId] of input.asset_ids.entries()) {
        const asset = store.snapshot.assets[assetId];
        if (asset?.availability !== "ready" || asset.mediaType !== "video")
          throw Error("下载失败：无法读取采用视频");
        const path = join(directory, `input-${index}`);
        await this.files.materialize(store, asset, path, signal).catch(() => {
          throw Error("下载失败：无法读取采用视频");
        });
        const format = asset.mimeType === "video/webm" ? "matroska" : "mov";
        const probe = await probeMedia(
          join(dirname(this.ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
          path,
          { signal, inputFormat: format },
        );
        const video = probe.streams.find((stream) => stream.codec_type === "video");
        if (!video?.width || !video.height) throw Error("转码失败：无法合成视频");
        dimensions ||= `${video.width}:${video.height}`;
        const duration = Number(video.duration) > 0 ? Number(video.duration) : probe.duration;
        args.push("-protocol_whitelist", "file", "-f", format, "-i", path);
        filters.push(
          `[${index}:v:0]scale=${dimensions}:force_original_aspect_ratio=decrease,pad=${dimensions}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${index}]`,
        );
        const audio = probe.streams.some((stream) => stream.codec_type === "audio")
          ? `[${index}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad`
          : "anullsrc=channel_layout=stereo:sample_rate=48000";
        filters.push(
          `${audio},atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS[a${index}]`,
        );
        pads.push(`[v${index}][a${index}]`);
        await recordDramaProgress(
          store,
          job.id,
          ((index + 1) * 40) / input.asset_ids.length,
          signal,
        );
      }
      filters.push(`${pads.join("")}concat=n=${pads.length}:v=1:a=1[video][audio]`);
      const output = join(directory, "final.mp4");
      await runMediaProcess(
        this.ffmpeg,
        [
          ...args,
          "-filter_complex",
          filters.join(";"),
          "-map",
          "[video]",
          "-map",
          "[audio]",
          "-c:v",
          "h264_videotoolbox",
          "-allow_sw",
          "1",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-video_track_timescale",
          "90000",
          "-movflags",
          "+faststart",
          output,
        ],
        { signal, timeoutMs: 600_000, maxRssMiB: 1024 },
      ).catch(() => {
        throw Error("转码失败：无法合成视频");
      });
      await recordDramaProgress(store, job.id, 80, signal);
      const handle = await open(output, "r");
      const staged = await this.assets
        .stage(store, handle, `第${job.episodes[0]}集成片.mp4`, randomUUID(), { signal })
        .finally(() => handle.close());
      try {
        staged.asset.origin = "derived";
        await store.updateGeneration(async (state) => {
          const document = dramaDocument(state);
          const task = document?.jobs?.find((entry) => entry.id === job.id);
          const episode = document?.episodes.find((entry) => entry.episode_no === job.episodes[0]);
          if (!document || !episode || task?.status !== "running")
            return { changed: false, result: null };
          await this.assets.publishBlob(store, staged, signal);
          state.assets[staged.asset.assetId] = staged.asset;
          episode.final_asset_id = staged.asset.assetId;
          episode.final_segment_version = input.segment_version;
          episode.revision = (episode.revision ?? 1) + 1;
          document.overview_revision ??= document.revision;
          document.revision++;
          task.final_asset_id = staged.asset.assetId;
          task.status = "succeeded";
          task.progress = 100;
          return { changed: true, result: null };
        }, signal);
      } finally {
        await this.assets.discard(staged);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async trim(
    store: ProjectStore,
    asset: AssetRecord,
    operationId: string,
    startMs: number,
    endMs: number,
    removeAudio: boolean,
    signal: AbortSignal,
  ) {
    if (asset.availability !== "ready" || asset.mediaType !== "video")
      throw new ProjectError("ASSET_NOT_FOUND", "只有可用的视频素材支持裁切");
    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      startMs < 0 ||
      endMs <= startMs ||
      (typeof asset.metadata.durationMs === "number" && endMs > asset.metadata.durationMs)
    )
      throw new ProjectError("VALIDATION_FAILED", "裁切范围无效");
    if (asset.sizeBytes > trimInputLimit)
      throw new ProjectError("ASSET_SIZE_LIMIT", "视频超过裁切大小限制");

    const directory = await mkdtemp(join(tmpdir(), "link-studio-trim-"));
    try {
      const source = join(directory, "source");
      const output = join(directory, "trimmed.mp4");
      await writeFile(source, await this.read(store, asset, trimInputLimit, signal), {
        mode: 0o600,
        signal,
      });
      const duration = (endMs - startMs) / 1000;
      const args = [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-ss",
        String(startMs / 1000),
        "-i",
        source,
        "-t",
        String(duration),
        "-map",
        "0:v:0",
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        "-pix_fmt",
        "yuv420p",
        ...(removeAudio ? [] : ["-map", "0:a?", "-c:a", "aac"]),
        "-movflags",
        "+faststart",
        output,
      ];
      await runMediaProcess(this.ffmpeg, args, {
        signal,
        timeoutMs: 120_000,
        maxStdoutBytes: 1024 * 1024,
        maxRssMiB: 768,
      }).catch((cause) => {
        if (signal.aborted) throw new ProjectError("ASSET_IMPORT_CANCELLED", "裁切已取消");
        throw new ProjectError("ASSET_READ_FAILED", "视频裁切失败", { cause });
      });
      signal.throwIfAborted();
      const outputStat = await lstat(output);
      if (!outputStat.isFile() || outputStat.size <= 0)
        throw new ProjectError("ASSET_READ_FAILED", "裁切没有生成有效视频");
      if (outputStat.size > trimOutputLimit)
        throw new ProjectError("ASSET_SIZE_LIMIT", "裁切结果超过 256 MiB 限制");
      const outputHandle = await open(output, "r");
      try {
        const staged = await this.assets.stage(
          store,
          outputHandle,
          `${asset.displayName.replace(/\.[^.]+$/, "")}-裁切.mp4`,
          operationId,
          { signal },
        );
        staged.asset.origin = "derived";
        Object.assign(staged.asset.metadata, {
          sourceAssetId: asset.assetId,
          trimStartMs: startMs,
          trimEndMs: endMs,
          ...(removeAudio ? { audioRemoved: true } : {}),
        });
        return staged;
      } finally {
        await outputHandle.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async split(
    store: ProjectStore,
    asset: AssetRecord,
    operationId: string,
    rows: number,
    columns: number,
    signal: AbortSignal,
    lines?: { x?: number[]; y?: number[] },
  ) {
    if (asset.availability !== "ready" || asset.mediaType !== "image")
      throw new ProjectError("ASSET_NOT_FOUND", "只有可用的图片素材支持拆图");
    if (
      !Number.isSafeInteger(rows) ||
      !Number.isSafeInteger(columns) ||
      rows < 1 ||
      rows > GRID_MAX ||
      columns < 1 ||
      columns > GRID_MAX ||
      rows * columns < 2
    )
      throw new ProjectError("VALIDATION_FAILED", "拆图网格至少需要 2 格，最大支持 5×5");
    const format = splitFormats[asset.mimeType];
    if (!format) throw new ProjectError("ASSET_TYPE_UNSUPPORTED", "此图片格式不支持拆图");
    const xLines = lines?.x ?? evenGridLines(columns);
    const yLines = lines?.y ?? evenGridLines(rows);
    if (!validGridLines(xLines, columns) || !validGridLines(yLines, rows))
      throw new ProjectError("VALIDATION_FAILED", "拆图分割线的位置无效");
    if (asset.sizeBytes > imageMediaLimit)
      throw new ProjectError("ASSET_SIZE_LIMIT", "图片超过拆图大小限制");
    const sourceBytes = await this.read(store, asset, imageMediaLimit, signal);
    const dimensions = asset.mimeType === "image/jpeg" ? jpegDimensions(sourceBytes) : undefined;
    const { width, height } = imageDisplaySize(dimensions ?? asset.metadata);
    const transform = orientationFilters[dimensions?.orientation ?? 1];
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < columns ||
      height < rows
    )
      throw new ProjectError("VALIDATION_FAILED", "图片尺寸不足以拆分当前网格");
    if (width * height > splitPixelLimit)
      throw new ProjectError("ASSET_SIZE_LIMIT", "拆图支持最多 2400 万像素的图片");
    const directory = await mkdtemp(join(tmpdir(), "link-studio-split-"));
    const staged: Awaited<ReturnType<AssetService["stage"]>>[] = [];
    try {
      const source = join(directory, "source");
      await writeFile(source, sourceBytes, {
        mode: 0o600,
        signal,
      });
      const xBounds = gridBounds(xLines, width);
      const yBounds = gridBounds(yLines, height);
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          signal.throwIfAborted();
          const left = xBounds[column] ?? 0;
          const right = xBounds[column + 1] ?? left;
          const top = yBounds[row] ?? 0;
          const bottom = yBounds[row + 1] ?? top;
          const tileWidth = right - left;
          const tileHeight = bottom - top;
          const factor = Math.min(1, 4096 / Math.max(tileWidth, tileHeight));
          const filters = [
            "format=rgba",
            transform,
            `crop=${tileWidth}:${tileHeight}:${left}:${top}:exact=1`,
          ];
          if (factor < 1) {
            const outputWidth = Math.max(1, Math.round(tileWidth * factor));
            const outputHeight = Math.max(1, Math.round(tileHeight * factor));
            filters.push(`scale=${outputWidth}:${outputHeight}:flags=bilinear`);
          }
          const output = join(directory, `tile-${row}-${column}.png`);
          await runMediaProcess(
            this.ffmpeg,
            [
              "-nostdin",
              "-xerror",
              "-v",
              "error",
              "-max_pixels",
              String(splitPixelLimit),
              "-noautorotate",
              "-f",
              format,
              "-i",
              source,
              "-vf",
              filters.filter(Boolean).join(","),
              "-frames:v",
              "1",
              "-c:v",
              "png",
              "-f",
              "image2",
              "-update",
              "1",
              output,
            ],
            {
              signal,
              timeoutMs: 30_000,
              maxRssMiB: 384,
            },
          ).catch((cause) => {
            if (signal.aborted) throw new ProjectError("ASSET_IMPORT_CANCELLED", "拆图已取消");
            throw new ProjectError("ASSET_READ_FAILED", "图片拆图失败", { cause });
          });
          const handle = await open(output, "r");
          try {
            const digest = createHash("sha256")
              .update(`split:${operationId}:${row}:${column}`)
              .digest("hex");
            const tileId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
            const tile = await this.assets.stage(
              store,
              handle,
              `grid-${row + 1}-${column + 1}.png`,
              tileId,
              { signal },
            );
            tile.asset.origin = "derived";
            Object.assign(tile.asset.metadata, {
              sourceAssetId: asset.assetId,
              splitRows: rows,
              splitColumns: columns,
              splitRow: row,
              splitColumn: column,
              splitX: left,
              splitY: top,
            });
            staged.push(tile);
          } finally {
            await handle.close();
          }
        }
      }
      return staged;
    } catch (cause) {
      await Promise.all(staged.map((item) => this.assets.discard(item)));
      if (signal.aborted) throw new ProjectError("ASSET_IMPORT_CANCELLED", "拆图已取消");
      throw cause;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async annotate(
    store: ProjectStore,
    asset: AssetRecord,
    operationId: string,
    pngData: string,
    signal: AbortSignal,
    purpose: "doodle" | "outpaint" = "doodle",
  ) {
    if (asset.availability !== "ready" || asset.mediaType !== "image")
      throw new ProjectError("ASSET_NOT_FOUND", "只有可用的图片素材支持涂鸦标注");
    await this.read(store, asset, imageMediaLimit, signal);
    const encoded = pngData.startsWith("data:image/png;base64,")
      ? pngData.slice("data:image/png;base64,".length)
      : pngData;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
      throw new ProjectError("VALIDATION_FAILED", "标注图片数据无效");
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > annotationLimit ||
      !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    )
      throw new ProjectError("ASSET_SIZE_LIMIT", "标注图片超过大小限制或不是 PNG");
    const directory = await mkdtemp(join(tmpdir(), "link-studio-annotate-"));
    try {
      const output = join(directory, "annotation.png");
      await writeFile(output, bytes, { mode: 0o600, signal });
      const handle = await open(output, "r");
      try {
        const staged = await this.assets.stage(
          store,
          handle,
          purpose === "outpaint"
            ? `${asset.displayName.replace(/\.[^.]+$/, "")}-扩图底图.png`
            : "doodle.png",
          operationId,
          { signal },
        );
        staged.asset.origin = "derived";
        Object.assign(staged.asset.metadata, {
          sourceAssetId: asset.assetId,
          annotation: purpose,
        });
        return staged;
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if (cause instanceof ProjectError) throw cause;
      throw new ProjectError("ASSET_READ_FAILED", "标注图片保存失败", { cause });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async read(store: MediaLocation, asset: AssetRecord, limit: number, signal: AbortSignal) {
    if (asset.sizeBytes > limit)
      throw new ProjectError("AGENT_MEDIA_LIMIT", "素材超过分析大小限制");
    const { handle } = await this.files.inspect(store, asset, true);
    try {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(asset.sizeBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (
        bytesRead !== buffer.length ||
        createHash("sha256").update(buffer).digest("hex") !== asset.sha256
      )
        throw new ProjectError("ASSET_REFERENCE_CHANGED", "素材内容已经变化");
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async videoInput(store: ProjectStore, asset: AssetRecord, signal: AbortSignal) {
    const bytes = await this.read(store, asset, 20 * 1024 * 1024, signal);
    return { mime_type: asset.mimeType, data: bytes.toString("base64") };
  }

  async readAudioForWaveform(store: MediaLocation, asset: AssetRecord) {
    if (asset.mediaType !== "audio" || asset.availability !== "ready")
      throw new ProjectError("ASSET_NOT_FOUND", "音频素材不可用");
    return this.read(store, asset, 50 * 1024 * 1024, new AbortController().signal);
  }

  async readClipboardImage(store: ProjectStore, asset: AssetRecord, signal: AbortSignal) {
    if (
      asset.mediaType !== "image" ||
      asset.availability !== "ready" ||
      !splitFormats[asset.mimeType]
    )
      throw new ProjectError("ASSET_NOT_FOUND", "图片素材不可用");
    return this.read(store, asset, imageMediaLimit, signal);
  }

  async attachment(
    store: ProjectStore,
    asset: AssetRecord,
    signal: AbortSignal,
    requestBudget = imageLimit,
  ) {
    if (asset.availability !== "ready")
      throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "素材不可用");
    const digest = createHash("sha256").update(`agent-attachment:${asset.assetId}`).digest("hex");
    const frameId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    let result: { assetId: string; mime: string; data: string };
    const limit = Math.min(requestBudget, imageLimit);
    if (asset.mediaType === "image" && asset.sizeBytes > limit) {
      const format = splitFormats[asset.mimeType];
      if (!format) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "不支持此图片格式");
      const directory = await mkdtemp(join(tmpdir(), "link-studio-agent-image-"));
      try {
        const source = join(directory, "source");
        await writeFile(source, await this.read(store, asset, imageMediaLimit, signal), {
          signal,
          mode: 0o600,
        });
        const image = join(directory, "preview.png");
        let data = "";
        for (const side of [1280, 768, 512, 320, 224]) {
          await runMediaProcess(
            this.ffmpeg,
            [
              "-nostdin",
              "-v",
              "error",
              "-y",
              "-protocol_whitelist",
              "file,pipe",
              "-max_pixels",
              "100000000",
              "-f",
              format,
              "-i",
              source,
              "-vf",
              `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`,
              "-frames:v",
              "1",
              "-threads",
              "1",
              "-c:v",
              "png",
              "-pix_fmt",
              "rgba",
              "-f",
              "image2",
              "-update",
              "1",
              image,
            ],
            { signal, timeoutMs: 15000, maxRssMiB: 384 },
          );
          const bytes = await readFile(image, { signal });
          if (bytes.length && bytes.length <= limit) {
            data = bytes.toString("base64");
            break;
          }
        }
        if (!data) throw new ProjectError("AGENT_MEDIA_LIMIT", "图片预览超过模型请求限制");
        result = { assetId: asset.assetId, mime: "image/png", data };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } else {
      result = await this.inspect(store, asset, 0, frameId, signal);
    }
    return {
      asset_id: result.assetId,
      kind: "image" as const,
      name: asset.displayName,
      mime_type: result.mime,
      byte_size: Buffer.byteLength(result.data, "base64"),
      url: `asset:${result.assetId}`,
      image: { mime_type: result.mime, data: result.data },
    };
  }

  async sampleVideo(store: ProjectStore, asset: AssetRecord, count: number, signal: AbortSignal) {
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 6 ||
      asset.mediaType !== "video" ||
      asset.availability !== "ready"
    )
      throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "请选择可用视频，抽取 1 到 6 帧");
    const directory = await mkdtemp(join(tmpdir(), "link-studio-video-preview-"));
    try {
      const source = join(directory, "source");
      await writeFile(source, await this.read(store, asset, videoLimit, signal), {
        mode: 0o600,
        signal,
      });
      const format = asset.mimeType === "video/webm" ? "matroska" : "mov";
      const probe = await probeMedia(
        join(dirname(this.ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
        source,
        { signal, inputFormat: format },
      );
      const track = probe.streams.find((stream) => stream.codec_type === "video");
      if (!track) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "素材缺少视频轨道");
      const duration = Number(track.duration) > 0 ? Number(track.duration) : probe.duration;
      const last = duration <= 0.2 ? duration / 2 : duration - 0.1;
      const frames = [];
      for (let index = 0; index < count; index++) {
        const at = count === 1 ? duration / 2 : (index * last) / (count - 1);
        const image = join(directory, "frame.png");
        for (const side of [1024, 512, 256]) {
          await runMediaProcess(
            this.ffmpeg,
            [
              "-nostdin",
              "-v",
              "error",
              "-y",
              "-protocol_whitelist",
              "file,pipe",
              "-max_alloc",
              "67108864",
              "-f",
              format,
              "-copyts",
              "-start_at_zero",
              "-noaccurate_seek",
              "-ss",
              String(at),
              "-i",
              source,
              "-map",
              "0:v:0",
              "-frames:v",
              "1",
              "-vf",
              `fps=fps=1000:start_time=${at}:round=up:eof_action=pass,scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`,
              "-threads",
              "1",
              "-c:v",
              "png",
              "-f",
              "image2",
              "-update",
              "1",
              image,
            ],
            { signal, timeoutMs: 15000, maxRssMiB: 384 },
          );
          const bytes = await readFile(image, { signal });
          await rm(image);
          if (bytes.length > imageLimit) continue;
          if (!bytes.length) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "未能提取预览帧");
          frames.push({ at, mime_type: "image/png", data: bytes.toString("base64") });
          break;
        }
        if (frames.length <= index)
          throw new ProjectError("AGENT_MEDIA_LIMIT", "预览帧超过模型请求限制");
      }
      return { duration, frames };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async inspect(
    store: ProjectStore,
    asset: AssetRecord,
    timeMs: number,
    frameId: string,
    signal: AbortSignal,
    fullFrame = false,
    collect?: (asset: AssetRecord) => void,
  ) {
    if (asset.mediaType === "image") {
      if (!["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType))
        throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "不支持此图片格式");
      const bytes = await this.read(store, asset, imageLimit, signal);
      return { assetId: asset.assetId, mime: asset.mimeType, data: bytes.toString("base64") };
    }

    const previous = store.snapshot.assets[frameId];
    if (
      previous?.availability === "ready" &&
      previous.origin === "derived" &&
      previous.metadata.sourceAssetId === asset.assetId &&
      previous.metadata.timeMs === timeMs
    ) {
      if (fullFrame) return { assetId: previous.assetId, mime: previous.mimeType, data: "" };
      const bytes = await this.read(store, previous, imageLimit, signal);
      return { assetId: previous.assetId, mime: previous.mimeType, data: bytes.toString("base64") };
    }
    if (
      previous ||
      (typeof asset.metadata.durationMs === "number" && timeMs >= asset.metadata.durationMs)
    )
      throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "目标帧不可用");
    const format = asset.mimeType === "video/webm" ? "matroska" : "mov";
    const directory = await mkdtemp(join(tmpdir(), "link-studio-frame-"));
    try {
      const source = join(directory, "video");
      await writeFile(
        source,
        await this.read(store, asset, fullFrame ? trimInputLimit : videoLimit, signal),
        {
          mode: 0o600,
          signal,
        },
      );
      const image = join(directory, "frame.png");
      let sampleTime = timeMs / 1000;
      if (fullFrame) {
        const probe = await probeMedia(
          join(dirname(this.ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
          source,
          { signal, inputFormat: format },
        );
        const track = probe.streams.find((stream) => stream.codec_type === "video");
        const end = Number(track?.duration) + (Number(track?.start_time) || 0);
        if (Number.isFinite(end) && end > 0)
          sampleTime = Math.min(sampleTime, Math.max(0, end - 0.001));
      }
      const pixels = await runMediaProcess(
        this.ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-max_alloc",
          "67108864",
          "-f",
          format,
          ...(fullFrame ? ["-copyts", "-start_at_zero", "-noaccurate_seek"] : []),
          "-ss",
          String(sampleTime),
          "-i",
          source,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          fullFrame
            ? `fps=fps=1000:start_time=${sampleTime}:round=up:eof_action=pass,scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease`
            : `scale=${frameSide}:${frameSide}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${frameSide}:${frameSide}:(ow-iw)/2:(oh-ih)/2`,
          "-pix_fmt",
          "rgb24",
          "-c:v",
          fullFrame ? "png" : "rawvideo",
          "-threads",
          "1",
          "-f",
          ...(fullFrame ? ["image2", "-update", "1", image] : ["rawvideo", "pipe:1"]),
        ],
        { signal, maxStdoutBytes: frameSide * frameSide * 3, timeoutMs: 15_000, maxRssMiB: 384 },
      ).catch(() => {
        throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "视频提帧失败");
      });
      const frame = fullFrame ? undefined : encodeFrame(pixels);
      if (frame) await writeFile(image, frame, { mode: 0o600, signal });
      const handle = await open(image, "r");
      try {
        const staged = await this.assets.stage(store, handle, `关键帧-${timeMs}ms.png`, frameId, {
          signal,
        });
        try {
          staged.asset.origin = "derived";
          Object.assign(staged.asset.metadata, { sourceAssetId: asset.assetId, timeMs });
          if (collect) {
            await this.assets.publishBlob(store, staged, signal);
            collect(staged.asset);
            return { assetId: frameId, mime: "image/png", data: "" };
          }
          await store.updateGeneration(async (state) => {
            if (state.assets[frameId]?.availability === "ready")
              return { changed: false, result: undefined };
            if (state.assets[frameId] || state.assets[asset.assetId]?.availability !== "ready")
              throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "源素材已变化");
            await this.assets.publishBlob(store, staged, signal);
            state.assets[frameId] = staged.asset;
            return { changed: true, result: undefined };
          }, signal);
        } finally {
          await this.assets.discard(staged);
        }
      } finally {
        await handle.close();
      }
      return { assetId: frameId, mime: "image/png", data: frame?.toString("base64") ?? "" };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
