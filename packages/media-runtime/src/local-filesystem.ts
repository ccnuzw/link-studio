import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function isLocalApfs(directory: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  try {
    await run("/bin/df", ["-T", "apfs", resolve(directory)], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
