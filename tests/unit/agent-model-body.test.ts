import { expect, it } from "vitest";
import { modelBodySha } from "../../src/main/settings/model-body-sha";

it("模型快照与 4277d16f configbody.ModelSHA256 的两个状态一致", () => {
  const body = { key: "demo", nested: { a: 1, z: 2 }, label: "猫<&>", enabled: true };
  expect(modelBodySha(body)).toBe(
    "340d861c70ed898b7d64364e00e5d40decdf7e6a8e0d80b450a59807b8a1587d",
  );
  expect(modelBodySha({ ...body, enabled: false })).toBe(
    "d9a6b56510ab315b2aa12f53fca5729bbff68cfcedd8dcf78a78baba38280e92",
  );
});
