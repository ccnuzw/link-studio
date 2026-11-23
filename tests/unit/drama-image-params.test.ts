import { dramaImageFields, type ModelConfig, settleDramaImageParams } from "@link-studio/core";
import { expect, test } from "vitest";

const plugins = [{ key: "doubao-image", hash: "image", origin: "builtin" as const }];
const model = { model: "doubao-seedream-4-0", channel: {}, pluginHash: "image" };
const config: ModelConfig = {
  name: "物品图像",
  kind: "image",
  description: "",
  sort: 0,
  params: {
    aspectRatio: { values: ["1:1", "16:9", "9:16"], default: "1:1" },
    resolution: { values: ["4K", "2K"], default: "2K" },
  },
};

test("比例与档位只显示开放且受支持的枚举，保留模型选项顺序", () => {
  const fields = dramaImageFields({ ...model, config }, plugins);
  expect(fields.ratios).toEqual(["1:1", "16:9", "9:16"]);
  expect(settleDramaImageParams(fields, "scene")).toEqual({
    aspectRatio: "16:9",
    resolution: "2K",
  });
  const closed = dramaImageFields(
    {
      ...model,
      config: { ...config, params: { resolution: { values: ["4K"], default: "4K", open: false } } },
    },
    plugins,
  );
  expect(settleDramaImageParams(closed, "prop", { aspectRatio: "1:1", resolution: "4K" })).toEqual(
    {},
  );
  expect(
    dramaImageFields({ ...model, config: { ...config, parameterOrder: ["resolution"] } }, plugins)
      .ratios,
  ).toEqual([]);
});

test("未声明默认档位时不默选第一项，暂时不支持手选值时不改写偏好", () => {
  const picks = { resolution: "4K", aspectRatio: "9:16" };
  const fields = dramaImageFields(model, plugins);
  expect(settleDramaImageParams(fields, "character")).toEqual({ aspectRatio: "16:9" });
  expect(settleDramaImageParams(dramaImageFields(undefined, plugins), "scene", picks)).toEqual({});
  expect(
    settleDramaImageParams(
      { ...fields, ratios: ["3:2", "1:1"], resolutions: ["2K"], defaultResolution: "2K" },
      "character",
      picks,
    ),
  ).toEqual({ aspectRatio: "1:1", resolution: "2K" });
  expect(settleDramaImageParams(fields, "prop", picks)).toEqual({
    aspectRatio: "9:16",
    resolution: "4K",
  });
});
