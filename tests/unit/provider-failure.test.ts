import { describe, expect, it } from "vitest";
import { providerFailureMessage } from "../../src/main/settings/provider-failure";

describe("供应商失败原因展示", () => {
  const clean = (value: unknown) =>
    providerFailureMessage(value, (text) => text.replaceAll("my-key", "[已移除]"), [
      "请画一张图",
      ["https://ref.invalid/private"],
    ]);
  it("优先清理完整输入和地址，再限制单行展示长度", () => {
    expect(clean("审核失败\n请画一张图 my-key https://remote.invalid/p?a=private")).toBe(
      "审核失败 [已隐藏] [已移除] [地址已隐藏]",
    );
    expect(clean("坏😀".repeat(180))).toBe("坏😀".repeat(150));
  });
  it.each([
    null,
    "",
    "   ",
    "X".repeat(5000),
    "Authorization: Digest test",
    '{"error":"private"}',
    "预计失败 ?sig=one",
    "Bearer abc",
    "data:text/plain,private",
  ])("对不可展示的诊断使用稳定错误码：%#", (value) => {
    expect(clean(value)).toBeUndefined();
  });
});
