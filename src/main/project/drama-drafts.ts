import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectError } from "./errors.ts";

export interface DramaDraft {
  text: string;
  chars: number;
  sha256: string;
  filename: string;
}

export function expiredDramaSource(): never {
  throw new ProjectError("DRAMA_SOURCE_EXPIRED", "文件已过期，请重新上传");
}

export class DramaDrafts {
  private db?: DatabaseSync;

  constructor(
    private file: string,
    private now = Date.now,
  ) {}

  private database() {
    if (!this.db) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(this.file);
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS drafts(token TEXT PRIMARY KEY,project TEXT NOT NULL,filename TEXT NOT NULL,text TEXT NOT NULL,chars INTEGER NOT NULL,sha256 TEXT NOT NULL,expires INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS drafts_expiry ON drafts(expires);`);
      } catch (error) {
        db.close();
        throw error;
      }
      this.db = db;
    }
    this.db.prepare("DELETE FROM drafts WHERE expires<=?").run(this.now());
    return this.db;
  }

  save(project: string, filename: string, source: { text: string; chars: number }) {
    const token = randomUUID();
    const hash = createHash("sha256").update(source.text).digest("hex");
    this.database()
      .prepare("INSERT INTO drafts VALUES(?,?,?,?,?,?,?)")
      .run(
        token,
        project,
        filename,
        source.text,
        source.chars,
        hash,
        this.now() + 24 * 60 * 60 * 1000,
      );
    return token;
  }

  read(project: string, token: string): DramaDraft {
    const row = this.database()
      .prepare("SELECT filename,text,chars,sha256 FROM drafts WHERE token=? AND project=?")
      .get(token, project);
    if (!row) return expiredDramaSource();
    return row as unknown as DramaDraft;
  }

  remove(project: string, token: string) {
    this.database().prepare("DELETE FROM drafts WHERE token=? AND project=?").run(token, project);
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }
}
