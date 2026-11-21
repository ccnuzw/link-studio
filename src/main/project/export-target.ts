import { randomUUID } from "node:crypto";
import { link, lstat, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ProjectError } from "./errors.ts";

export interface ExportTargetTransaction {
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface ExportTargetIdentity {
  exists: boolean;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

async function restoreBackupSafely(target: string, backup: string | undefined) {
  if (!backup) {
    const current = await lstat(target).catch(() => undefined);
    if (current) throw new ProjectError("EXPORT_COMMIT_UNKNOWN", "导出目标恢复时发现外部文件");
    return;
  }
  const current = await lstat(target).catch(() => undefined);
  if (current) throw new ProjectError("EXPORT_COMMIT_UNKNOWN", "导出目标恢复时发现外部文件");
  await rename(backup, target);
}

function identityOf(entry: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): ExportTargetIdentity {
  return {
    exists: true,
    dev: entry.dev,
    ino: entry.ino,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
  };
}

function matchesIdentity(
  entry: Awaited<ReturnType<typeof lstat>> | undefined,
  expected: ExportTargetIdentity,
) {
  return (
    expected.exists === Boolean(entry) &&
    (!entry ||
      (entry.dev === expected.dev &&
        entry.ino === expected.ino &&
        entry.size === expected.size &&
        entry.mtimeMs === expected.mtimeMs &&
        entry.ctimeMs === expected.ctimeMs))
  );
}

export async function installExportTarget(
  temporaryTarget: string,
  target: string,
  expected: ExportTargetIdentity,
): Promise<ExportTargetTransaction> {
  const temporary = await lstat(temporaryTarget).catch(() => undefined);
  if (!temporary?.isFile() || temporary.isSymbolicLink())
    throw new ProjectError("EXPORT_MEDIA_INVALID", "导出文件不存在或不是普通文件");

  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new ProjectError("EXPORT_TARGET_BUSY", "导出目标不是普通文件");
  if (
    expected.exists !== Boolean(existing) ||
    (existing &&
      (existing.dev !== expected.dev ||
        existing.ino !== expected.ino ||
        existing.size !== expected.size ||
        existing.mtimeMs !== expected.mtimeMs ||
        existing.ctimeMs !== expected.ctimeMs))
  )
    throw new ProjectError("EXPORT_TARGET_CHANGED", "导出目标在确认后发生变化");

  const backup = existing
    ? join(dirname(target), `.link-studio-export-backup-${randomUUID()}-${basename(target)}`)
    : undefined;
  try {
    if (backup) await rename(target, backup);
    try {
      await link(temporaryTarget, target);
      await unlink(temporaryTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ProjectError("EXPORT_TARGET_CHANGED", "导出目标在确认后发生变化");
      throw error;
    }
  } catch (cause) {
    try {
      await restoreBackupSafely(target, backup);
    } catch (restoreCause) {
      throw new ProjectError("EXPORT_COMMIT_UNKNOWN", "导出目标恢复失败，请检查目标文件", {
        cause: restoreCause,
      });
    }
    if (cause instanceof ProjectError) throw cause;
    throw new ProjectError("EXPORT_TARGET_BUSY", "无法安装导出文件", { cause });
  }

  const installed = await lstat(target).catch(() => undefined);
  if (!installed?.isFile() || installed.isSymbolicLink()) {
    await restoreBackupSafely(target, backup).catch(() => undefined);
    throw new ProjectError("EXPORT_COMMIT_UNKNOWN", "导出目标安装状态未知，请检查目标文件");
  }
  const installedIdentity = identityOf(installed);

  let settled = false;
  return {
    async rollback() {
      if (settled) return;
      settled = true;
      try {
        const current = await lstat(target).catch(() => undefined);
        if (!matchesIdentity(current, installedIdentity))
          throw new ProjectError("EXPORT_COMMIT_UNKNOWN", "导出目标在回滚前发生变化");
        if (current) await rm(target, { force: true });
        if (backup) await rename(backup, target);
      } catch (cause) {
        throw new ProjectError("EXPORT_COMMIT_UNKNOWN", "导出目标恢复失败，请检查目标文件", {
          cause,
        });
      }
    },
    async finalize() {
      if (settled) return;
      settled = true;
      await unlink(backup ?? "").catch(() => undefined);
    },
  };
}
