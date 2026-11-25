import type { ProviderView, SettingsValues } from "@link-studio/core";
import { expect, it } from "vitest";
import {
  canvasModelGroups,
  defaultNodeGeneration,
} from "../../src/renderer/workspace/media-node-model";
import { requireTestValue } from "../require-test-value";

const adapters = ["text", "image", "video", "audio"].map((kind) => ({
  key: kind,
  name: kind,
  hash: kind,
  version: "1",
  kind,
  apiVersion: 1,
  mode: "sync" as const,
  disabled: false,
  auth: "key",
  fields: {},
  hooks: [],
  origin: "manual" as const,
  source: "",
}));
function provider(kind: string, patch: Partial<ProviderView> = {}): ProviderView {
  return {
    id: kind,
    revision: 1,
    pluginHash: kind,
    enabled: true,
    channel: {},
    model: kind,
    label: kind,
    endpoint: "",
    hasSecret: true,
    hasSecretKey: false,
    allowLocal: false,
    agentEnabled: false,
    ...patch,
  };
}
const settings: SettingsValues["list"] = {
  providers: adapters.map((model) => provider(model.kind)),
  plugins: adapters,
};

it("按文本、图片、视频、音频显示可用种类，只有被显式选中的有效模型写入节点", () => {
  const groups = canvasModelGroups(settings);
  expect(groups.map((group) => group.kind)).toEqual(["script", "image", "video", "audio"]);
  for (const group of groups) {
    const selected = requireTestValue(group.models[0]).id;
    expect(defaultNodeGeneration(group.kind, { [group.kind]: selected }, groups)).toEqual({
      generation: { providerId: selected },
    });
    expect(defaultNodeGeneration(group.kind, {}, groups)).toEqual({});
  }
  for (const kind of ["director", "storyboard", "character"])
    expect(defaultNodeGeneration(kind, { script: "text", image: "image" }, groups)).toEqual({});
});

it("停用模型、渠道、插件、缺少凭证、过期或跨种类的选择不污染新节点", () => {
  const defaults = { image: "image" };
  for (const patch of [
    { enabled: false },
    { channelEnabled: false },
    { hasSecret: false },
    { id: "replacement" },
  ]) {
    const groups = canvasModelGroups({
      ...settings,
      providers: [provider("image", patch), provider("image", { id: "fallback" })],
    });
    expect(defaultNodeGeneration("image", defaults, groups)).toEqual({});
  }
  expect(defaultNodeGeneration("image", { image: "video" }, canvasModelGroups(settings))).toEqual(
    {},
  );
  const groups = canvasModelGroups({
    ...settings,
    plugins: adapters.map((model) => ({ ...model, disabled: model.kind === "image" })),
  });
  expect(groups.some((group) => group.kind === "image")).toBe(false);
  expect(defaultNodeGeneration("image", defaults, groups)).toEqual({});
});
