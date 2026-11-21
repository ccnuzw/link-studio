import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installExportTarget } from "../../src/main/project/export-target";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("export target transaction", () => {
  it("installs a new target and removes it on rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "link-export-target-"));
    directories.push(directory);
    const temporary = join(directory, "temporary.mp4");
    const target = join(directory, "output.mp4");
    await writeFile(temporary, "new");
    const transaction = await installExportTarget(temporary, target, { exists: false });
    await expect(readFile(target, "utf8")).resolves.toBe("new");
    await transaction.rollback();
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("restores an overwritten target on rollback and finalizes the backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "link-export-target-"));
    directories.push(directory);
    const temporary = join(directory, "temporary.mp4");
    const target = join(directory, "output.mp4");
    await writeFile(temporary, "new");
    await writeFile(target, "old");
    const entry = await lstat(target);
    const transaction = await installExportTarget(temporary, target, {
      exists: true,
      dev: entry.dev,
      ino: entry.ino,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
    });
    await transaction.rollback();
    await expect(readFile(target, "utf8")).resolves.toBe("old");
    await expect(readdir(directory)).resolves.toEqual(["output.mp4"]);
  });

  it("does not overwrite an externally changed target during a stale install", async () => {
    const directory = await mkdtemp(join(tmpdir(), "link-export-target-"));
    directories.push(directory);
    const temporary = join(directory, "temporary.mp4");
    const target = join(directory, "output.mp4");
    await writeFile(temporary, "new");
    const expected = { exists: false } as const;
    await writeFile(target, "external");
    const second = join(directory, "second.mp4");
    await writeFile(second, "second");
    await expect(installExportTarget(temporary, target, expected)).rejects.toMatchObject({
      code: "EXPORT_TARGET_CHANGED",
    });
    await expect(readFile(target, "utf8")).resolves.toBe("external");
  });

  it("refuses to roll back over a target changed after installation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "link-export-target-"));
    directories.push(directory);
    const temporary = join(directory, "temporary.mp4");
    const target = join(directory, "output.mp4");
    await writeFile(temporary, "new");
    const transaction = await installExportTarget(temporary, target, { exists: false });
    await writeFile(target, "external");
    await expect(transaction.rollback()).rejects.toMatchObject({ code: "EXPORT_COMMIT_UNKNOWN" });
    await expect(readFile(target, "utf8")).resolves.toBe("external");
  });
});
