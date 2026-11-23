import { modelGenerationOptions } from "@link-studio/core";
import { describe, expect, it } from "vitest";
import { planModelSwitch } from "../../src/renderer/workspace/model-switch";

const options = modelGenerationOptions("video", "doubao-video", "doubao-seedance-2-0");
const draft = { params: {}, size: "", duration: "", mode: undefined, references: [] };

describe("画布模型切换", () => {
  it("保留同名同类型的值，包括显式静音；不把默认值写入草稿", () => {
    const params = { aspectRatio: "16:9", duration: 6, generateAudio: false };
    expect(planModelSwitch(options, options, { ...draft, params }, [], true)).toEqual({
      ...draft,
      params,
      effectiveMode: "t2v",
      droppedLabels: [],
    });
  });
  it("预览丢失的取值，不改写原草稿，空值不报警", () => {
    const params = { resolution: "1080p" as const, duration: 8, negativePrompt: "  " };
    const next = { ...options, durationRange: { min: 4, max: 6 }, resolutions: ["720p"] };
    const result = planModelSwitch(options, next, { ...draft, params }, [], true);
    expect(result.params).toEqual({});
    expect(result.droppedLabels).toEqual(["清晰度", "时长"]);
    expect(params.duration).toBe(8);
  });
  it("新模型的同名自定义字段变类型、删除或收窄范围时使用旧标签", () => {
    const level = {
      type: "number" as const,
      min: 0,
      max: 10,
      default: 1,
      open: true,
      label: "强度",
    };
    const toggle = { type: "boolean" as const, default: true, open: true, label: "锁定" };
    const before = {
      ...options,
      customParameters: { level, toggle, removed: { ...level, label: "偏移" }, stable: toggle },
    };
    const after = {
      ...options,
      customParameters: {
        level: { ...level, max: 4 },
        toggle: { ...level, label: "新标签" },
        stable: toggle,
      },
    };
    expect(
      planModelSwitch(
        before,
        after,
        {
          ...draft,
          params: { customParams: { level: 6, toggle: false, removed: 0, stable: false } },
        },
        [],
        false,
      ),
    ).toMatchObject({
      params: { customParams: { stable: false } },
      droppedLabels: ["强度", "锁定", "偏移"],
    });
  });
  it("弃用生成模式本身不报警；按回落方式过滤手动素材，不改变连接", () => {
    const assets = [
      { assetId: "photo", mediaType: "image" as const },
      { assetId: "clip", mediaType: "video" as const },
    ];
    const current = { ...draft, references: ["clip", "photo"], mode: "omni" as const };
    const next = { ...options, omni: false, modes: ["i2v", "t2v"] as ("i2v" | "t2v")[] };
    expect(planModelSwitch(options, next, current, assets, true)).toMatchObject({
      references: ["photo"],
      droppedLabels: ["参考视频"],
      mode: undefined,
    });
    expect(
      planModelSwitch(options, { ...next, modes: ["t2v", "i2v"] }, current, assets, true),
    ).toMatchObject({ references: [], droppedLabels: ["参考视频", "参考图片"] });
  });
  it("图片自动模式保留手动图片，禁止参考图片时才确认", () => {
    const image = modelGenerationOptions("image", "openai-image", "gpt-image-1");
    const assets = [{ assetId: "photo", mediaType: "image" as const }];
    const current = { ...draft, references: ["photo"] };
    expect(planModelSwitch(image, image, current, assets, false)).toMatchObject({
      references: ["photo"],
      droppedLabels: [],
    });
    expect(
      planModelSwitch(
        image,
        modelGenerationOptions("image", "openai-image", "dall-e-3"),
        current,
        assets,
        false,
      ),
    ).toMatchObject({ references: [], droppedLabels: ["参考图片"] });
  });
});
