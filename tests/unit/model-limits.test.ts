import { expect, it } from "vitest";
import { resolveModelLimits } from "../../src/main/settings/model-limits";

it("按原名、去日期和最新系列匹配，非法规格不会覆盖内置建议", () => {
  const expected = {
    found: true,
    source: "builtin",
    window: 128000,
    output: 16384,
    vision: true,
    video: false,
  };
  for (const name of [
    "OpenAI/GPT-4o:free",
    "gpt-4o@beta",
    "gpt-4o-271212-latest",
    "gpt-4o-2099-12-31",
    "gpt-4o",
  ])
    expect(resolveModelLimits(name)).toEqual(expected);
  for (const upstream of [
    { window: 128000, output: 128000 },
    { window: 128000, output: 0 },
    { window: 128000, output: 255 },
    { window: 10_000_001, output: 1000 },
  ])
    expect(resolveModelLimits("gpt-4o", upstream)).toEqual(expected);
  expect(resolveModelLimits("private-m", { window: 8_000_000, output: 1_000_001 })).toEqual({
    found: true,
    source: "upstream",
    window: 8_000_000,
    output: 1_000_000,
  });
  expect(resolveModelLimits("private-m")).toEqual({ found: false });
});
