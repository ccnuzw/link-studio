import { appendFile, readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";

const steps = JSON.parse(process.env.CHECK_STEPS);
const stages = [
  ["build", "Build"],
  ["integration", "Integration", "integration"],
  ["upstream", "Agent upstream"],
  ["e2e", "Electron E2E", "desktop"],
];
if (process.env.PACKAGE_SMOKE === "true")
  stages.push(["package", "Package"], ["packaged_e2e", "Packaged E2E", "packaged"]);

function diagnostic(title, message = "") {
  const detail = stripVTControlCharacters(message).trim().split("\n").slice(0, 8).join("\n");
  return detail ? `${title}\n${detail.slice(0, 1200)}` : title;
}

function playwrightFailures(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests
        .filter((test) => test.status !== "expected")
        .map((test) => {
          const result = test.results.find((attempt) => attempt.errors?.length);
          return diagnostic(`${spec.file}:${spec.line} ${spec.title}`, result?.errors[0]?.message);
        }),
    ),
    ...playwrightFailures(suite.suites ?? []),
  ]);
}

const lines = [
  "### Desktop macOS ARM64",
  `PR / push \`${process.env.HEAD_SHA}\` · checkout \`${process.env.GITHUB_SHA}\``,
  "",
  "| Stage | Result | Duration |",
  "| --- | --- | --- |",
];
const failures = [];
for (const [id, label, reportName] of stages) {
  const step = steps[id];
  const seconds = step?.outputs?.seconds;
  lines.push(`| ${label} | ${step?.outcome ?? "skipped"} | ${seconds ? `${seconds}s` : "—"} |`);
  if (step?.outcome !== "failure" || !reportName) continue;
  try {
    const report = JSON.parse(await readFile(`test-results/${reportName}.json`, "utf8"));
    if (id === "integration") {
      for (const suite of report.testResults) {
        for (const test of suite.assertionResults ?? []) {
          if (test.status !== "passed")
            failures.push(
              diagnostic(`${suite.name} · ${test.fullName}`, test.failureMessages?.[0]),
            );
        }
      }
    } else {
      failures.push(...playwrightFailures(report.suites));
      for (const error of report.errors ?? [])
        failures.push(diagnostic("Playwright", error.message));
    }
  } catch (error) {
    console.warn(`无法读取 ${reportName} 报告：${error.message}`);
  }
}
if (failures.length) {
  const text = failures
    .join("\n")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  lines.push("", "失败或未通过的用例", `<pre>${text}</pre>`);
}
if (process.env.EVIDENCE_URL) lines.push("", `[下载测试报告与 trace](${process.env.EVIDENCE_URL})`);
await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
