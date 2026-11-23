import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DramaSkillSnapshot,
  MethodCandidate,
  MethodStep,
  MethodTrial,
  PromptStep,
  SkillFile,
  SkillInspection,
  SkillItem,
  SkillPreview,
  SkillScope,
  SkillsInput,
  SkillVersion,
} from "@link-studio/core";
import { zipSync } from "fflate";
import { isSkillScript, skillMethodText } from "./drama-body";
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
  warnings?: string;
  hash?: string;
};
const previewLimit = 1 << 20;
const stageLifetime = 15 * 60_000;

function fileList(pkg: SkillPackage): SkillFile[] {
  return [...pkg.files]
    .map(
      ([path, bytes]): SkillFile => ({
        path,
        size: bytes.length,
        text: isUtf8(bytes) && !bytes.subarray(0, 8192).includes(0),
        kind:
          path === "SKILL.md"
            ? "skill"
            : isSkillScript(path)
              ? "script"
              : path.startsWith("assets/")
                ? "asset"
                : /\.(md|txt)$/i.test(path)
                  ? "doc"
                  : /\.(png|jpg|jpeg|gif|webp|svg|json|ya?ml|csv|tsv|xml|toml|pdf)$/i.test(path)
                    ? "asset"
                    : "other",
      }),
    )
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
    warnings: JSON.parse(row.warnings ?? "[]"),
    hash: row.hash,
  };
}

