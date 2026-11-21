import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  evenGridLines,
  GRID_MAX,
  gridBounds,
  validGridLines,
} from "../../../packages/link-studio-core/src/grid-split.ts";
import { runMediaProcess } from "../../../packages/media-runtime/src/process.ts";
import type { AssetFiles, AssetRecord } from "./asset-files.ts";
import type { AssetService } from "./assets.ts";
import { ProjectError } from "./errors.ts";
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
  constructor(
    private readonly files: AssetFiles,
    private readonly assets: AssetService,
    private readonly ffmpeg: string,
  ) {}

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
    const width = Number(asset.metadata.width);
    const height = Number(asset.metadata.height);
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
      await writeFile(source, await this.read(store, asset, imageMediaLimit, signal), {
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
              `format=rgba,crop=${tileWidth}:${tileHeight}:${left}:${top}:exact=1`,
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
              `${asset.displayName.replace(/\.[^.]+$/, "")}-${row + 1}-${column + 1}.png`,
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
          `${asset.displayName.replace(/\.[^.]+$/, "")}-${purpose === "outpaint" ? "扩图底图" : "标注"}.png`,
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

  private async read(store: ProjectStore, asset: AssetRecord, limit: number, signal: AbortSignal) {
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

  async attachment(store: ProjectStore, asset: AssetRecord, signal: AbortSignal) {
    if (asset.availability !== "ready")
      throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "素材不可用");
    const digest = createHash("sha256").update(`agent-attachment:${asset.assetId}`).digest("hex");
    const frameId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const result = await this.inspect(store, asset, 0, frameId, signal);
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

  async inspect(
    store: ProjectStore,
    asset: AssetRecord,
    timeMs: number,
    frameId: string,
    signal: AbortSignal,
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
      await writeFile(source, await this.read(store, asset, videoLimit, signal), {
        mode: 0o600,
        signal,
      });
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
          "-ss",
          String(timeMs / 1000),
          "-i",
          source,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          `scale=${frameSide}:${frameSide}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${frameSide}:${frameSide}:(ow-iw)/2:(oh-ih)/2`,
          "-pix_fmt",
          "rgb24",
          "-c:v",
          "rawvideo",
          "-threads",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { signal, maxStdoutBytes: frameSide * frameSide * 3, timeoutMs: 15_000, maxRssMiB: 384 },
      ).catch(() => {
        throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "视频提帧失败");
      });
      const frame = encodeFrame(pixels);
      const image = join(directory, "frame.png");
      await writeFile(image, frame, { mode: 0o600, signal });
      const handle = await open(image, "r");
      try {
        const staged = await this.assets.stage(store, handle, `关键帧-${timeMs}ms.png`, frameId, {
          signal,
        });
        try {
          staged.asset.origin = "derived";
          Object.assign(staged.asset.metadata, { sourceAssetId: asset.assetId, timeMs });
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
      return { assetId: frameId, mime: "image/png", data: frame.toString("base64") };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
