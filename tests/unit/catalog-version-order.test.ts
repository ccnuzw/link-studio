import type { PluginView } from "@link-studio/core";
import { expect, it } from "vitest";
import {
  groupAdapters,
  olderCatalogVersions,
} from "../../src/renderer/settings/catalog-version-order";
import { decodeModelBody } from "../../src/renderer/settings/model-document";

function plugin(key: string, version: string): PluginView {
  return {
    key,
    version,
    hash: `${key}/${version}`,
    name: key,
    kind: "text",
    disabled: false,
    apiVersion: 1,
    mode: "sync",
    auth: "none",
    hooks: [],
    origin: "manual",
    source: "",
    fields: {},
  };
}

const installed = [
  plugin("other", "2.0.0"),
  plugin("demo", "1.9.0"),
  plugin("demo", "1.10.0"),
  plugin("demo", "1.10.0-rc.1"),
];

it("按 key 排列目录，核心版本相同取最近安装的版本，只统计核心版本较低的旧版", () => {
  const groups = groupAdapters(installed);
  expect(groups.map(([head]) => head?.key)).toEqual(["demo", "other"]);
  expect(groups[0]?.map(({ version }) => version)).toEqual(["1.10.0-rc.1", "1.10.0", "1.9.0"]);
  expect(olderCatalogVersions(groups[0]!).map(({ version }) => version)).toEqual(["1.9.0"]);
});

it.each([
  [undefined, "1.10.0-rc.1"],
  ["1.10.0", "1.10.0"],
  ["1.9.0", "1.9.0"],
])("配置 JSON 对版本 %s 解析已安装插件 %s", (version, resolved) => {
  const protocol = { plugin: "demo", ...(version && { version }) };
  const body = {
    label: "样例",
    kind: "text",
    sort: 0,
    channels: [{ channel: "local", upstream_model: "demo", protocol }],
  };
  expect(decodeModelBody(body, installed).pluginHash).toBe(`demo/${resolved}`);
});
