import { randomUUID } from "node:crypto";
import { type AppInfo, isAppInfo, isAppInfoRequest } from "@link-studio/core";
import { describe, expect, it } from "vitest";
import { getAppInfo } from "../../src/main/app-info";
import { isTrustedDocument } from "../../src/main/security";

const info: AppInfo = {
  productName: "灵可",
  agentName: "小灵",
  version: "0.1.0",
  platform: "darwin",
  arch: "arm64",
  electron: "45.4.1",
  chromium: "134",
  node: "22.23.0",
  packaged: false,
};

describe("桌面契约", () => {
  it("校验请求并拒绝额外字段和任意载荷", () => {
    expect(isAppInfoRequest({ requestId: randomUUID() })).toBe(true);
    for (const input of [
      null,
      {},
      [],
      { requestId: 1 },
      { requestId: randomUUID(), path: "/tmp" },
    ]) {
      expect(isAppInfoRequest(input)).toBe(false);
    }
  });
  it("只返回已声明的运行信息", () => {
    expect(isAppInfo(info)).toBe(true);
    expect(isAppInfo({ ...info, secret: "forbidden" })).toBe(false);
    expect(getAppInfo({ requestId: randomUUID() }, true, info)).toEqual({ ok: true, data: info });
  });
  it("在执行前拒绝不可信来源及无效参数", () => {
    expect(getAppInfo({}, false, info)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(getAppInfo({}, true, info)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });
});

describe("文档来源校验", () => {
  const trusted = "file:///Applications/Link/out/renderer/index.html";
  it("只允许自身文档及页内导航", () => {
    expect(isTrustedDocument(trusted, trusted)).toBe(true);
    expect(isTrustedDocument(`${trusted}#canvas`, trusted)).toBe(true);
    for (const candidate of [
      "https://evil.example",
      `${trusted}?injected=1`,
      "file:///etc/passwd",
      "invalid",
    ]) {
      expect(isTrustedDocument(candidate, trusted)).toBe(false);
    }
  });
  it("开发环境同样校验端口与路径", () => {
    expect(isTrustedDocument("http://localhost:5173/", "http://localhost:5173/")).toBe(true);
    expect(isTrustedDocument("http://localhost:5174/", "http://localhost:5173/")).toBe(false);
    expect(isTrustedDocument("http://localhost:5173/other", "http://localhost:5173/")).toBe(false);
  });
});
