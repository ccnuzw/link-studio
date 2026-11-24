import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Value } from "@sinclair/typebox/value";
import { GenerationInput } from "../../../packages/link-studio-core/src/generation.ts";
import { Asset, type ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import type { ProjectRequest } from "../../../packages/link-studio-core/src/projects-api.ts";
import { type AssetFiles, readOnly } from "./asset-files.ts";
import { ProjectError } from "./errors.ts";
import { requireDirectory } from "./ownership.ts";
import type { ProjectStore } from "./store.ts";

type Canvas = { recentEntryId: string; projectId: string; directory: string; displayName: string };
type Filter = NonNullable<ProjectRequest<"filingLibraryPage">["history"]>;
type Row = Record<string, unknown>;
export type HistoryCursor = { created: number; id: string };

function generated(state: ProjectState) {
  const entries = [];
  for (const [jobId, job] of Object.entries(state.jobs)) {
    if (
      !job ||
      typeof job !== "object" ||
      Array.isArray(job) ||
      job.version !== 1 ||
      (job.kind !== "image" && job.kind !== "video" && job.kind !== "audio") ||
      job.id !== jobId ||
      typeof job.model !== "string" ||
      !Value.Check(GenerationInput, job.input) ||
      !Array.isArray(job.outputs)
    )
      continue;
    for (const output of job.outputs) {
      if (
        !output ||
        typeof output !== "object" ||
        Array.isArray(output) ||
        output.kind !== job.kind ||
        typeof output.assetId !== "string"
      )
        continue;
      const asset = state.assets[output.assetId];
      if (
        asset?.origin === "generated" &&
        asset.metadata.jobId === job.id &&
        asset.mediaType === job.kind &&
        asset.availability === "ready" &&
        asset.storage.kind === "blob" &&
        Number.isFinite(Date.parse(asset.createdAt))
      )
        entries.push({ asset, prompt: job.input.prompt, model: job.model });
    }
  }
  return entries;
}

export class FilingHistory {
  private database?: DatabaseSync;
  constructor(
    private file: string,
    private files: AssetFiles,
    private recents: () => readonly Canvas[],
  ) {}
  private async index() {
    if (!this.database) {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await requireDirectory(dirname(this.file));
      if (!this.database) {
        const database = new DatabaseSync(this.file);
        try {
          database.exec(`PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS canvases(id TEXT PRIMARY KEY,project TEXT NOT NULL,device TEXT NOT NULL,inode TEXT NOT NULL,commit_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,canvas TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,asset TEXT NOT NULL,record TEXT NOT NULL,prompt TEXT NOT NULL,model TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(canvas,asset));
          CREATE INDEX IF NOT EXISTS images_by_date ON images(created DESC,id DESC)`);
        } catch (error) {
          database.close();
          throw error;
        }
        this.database = database;
      }
    }
    return this.database;
  }
  close() {
    this.database?.close();
    this.database = undefined;
  }
  async forget(id: string) {
    (await this.index()).prepare("DELETE FROM canvases WHERE id=?").run(id);
  }
  async observe(store: ProjectStore, canvas: Canvas) {
    const db = await this.index(),
      identity = await lstat(store.directory, { bigint: true });
    const allowed = () =>
      this.recents().some(
        (entry) =>
          entry.recentEntryId === canvas.recentEntryId &&
          entry.directory === store.directory &&
          entry.projectId === store.projectId,
      );
    let initial = true,
      priorAssets: ProjectState["assets"] | undefined,
      priorJobs: ProjectState["jobs"] | undefined;
    await store.observeGenerationHistory((state) => {
      if (!allowed() || this.database !== db) return;
      db.exec("BEGIN");
      try {
        if (initial)
          db.prepare(
            "DELETE FROM canvases WHERE id=? AND (project<>? OR device<>? OR inode<>?)",
          ).run(canvas.recentEntryId, state.projectId, String(identity.dev), String(identity.ino));
        db.prepare(
          "INSERT INTO canvases VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET commit_hash=excluded.commit_hash",
        ).run(
          canvas.recentEntryId,
          state.projectId,
          String(identity.dev),
          String(identity.ino),
          state.commitHash,
        );
        if (priorAssets !== state.assets || priorJobs !== state.jobs) {
          const known = new Set(
            db
              .prepare("SELECT asset FROM images WHERE canvas=?")
              .all(canvas.recentEntryId)
              .map((row) => String(row.asset)),
          );
          const put = db.prepare(
            "INSERT INTO images VALUES(?,?,?,?,?,?,?) ON CONFLICT(canvas,asset) DO UPDATE SET record=excluded.record,prompt=excluded.prompt,model=excluded.model,created=excluded.created WHERE (record,prompt,model,created)<>(excluded.record,excluded.prompt,excluded.model,excluded.created)",
          );
          for (const { asset, prompt, model } of generated(state)) {
            put.run(
              randomUUID(),
              canvas.recentEntryId,
              asset.assetId,
              JSON.stringify(asset),
              prompt,
              model,
              Date.parse(asset.createdAt),
            );
            known.delete(asset.assetId);
          }
          const remove = db.prepare("DELETE FROM images WHERE canvas=? AND asset=?");
          for (const id of known) remove.run(canvas.recentEntryId, id);
        }
        db.exec("COMMIT");
        initial = false;
        priorAssets = state.assets;
        priorJobs = state.jobs;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  private async current(row: Row) {
    const canvas = this.recents().find(
      (entry) => entry.recentEntryId === row.canvas && entry.projectId === row.project,
    );
    if (!canvas) return;
    try {
      if ((await realpath(canvas.directory)) !== canvas.directory) return;
      const stat = await lstat(canvas.directory, { bigint: true });
      if (!stat.isDirectory() || String(stat.dev) !== row.device || String(stat.ino) !== row.inode)
        return;
      const fd = await open(join(canvas.directory, "manifest.json"), readOnly);
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > 8192) return;
        const manifest = JSON.parse(await fd.readFile("utf8"));
        if (
          manifest.projectId === row.project &&
          manifest.commitHash === row.commit_hash &&
          this.recents().includes(canvas)
        )
          return canvas;
      } finally {
        await fd.close();
      }
    } catch {
      return;
    }
  }
  async page(
    filter: Filter,
    query: string,
    before?: HistoryCursor,
    media: "image" | "video" | "audio" = "image",
    oldest = false,
  ) {
    const db = await this.index();
    const indexed = db.prepare("SELECT id AS canvas,* FROM canvases").all();
    const canvases = (await Promise.all(indexed.map((row) => this.current(row)))).flatMap(
      (entry) => (entry ? [{ id: entry.recentEntryId, name: entry.displayName }] : []),
    );
    const ids = canvases
      .filter((entry) => !filter.canvas || entry.id === filter.canvas)
      .map((entry) => entry.id);
    const now = new Date(),
      since = filter.days
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - filter.days + 1).getTime()
        : 0;
    const order = oldest ? "ASC" : "DESC";
    const rows =
      ids.length && !filter.conversation
        ? db
            .prepare(
              `SELECT images.*,project FROM images JOIN canvases ON canvas=canvases.id WHERE canvas IN (${ids.map(() => "?").join(",")}) AND json_extract(record,'$.mediaType')=? AND created>=? AND instr(lower(prompt),lower(?))>0 AND (? IS NULL OR (created,images.id)${oldest ? ">" : "<"}(?,?)) ORDER BY created ${order},images.id ${order} LIMIT 41`,
            )
            .all(
              ...ids,
              media,
              since,
              query.trim(),
              before?.id ?? null,
              before?.created ?? 0,
              before?.id ?? "",
            )
        : [];
    return {
      canvases,
      items: rows.slice(0, 40).map((row) => this.item(row)),
      next:
        rows.length > 40
          ? { created: Number(rows[39]!.created), id: String(rows[39]!.id) }
          : undefined,
    };
  }
  private item(row: Row) {
    const raw: unknown = JSON.parse(String(row.record));
    if (
      !Value.Check(Asset, raw) ||
      raw.assetId !== row.asset ||
      raw.origin !== "generated" ||
      raw.availability !== "ready" ||
      raw.storage.kind !== "blob" ||
      raw.storage.hash !== raw.sha256
    )
      throw new ProjectError("ASSET_NOT_FOUND", "历史图片不可用");
    return {
      asset: { ...raw, availability: "ready" as const, assetId: `history:${row.id}` },
      origin: { project: String(row.project), asset: raw.assetId },
      canvasId: String(row.canvas),
      prompt: String(row.prompt),
      model: String(row.model),
    };
  }
  async lookup(key: string) {
    const db = await this.index();
    const row = db
      .prepare(
        "SELECT images.*,canvases.project,device,inode,commit_hash FROM images JOIN canvases ON canvas=canvases.id WHERE images.id=?",
      )
      .get(key.slice(8));
    const canvas = row && (await this.current(row));
    return row && canvas ? { row, canvas, ...this.item(row) } : undefined;
  }
  async selection(key: string) {
    const item = await this.lookup(key);
    return item?.asset.mediaType === "image"
      ? { asset: item.asset, origin: item.origin }
      : undefined;
  }
  async image(key: string) {
    const item = await this.lookup(key);
    if (item?.asset.mediaType !== "image")
      throw new ProjectError("ASSET_NOT_FOUND", "历史图片已失效");
    const { asset, origin, canvas, row } = item;
    if (
      asset.sizeBytes > 10 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType)
    )
      throw new ProjectError(
        "ASSET_TYPE_UNSUPPORTED",
        "请选择 10 MiB 以内的 PNG、JPEG 或 WebP 图片",
      );
    const { handle } = await this.files.inspect(canvas, asset, true);
    try {
      const bytes = Buffer.alloc(asset.sizeBytes);
      for (let offset = 0; offset < bytes.length; ) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new ProjectError("ASSET_READ_FAILED", "无法读取历史图片");
        offset += bytesRead;
      }
      if (!(await this.current(row)) || !(await this.lookup(key)))
        throw new ProjectError("ASSET_NOT_FOUND", "历史图片已失效");
      return { asset: { ...asset, assetId: origin.asset }, bytes, origin };
    } finally {
      await handle.close();
    }
  }
}
