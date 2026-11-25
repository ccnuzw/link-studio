import type { CreativeData, ProviderView, SettingsValues } from "@link-studio/core";
import { expect, it } from "vitest";
import {
  assetImageInput,
  assetUnit,
  assetVoiceInput,
} from "../../src/renderer/workspace/drama-asset-generation";
import { assetMarquee } from "../../src/renderer/workspace/drama-asset-marquee";
import { requireTestValue } from "../require-test-value";

const provider: ProviderView = {
  id: "image",
  pluginHash: "image",
  label: "图",
  model: "gpt-image-1",
  revision: 3,
  enabled: true,
  hasSecret: true,
  hasSecretKey: true,
  channel: {},
  allowLocal: false,
  endpoint: "",
  agentEnabled: false,
};
const settings: SettingsValues["list"] = {
  providers: [provider],
  plugins: [
    {
      key: "openai-image",
      name: "图片",
      hash: "image",
      version: "1",
      kind: "image",
      apiVersion: 1,
      mode: "sync",
      disabled: false,
      auth: "key",
      fields: {},
      hooks: [],
      origin: "builtin",
      source: "",
    },
  ],
};
const data: CreativeData = { kind: "image", label: "道具", text: "铜钥匙特写" };

it("不足四像素不启动，四个方向和单轴拖动使用同一门槛", () => {
  const start = { x: 30, y: 20 };
  expect(assetMarquee(start, { x: 27, y: 23 })).toBeNull();
  for (const dx of [-4, 4])
    for (const dy of [-6, 6])
      expect(assetMarquee(start, { x: 30 + dx, y: 20 + dy })).toEqual({
        left: Math.min(30, 30 + dx),
        top: Math.min(20, 20 + dy),
        width: 4,
        height: 6,
      });
  expect(assetMarquee(start, { x: 34, y: 20 })?.width).toBe(4);
});
it("批量按最低启用档估价，不把禁用档、待定价和 Token 当成单张费用", () => {
  const config = { kind: "image" as const, name: "图", sort: 0, description: "" },
    price = {
      unit: "request" as const,
      input: 7,
      tiers: [
        { unit: 4, on: true, when: {} },
        { unit: 1, on: false, when: {} },
      ],
    };
  expect(assetUnit({ ...provider, config: { ...config, pricing: price } })).toBe(4);
  for (const pricing of [
    { ...price, pending: true },
    { ...price, unit: "token" as const },
  ])
    expect(assetUnit({ ...provider, config: { ...config, pricing } })).toBe(0);
});
it("单卡已保存的尺寸、节点、模型修订进入请求，无词、无效尺寸、下线模型在提交前报告", () => {
  const prepare = (patch: Partial<CreativeData>) =>
    assetImageInput({ id: "key", settings, data: { ...data, ...patch }, assets: [] });
  expect(
    prepare({ generation: { sizeInput: "1024x1024", params: { aspectRatio: "1:1", count: 2 } } }),
  ).toEqual({
    input: {
      nodeId: "key",
      providerId: "image",
      expectedProviderRevision: 3,
      prompt: "铜钥匙特写",
      referenceAssetIds: [],
      count: 2,
      size: "1024x1024",
    },
  });
  expect(prepare({ text: " " })).toHaveProperty("error");
  expect(prepare({ generation: { sizeInput: "1x0" } })).toHaveProperty("error");
  expect(prepare({ generation: { providerId: "offline" } })).toHaveProperty("error");
});
it("缺音色提示和没有音频模型给出不同原因，不冒充音色已生成", () => {
  expect(assetVoiceInput(data, settings)).toEqual({ error: "还没有音色描述" });
  expect(
    assetVoiceInput(
      {
        ...data,
        character: {
          name: "来客",
          look: "",
          description: "",
          extraAssetIds: [],
          voicePrompt: "低声",
        },
      },
      settings,
    ),
  ).toEqual({ error: "暂无可用音频模型" });
});

it("联合生成仅拦截需要公网图址的模型，无图能力不是禁用理由", () => {
  const actor = {
    ...data,
    character: {
      name: "来客",
      look: "",
      description: "",
      extraAssetIds: [],
      voicePrompt: " 低声 ",
    },
  };
  const plugin = {
    ...requireTestValue(settings.plugins[0]),
    key: "doubao-audio",
    kind: "audio" as const,
  };
  for (const [max, as, allowed] of [
    [1, "url", false],
    [1, "base64", true],
    [0, "url", true],
  ] as const) {
    const model = {
      ...provider,
      channel: { as },
      config: {
        kind: "audio" as const,
        name: "音色",
        sort: 0,
        description: "",
        refs: { image: { max, mb: 1 } },
      },
    };
    const input = assetVoiceInput(actor, { providers: [model], plugins: [plugin] });
    expect(input).toEqual(
      allowed ? { provider: model, prompt: "低声" } : { error: "音色模型需要公网参考图地址" },
    );
  }
});
