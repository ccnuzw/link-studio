import { expect, it } from "vitest";
import {
  historyPageContext,
  settingsPaths,
  settingsRefs,
} from "../../packages/link-studio-core/src/settings-page-context";

it("只读引用沿用发送时的标识，不把旧版本的名称、配置或内部插件哈希回显成标识", () => {
  const snapshot = { route: settingsPaths.providers, channel_key: "test", model_key: "model-id" };
  const legacy = {
    route: "providers",
    channel: { id: "test", name: "旧渠道" },
    provider: { id: "model-id", model: "upstream-id", label: "旧模型", revision: 3 },
  };
  expect(historyPageContext(snapshot)).toEqual(snapshot);
  expect(historyPageContext(legacy)).toEqual(snapshot);
  expect(settingsRefs(snapshot).map((ref) => ref.label)).toEqual([
    "模型渠道",
    "渠道：test",
    "模型：model-id",
  ]);
  expect(historyPageContext({ plugin: { key: "old-plugin", hash: "internal-only" } })).toEqual({
    route: settingsPaths.adapters,
    plugin_key: "old-plugin",
  });
  for (const invalid of [null, undefined, {}, [], { route: "unknown", channel_key: "data" }])
    expect(historyPageContext(invalid)).toBeUndefined();
});
