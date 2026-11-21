import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SkillFile,
  SkillInspection,
  SkillItem,
  SkillPreview,
  SkillScope,
  SkillsInput,
  SkillVersion,
} from "@link-studio/core";
import { SkillError, type SkillPackage } from "./intake";

type RecordRow = {
  name: string;
  title: string;
  enabled: number;
  scopes: string;
  active: number;
  latest: number;
};
type VersionRow = {
  name: string;
  version: number;
  description: string;
  created: string;
  files: string;
};
const previewLimit = 1 << 20;
const stageLifetime = 15 * 60_000;

function fileList(pkg: SkillPackage): SkillFile[] {
  return [...pkg.files]
    .map(([path, bytes]) => ({ path, size: bytes.length }))
    .sort((left, right) =>
      left.path === "SKILL.md"
        ? -1
        : right.path === "SKILL.md"
          ? 1
          : left.path.localeCompare(right.path),
    );
}

function versionView(row: VersionRow): SkillVersion {
  return {
    version: row.version,
    description: row.description,
    createdAt: row.created,
    files: JSON.parse(row.files),
  };
}

function itemView(row: RecordRow, versions: SkillVersion[]): SkillItem {
  return {
    name: row.name,
    title: row.title,
    enabled: !!row.enabled,
    scopes: JSON.parse(row.scopes),
    activeVersion: row.active,
    origin: "local",
    versions,
  };
}

function textPreview(bytes: Uint8Array, size: number): SkillPreview {
  const truncated = size > previewLimit;
  try {
    const sample = bytes.subarray(0, previewLimit);
    if (sample.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))
      return { text: null, truncated };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      stream: truncated,
    });
    return { text, truncated };
  } catch {
    return { text: null, truncated };
  }
}

