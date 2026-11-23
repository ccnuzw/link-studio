import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import { jpegDimensions, jpegHeaderLimit } from "./jpeg-dimensions.ts";
import { requireDirectory } from "./ownership.ts";
import { type ProjectStore, syncDirectory } from "./store.ts";

export type AssetRecord = ProjectState["assets"][string];
export type MediaLocation = Pick<ProjectStore, "projectId" | "directory">;
export const readOnly = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function identity(stat: Stats) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export async function verifyContent(
  handle: FileHandle,
  asset: AssetRecord,
  before?: Stats,
  signal?: AbortSignal,
) {
  const stat = before ?? (await handle.stat());
  if (!stat.isFile() || stat.size !== asset.sizeBytes || stat.size === 0)
    throw new ProjectError("ASSET_REFERENCE_CHANGED", "文件内容与原素材不一致");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (let position = 0; position < stat.size; ) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, stat.size - position),
      position,
    );
    if (!bytesRead) throw new ProjectError("ASSET_REFERENCE_CHANGED", "文件内容与原素材不一致");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (hash.digest("hex") !== asset.sha256 || identity(await handle.stat()) !== identity(stat))
    throw new ProjectError("ASSET_REFERENCE_CHANGED", "文件内容与原素材不一致");
  return stat;
}

export class AssetFiles {
  private readonly jpegOrientations = new Map<string, number>();
  private readonly verified = new Map<string, string>();

  constructor(private readonly directory: string) {}

  private async locator(store: MediaLocation, asset: AssetRecord) {
    if (asset.storage.kind !== "external")
      throw new ProjectError("ASSET_NOT_FOUND", "该素材未使用外部引用");
    const { dev, ino } = await lstat(store.directory);
    const key = contentHash({
      dev,
      ino,
      projectId: store.projectId,
      assetId: asset.assetId,
      locatorId: asset.storage.locatorId,
    });
    return join(this.directory, `${key}.json`);
  }

  async bind(
    store: ProjectStore,
    asset: AssetRecord,
    path: string,
    handle: FileHandle,
    signal?: AbortSignal,
  ) {
    const stat = await verifyContent(handle, asset, undefined, signal);
    const entry = await lstat(path).catch(() => null);
    if (!entry || identity(entry) !== identity(stat))
      throw new ProjectError("ASSET_REFERENCE_CHANGED", "所选文件已移动或发生变化");
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    await requireDirectory(this.directory);
    const locator = await this.locator(store, asset);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const target = await open(temporary, "wx", 0o600);
      try {
        await target.writeFile(JSON.stringify({ path, identity: identity(stat) }));
        await target.sync();
      } finally {
        await target.close();
      }
      signal?.throwIfAborted();
      await rename(temporary, locator);
      await syncDirectory(this.directory);
    } catch (cause) {
      throw new ProjectError("ASSET_STORAGE_FAILED", "无法保存外部定位", { cause });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async resolve(store: MediaLocation, asset: AssetRecord) {
    if (asset.availability === "deleted") throw new ProjectError("ASSET_NOT_FOUND", "素材已移除");
    if (asset.storage.kind === "blob") {
      const root = join(store.directory, "assets");
      const hashRoot = join(root, "sha256");
      const bucket = join(hashRoot, asset.sha256.slice(0, 2));
      for (const directory of [root, hashRoot, bucket]) await requireDirectory(directory);
      return { path: join(bucket, asset.sha256), identity: undefined };
    }
    await requireDirectory(this.directory);
    const locator = await open(await this.locator(store, asset), readOnly);
    try {
      const stat = await locator.stat();
      if (!stat.isFile() || stat.size > 32_768) throw new Error("Invalid locator");
      const data = JSON.parse(await locator.readFile("utf8"));
      if (
        typeof data.path !== "string" ||
        !isAbsolute(data.path) ||
        typeof data.identity !== "string"
      )
        throw new Error("Invalid locator");
      return { path: data.path as string, identity: data.identity as string };
    } finally {
      await locator.close();
    }
  }

  async inspect(store: MediaLocation, asset: AssetRecord, verifyBlob = false) {
    let handle: FileHandle | undefined;
    try {
      const target = await this.resolve(store, asset);
      handle = await open(target.path, readOnly);
      const stat = await handle.stat();
      const stamp = identity(stat);
      if (!stat.isFile() || stat.size !== asset.sizeBytes || !stat.size)
        throw new ProjectError(
          asset.storage.kind === "external" ? "ASSET_REFERENCE_CHANGED" : "ASSET_NOT_FOUND",
          "素材文件不可用",
        );
      const key = `${asset.sha256}:${target.path}`;
      if (
        (verifyBlob || target.identity !== undefined) &&
        target.identity !== stamp &&
        this.verified.get(key) !== stamp
      ) {
        await verifyContent(handle, asset, stat);
        if (this.verified.size >= 256) this.verified.clear();
        this.verified.set(key, stamp);
      }
      const file = { handle, stamp };
      handle = undefined;
      return file;
    } catch (cause) {
      if (cause instanceof ProjectError && cause.code === "ASSET_REFERENCE_CHANGED") throw cause;
      throw new ProjectError("ASSET_NOT_FOUND", "素材文件不可用", { cause });
    } finally {
      await handle?.close();
    }
  }

  async materialize(
    store: MediaLocation,
    asset: AssetRecord,
    destination: string,
    signal?: AbortSignal,
  ) {
    const { handle } = await this.inspect(store, asset, true);
    try {
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        { signal },
      );
    } catch (cause) {
      await unlink(destination).catch(() => undefined);
      throw new ProjectError("ASSET_READ_FAILED", "无法准备导出素材", { cause });
    } finally {
      await handle.close();
    }
  }

