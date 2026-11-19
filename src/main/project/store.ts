import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  isOperationId,
  isProjectState,
  normalizeProjectName,
  type ProjectReceipt,
  type ProjectState,
} from "../../../packages/link-studio-core/src/project.ts";
import { canonicalJson, contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import { ProjectOwnership, requireDirectory } from "./ownership.ts";

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_FILE = /^(\d{12,16})-([0-9a-f]{64})\.json$/;
export type CommitStage = "temporary-synced" | "snapshot-published" | "directory-synced";
export interface StoreOptions {
  onStage?: (stage: CommitStage) => Promise<void>;
}

async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function readSnapshot(path: string): Promise<unknown> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await descriptor.stat();
    if (!entry.isFile() || entry.size > MAX_SNAPSHOT_BYTES) {
      throw new ProjectError("PROJECT_SCHEMA_INVALID", "快照类型或大小无效");
    }
    return JSON.parse(await descriptor.readFile("utf8"));
  } finally {
    await descriptor.close();
  }
}

function verifySnapshot(value: unknown, filename: string): value is ProjectState {
  if (!isProjectState(value) || normalizeProjectName(value.name) !== value.name) return false;
  const { commitHash, ...body } = value;
  return (
    contentHash(body) === commitHash &&
    filename === `${String(value.revision).padStart(12, "0")}-${commitHash}.json` &&
    (value.revision === 1 ? value.parentHash === null : value.parentHash !== null) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    Object.values(value.operationReceipts).every((receipt) => receipt.revision <= value.revision)
  );
}

export class ProjectStore {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private faulted = false;
  private state!: ProjectState;
  readonly warnings: string[] = [];

  private constructor(
    private readonly owner: ProjectOwnership,
    private readonly options: StoreOptions,
  ) {}

