import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { JsonValue, ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import type { ProjectAsset } from "../../../packages/link-studio-core/src/projects-api.ts";
import { probeMedia } from "../../../packages/media-runtime/src/probe.ts";
import { ProjectError } from "./errors.ts";
import { type ProjectStore, syncDirectory } from "./store.ts";

const MAX_ASSET_BYTES = 20 * 1024 ** 3;
const EXTENSIONS: Record<
  string,
  { mediaType: ProjectAsset["mediaType"]; mimeType: string; format?: string }
> = {
  ".png": { mediaType: "image", mimeType: "image/png" },
  ".jpg": { mediaType: "image", mimeType: "image/jpeg" },
  ".jpeg": { mediaType: "image", mimeType: "image/jpeg" },
  ".webp": { mediaType: "image", mimeType: "image/webp" },
  ".mp4": { mediaType: "video", mimeType: "video/mp4", format: "mov" },
  ".mov": { mediaType: "video", mimeType: "video/quicktime", format: "mov" },
  ".webm": { mediaType: "video", mimeType: "video/webm", format: "matroska" },
  ".mp3": { mediaType: "audio", mimeType: "audio/mpeg", format: "mp3" },
  ".wav": { mediaType: "audio", mimeType: "audio/wav", format: "wav" },
  ".m4a": { mediaType: "audio", mimeType: "audio/mp4", format: "mov" },
  ".ogg": { mediaType: "audio", mimeType: "audio/ogg", format: "ogg" },
};

async function ensureAssetDirectory(directory: string) {
  const root = join(directory, "assets");
  const hashRoot = join(root, "sha256");
  for (const path of [root, hashRoot]) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new ProjectError("ASSET_STORAGE_FAILED", "项目资产目录无效");
  }
  return hashRoot;
}

export type AssetImportResult =
  | { kind: "duplicate"; candidateAssetIds: string[]; revision: number }
  | { kind: "reused"; asset: ProjectAsset; revision: number }
  | { kind: "created"; asset: ProjectAsset & ProjectState["assets"][string]; revision: number };

