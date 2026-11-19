import { describe, expect, it } from "vitest";
import { normalizeProjectName } from "../../packages/link-studio-core/src/project";
import { canonicalJson, contentHash } from "../../src/main/project/encoding";

describe("项目规范 JSON", () => {
  it("递归排序对象，保留数组顺序，拒绝非 JSON 值", () => {
    expect(canonicalJson({ z: [{ beta: 2, alpha: 1 }], a: -0 })).toBe(
      '{"a":0,"z":[{"alpha":1,"beta":2}]}',
    );
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    for (const value of [undefined, Number.NaN, Infinity, 1n, new Date(), { a: undefined }]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    expect(() => canonicalJson(Array(1))).toThrow();
  });

  it("名称按码点计数并拒绝控制字符和路径分隔符", () => {
    expect(normalizeProjectName("  灵可  ")).toBe("灵可");
    expect(normalizeProjectName("🎬".repeat(100))).toBe("🎬".repeat(100));
    for (const value of ["", " ", "../项目", "a\\b", "a\nb", "🎬".repeat(101)]) {
      expect(normalizeProjectName(value)).toBeNull();
    }
  });
});
