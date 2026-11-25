import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { requirePresent } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import { Asset } from "../../../packages/link-studio-core/src/project.ts";
import {
  type AssetFiles,
  type AssetRecord,
  type MediaLocation,
  readOnly,
  verifyContent,
} from "./asset-files.ts";
import type { AssetService, StagedAsset } from "./assets.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import { requireDirectory } from "./ownership.ts";
import type { ProjectStore } from "./store.ts";

export class PersonalLibrary {
  readonly projectId = "personal-library";
  private database?: DatabaseSync;
  private readonly pendingRecords = new Map<string, string>();
  constructor(
    readonly directory: string,
    private files: AssetFiles,
    private blobs: AssetService,
  ) {}
  close() {
    this.database?.close();
    this.database = undefined;
    this.pendingRecords.clear();
  }

  private async index() {
    if (!this.database) {
      await mkdir(this.directory, { mode: 0o700, recursive: true });
      await requireDirectory(this.directory);
      if (!this.database) {
        const database = new DatabaseSync(join(this.directory, "items.sqlite"));
        try {
          database.exec(`PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS library_folders(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_items(id TEXT PRIMARY KEY, source_project TEXT NOT NULL, source_asset TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(source_project,source_asset));
          CREATE TABLE IF NOT EXISTS folder_members(item TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE, folder TEXT NOT NULL REFERENCES library_folders(id));
          CREATE TABLE IF NOT EXISTS removed_library_items(item TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE)`);
        } catch (error) {
          database.close();
          throw error;
        }
        this.database = database;
      }
    }
    return this.database;
  }
  private record(value: unknown) {
    const item: unknown = JSON.parse(String(value));
    if (
      !Value.Check(Asset, item) ||
      item.storage.kind !== "blob" ||
      item.storage.hash !== item.sha256 ||
      item.availability !== "ready"
    )
      throw new ProjectError("ASSET_READ_FAILED", "个人库索引不可用");
    return { ...item, availability: "ready" as const };
  }
  async list(projectId: string, before = Number.MAX_SAFE_INTEGER) {
    const db = await this.index();
    const rows = db
      .prepare(
        "SELECT library_items.rowid AS cursor,record,source_project,source_asset,folder FROM library_items LEFT JOIN folder_members ON item=id WHERE library_items.rowid < ? AND id NOT IN (SELECT item FROM removed_library_items) ORDER BY library_items.rowid DESC LIMIT 41",
      )
      .all(before);
    const removedSourceIds =
      before === Number.MAX_SAFE_INTEGER
        ? db
            .prepare(
              "SELECT source_asset FROM library_items JOIN removed_library_items ON item=id WHERE source_project=?",
            )
            .all(projectId)
            .map((row) => String(row.source_asset))
        : [];
    return {
      items: rows.slice(0, 40).map((row) => ({
        asset: this.record(row.record),
        folderId: row.folder === null ? null : String(row.folder),
        ...(row.source_project === projectId && { sourceId: String(row.source_asset) }),
      })),
      folders: this.folderList(db),
      ...(removedSourceIds.length && { removedSourceIds }),
      ...(rows.length > 40 && { next: Number(requirePresent(rows[39], "rows[39]").cursor) }),
    };
  }
  async listFolders() {
    return this.folderList(await this.index());
  }
  private folderList(db: DatabaseSync) {
    return db
      .prepare(
        "SELECT id,name,created_at,COUNT(item) AS count FROM library_folders LEFT JOIN folder_members ON folder=id GROUP BY id ORDER BY library_folders.rowid",
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        createdAt: String(row.created_at),
        itemCount: Number(row.count),
      }));
  }
  private folderName(db: DatabaseSync, raw: string, except = "") {
    const name = raw.trim();
    if (!name || Array.from(name).length > 30)
      throw new ProjectError("VALIDATION_FAILED", name ? "名称最多 30 个字" : "请输入文件夹名称");
    if (db.prepare("SELECT id FROM library_folders WHERE name=? AND id<>?").get(name, except))
      throw new ProjectError("VALIDATION_FAILED", "文件夹名称已存在");
    return name;
  }
  async createFolder(raw: string) {
    const db = await this.index();
    const name = this.folderName(db, raw);
    if (Number(db.prepare("SELECT COUNT(*) AS count FROM library_folders").get()?.count) >= 100)
      throw new ProjectError("VALIDATION_FAILED", "最多创建 100 个文件夹");
    const folder = { id: randomUUID(), name, createdAt: new Date().toISOString(), itemCount: 0 };
    db.prepare("INSERT INTO library_folders VALUES(?,?,?)").run(folder.id, name, folder.createdAt);
    return folder;
  }
  private requireFolder(db: DatabaseSync, folderId: string) {
    if (!db.prepare("SELECT id FROM library_folders WHERE id=?").get(folderId))
      throw new ProjectError("ASSET_NOT_FOUND", "该内容已不存在");
  }
  async renameFolder(folderId: string, raw: string) {
    const db = await this.index();
    this.requireFolder(db, folderId);
    db.prepare("UPDATE library_folders SET name=? WHERE id=?").run(
      this.folderName(db, raw, folderId),
      folderId,
    );
  }
  private transaction<Result>(db: DatabaseSync, apply: () => Result) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = apply();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  async deleteFolder(folderId: string) {
    const db = await this.index();
    return this.transaction(db, () => {
      this.requireFolder(db, folderId);
      const { changes } = db
        .prepare("INSERT INTO removed_library_items SELECT item FROM folder_members WHERE folder=?")
        .run(folderId);
      db.prepare("DELETE FROM folder_members WHERE folder=?").run(folderId);
      db.prepare("DELETE FROM library_folders WHERE id=?").run(folderId);
      return Number(changes);
    });
  }
  async moveItem(itemId: string, folderId: string | null) {
    const db = await this.index();
    this.transaction(db, () => {
      if (
        !db
          .prepare(
            "SELECT id FROM library_items WHERE id=? AND id NOT IN (SELECT item FROM removed_library_items)",
          )
          .get(itemId)
      )
        throw new ProjectError("ASSET_NOT_FOUND", "该内容已不存在");
      if (folderId) {
        this.requireFolder(db, folderId);
        db.prepare(
          "INSERT INTO folder_members VALUES(?,?) ON CONFLICT(item) DO UPDATE SET folder=excluded.folder",
        ).run(itemId, folderId);
      } else db.prepare("DELETE FROM folder_members WHERE item=?").run(itemId);
    });
  }
  async removeItem(itemId: string) {
    const db = await this.index();
    this.transaction(db, () => {
      if (
        !db
          .prepare(
            "INSERT OR IGNORE INTO removed_library_items SELECT id FROM library_items WHERE id=?",
          )
          .run(itemId).changes
      )
        throw new ProjectError("ASSET_NOT_FOUND", "该内容已不存在");
      db.prepare("DELETE FROM folder_members WHERE item=?").run(itemId);
    });
  }
  private restore(
    db: DatabaseSync,
    item: ReturnType<PersonalLibrary["record"]>,
    folderId?: string,
  ) {
    this.transaction(db, () => {
      if (
        db.prepare("DELETE FROM removed_library_items WHERE item=?").run(item.assetId).changes &&
        folderId
      ) {
        this.requireFolder(db, folderId);
        db.prepare("INSERT INTO folder_members VALUES(?,?)").run(item.assetId, folderId);
      }
    });
    return item;
  }
  async get(itemId: string) {
    const row = (await this.index())
      .prepare("SELECT record FROM library_items WHERE id=?")
      .get(itemId);
    if (!row) throw new ProjectError("ASSET_NOT_FOUND", "个人库素材不存在");
    return this.record(row.record);
  }
  async filingPage(before = Number.MAX_SAFE_INTEGER, search = "", folder?: string) {
    const db = await this.index(),
      keyword = search.trim();
    const rows = db
      .prepare(`SELECT library_items.rowid AS cursor,record FROM library_items LEFT JOIN folder_members ON item=id
      WHERE library_items.rowid < ? AND json_extract(record,'$.mediaType')='image' AND id NOT IN (SELECT item FROM removed_library_items)
      AND (? <> '' OR folder IS ?) AND instr(lower(json_extract(record,'$.displayName')),lower(?))>0 ORDER BY library_items.rowid DESC LIMIT 41`)
      .all(before, keyword, folder ?? null, keyword);
    return {
      assets: rows.slice(0, 40).map((row) => this.record(row.record)),
      folders: this.folderList(db),
      ...(rows.length > 40 && { next: Number(requirePresent(rows[39], "rows[39]").cursor) }),
    };
  }
  async filingSelection(itemId: string) {
    const row = (await this.index())
      .prepare(
        "SELECT record FROM library_items WHERE id=? AND id NOT IN (SELECT item FROM removed_library_items)",
      )
      .get(itemId);
    return row ? this.record(row.record) : undefined;
  }
  async filingImage(itemId: string) {
    const row = (await this.index())
      .prepare(`SELECT record,source_project,source_asset FROM library_items
      WHERE id=? AND id NOT IN (SELECT item FROM removed_library_items)`)
      .get(itemId);
    if (!row) throw new ProjectError("ASSET_NOT_FOUND", "个人库图片已不存在");
    const asset = this.record(row.record);
    if (
      asset.mediaType !== "image" ||
      !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType) ||
      asset.sizeBytes > 10 * 1024 * 1024
    )
      throw new ProjectError(
        "ASSET_TYPE_UNSUPPORTED",
        "请选择 10 MiB 以内的 PNG、JPEG 或 WebP 图片",
      );
    const { handle } = await this.files.inspect(this, asset, true);
    try {
      const bytes = Buffer.alloc(asset.sizeBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new ProjectError("ASSET_READ_FAILED", "无法读取个人库图片");
        offset += bytesRead;
      }
      return {
        asset,
        bytes,
        origin: { project: String(row.source_project), asset: String(row.source_asset) },
      };
    } finally {
      await handle.close();
    }
  }
  async importFilingImage(
    name: string,
    bytes: Uint8Array,
    folder: string | undefined,
    signal: AbortSignal,
  ) {
    if (
      !/\.(png|jpe?g|webp)$/i.test(name) ||
      /[/\\]/.test(name) ||
      Array.from(name).some((char) => char.charCodeAt(0) < 32)
    )
      throw new ProjectError("ASSET_TYPE_UNSUPPORTED", "请选择 PNG、JPEG 或 WebP 图片");
    if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024)
      throw new ProjectError("ASSET_SIZE_LIMIT", "单张备案图片最多 10 MiB");
    const db = await this.index();
    if (folder) this.requireFolder(db, folder);
    const tempDir = join(this.directory, "tmp");
    await mkdir(tempDir, { mode: 0o700, recursive: true });
    await requireDirectory(tempDir);
    const temporary = join(tempDir, `${randomUUID()}.upload`);
    const handle = await open(temporary, "wx+", 0o600);
    try {
      await handle.writeFile(bytes, { signal });
      return await this.importFile(handle, name, folder, signal);
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => {});
    }
  }
  async importFile(
    handle: FileHandle,
    name: string,
    folder?: string,
    signal?: AbortSignal,
    onProgress?: (copied: number, total: number) => void,
  ) {
    const db = await this.index();
    await mkdir(join(this.directory, "tmp"), { recursive: true, mode: 0o700 });
    let staged: StagedAsset | undefined;
    try {
      staged = await this.blobs.stage(this, handle, name, randomUUID(), { signal, onProgress });
      await this.blobs.publishBlob(this, staged, signal);
      signal?.throwIfAborted();
      const { asset } = staged;
      this.transaction(db, () => {
        if (folder) this.requireFolder(db, folder);
        db.prepare(
          "INSERT INTO library_items(id,source_project,source_asset,record) VALUES(?,?,?,?)",
        ).run(asset.assetId, this.projectId, asset.assetId, JSON.stringify(asset));
        if (folder)
          db.prepare("INSERT INTO folder_members(item,folder) VALUES(?,?)").run(
            asset.assetId,
            folder,
          );
      });
      return asset;
    } finally {
      if (staged) await this.blobs.discard(staged);
    }
  }
  async filingMembership(
    items: { asset: AssetRecord; origin: { project: string; asset: string } }[],
  ) {
    const members = new Set<string>();
    if (!items.length) return members;
    const find = (await this.index()).prepare(
      "SELECT record FROM library_items WHERE source_project=? AND source_asset=? AND id NOT IN (SELECT item FROM removed_library_items)",
    );
    for (const { asset, origin } of items) {
      const row = find.get(origin.project, origin.asset);
      if (row && this.record(row.record).sha256 === asset.sha256) members.add(asset.assetId);
    }
    return members;
  }
  async filingOrigins(assets: AssetRecord[]) {
    const origins = new Map<string, { project: string; asset: string }>();
    if (!assets.length) return origins;
    const origin = (await this.index()).prepare(
      "SELECT source_project,source_asset,record FROM library_items WHERE id=?",
    );
    for (const asset of assets) {
      const row = origin.get(
        typeof asset.metadata.libraryItemId === "string"
          ? asset.metadata.libraryItemId
          : asset.assetId,
      );
      if (row && this.record(row.record).sha256 === asset.sha256)
        origins.set(asset.assetId, {
          project: String(row.source_project),
          asset: String(row.source_asset),
        });
    }
    return origins;
  }
  private async copy(
    source: MediaLocation,
    original: AssetRecord,
    destination: MediaLocation,
    item: StagedAsset["asset"],
    signal?: AbortSignal,
    staged = false,
  ) {
    signal?.throwIfAborted();
    const published = await this.files.inspect(destination, item, true).catch(() => undefined);
    if (published) {
      await published.handle.close();
      if (!staged) {
        const verified = await this.files.inspect(source, original, true);
        await verified.handle.close();
      }
      return;
    }
    const tempDir = join(destination.directory, "tmp");
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    await requireDirectory(tempDir);
    const temporary = join(tempDir, `${randomUUID()}.library`);
    try {
      await this.files.materialize(source, original, temporary, signal);
      const handle = await open(temporary, readOnly);
      try {
        await verifyContent(handle, item, undefined, signal);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.blobs.publishBlob(destination, { temporary, asset: item }, signal);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async register(store: ProjectStore, assetId: string, folderId?: string) {
    const source = store.snapshot.assets[assetId];
    if (source?.availability !== "ready")
      throw new ProjectError("ASSET_NOT_FOUND", "项目素材不可用");
    return this.registerSource(store, source, folderId);
  }
  async registerSource(store: MediaLocation, source: AssetRecord, folderId?: string) {
    const database = await this.index();
    const assetId = source.assetId;
    if (typeof source.metadata.libraryItemId === "string") {
      const existing = await this.get(source.metadata.libraryItemId);
      if (existing.sha256 === source.sha256) return this.restore(database, existing, folderId);
    }
    const find = () =>
      database
        .prepare("SELECT record FROM library_items WHERE source_project=? AND source_asset=?")
        .get(store.projectId, assetId);
    const previous = find();
    if (previous) {
      const item = this.record(previous.record);
      if (item.sha256 !== source.sha256)
        throw new ProjectError("ASSET_REFERENCE_CHANGED", "个人库素材的来源已变更");
      return this.restore(database, item, folderId);
    }
    const item: StagedAsset["asset"] = {
      ...source,
      assetId: randomUUID(),
      createdAt: new Date().toISOString(),
      origin: "imported",
      importMode: "copy",
      storage: { kind: "blob", hash: source.sha256 },
      availability: "ready",
      metadata: Object.fromEntries(
        Object.entries(source.metadata).filter(([key]) =>
          ["width", "height", "durationMs", "sampleRate"].includes(key),
        ),
      ),
    };
    const key = contentHash([store.directory, store.projectId, assetId]);
    await this.copy(
      store,
      source,
      this,
      item,
      undefined,
      this.pendingRecords.get(key) === source.sha256,
    );
    if (this.pendingRecords.size >= 128)
      this.pendingRecords.delete(
        requirePresent(
          this.pendingRecords.keys().next().value,
          "this.pendingRecords.keys().next().value",
        ),
      );
    this.pendingRecords.set(key, source.sha256);
    database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = database
        .prepare(
          "INSERT INTO library_items(id,source_project,source_asset,record) VALUES(?,?,?,?) ON CONFLICT(source_project,source_asset) DO NOTHING",
        )
        .run(item.assetId, store.projectId, assetId, JSON.stringify(item));
      if (inserted.changes && folderId)
        database.prepare("INSERT INTO folder_members VALUES(?,?)").run(item.assetId, folderId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    this.pendingRecords.delete(key);
    return this.record(requirePresent(find(), "find()").record);
  }
  async attach(store: ProjectStore, itemId: string, operationId: string, signal?: AbortSignal) {
    const item = await this.get(itemId);
    const requestHash = contentHash({ kind: "personal-library", itemId });
    const prior = store.replayAssetImport(operationId, requestHash);
    if (prior) return prior;
    const state = store.snapshot;
    const existing = Object.values(state.assets).find(
      (asset) =>
        asset.metadata.libraryItemId === itemId &&
        asset.sha256 === item.sha256 &&
        asset.availability === "ready",
    );
    if (existing && (await this.files.available(store, existing)))
      return { asset: { ...existing, availability: "ready" as const }, revision: state.revision };
    const asset: StagedAsset["asset"] = {
      ...item,
      assetId: randomUUID(),
      metadata: { ...item.metadata, libraryItemId: itemId },
    };
    await this.copy(this, item, store, asset, signal);
    return store.commitAsset({
      operationId,
      requestHash,
      expectedRevision: store.snapshot.revision,
      asset,
      signal,
    });
  }
}