export class SkillLibrary {
  private readonly db: DatabaseSync;
  private readonly stages = new Map<
    number,
    {
      id: string;
      pkg: SkillPackage;
      plan: SkillInspection["plan"];
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "skills.sqlite"));
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY, title TEXT NOT NULL, enabled INTEGER NOT NULL,
        scopes TEXT NOT NULL, active INTEGER NOT NULL, latest INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        name TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE, version INTEGER NOT NULL,
        hash TEXT NOT NULL, description TEXT NOT NULL, created TEXT NOT NULL, files TEXT NOT NULL,
        PRIMARY KEY (name, version), UNIQUE (name, hash)
      );
      CREATE TABLE IF NOT EXISTS files (
        name TEXT NOT NULL, version INTEGER NOT NULL, path TEXT NOT NULL, bytes BLOB NOT NULL,
        PRIMARY KEY (name, version, path),
        FOREIGN KEY (name, version) REFERENCES versions(name, version) ON DELETE CASCADE
      );
    `);
  }

  close() {
    for (const owner of this.stages.keys()) this.discard(owner);
    this.db.close();
  }

  list(): SkillItem[] {
    const versions = new Map<string, SkillVersion[]>();
    for (const row of this.db
      .prepare(
        "SELECT name, version, description, created, files FROM versions ORDER BY version DESC",
      )
      .all() as VersionRow[]) {
      const group = versions.get(row.name) ?? [];
      group.push(versionView(row));
      versions.set(row.name, group);
    }
    return (this.db.prepare("SELECT * FROM skills ORDER BY name").all() as RecordRow[]).map((row) =>
      itemView(row, versions.get(row.name) ?? []),
    );
  }

  private row(name: string) {
    return this.db.prepare("SELECT * FROM skills WHERE name = ?").get(name) as
      | RecordRow
      | undefined;
  }

  private requireRow(name: string) {
    const row = this.row(name);
    if (!row) throw new SkillError("该技能已不存在，请刷新列表。");
    return row;
  }

  private item(name: string) {
    const row = this.requireRow(name);
    const versions = this.db
      .prepare(
        "SELECT name, version, description, created, files FROM versions WHERE name = ? ORDER BY version DESC",
      )
      .all(name) as VersionRow[];
    return itemView(row, versions.map(versionView));
  }

  private plan(pkg: SkillPackage): NonNullable<SkillInspection["plan"]> {
    const same = this.db
      .prepare("SELECT version FROM versions WHERE name = ? AND hash = ?")
      .get(pkg.name, pkg.hash);
    if (same) throw new SkillError(`内容与已有的 v${same.version} 相同，无需重复导入。`);
    const row = this.row(pkg.name);
    return row
      ? { action: "new_version", version: row.latest + 1 }
      : { action: "create", version: 1 };
  }

  stage(owner: number, pkg: SkillPackage): SkillInspection {
    this.discard(owner);
    const id = randomUUID();
    let plan: SkillInspection["plan"] = null;
    let error: string | undefined;
    try {
      plan = this.plan(pkg);
    } catch (failure) {
      if (!(failure instanceof SkillError)) throw failure;
      error = failure.message;
    }
    const timer = setTimeout(() => this.discard(owner, id), stageLifetime).unref();
    this.stages.set(owner, { id, pkg, plan, timer });
    return {
      id,
      name: pkg.name,
      title: pkg.title,
      description: pkg.description,
      files: fileList(pkg),
      warnings: pkg.warnings,
      error,
      plan,
    };
  }

  discard(owner: number, id?: string) {
    const stage = this.stages.get(owner);
    if (stage && (!id || stage.id === id)) {
      clearTimeout(stage.timer);
      this.stages.delete(owner);
    }
    return null;
  }

  private staged(owner: number, id: string) {
    const stage = this.stages.get(owner);
    if (!stage || stage.id !== id) throw new SkillError("暂存已失效，请重新选择技能包。");
    return stage;
  }

  confirm(owner: number, { id, enabled, scopes }: SkillsInput<"confirm">) {
    const { pkg, plan } = this.staged(owner, id);
    const current = this.plan(pkg);
    if (plan?.action !== current.action || plan.version !== current.version)
      throw new SkillError("技能库已变化，请重新预检。");
    const { name } = pkg;
    const { version } = current;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (current.action === "create") {
        this.db
          .prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)")
          .run(name, pkg.title, Number(enabled), JSON.stringify(scopes), version, version);
      } else this.db.prepare("UPDATE skills SET latest = ? WHERE name = ?").run(version, name);
      this.db
        .prepare("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          name,
          version,
          pkg.hash,
          pkg.description,
          new Date().toISOString(),
          JSON.stringify(fileList(pkg)),
        );
      const insert = this.db.prepare("INSERT INTO files VALUES (?, ?, ?, ?)");
      for (const [path, bytes] of pkg.files) insert.run(name, version, path, bytes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.discard(owner, id);
    return this.item(name);
  }

  update({ name, title, enabled, scopes }: SkillsInput<"update">) {
    this.requireRow(name);
    if (!title.trim()) throw new SkillError("请输入显示名称。");
    this.db
      .prepare("UPDATE skills SET title = ?, enabled = ?, scopes = ? WHERE name = ?")
      .run(title.trim(), Number(enabled), JSON.stringify(scopes), name);
    return this.item(name);
  }

  activate({ name, version }: SkillsInput<"activate">) {
    if (
      !this.db.prepare("SELECT 1 FROM versions WHERE name = ? AND version = ?").get(name, version)
    )
      throw new SkillError("找不到该版本，请刷新列表。");
    this.db.prepare("UPDATE skills SET active = ? WHERE name = ?").run(version, name);
    return this.item(name);
  }

  removeVersion({ name, version }: SkillsInput<"removeVersion">) {
    if (this.requireRow(name).active === version)
      throw new SkillError("请先切换生效版本，再删除此版本。");
    this.db.prepare("DELETE FROM versions WHERE name = ? AND version = ?").run(name, version);
    return this.item(name);
  }

  remove({ name }: SkillsInput<"remove">) {
    this.db.prepare("DELETE FROM skills WHERE name = ?").run(name);
    return null;
  }

  preview(owner: number, input: SkillsInput<"preview">) {
    if ("id" in input) {
      const bytes = this.staged(owner, input.id).pkg.files.get(input.path);
      if (bytes) return textPreview(bytes, bytes.length);
    } else {
      const row = this.db
        .prepare(
          "SELECT substr(bytes, 1, ?) AS sample, length(bytes) AS size FROM files WHERE name = ? AND version = ? AND path = ?",
        )
        .get(previewLimit, input.name, input.version, input.path) as
        | { sample: Uint8Array; size: number }
        | undefined;
      if (row) return textPreview(row.sample, row.size);
    }
    throw new SkillError("找不到此文件。");
  }

  catalog(scope: SkillScope) {
    return this.list()
      .filter((item) => item.enabled && item.scopes.includes(scope))
      .flatMap((item) => {
        const active = item.versions.find(({ version }) => version === item.activeVersion);
        return active ? [{ name: item.name, title: item.title, ...active }] : [];
      });
  }

  agentCatalog(query = "") {
    const normalized = query.toLowerCase();
    return this.catalog("agent")
      .map((skill) => ({
        id: `${skill.name}@${skill.version}`,
        title: skill.title,
        summary: skill.description,
      }))
      .filter(
        (skill) =>
          !normalized ||
          `${skill.id} ${skill.title} ${skill.summary}`.toLowerCase().includes(normalized),
      );
  }

  agentContent(name: string, version: number) {
    const row = this.db
      .prepare(
        `SELECT files.bytes
           FROM files
           JOIN skills ON skills.name = files.name
          WHERE files.name = ?
            AND files.version = ?
            AND files.path = 'SKILL.md'
            AND skills.enabled = 1
            AND skills.active = files.version
            AND skills.scopes LIKE '%"agent"%'`,
      )
      .get(name, version) as { bytes?: Uint8Array } | undefined;
    if (!row?.bytes) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(row.bytes).slice(0, 64 * 1024);
  }
}