  static async create(parent: string, inputName: string, options: StoreOptions = {}) {
    const name = normalizeProjectName(inputName);
    if (!name) throw new ProjectError("PROJECT_NAME_INVALID", "项目名称不符合要求");
    await requireDirectory(parent);
    const directory = join(parent, `${randomUUID()}.linkstudio`);
    await mkdir(directory, { mode: 0o700 });
    const owner = await ProjectOwnership.acquire(directory);
    const store = new ProjectStore(owner, options);
    try {
      await store.prepare();
      const timestamp = new Date().toISOString();
      const body: Omit<ProjectState, "commitHash"> = {
        schemaVersion: 1,
        projectId: randomUUID(),
        name,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
        parentHash: null,
        assets: {},
        canvas: {
          schemaVersion: 1,
          revision: 1,
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        compositions: {},
        jobs: {},
        operationReceipts: {},
        extensions: {},
      };
      await store.publish({ ...body, commitHash: contentHash(body) });
      await syncDirectory(parent);
      return store;
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  static async open(directory: string, options: StoreOptions = {}) {
    const owner = await ProjectOwnership.acquire(directory);
    const store = new ProjectStore(owner, options);
    try {
      await store.prepare();
      await store.recover();
      await store.rebuildManifest();
      return store;
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  get directory(): string {
    return this.owner.directory;
  }

  get snapshot(): ProjectState {
    return structuredClone(this.state);
  }

  rename(input: { operationId: string; expectedRevision: number; name: string }) {
    return this.enqueue(async (): Promise<ProjectReceipt> => {
      await this.owner.assertCurrent();
      if (this.faulted) {
        throw new ProjectError("PROJECT_SAVE_FAILED", "上次提交中断，请关闭并重新打开以核对结果");
      }
      if (!isOperationId(input.operationId) || !Number.isSafeInteger(input.expectedRevision)) {
        throw new ProjectError("PROJECT_SCHEMA_INVALID", "无效的操作标识或修订号");
      }
      const name = normalizeProjectName(input.name);
      if (!name) throw new ProjectError("PROJECT_NAME_INVALID", "项目名称不符合要求");
      const requestHash = contentHash({ kind: "rename", ...input, name });
      const previous = this.state.operationReceipts[input.operationId];
      if (previous) {
        if (previous.requestHash !== requestHash) {
          throw new ProjectError("OPERATION_ID_REUSED", "同一操作标识不能用于不同请求");
        }
        return structuredClone(previous);
      }
      if (input.expectedRevision !== this.state.revision) {
        throw new ProjectError("PROJECT_CONFLICT", "项目修订号已变化，请重新读取");
      }
      const revision = this.state.revision + 1;
      const receipt = { requestHash, revision, result: { name } };
      const { commitHash: parentHash, ...current } = this.state;
      const body = {
        ...current,
        name,
        revision,
        parentHash,
        updatedAt: new Date().toISOString(),
        operationReceipts: { ...current.operationReceipts, [input.operationId]: receipt },
      };
      await this.publish({ ...body, commitHash: contentHash(body) });
      return structuredClone(receipt);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    await this.owner.release();
  }

  private enqueue<Result>(action: () => Promise<Result>): Promise<Result> {
    if (this.closing) return Promise.reject(new ProjectError("PROJECT_CLOSED", "项目会话已关闭"));
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async prepare(): Promise<void> {
    for (const name of ["state", "tmp", "assets", "runtime", "exports", "cache"]) {
      const directory = join(this.directory, name);
      await mkdir(directory, { recursive: true });
      await requireDirectory(directory);
    }
    await syncDirectory(this.directory);
  }

  private async recover(): Promise<void> {
    const stateDirectory = join(this.directory, "state");
    const names = (await readdir(stateDirectory)).sort((left, right) =>
      left.localeCompare(right, "en", { numeric: true }),
    );
    let current: ProjectState | undefined;
    const invalid: string[] = [];
    const revisions = new Set<number>();
    for (const filename of names) {
      const match = SNAPSHOT_FILE.exec(filename);
      if (!match) throw new ProjectError("PROJECT_CORRUPT", "快照目录包含未知文件，需要人工检查");
      const revision = Number(match[1]);
      if (revisions.has(revision)) {
        throw new ProjectError("PROJECT_CORRUPT", "同一修订存在多个快照，拒绝自动选择分支");
      }
      revisions.add(revision);
      if (revision !== (current?.revision ?? 0) + invalid.length + 1) {
        throw new ProjectError("PROJECT_CORRUPT", "快照修订号不连续，拒绝自动恢复");
      }
      const value = await readSnapshot(join(stateDirectory, filename)).catch(() => null);
      if (
        value &&
        typeof value === "object" &&
        "schemaVersion" in value &&
        typeof value.schemaVersion === "number" &&
        value.schemaVersion > 1
      ) {
        throw new ProjectError("PROJECT_VERSION_UNSUPPORTED", "项目格式高于当前应用版本");
      }
      if (!verifySnapshot(value, filename)) {
        invalid.push(filename);
        continue;
      }
      if (
        invalid.length ||
        value.revision !== (current?.revision ?? 0) + 1 ||
        value.parentHash !== (current?.commitHash ?? null) ||
        (current &&
          (value.projectId !== current.projectId || value.createdAt !== current.createdAt))
      ) {
        throw new ProjectError("PROJECT_CORRUPT", "快照链断裂或项目身份发生变化");
      }
      current = value;
    }
    if (!current) throw new ProjectError("PROJECT_CORRUPT", "没有可恢复的完整快照");
    if (invalid.length) {
      const quarantine = join(this.directory, ".runtime", `recovery-${randomUUID()}`);
      await mkdir(quarantine);
      for (const filename of invalid) {
        await rename(join(stateDirectory, filename), join(quarantine, filename));
      }
      await syncDirectory(quarantine);
      await syncDirectory(join(this.directory, ".runtime"));
      await syncDirectory(stateDirectory);
      this.warnings.push(`已保留 ${invalid.length} 个损坏尾快照并恢复到修订 ${current.revision}`);
    }
    this.state = current;
  }

  private async publish(next: ProjectState): Promise<void> {
    const serialized = canonicalJson(next);
    if (
      !verifySnapshot(next, `${String(next.revision).padStart(12, "0")}-${next.commitHash}.json`)
    ) {
      throw new ProjectError("PROJECT_SCHEMA_INVALID", "快照结构无效");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new ProjectError("PROJECT_SCHEMA_INVALID", "快照超过 32 MiB 限制");
    }
    const temporary = join(this.directory, "tmp", `${randomUUID()}.json`);
    const stateDirectory = join(this.directory, "state");
    const destination = join(
      stateDirectory,
      `${String(next.revision).padStart(12, "0")}-${next.commitHash}.json`,
    );
    try {
      await this.owner.assertCurrent();
      await requireDirectory(stateDirectory);
      await requireDirectory(join(this.directory, "tmp"));
      const descriptor = await open(temporary, "wx", 0o600);
      try {
        await descriptor.writeFile(serialized, "utf8");
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      await this.options.onStage?.("temporary-synced");
      await this.owner.assertCurrent();
      await link(temporary, destination);
      await this.options.onStage?.("snapshot-published");
      await syncDirectory(stateDirectory);
      await this.options.onStage?.("directory-synced");
      this.state = next;
    } catch (cause) {
      this.faulted = true;
      throw new ProjectError("PROJECT_SAVE_FAILED", "快照保存中断，请重新打开核对结果", { cause });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await this.rebuildManifest();
  }

  private async rebuildManifest(): Promise<void> {
    const temporary = join(this.directory, "tmp", `${randomUUID()}.manifest`);
    try {
      await this.owner.assertCurrent();
      const descriptor = await open(temporary, "wx", 0o600);
      try {
        await descriptor.writeFile(
          canonicalJson({
            schemaVersion: 1,
            projectId: this.state.projectId,
            name: this.state.name,
            revision: this.state.revision,
            commitHash: this.state.commitHash,
          }),
        );
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      const manifest = join(this.directory, "manifest.json");
      const existing = await stat(manifest).catch(() => null);
      if (existing && !existing.isFile()) throw new Error("manifest 不是文件");
      await rename(temporary, manifest);
      await syncDirectory(this.directory);
    } catch {
      this.warnings.push("快照已提交，manifest 更新失败；下次打开时重建");
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