function imageDimensions(header: Buffer, trailer: Buffer, bytes: number, extension: string) {
  if (
    extension === ".png" &&
    bytes >= 57 &&
    header.subarray(0, 16).equals(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")) &&
    trailer.equals(Buffer.from("0000000049454e44ae426082", "hex"))
  )
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  if (
    [".jpg", ".jpeg"].includes(extension) &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    trailer.subarray(-2).equals(Buffer.from("ffd9", "hex"))
  ) {
    let offset = 2;
    while (offset + 9 < header.length) {
      if (header[offset] !== 0xff) break;
      const marker = header[offset + 1];
      const length = header.readUInt16BE(offset + 2);
      if (
        typeof marker === "number" &&
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      )
        return { width: header.readUInt16BE(offset + 7), height: header.readUInt16BE(offset + 5) };
      offset += length + 2;
    }
  }
  if (
    extension === ".webp" &&
    header.length >= 20 &&
    header.readUInt32LE(4) === bytes - 8 &&
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WEBP"
  ) {
    const kind = header.toString("ascii", 12, 16);
    if (
      kind === "VP8 " &&
      header.length >= 30 &&
      header.subarray(23, 26).equals(Buffer.from("9d012a", "hex"))
    )
      return { width: header.readUInt16LE(26) & 0x3fff, height: header.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8X" && header.length >= 30)
      return { width: 1 + header.readUIntLE(24, 3), height: 1 + header.readUIntLE(27, 3) };
    if (kind === "VP8L" && header.length >= 25 && header[20] === 0x2f)
      return {
        width: 1 + ((((header[22] ?? 0) & 0x3f) << 8) | (header[21] ?? 0)),
        height:
          1 +
          ((((header[24] ?? 0) & 0x0f) << 10) |
            ((header[23] ?? 0) << 2) |
            (((header[22] ?? 0) & 0xc0) >> 6)),
      };
  }
  throw new ProjectError("ASSET_READ_FAILED", "媒体内容无效或无法识别");
}

export class AssetService {
  constructor(
    private readonly ffprobe: string,
    private readonly writeChunk = async (target: FileHandle, chunk: Buffer, position: number) => {
      const { bytesWritten } = await target.write(chunk, 0, chunk.length, position);
      return bytesWritten;
    },
  ) {}

  async importCopy(
    store: ProjectStore,
    sourceHandle: FileHandle,
    displayName: string,
    assetId: string,
    choice?: "reuse" | "independent",
  ): Promise<AssetImportResult> {
    const staged = await this.stage(store, sourceHandle, displayName, assetId);
    try {
      const current = store.snapshot;
      const candidates = copyCandidates(current, staged.asset);
      if (candidates.length && !choice)
        return {
          kind: "duplicate",
          candidateAssetIds: candidates.map((asset) => asset.assetId),
          revision: current.revision,
        };
      await this.publishBlob(store, staged);
      const candidate = candidates[0];
      return candidate && choice === "reuse"
        ? { kind: "reused", asset: candidate, revision: current.revision }
        : { kind: "created", asset: staged.asset, revision: current.revision };
    } finally {
      await this.discard(staged);
    }
  }

  async stage(
    store: ProjectStore,
    sourceHandle: FileHandle,
    displayName: string,
    assetId: string,
    options: {
      signal?: AbortSignal;
      onProgress?: (copiedBytes: number, totalBytes: number) => void;
    } = {},
  ): Promise<StagedAsset> {
    const extension = extname(displayName).toLowerCase();
    const expected = EXTENSIONS[extension];
    if (!expected) throw new ProjectError("ASSET_TYPE_UNSUPPORTED", "该文件类型暂不支持");
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) throw new ProjectError("ASSET_READ_FAILED", "所选对象不是普通文件");
    if (sourceStat.size <= 0 || sourceStat.size > MAX_ASSET_BYTES)
      throw new ProjectError("ASSET_SIZE_LIMIT", "文件超过 20 GiB 导入限制");
    const tempDirectory = join(store.directory, "tmp");
    const temporary = join(tempDirectory, `${randomUUID()}.asset`);
    const hash = createHash("sha256");
    let bytes = 0;
    let complete = false;
    try {
      options.signal?.throwIfAborted();
      const tempStat = await lstat(tempDirectory);
      if (!tempStat.isDirectory() || tempStat.isSymbolicLink())
        throw new ProjectError("ASSET_STORAGE_FAILED", "项目临时目录无效");
      const target = await open(temporary, "wx+", 0o600);
      let header: Buffer;
      let trailer: Buffer;
      try {
        options.onProgress?.(0, sourceStat.size);
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        while (bytes < sourceStat.size) {
          options.signal?.throwIfAborted();
          const { bytesRead } = await sourceHandle.read(
            buffer,
            0,
            Math.min(buffer.length, sourceStat.size - bytes),
            bytes,
          );
          if (!bytesRead) throw new ProjectError("ASSET_READ_FAILED", "源文件在导入期间发生变化");
          const chunk = buffer.subarray(0, bytesRead);
          let written = 0;
          while (written < bytesRead) {
            options.signal?.throwIfAborted();
            const count = await this.writeChunk(target, chunk.subarray(written), bytes + written);
            if (!count) throw new ProjectError("ASSET_STORAGE_FAILED", "无法写入临时文件");
            written += count;
          }
          hash.update(chunk);
          bytes += bytesRead;
          options.onProgress?.(bytes, sourceStat.size);
        }
        options.signal?.throwIfAborted();
        await target.sync();
        header = Buffer.alloc(Math.min(bytes, 65_536));
        trailer = Buffer.alloc(Math.min(bytes, 12));
        await target.read(header, 0, header.length, 0);
        await target.read(trailer, 0, trailer.length, bytes - trailer.length);
      } finally {
        await target.close();
      }
      const afterRead = await sourceHandle.stat();
      if (
        bytes !== sourceStat.size ||
        afterRead.size !== sourceStat.size ||
        afterRead.mtimeMs !== sourceStat.mtimeMs ||
        afterRead.ctimeMs !== sourceStat.ctimeMs ||
        afterRead.ino !== sourceStat.ino
      )
        throw new ProjectError("ASSET_READ_FAILED", "源文件在导入期间发生变化");
      const sha256 = hash.digest("hex");
      const metadata: Record<string, JsonValue> = {};
      if (!expected.format) {
        const dimensions = imageDimensions(header, trailer, bytes, extension);
        if (!dimensions.width || !dimensions.height)
          throw new ProjectError("ASSET_READ_FAILED", "图片尺寸无效");
        if (dimensions.width * dimensions.height > 100_000_000)
          throw new ProjectError("ASSET_SIZE_LIMIT", "图片超过 100 MP 限制");
        Object.assign(metadata, dimensions);
      } else {
        if (options.signal?.aborted) throw new ProjectError("ASSET_IMPORT_CANCELLED", "导入已取消");
        const probe = await probeMedia(this.ffprobe, temporary, {
          inputFormat: expected.format,
          signal: options.signal,
        }).catch((cause) => {
          throw new ProjectError("ASSET_READ_FAILED", "媒体内容无效或无法识别", { cause });
        });
        const stream = probe.streams.find(
          (item) => item.codec_type === (expected.mediaType === "video" ? "video" : "audio"),
        );
        if (!stream) throw new ProjectError("ASSET_READ_FAILED", "媒体内容与文件类型不匹配");
        Object.assign(metadata, {
          durationMs: Math.round(probe.duration * 1000),
          ...(stream.width ? { width: stream.width, height: stream.height } : {}),
          ...(stream.sample_rate ? { sampleRate: Number(stream.sample_rate) } : {}),
        });
      }
      options.signal?.throwIfAborted();
      const asset: StagedAsset["asset"] = {
        assetId,
        createdAt: new Date().toISOString(),
        origin: "imported",
        displayName: basename(displayName).slice(0, 255),
        mediaType: expected.mediaType,
        mimeType: expected.mimeType,
        sha256,
        sizeBytes: bytes,
        importMode: "copy",
        storage: { kind: "blob", hash: sha256 },
        metadata,
        availability: "ready",
      };
      complete = true;
      return { asset, temporary };
    } catch (error) {
      if (options.signal?.aborted) throw new ProjectError("ASSET_IMPORT_CANCELLED", "导入已取消");
      if (error instanceof ProjectError) throw error;
      throw new ProjectError("ASSET_STORAGE_FAILED", "导入未完成，源文件未更改", { cause: error });
    } finally {
      if (!complete) await unlink(temporary).catch(() => undefined);
    }
  }

  async discard(staged: StagedAsset) {
    await unlink(staged.temporary).catch(() => undefined);
  }

  async publishBlob(store: ProjectStore, staged: StagedAsset, signal?: AbortSignal) {
    const { sha256, sizeBytes: bytes } = staged.asset;
    const { temporary } = staged;
    let created = false;
    try {
      signal?.throwIfAborted();
      const hashRoot = await ensureAssetDirectory(store.directory);
      const blobDirectory = join(hashRoot, sha256.slice(0, 2));
      await mkdir(blobDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const blobDirectoryStat = await lstat(blobDirectory);
      if (!blobDirectoryStat.isDirectory() || blobDirectoryStat.isSymbolicLink())
        throw new ProjectError("ASSET_STORAGE_FAILED", "项目资产目录无效");
      const blob = join(blobDirectory, sha256);
      try {
        await link(temporary, blob);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await open(
          blob,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const existingStat = await existing.stat();
          if (!existingStat.isFile() || existingStat.size !== bytes)
            throw new ProjectError("ASSET_STORAGE_FAILED", "已有媒体 Blob 校验失败");
          const existingHash = createHash("sha256");
          for await (const chunk of existing.createReadStream({
            autoClose: false,
            start: 0,
            end: bytes - 1,
          })) {
            signal?.throwIfAborted();
            existingHash.update(chunk);
          }
          const afterVerify = await existing.stat();
          if (
            afterVerify.size !== bytes ||
            afterVerify.ctimeMs !== existingStat.ctimeMs ||
            existingHash.digest("hex") !== sha256
          )
            throw new ProjectError("ASSET_STORAGE_FAILED", "已有媒体 Blob 校验失败");
        } finally {
          await existing.close();
        }
      }
      for (const directory of [
        blobDirectory,
        hashRoot,
        join(store.directory, "assets"),
        store.directory,
      ])
        await syncDirectory(directory);
      return { path: blob, created };
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      throw new ProjectError("ASSET_STORAGE_FAILED", "导入未完成，源文件未更改", { cause: error });
    }
  }

  async discardPublishedBlob(published: { path: string; created: boolean }) {
    if (!published.created) return;
    await unlink(published.path).catch(() => undefined);
  }
}

export interface StagedAsset {
  asset: ProjectAsset & ProjectState["assets"][string];
  temporary: string;
}

export function copyCandidates(state: ProjectState, asset: { sha256: string; importMode: string }) {
  return Object.values(state.assets).filter(
    (candidate): candidate is StagedAsset["asset"] =>
      candidate.sha256 === asset.sha256 &&
      candidate.availability === "ready" &&
      candidate.importMode === asset.importMode,
  );
}
