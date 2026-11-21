import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [mode = "quality", ...options] = process.argv.slice(2);
if (!["quality", "desktop"].includes(mode) || options.some((option) => option !== "--package")) {
  throw new Error("用法：node scripts/check.mjs quality|desktop [--package]");
}
if (mode === "quality" && options.length) throw new Error("--package 仅用于 desktop 检查");

function run(command, args, environment = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...environment },
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function verifyIntegrationReport() {
  const report = JSON.parse(
    await readFile(new URL("../test-results/integration.json", import.meta.url), "utf8"),
  );
  const required = [
    "provider-runtime.test.ts",
    "media-composition.test.ts",
    "agent-runtime.test.ts",
    "build-artifacts.test.ts",
    "generation.test.ts",
  ];
  for (const filename of required) {
    const suite = report.testResults.find((result) => result.name.endsWith(`/${filename}`));
    if (
      !suite?.assertionResults.length ||
      suite.assertionResults.some((result) => result.status !== "passed")
    ) {
      throw new Error(`关键集成测试未完整通过：${filename}`);
    }
  }
  if (!report.success || report.numPendingTests > 0 || report.numTodoTests > 0) {
    throw new Error("集成测试失败或存在跳过/待实现的测试");
  }
}

async function runE2E(name, environment = {}) {
  const path = `test-results/${name}.json`;
  run("pnpm", ["exec", "playwright", "test", "--reporter=line,json"], {
    ...environment,
    PLAYWRIGHT_JSON_OUTPUT_FILE: path,
  });
  const report = JSON.parse(await readFile(new URL(path, new URL("..", import.meta.url)), "utf8"));
  if (
    report.stats.expected < 1 ||
    report.stats.skipped ||
    report.stats.unexpected ||
    report.stats.flaky
  ) {
    throw new Error("桌面 E2E 必须实际执行且全部通过，不允许跳过或依赖重试通过");
  }
}

if (mode === "quality") {
  for (const script of ["typecheck", "lint", "test"]) run("pnpm", [script]);
} else {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("完整桌面检查当前要求 macOS arm64，不能用其他平台的跳过结果代替");
  }
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  run("pnpm", ["build"]);
  run("pnpm", [
    "exec",
    "vitest",
    "run",
    "--project",
    "integration",
    "--reporter=default",
    "--reporter=json",
    "--outputFile=test-results/integration.json",
  ]);
  await verifyIntegrationReport();
  run("pnpm", ["test:agent:upstream"]);
  await runE2E("desktop");
  if (options.includes("--package")) {
    run("pnpm", ["exec", "electron-builder", "--mac", "dir", "--arm64", "--publish", "never"], {
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });
    await runE2E("packaged", {
      LINK_STUDIO_E2E_EXECUTABLE: fileURLToPath(
        new URL("../release/mac-arm64/灵可.app/Contents/MacOS/灵可", import.meta.url),
      ),
    });
  }
}
