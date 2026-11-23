import { describe, expect, it } from "vitest";
import {
  canvasNoticeKind,
  canvasNoticeTitle,
} from "../../packages/link-studio-core/src/agent-notice";

describe("后台画布系统通知", () => {
  it.each([
    ["approval.created", { kind: "generate", status: "pending" }, "approval"],
    ["approval.created", { kind: "ask", status: "pending" }, undefined],
    ["approval.created", { kind: "delete", status: "pending" }, undefined],
    ["approval.created", { kind: "generate", status: "approved" }, undefined],
    ["approval.resolved", { kind: "generate", status: "pending" }, undefined],
    ["tasks.settled", { steer: false }, "settled"],
    ["tasks.settled", { steer: true }, undefined],
    ["tasks.settled", { steer: false, receipt_only: true }, undefined],
    ["tasks.settled", {}, undefined],
    ["tasks.settled", null, undefined],
  ] as const)("%s %j", (type, payload, expected) => {
    expect(canvasNoticeKind(type, payload)).toBe(expected);
  });

  it("只显示画布标题及固定文案", () => {
    expect(canvasNoticeTitle("approval", " 片头 ")).toBe("片头：Agent 需要你批准一批生成");
    expect(canvasNoticeTitle("settled", "  ")).toBe("未命名画布：生成已完成，Agent 正在验收");
  });
});