  async available(store: ProjectStore, asset: AssetRecord) {
    try {
      const file = await this.inspect(store, asset);
      await file.handle.close();
      return true;
    } catch {
      return false;
    }
  }

  async previewMetadata(store: ProjectStore, asset: AssetRecord) {
    const file = await this.inspect(store, asset).catch(() => undefined);
    if (!file) return;
    try {
      if (asset.mimeType !== "image/jpeg" || asset.metadata.orientation !== undefined)
        return asset.metadata;
      const key = `${asset.sha256}:${file.stamp}`;
      let orientation = this.jpegOrientations.get(key);
      if (orientation === undefined) {
        const header = Buffer.alloc(Math.min(asset.sizeBytes, jpegHeaderLimit));
        const { bytesRead } = await file.handle.read(header, 0, header.length, 0);
        orientation = jpegDimensions(header.subarray(0, bytesRead))?.orientation ?? 1;
        if (this.jpegOrientations.size >= 256) this.jpegOrientations.clear();
        this.jpegOrientations.set(key, orientation);
      }
      return { ...asset.metadata, orientation };
    } finally {
      await file.handle.close();
    }
  }
}

const mediaTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/ogg",
]);

export async function servePreview(
  request: Request,
  files: AssetFiles,
  store: MediaLocation,
  asset: AssetRecord,
  stamp: string,
  active: () => boolean,
) {
  if (!mediaTypes.has(asset.mimeType) || !["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 404 });
  const range = request.headers.get("range");
  const length = asset.sizeBytes;
  let start = 0;
  let end = length - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]) || !length)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${length}` } });
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else start = Math.max(0, length - Number(match[2]));
    if (!Number.isSafeInteger(start) || start > end || start >= length)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${length}` } });
  }
  const file = await files.inspect(store, asset, true);
  if (file.stamp !== stamp || !active()) {
    await file.handle.close();
    return new Response(null, { status: 404 });
  }
  const headers = new Headers({
    "content-type": asset.mimeType,
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  if (range) headers.set("content-range", `bytes ${start}-${end}/${length}`);
  if (request.method === "HEAD") {
    await file.handle.close();
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const stream = file.handle.createReadStream({ start, end, signal: request.signal });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers,
  });
}