function itemView(row: RecordRow, versions: SkillVersion[]): SkillItem {
  return {
    name: row.name,
    title: row.title,
    enabled: !!row.enabled,
    scopes: (JSON.parse(row.scopes) as SkillScope[]).filter(
      (scope) => scope !== "agent" || row.enabled,
    ),
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
      CREATE TABLE IF NOT EXISTS version_notes (name TEXT NOT NULL,version INTEGER NOT NULL,warnings TEXT NOT NULL,PRIMARY KEY(name,version),FOREIGN KEY(name,version) REFERENCES versions(name,version) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS skill_instances(name TEXT PRIMARY KEY REFERENCES skills(name) ON DELETE CASCADE,token TEXT NOT NULL);
      INSERT OR IGNORE INTO skill_instances SELECT name,hex(randomblob(16)) FROM skills;
      CREATE TABLE IF NOT EXISTS step_trials(id TEXT PRIMARY KEY,step TEXT NOT NULL,identity TEXT NOT NULL,finished INTEGER NOT NULL,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS step_bindings(step TEXT PRIMARY KEY,identity TEXT NOT NULL,candidate TEXT NOT NULL,trial TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS step_binding_history(step TEXT NOT NULL,trial TEXT NOT NULL,created INTEGER NOT NULL,candidate TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS step_runs(step TEXT NOT NULL,finished INTEGER NOT NULL,passed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS step_runs_finished ON step_runs(finished);
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
        "SELECT name,version,description,created,files,warnings,hash FROM versions LEFT JOIN version_notes USING(name,version) ORDER BY version DESC",
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
        "SELECT name,version,description,created,files,warnings,hash FROM versions LEFT JOIN version_notes USING(name,version) WHERE name = ? ORDER BY version DESC",
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
    const { name } = pkg;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.plan(pkg);
      if (plan?.action !== current.action || plan.version !== current.version)
        throw new SkillError("技能库已变化，请重新预检。");
      const { version } = current;
      if (current.action === "create") {
        this.db
          .prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)")
          .run(name, pkg.title, Number(enabled), JSON.stringify(scopes), version, version);
        this.db.prepare("INSERT INTO skill_instances VALUES(?,?)").run(name, randomUUID());
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
      this.db
        .prepare("INSERT INTO version_notes VALUES (?,?,?)")
        .run(name, version, JSON.stringify(pkg.warnings));
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

  exportZip({ name, version }: SkillsInput<"exportZip">) {
    const rows = this.db
      .prepare("SELECT path,bytes FROM files WHERE name=? AND version=? ORDER BY path")
      .all(name, version) as { path: string; bytes: Uint8Array }[];
    if (!rows.length) throw new SkillError("找不到此版本。");
    return zipSync(
      Object.assign(
        Object.create(null),
        Object.fromEntries(rows.map(({ path, bytes }) => [path, bytes])),
      ),
      { level: 0 },
    );
  }

  remove({ name }: SkillsInput<"remove">) {
    const result = this.db
      .prepare(`DELETE FROM skills WHERE name = ? AND NOT EXISTS (
      SELECT 1 FROM json_each(skills.scopes) WHERE value != 'agent' OR skills.enabled = 1
    )`)
      .run(name);
    if (!result.changes) {
      this.requireRow(name);
      throw new SkillError("请先关闭所有使用场景并保存，再删除技能。");
    }
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
      .filter((item) => item.scopes.includes(scope))
      .flatMap((item) => {
        const active = item.versions.find(({ version }) => version === item.activeVersion);
        return active ? [{ name: item.name, title: item.title, ...active }] : [];
      });
  }

  agentCatalog(query = "") {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const items = this.db
      .prepare(
        `SELECT s.name || '@' || v.version AS id,title,description AS summary FROM skills s JOIN versions v ON s.name=v.name AND s.active=v.version WHERE enabled=1 AND EXISTS(SELECT 1 FROM json_each(scopes) WHERE value='agent') ORDER BY s.name`,
      )
      .all() as { id: string; title: string; summary: string }[];
    return items
      .map((skill) => ({
        skill,
        score: words.filter((word) =>
          `${skill.id} ${skill.title} ${skill.summary}`.toLowerCase().includes(word),
        ).length,
      }))
      .filter((hit) => !words.length || hit.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((hit) => hit.skill);
  }

  agentPage(id: string, offset: number, file?: string, pinned?: string) {
    const [name, requested] = id.split("@");
    if (!name || !Number.isSafeInteger(offset) || offset < 0) return null;
    const row = this.db
      .prepare(`SELECT v.version,v.hash,v.files FROM skills s JOIN versions v ON v.name=s.name
      WHERE s.name=? AND s.enabled=1 AND EXISTS (SELECT 1 FROM json_each(s.scopes) WHERE value='agent')
      AND (s.active=v.version OR v.hash=?) ORDER BY (v.hash=?) DESC LIMIT 1`)
      .get(name, pinned ?? "", pinned ?? "") as
      | { version: number; hash: string; files: string }
      | undefined;
    if (!row || (!pinned && requested && Number(requested) !== row.version)) return null;
    const files: SkillFile[] = JSON.parse(row.files);
    const path = file ?? "SKILL.md";
    const entry = files.find((item) => item.path === path);
    if (!entry || offset > entry.size) return null;
    const prefix = this.db
      .prepare(
        "SELECT substr(bytes,1,8192) AS bytes FROM files WHERE name=? AND version=? AND path=?",
      )
      .get(name, row.version, path)?.bytes as Uint8Array;
    const info = { id: `${name}@${row.version}`, hash: row.hash, size: entry.size };
    if (
      entry.text === false ||
      (entry.text === undefined &&
        textPreview(prefix, prefix.length < entry.size ? previewLimit + 1 : entry.size).text ===
          null)
    )
      return { ...info, text: "", binary: true, nextOffset: null };
    const bytes = this.db
      .prepare(
        "SELECT substr(bytes,?,65540) AS bytes FROM files WHERE name=? AND version=? AND path=?",
      )
      .get(offset + 1, name, row.version, path)?.bytes as Uint8Array;
    let length = Math.min(bytes.length, 65536);
    while (length && length < bytes.length && (bytes[length]! & 192) === 128) length--;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      const resources = files.filter((item) => item.path !== "SKILL.md");
      return {
        ...info,
        text,
        nextOffset: offset + length < entry.size ? offset + length : null,
        ...(!file &&
          offset === 0 && {
            files: resources.slice(0, 100),
            omitted: Math.max(0, resources.length - 100),
          }),
      };
    } catch {
      return { ...info, text: "", binary: true, nextOffset: null };
    }
  }

  dramaSnapshot(step: PromptStep, name: string): DramaSkillSnapshot | undefined {
    const row = this.row(name);
    if (!row || step === "board" || !JSON.parse(row.scopes).includes(step)) return;
    const body = this.methodText(name, row.active);
    if (body === undefined) return;
    return {
      id: `skill:${name}`,
      source: "skill",
      step,
      revision: row.active,
      name: row.title,
      body: `【写作方法：${row.title}】\n以下是本步骤必须遵循的方法与标准，按它决定取舍、粒度与写法。输出格式以下方本步骤的输出约定或 JSON 结构为准，方法与之冲突时以约定为准，方法里要求的其他输出格式一律不输出。\n<skill>\n${body}\n</skill>`,
    };
  }

  private methodText(name: string, number: number) {
    const version = this.db
      .prepare("SELECT files FROM versions WHERE name = ? AND version = ?")
      .get(name, number);
    if (!version) return;
    const query = this.db.prepare(
      "SELECT bytes FROM files WHERE name = ? AND version = ? AND path = ?",
    );
    function read(path: string) {
      const bytes = query.get(name, number, path)?.bytes;
      if (!(bytes instanceof Uint8Array)) throw new SkillError("技能文件缺失，请重新导入");
      return bytes;
    }
    const files: SkillFile[] = JSON.parse(String(version.files));
    return skillMethodText(
      read("SKILL.md"),
      files.map((file) => file.path),
      read,
    );
  }

  private identity(candidate: MethodCandidate) {
    if (candidate.source === "builtin") return "builtin";
    const row = this.db
      .prepare(
        `SELECT hash,token FROM versions JOIN skills USING(name) JOIN skill_instances USING(name) WHERE name=? AND version=? AND enabled=1 AND EXISTS (SELECT 1 FROM json_each(scopes) WHERE value='agent')`,
      )
      .get(candidate.name, candidate.version);
    return row ? JSON.stringify([row.token, candidate.name, candidate.version, row.hash]) : null;
  }

  method(candidate: MethodCandidate) {
    const identity = this.identity(candidate);
    if (!identity) throw new SkillError("候选技能已停用或版本已删除。");
    const method =
      candidate.source === "builtin"
        ? { Source: "builtin" }
        : {
            Source: "skill",
            SkillName: candidate.name,
            SkillTitle: this.requireRow(candidate.name).title,
            Version: candidate.version,
            Body: this.methodText(candidate.name, candidate.version),
          };
    return { identity, method };
  }

  recordTrial(details: Omit<MethodTrial, "id" | "finished">, identity: string): MethodTrial {
    const trial = { ...details, id: randomUUID(), finished: Date.now() };
    this.db
      .prepare("INSERT INTO step_trials VALUES(?,?,?,?,?)")
      .run(trial.id, trial.step, identity, trial.finished, JSON.stringify(trial));
    return trial;
  }

  bind({ step, candidate, trial }: SkillsInput<"bind">) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM step_trials WHERE id=? AND step=? AND finished BETWEEN ? AND ?")
        .get(trial, step, Date.now() - 86400000, Date.now());
      if (
        !row ||
        row.identity !== this.identity(candidate) ||
        !JSON.parse(String(row.details)).passed
      )
        throw new SkillError("需要 24 小时内同环节、同候选版本且通过校验的试跑。");
      this.db
        .prepare("INSERT OR REPLACE INTO step_bindings VALUES(?,?,?,?)")
        .run(step, row.identity, JSON.stringify(candidate), trial);
      this.db
        .prepare("INSERT INTO step_binding_history VALUES(?,?,?,?)")
        .run(step, trial, Date.now(), JSON.stringify(candidate));
      this.db.exec("COMMIT");
      return null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resolveMethod(step: MethodStep) {
    const row = this.db.prepare("SELECT * FROM step_bindings WHERE step=?").get(step);
    const candidate: MethodCandidate = row
      ? JSON.parse(String(row.candidate))
      : { source: "builtin" };
    const fallback = !!row && this.identity(candidate) !== row.identity;
    return { candidate, fallback, ...this.method(fallback ? { source: "builtin" } : candidate) };
  }

  stepHistory() {
    return this.db
      .prepare("SELECT details FROM step_trials ORDER BY finished DESC,rowid DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(String(row.details)) as MethodTrial);
  }

  methodTelemetry(step: MethodStep) {
    const week = Date.now() - 7 * 86400000;
    const counts = this.db
      .prepare(
        "SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE passed=0) AS failed FROM step_runs WHERE step=? AND finished>=?",
      )
      .get(step, week)!;
    const history = this.db
      .prepare(
        "SELECT rowid,created,candidate,trial FROM step_binding_history WHERE step=? ORDER BY rowid DESC LIMIT 50",
      )
      .all(step)
      .map((row) => ({
        id: Number(row.rowid),
        at: Number(row.created),
        candidate: JSON.parse(String(row.candidate)) as MethodCandidate,
        trial: String(row.trial),
      }));
    return { total: Number(counts.total), failed: Number(counts.failed), history };
  }

  finishMethod(step: MethodStep, passed: boolean) {
    this.db.prepare("INSERT INTO step_runs VALUES(?,?,?)").run(step, Date.now(), Number(passed));
    this.db.prepare("DELETE FROM step_runs WHERE finished<?").run(Date.now() - 7 * 86400000);
  }
}
