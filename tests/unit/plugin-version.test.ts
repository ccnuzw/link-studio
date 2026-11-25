import { expect, it } from "vitest";
import { declaredPluginVersion, nextPluginVersion } from "../../src/main/settings/plugin-version";

it.each([
  undefined,
  null,
  1.5,
  "",
  "v1.0",
  "1.0",
  "01.2.3",
  "1.2.3-a_b",
  "1.0.0\n",
  `1.0.0-${"a".repeat(27)}`,
])("非法声明 %s 按未填写处理", (declared) => {
  expect(declaredPluginVersion(declared)).toBe("");
  expect(nextPluginVersion(declared, [])).toBe("1.0.0");
  expect(nextPluginVersion(declared, ["1.0.0-rc.1", "1.0.0"])).toBe("1.0.1");
});

it("比较版本时区分 uint64 数字段与超出范围的预发布标识", () => {
  const maximum = "18446744073709551615";
  const overflow = "18446744073709551616";
  expect(nextPluginVersion(`1.0.0-${overflow}`, [`1.0.0-${maximum}`])).toBe(`1.0.0-${overflow}`);
  expect(nextPluginVersion(`1.0.0-${overflow}`, ["1.0.0-1a"])).toBe("1.0.1");
  expect(nextPluginVersion(`1.0.${overflow}`, [])).toBe(`1.0.${overflow}`);
  expect(nextPluginVersion(`1.0.${overflow}`, [`1.0.${overflow}`])).toBe("1.0.0");
  expect(nextPluginVersion(`1.0.${overflow}`, ["1.0.0"])).toBe("1.0.1");
  expect(() => nextPluginVersion("", [`1.0.${maximum}`])).toThrow("PLUGIN_VERSION_LIMIT");
});
