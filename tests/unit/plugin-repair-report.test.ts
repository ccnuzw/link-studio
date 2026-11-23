import { expect, it } from "vitest";
import {
  normalizeUploadIssues,
  uploadRepairReport,
} from "../../src/renderer/settings/repair-report";

it("预检响应忽略非列表、去重并保留同一路径的问题顺序", () => {
  for (const raw of [undefined, null, "error", { path: "meta" }])
    expect(normalizeUploadIssues(raw)).toEqual([]);
  expect(
    normalizeUploadIssues([
      null,
      1,
      { path: " meta ", message: " 第二项 " },
      { path: "meta", message: "第一项" },
      { path: "meta", message: "第二项" },
      { path: false, message: " " },
    ]),
  ).toEqual([
    { path: "", message: "未知问题" },
    { path: "meta", message: "第二项" },
    { path: "meta", message: "第一项" },
  ]);
});

it("上传修复信息保留问题路径、整文件问题和续行缩进", () => {
  const report = uploadRepairReport([
    { path: "meta.auth.type", message: "无效类型" },
    { path: "", message: "整文件错误\r\n 第二行" },
  ]);
  expect(report).toContain("输出完整的 .js 文件");
  expect(report).toContain(
    "阶段：上传预检\n\n问题：\n- meta.auth.type：无效类型\n- （整个文件）：整文件错误\n   第二行",
  );
});

it("按 UTF-8 字节控制问题和整个报告的长度，保留完整字符", () => {
  const issue = { path: "meta.name", message: "🖼中".repeat(1000) };
  const line = uploadRepairReport([issue]).split("- meta.name：")[1]!;
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
  const report = uploadRepairReport(Array.from({ length: 20 }, () => issue));
  expect(Buffer.byteLength(report)).toBeLessThanOrEqual(16384);
  for (const text of [line, report]) {
    expect(text.endsWith("…（已截断）")).toBe(true);
    expect(Buffer.from(text).toString()).toBe(text);
  }
});
