import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tryLock, unlock } from "fs-native-extensions";
import { isLocalApfs } from "../../../packages/media-runtime/src/local-filesystem.ts";
import { ProjectError } from "./errors.ts";

export async function requireDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ProjectError("PROJECT_PATH_DENIED", "项目内部目录必须是本地实体目录");
  }
}

export class ProjectOwnership {
  private released = false;

  private constructor(
    readonly directory: string,
    private readonly descriptor: FileHandle,
    private readonly identities: { path: string; dev: number; ino: number }[],
  ) {}

  static async acquire(directory: string): Promise<ProjectOwnership> {
    const canonical = await realpath(directory);
    if (
      /\/(?:Library\/CloudStorage|Library\/Mobile Documents)(?:\/|$)/.test(canonical) ||
      !(await isLocalApfs(canonical))
    ) {
      throw new ProjectError(
        "PROJECT_FILESYSTEM_UNSUPPORTED",
        "M0 当前仅开放 macOS 本机 APFS 目录；其他平台和同步目录需单独验证",
      );
    }
    await requireDirectory(canonical);
    const runtime = join(canonical, ".runtime");
    await mkdir(runtime, { recursive: true });
    await requireDirectory(runtime);
    const lockPath = join(runtime, "owner.lock");
    const descriptor = await open(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    let locked = false;
    try {
      locked = tryLock(descriptor.fd);
      if (!locked) throw new ProjectError("PROJECT_IN_USE", "项目正由另一个会话占用");
      const identities = [];
      for (const path of [canonical, runtime, lockPath]) {
        const entry = await lstat(path);
        identities.push({ path, dev: entry.dev, ino: entry.ino });
      }
      const handleStat = await descriptor.stat();
      const lockIdentity = identities.at(-1);
      if (lockIdentity?.dev !== handleStat.dev || lockIdentity.ino !== handleStat.ino) {
        throw new ProjectError("PROJECT_PATH_DENIED", "锁文件已被外部替换");
      }
      return new ProjectOwnership(canonical, descriptor, identities);
    } catch (error) {
      if (locked) unlock(descriptor.fd);
      await descriptor.close();
      throw error;
    }
  }

  async assertCurrent(): Promise<void> {
    if (this.released) throw new ProjectError("PROJECT_CLOSED", "项目会话已关闭");
    for (const identity of this.identities) {
      const current = await lstat(identity.path).catch(() => null);
      if (
        !current ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        throw new ProjectError("PROJECT_PATH_DENIED", "项目目录或锁被外部移动、删除或替换");
      }
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      unlock(this.descriptor.fd);
    } finally {
      await this.descriptor.close();
    }
  }
}
