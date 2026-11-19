import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../packages/agent-runtime/upstream", import.meta.url));
const tests = [
  "engine",
  "engine-approval",
  "engine-steer",
  "engine-watch",
  "engine-recovery",
  "engine-compaction",
  "durable-tools",
  "store",
  "model-provider",
];
const child = spawn(
  process.execPath,
  [
    "--disable-warning=ExperimentalWarning",
    "--test",
    "--test-concurrency=1",
    ...tests.map((name) => `test/${name}.test.ts`),
  ],
  { cwd: directory, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
