import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  type CanvasOperation,
  CanvasOperations,
} from "../../../packages/link-studio-core/src/canvas.ts";
import {
  isOperationId,
  isProjectState,
  normalizeProjectName,
  type ProjectState,
} from "../../../packages/link-studio-core/src/project.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import { canonicalJson, contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import { ProjectOwnership, requireDirectory } from "./ownership.ts";

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_FILE = /^(\d{12,16})-([0-9a-f]{64})\.json$/;

export function containsAssetReference(value: unknown, assetId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsAssetReference(item, assetId));
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (["assetId", "bgmAssetId", "audioAssetId"].includes(key) && item === assetId) return true;
    if (
      (key === "assetIds" || key.endsWith("AssetIds")) &&
      Array.isArray(item) &&
      item.includes(assetId)
    )
      return true;
    if (containsAssetReference(item, assetId)) return true;
  }
  return false;
}
export type CommitStage = "temporary-synced" | "snapshot-published" | "directory-synced";
export interface StoreOptions {
  onStage?: (stage: CommitStage) => Promise<void>;
}

export async function syncDirectory(directory: string): Promise<void> {
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
    Object.entries(value.assets).every(
      ([id, asset]) =>
        id === asset.assetId &&
        (asset.importMode === "copy"
          ? asset.storage.kind === "blob" && asset.storage.hash === asset.sha256
          : asset.storage.kind === "external"),
    ) &&
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

  get projectId() {
    return this.state.projectId;
  }

  get snapshot(): ProjectState {
    return structuredClone(this.state);
  }

  rename(input: { operationId: string; expectedRevision: number; name: string }) {
    return this.enqueue(async () => {
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

  replayAssetImport(operationId: string, requestHash: string) {
    const previous = this.state.operationReceipts[operationId];
    if (!previous) return;
    if (previous.requestHash !== requestHash)
      throw new ProjectError("OPERATION_ID_REUSED", "同一操作标识不能用于不同请求");
    const { assetId } = previous.result as { assetId: string };
    const saved = this.state.assets[assetId];
    if (!saved) throw new ProjectError("PROJECT_CORRUPT", "导入回执对应资产不存在");
    const { deletedAt: _deletedAt, ...asset } = saved;
    return { asset: { ...asset, availability: "ready" as const }, revision: previous.revision };
  }

  replayAssetBatch(operationId: string, requestHash: string) {
    const previous = this.state.operationReceipts[operationId];
    if (!previous) return;
    if (previous.requestHash !== requestHash)
      throw new ProjectError("OPERATION_ID_REUSED", "同一操作标识不能用于不同请求");
    const assetIds = (previous.result as { assetIds?: string[] }).assetIds;
    if (!assetIds?.length) throw new ProjectError("PROJECT_CORRUPT", "批量资产回执无效");
    const assets = assetIds.map((assetId) => this.state.assets[assetId]);
    if (assets.some((asset) => !asset)) throw new ProjectError("PROJECT_CORRUPT", "批量资产不存在");
    return { assets: structuredClone(assets), revision: previous.revision };
  }

  commitAsset(
    input: {
      operationId: string;
      expectedRevision: number;
      requestHash: string;
      signal?: AbortSignal;
      composition?: { id: string; value: ProjectState["compositions"][string] };
    } & (
      | { asset: ProjectState["assets"][string]; reuseAssetId?: never }
      | { reuseAssetId: string; asset?: never }
    ),
  ) {
    return this.enqueue(async () => {
      await this.owner.assertCurrent();
      if (!isOperationId(input.operationId) || !Number.isSafeInteger(input.expectedRevision))
        throw new ProjectError("PROJECT_SCHEMA_INVALID", "无效的资产提交请求");
      const { requestHash } = input;
      const previous = this.replayAssetImport(input.operationId, requestHash);
      if (previous) return previous;
      if (input.expectedRevision !== this.state.revision)
        throw new ProjectError("PROJECT_CONFLICT", "项目修订号已变化，请刷新后重试");
      const asset = input.asset ?? this.state.assets[input.reuseAssetId];
      if (asset?.availability !== "ready")
        throw new ProjectError("ASSET_NOT_FOUND", "资产不存在或已移除");
      if (input.asset && this.state.assets[asset.assetId])
        throw new ProjectError("PROJECT_CONFLICT", "资产 ID 已存在");
      const revision = this.state.revision + 1;
      const result = { assetId: asset.assetId };
      const receipt = { requestHash, revision, result };
      const { commitHash: parentHash, ...current } = this.state;
      const body = {
        ...current,
        revision,
        parentHash,
        updatedAt: new Date().toISOString(),
        assets: input.asset ? { ...current.assets, [asset.assetId]: asset } : current.assets,
        compositions: input.composition
          ? { ...current.compositions, [input.composition.id]: input.composition.value }
          : current.compositions,
        operationReceipts: { ...current.operationReceipts, [input.operationId]: receipt },
      };
      await this.publish({ ...body, commitHash: contentHash(body) }, input.signal);
      return { asset: { ...structuredClone(asset), availability: "ready" as const }, revision };
    });
  }

  commitAssets(input: {
    operationId: string;
    expectedRevision: number;
    requestHash: string;
    assets: ProjectState["assets"][string][];
    signal?: AbortSignal;
  }) {
    return this.enqueue(async () => {
      await this.owner.assertCurrent();
      if (
        !isOperationId(input.operationId) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.assets.length < 1 ||
        input.assets.length > 25 ||
        new Set(input.assets.map(({ assetId }) => assetId)).size !== input.assets.length
      )
        throw new ProjectError("PROJECT_SCHEMA_INVALID", "无效的批量资产提交请求");
      const previous = this.state.operationReceipts[input.operationId];
      if (previous) {
        if (previous.requestHash !== input.requestHash)
          throw new ProjectError("OPERATION_ID_REUSED", "同一操作标识不能用于不同请求");
        const replay = this.replayAssetBatch(input.operationId, input.requestHash);
        if (!replay) throw new ProjectError("PROJECT_CORRUPT", "批量资产回执无效");
        return replay;
      }
      await this.recoverFailedCommit();
      if (input.expectedRevision !== this.state.revision)
        throw new ProjectError("PROJECT_CONFLICT", "项目已更新，请刷新后重试");
      if (
        input.assets.some(
          (asset) =>
            asset.availability !== "ready" ||
            asset.origin !== "derived" ||
            this.state.assets[asset.assetId],
        )
      )
        throw new ProjectError("PROJECT_CONFLICT", "批量派生资产无效或已存在");
      const revision = this.state.revision + 1;
      const assetIds = input.assets.map(({ assetId }) => assetId);
      const receipt = { requestHash: input.requestHash, revision, result: { assetIds } };
      const { commitHash: parentHash, ...current } = this.state;
      const body = {
        ...current,
        revision,
        parentHash,
        updatedAt: new Date().toISOString(),
        assets: {
          ...current.assets,
          ...Object.fromEntries(input.assets.map((asset) => [asset.assetId, asset])),
        },
        operationReceipts: { ...current.operationReceipts, [input.operationId]: receipt },
      };
      await this.publish({ ...body, commitHash: contentHash(body) }, input.signal);
      return { assets: structuredClone(input.assets), revision };
    });
  }

  removeAsset(input: { operationId: string; expectedRevision: number; assetId: string }) {
    return this.enqueue(async () => {
      await this.owner.assertCurrent();
      if (!isOperationId(input.operationId) || !Number.isSafeInteger(input.expectedRevision))
        throw new ProjectError("PROJECT_SCHEMA_INVALID", "无效的资产移除请求");
      const requestHash = contentHash({ kind: "asset-remove", assetId: input.assetId });
      const previous = this.state.operationReceipts[input.operationId];
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new ProjectError("OPERATION_ID_REUSED", "同一操作标识不能用于不同请求");
        return structuredClone(previous);
      }
      const asset = this.state.assets[input.assetId];
      if (!asset || asset.availability === "deleted")
        throw new ProjectError("ASSET_NOT_FOUND", "资产不存在或已移除");
      if (
        containsAssetReference(this.state.canvas, input.assetId) ||
        containsAssetReference(this.state.compositions, input.assetId) ||
        containsAssetReference(this.state.jobs, input.assetId)
      )
        throw new ProjectError("ASSET_IN_USE", "资产仍被项目内容引用");
      if (input.expectedRevision !== this.state.revision)
        throw new ProjectError("PROJECT_CONFLICT", "项目修订号已变化，请刷新后重试");
      const revision = this.state.revision + 1;
      const receipt = {
        requestHash,
        revision,
        result: { assetId: input.assetId, removed: true },
      };
      const { commitHash: parentHash, ...current } = this.state;
      const body = {
        ...current,
        revision,
        parentHash,
        updatedAt: new Date().toISOString(),
        assets: {
          ...current.assets,
          [input.assetId]: {
            ...asset,
            availability: "deleted" as const,
            deletedAt: new Date().toISOString(),
          },
        },
        operationReceipts: { ...current.operationReceipts, [input.operationId]: receipt },
      };
      await this.publish({ ...body, commitHash: contentHash(body) });
      return structuredClone(receipt);
    });
  }

  getCanvas() {
    const { canvas, revision } = this.state;
    return { canvas: projectCanvas(canvas), canvasRevision: canvas.revision, revision };
  }

  readCanvas() {
    return this.enqueue(async () => {
      await this.owner.assertCurrent();
      await this.recoverFailedCommit();
      return this.getCanvas();
    });
  }

  updateGeneration<Result>(
    update: (
      state: ProjectState,
    ) => { result: Result; changed: boolean } | Promise<{ result: Result; changed: boolean }>,
    signal?: AbortSignal,
  ) {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.owner.assertCurrent();
      await this.recoverFailedCommit();
      const state = this.snapshot;
      const { result, changed } = await update(state);
      if (!changed) return result;
      const { commitHash: parentHash, ...body } = state;
      body.parentHash = parentHash;
      body.revision++;
      body.updatedAt = new Date().toISOString();
      await this.publish({ ...body, commitHash: contentHash(body) }, signal);
      return result;
    });
  }

  applyCanvasOperations(input: {
    operationId: string;
    expectedCanvasRevision: number;
    operations: CanvasOperation[];
  }): Promise<{ revision: number; canvasRevision: number }> {
    return this.enqueue(async () => {
      await this.owner.assertCurrent();
      if (
        !isOperationId(input.operationId) ||
        !Number.isSafeInteger(input.expectedCanvasRevision) ||
        input.expectedCanvasRevision < 1 ||
        !Value.Check(CanvasOperations, input.operations) ||
        Buffer.byteLength(JSON.stringify(input.operations), "utf8") > 8 * 1024 * 1024
      )
        throw new ProjectError("CANVAS_OPERATION_INVALID", "画布操作结构或大小无效");
      await this.recoverFailedCommit();
      const requestHash = contentHash({ kind: "canvas", ...input });
      const previous = this.state.operationReceipts[input.operationId];
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new ProjectError("OPERATION_ID_REUSED", "同一操作标识不能用于不同请求");
        return { revision: previous.revision, canvasRevision: previous.result as number };
      }
      if (input.expectedCanvasRevision !== this.state.canvas.revision)
        throw new ProjectError("CANVAS_REVISION_CONFLICT", "画布已更新，请检查本地更改");
      const { commitHash: parentHash, ...current } = this.state;
      const canvas = applyCanvas(this.state, input.operations);
      const revision = current.revision + 1;
      const receipt = { requestHash, revision, result: canvas.revision };
      const body = {
        ...current,
        revision,
        parentHash,
        updatedAt: new Date().toISOString(),
        canvas,
        operationReceipts: { ...current.operationReceipts, [input.operationId]: receipt },
      };
      await this.publish({ ...body, commitHash: contentHash(body) });
      return { revision, canvasRevision: canvas.revision };
    });
  }

  flush(): Promise<number> {
    return this.enqueue(async () => {
      await this.owner.assertCurrent();
      if (this.faulted) throw new ProjectError("PROJECT_SAVE_FAILED", "请重新打开项目核对提交结果");
      return this.state.revision;
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
    const temporary = join(this.directory, "tmp");
    for (const entry of await readdir(temporary)) {
      if (/^[a-f0-9-]{36}\.asset$/.test(entry))
        await unlink(join(temporary, entry)).catch(() => undefined);
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

  private async recoverFailedCommit() {
    if (!this.faulted) return;
    const stateDirectory = join(this.directory, "state");
    await requireDirectory(stateDirectory);
    await syncDirectory(stateDirectory);
    await this.recover();
    this.faulted = false;
    await this.rebuildManifest();
  }

  private async publish(next: ProjectState, signal?: AbortSignal): Promise<void> {
    if (this.faulted) throw new ProjectError("PROJECT_SAVE_FAILED", "请重新打开项目核对提交结果");
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
      if (signal?.aborted) throw new ProjectError("ASSET_IMPORT_CANCELLED", "导入已取消");
      await link(temporary, destination);
      await this.options.onStage?.("snapshot-published");
      await syncDirectory(stateDirectory);
      await this.options.onStage?.("directory-synced");
      this.state = next;
    } catch (cause) {
      if (cause instanceof ProjectError && cause.code === "ASSET_IMPORT_CANCELLED") throw cause;
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
