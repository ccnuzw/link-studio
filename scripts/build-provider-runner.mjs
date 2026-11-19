import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, "out", "provider-runtime");
mkdirSync(target, { recursive: true });
execFileSync(
  "go",
  [
    "build",
    "-trimpath",
    "-o",
    join(target, process.platform === "win32" ? "runner.exe" : "runner"),
    ".",
  ],
  {
    cwd: join(root, "packages/provider-runtime/runner"),
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: "inherit",
  },
);
