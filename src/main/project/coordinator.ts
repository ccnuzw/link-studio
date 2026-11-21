import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  isOperationId,
  normalizeProjectName,
} from "../../../packages/link-studio-core/src/project.ts";
import type { ProjectSession } from "../../../packages/link-studio-core/src/projects-api.ts";
import { ProjectError } from "./errors.ts";
import { ProjectStore } from "./store.ts";

export interface WindowLease {
  focus: () => void;
}

interface DirectoryGrant {
  owner: WindowLease;
  directory: string;
  identity: string;
  expiresAt: number;
  purpose: "create" | "open";
}

interface ProjectEntry {
  owner: WindowLease;
  handle: string;
  store: ProjectStore;
}

async function directoryIdentity(directory: string) {
  const canonical = await realpath(directory);
  const entry = await lstat(canonical);
  if (!entry.isDirectory()) throw new ProjectError("PROJECT_PATH_DENIED", "授权目标必须是目录");
  return { canonical, identity: `${entry.dev}:${entry.ino}` };
}

export class ProjectCoordinator {
  private readonly windows = new Map<number, WindowLease>();
  private readonly releases = new Map<WindowLease, Promise<void>>();
  private readonly grants = new Map<string, DirectoryGrant>();
  private readonly projects = new Map<string, ProjectEntry>();
  private readonly creates = new Map<
    string,
    { owner: WindowLease; requestHash: string; session: ProjectSession }
  >();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now) {}

  registerWindow(windowId: number, focus: () => void) {
    if (!Number.isSafeInteger(windowId) || this.windows.has(windowId))
      throw new ProjectError("PROJECT_PATH_DENIED", "窗口未注册或重复注册");
    const owner = { focus };
    this.windows.set(windowId, owner);
    return owner;
  }

  async grantProjectDirectory(
    windowId: number,
    directory: string,
    purpose: "create" | "open" = "open",
  ) {
    const owner = this.owner(windowId);
    const { canonical, identity } = await directoryIdentity(directory);
    this.assertOwner(windowId, owner);
    for (const [key, grant] of this.grants)
      if (grant.expiresAt <= this.now()) this.grants.delete(key);
    const token = randomUUID();
    this.grants.set(token, {
      owner,
      directory: canonical,
      identity,
      expiresAt: this.now() + 600_000,
      purpose,
    });
    return token;
  }

  open(windowId: number, directoryToken: string, purpose: "create" | "open" = "open") {
    const owner = this.owner(windowId);
    return this.enqueue(
      async (): Promise<
        { disposition: "opened"; session: ProjectSession } | { disposition: "focusedExisting" }
      > => {
        this.assertOwner(windowId, owner);
        const grant = this.grants.get(directoryToken);
        if (
          !grant ||
          grant.owner !== owner ||
          grant.purpose !== purpose ||
          grant.expiresAt <= this.now()
        )
          throw new ProjectError("TOKEN_INVALID_OR_EXPIRED", "请重新选择项目目录");
        const current = await directoryIdentity(grant.directory);
        this.assertOwner(windowId, owner);
        this.grants.delete(directoryToken);
        if (current.identity !== grant.identity)
          throw new ProjectError("PROJECT_PATH_DENIED", "授权目录已被外部替换");
        const existing = this.projects.get(grant.identity);
        if (existing) {
          await existing.store.flush();
          existing.owner.focus();
          return { disposition: "focusedExisting" };
        }
        const store = await ProjectStore.open(current.canonical);
        try {
          this.assertOwner(windowId, owner);
          const verified = await directoryIdentity(current.canonical);
          if (verified.identity !== grant.identity)
            throw new ProjectError("PROJECT_PATH_DENIED", "项目目录已被外部替换");
          const project = { owner, handle: randomUUID(), store };
          this.projects.set(grant.identity, project);
          return { disposition: "opened", session: this.session(project) };
        } catch (error) {
          await store.close();
          throw error;
        }
      },
    );
  }

  create(windowId: number, directoryToken: string, operationId: string, name: string) {
    const owner = this.owner(windowId);
    return this.enqueue(async () => {
      this.assertOwner(windowId, owner);
      const grant = this.grants.get(directoryToken);
      if (
        !grant ||
        grant.owner !== owner ||
        grant.purpose !== "create" ||
        grant.expiresAt <= this.now()
      )
        throw new ProjectError("TOKEN_INVALID_OR_EXPIRED", "请重新选择项目位置");
      if (!isOperationId(operationId) || !normalizeProjectName(name))
        throw new ProjectError("PROJECT_SCHEMA_INVALID", "无效项目创建请求");
      const parent = await directoryIdentity(grant.directory);
      this.assertOwner(windowId, owner);
      this.grants.delete(directoryToken);
      if (parent.identity !== grant.identity)
        throw new ProjectError("PROJECT_PATH_DENIED", "授权位置已被外部替换");
      const requestHash = `${grant.identity}:${normalizeProjectName(name)}`;
      const prior = this.creates.get(operationId);
      if (prior) {
        if (prior.owner !== owner)
          throw new ProjectError("PROJECT_PATH_DENIED", "创建操作属于其他窗口");
        if (prior.requestHash !== requestHash)
          throw new ProjectError("OPERATION_ID_REUSED", "同一操作标识不能用于不同请求");
        return this.session(this.project(owner, prior.session.projectHandle));
      }
      const store = await ProjectStore.create(parent.canonical, name);
      try {
        const verified = await directoryIdentity(store.directory);
        this.assertOwner(windowId, owner);
        const project = { owner, handle: randomUUID(), store };
        this.projects.set(verified.identity, project);
        const session = this.session(project);
        this.creates.set(operationId, { owner, requestHash, session });
        return session;
      } catch (error) {
        await store.close();
        throw error;
      }
    });
  }

  async authorizeRecent(windowId: number, directory: string) {
    const owner = this.owner(windowId);
    const { canonical, identity } = await directoryIdentity(directory);
    this.assertOwner(windowId, owner);
    const token = randomUUID();
    this.grants.set(token, {
      owner,
      directory: canonical,
      identity,
      expiresAt: this.now() + 600_000,
      purpose: "open",
    });
    return token;
  }

  async validateSelectedDirectory(directory: string) {
    return directoryIdentity(directory);
  }

  getSession(windowId: number, projectHandle: string) {
    return this.session(this.project(this.owner(windowId), projectHandle));
  }

  getDirectory(windowId: number, projectHandle: string) {
    return this.project(this.owner(windowId), projectHandle).store.directory;
  }

  getStore(windowId: number, projectHandle: string) {
    return this.project(this.owner(windowId), projectHandle).store;
  }

  withStore<T>(windowId: number, projectHandle: string, run: (store: ProjectStore) => Promise<T>) {
    const owner = this.owner(windowId);
    return this.enqueue(async () => {
      this.assertOwner(windowId, owner);
      return run(this.project(owner, projectHandle).store);
    });
  }

  flush(windowId: number, projectHandle: string) {
    const owner = this.owner(windowId);
    return this.enqueue(async () => {
      this.assertOwner(windowId, owner);
      const project = this.project(owner, projectHandle);
      const revision = await project.store.flush();
      this.assertOwner(windowId, owner);
      return { revision };
    });
  }

  getState(windowId: number, projectHandle: string) {
    const owner = this.owner(windowId);
    return this.enqueue(async () => {
      this.assertOwner(windowId, owner);
      const project = this.project(owner, projectHandle);
      await project.store.flush();
      this.assertOwner(windowId, owner);
      return { session: this.session(project) };
    });
  }

  closeWindows(windowIds: number[]) {
    const owners = windowIds.map((windowId) => ({ windowId, owner: this.owner(windowId) }));
    return this.enqueue(async () => {
      for (const { windowId, owner } of owners) this.assertOwner(windowId, owner);
      const projects = [...this.projects.values()].filter((project) =>
        owners.some(({ owner }) => owner === project.owner),
      );
      for (const project of projects) await project.store.flush();
      for (const { windowId, owner } of owners) {
        this.assertOwner(windowId, owner);
        this.windows.delete(windowId);
        for (const [token, grant] of this.grants)
          if (grant.owner === owner) this.grants.delete(token);
        for (const [id, receipt] of this.creates)
          if (receipt.owner === owner) this.creates.delete(id);
      }
      for (const project of projects) {
        await project.store.close();
        this.remove(project);
      }
    });
  }

  rename(
    windowId: number,
    input: { projectHandle: string; operationId: string; expectedRevision: number; name: string },
  ) {
    const owner = this.owner(windowId);
    const request = { ...input };
    return this.enqueue(async () => {
      this.assertOwner(windowId, owner);
      const project = this.project(owner, request.projectHandle);
      if (
        typeof request.name !== "string" ||
        !normalizeProjectName(request.name) ||
        !isOperationId(request.operationId) ||
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision < 1
      )
        throw new ProjectError("PROJECT_SCHEMA_INVALID", "无效项目变更请求");
      const receipt = await project.store.rename({
        operationId: request.operationId,
        expectedRevision: request.expectedRevision,
        name: request.name,
      });
      return { revision: receipt.revision, name: (receipt.result as { name: string }).name };
    });
  }

  close(windowId: number, projectHandle: string) {
    const owner = this.owner(windowId);
    return this.enqueue(async () => {
      this.assertOwner(windowId, owner);
      const project = this.project(owner, projectHandle);
      await project.store.flush();
      await project.store.close();
      this.remove(project);
    });
  }

  releaseWindow(windowId: number, lease?: WindowLease): Promise<void> {
    const owner = this.windows.get(windowId);
    if (!owner || (lease && owner !== lease)) {
      return lease ? (this.releases.get(lease) ?? Promise.resolve()) : Promise.resolve();
    }
    const inFlight = this.releases.get(owner);
    if (inFlight) return inFlight;
    this.windows.delete(windowId);
    for (const [token, grant] of this.grants) if (grant.owner === owner) this.grants.delete(token);
    for (const [id, receipt] of this.creates) if (receipt.owner === owner) this.creates.delete(id);
    const released = this.enqueue(async () => {
      for (const project of [...this.projects.values()]) {
        if (project.owner !== owner) continue;
        await project.store.close();
        this.remove(project);
      }
    });
    this.releases.set(owner, released);
    return released;
  }

  private owner(windowId: number): WindowLease {
    const owner = this.windows.get(windowId);
    if (!owner) throw new ProjectError("PROJECT_PATH_DENIED", "窗口授权已失效");
    return owner;
  }

  private assertOwner(windowId: number, owner: WindowLease) {
    if (this.windows.get(windowId) !== owner)
      throw new ProjectError("PROJECT_PATH_DENIED", "窗口授权已失效");
  }

  private project(owner: WindowLease, handle: string) {
    const project = [...this.projects.values()].find(
      (entry) => entry.handle === handle && entry.owner === owner,
    );
    if (!project) throw new ProjectError("PROJECT_NOT_OPEN", "项目会话不可用");
    return project;
  }

  private session(project: ProjectEntry): ProjectSession {
    const state = project.store.snapshot;
    return {
      projectHandle: project.handle,
      projectId: state.projectId,
      name: state.name,
      schemaVersion: 1,
      revision: state.revision,
      recoveredFromPrevious: project.store.warnings.some((warning) => warning.startsWith("已保留")),
    };
  }

  private remove(project: ProjectEntry) {
    for (const [identity, entry] of this.projects)
      if (entry === project) this.projects.delete(identity);
  }

  private enqueue<Result>(action: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
