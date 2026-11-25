import { modelGenerationOptions } from "@link-studio/core";
import { expect, it } from "vitest";
import {
  decodeModelBody,
  inspectOfflineBody,
  modelCapabilities,
} from "../../src/renderer/settings/model-document";
import {
  editedModelText,
  isLegacyModelDraft,
  projectModelDraft,
} from "../../src/renderer/settings/model-json-draft";

const body = {
  kind: "text",
  label: "原稿",
  sort: 10,
  channels: [{ channel: "channel", upstream_model: "upstream" }],
};
it("参考素材关闭后仍可回读原数量和大小，并且不能作为试跑输入", () => {
  const audio = { on: false, max: 4, max_mb: 15 };
  const raw = { ...body, kind: "video", capabilities: { refs: { audio } } };
  const config = decodeModelBody(raw, []).config;
  const options = modelGenerationOptions(
    "video",
    "doubao-video",
    "doubao-seedance-2-5-flash",
    {},
    config,
  );
  expect(modelCapabilities(config).refs?.audio).toEqual(audio);
  expect(options.references.audio).toBe(0);
});
const merge = (raw: unknown, before: unknown, after: unknown) =>
  JSON.parse(
    editedModelText(
      { text: JSON.stringify(raw), document: JSON.stringify(before) },
      JSON.stringify(after),
    ),
  );

it("离线投影按参数类型清理未知键，不把错误的已知字段解释为扩展", () => {
  const field = { open: true, type: "number", min: 0, max: 3, default: 1, privateNote: "原文" };
  const text = (value: unknown) =>
    JSON.stringify({
      ...body,
      params: { historical: true },
      capabilities: { params: { count: value } },
    });
  const result = inspectOfflineBody(text(field));
  expect(result.issues).toEqual([
    { field: "/capabilities/params/count/privateNote", text: "未知字段" },
  ]);
  expect(result.body.capabilities?.params?.count).not.toHaveProperty("privateNote");
  expect(result.body).not.toHaveProperty("params");
  expect(() => inspectOfflineBody(text({ ...field, min: "0" }))).toThrow();
  expect(() => inspectOfflineBody(text({ ...field, type: "other" }))).toThrow();
});

it("空正文和无法识别的能力不继承上一个模型", () => {
  expect(projectModelDraft({}, [])).toMatchObject({
    kindSelected: false,
    config: { name: "", sort: 0 },
  });
  const partial = projectModelDraft(
    {
      ...body,
      kind: "unsupported",
      pricing: { billing: "unknown" },
      capabilities: { vision: true, context: 5, extension: "keep" },
    },
    [],
  );
  expect(partial).toMatchObject({
    kindSelected: false,
    config: { name: "原稿", vision: true },
    channels: body.channels,
  });
  expect(partial.config.pricing).toBeUndefined();
});

it("文本与 Agent 的最大输出必须小于窗口，原版上限和下限取闭区间", () => {
  const issues = (window: number, output: number, kind = "agent") =>
    inspectOfflineBody(
      JSON.stringify({ ...body, kind, capabilities: { context: { window, output } } }),
    ).issues;
  expect(issues(10_000_000, 1_000_000)).toEqual([]);
  expect(issues(257, 256, "text")).toEqual([]);
  expect(issues(256, 256)).toEqual([
    { field: "/capabilities/context/output", text: "最大输出必须小于上下文窗口" },
  ]);
  expect(issues(256, 255)[0]?.text).toContain("256 – 1000000");
});

it("混合标签只显示字符串；改名保留原标签，主动改标签才替换整个列表", () => {
  const raw = { ...body, tags: [5, "甲", null, "乙"] };
  const tags = projectModelDraft(raw, []).config.tags;
  expect(tags).toEqual(["甲", "乙"]);
  expect(merge(raw, { ...body, tags }, { ...body, tags, label: "新名" }).tags).toEqual(raw.tags);
  expect(merge(raw, { ...body, tags }, { ...body, tags: ["乙", "丙"] }).tags).toEqual(["乙", "丙"]);
});

it("无改动保留空白；只替换实际编辑的字段，同时保留层级、键序和不展示的渠道", () => {
  const raw = JSON.parse(
    '{"__proto__":{"ok":true},"label":"原稿","channels":[{"extension":"x","upstream_model":"upstream","channel":"channel"},{"extra":true}],"unused":5}',
  );
  const text = ` ${JSON.stringify(raw)}\n`;
  expect(editedModelText({ text, document: JSON.stringify(body) }, JSON.stringify(body))).toBe(
    text,
  );
  const next = merge(raw, body, {
    ...body,
    label: "新名",
    channels: [{ ...body.channels[0], upstream_model: "new" }],
  });
  expect(Object.keys(next)).toEqual(Object.keys(raw));
  expect(Object.hasOwn(next, "__proto__")).toBe(true);
  expect(next).toEqual({
    ...raw,
    label: "新名",
    channels: [{ ...raw.channels[0], upstream_model: "new" }, raw.channels[1]],
  });
});

it("参数顺序及数组行的扩展数据跟随真正的重排", () => {
  const before = { params: { size: 1, quality: 2 }, tiers: [{ unit: 1 }, { unit: 2 }] };
  const raw = {
    params: { size: 1, extra: 3, quality: 2 },
    tiers: [
      { unit: 1, ext: "first" },
      { unit: 2, ext: "second" },
    ],
  };
  const reordered = merge(raw, before, {
    params: { quality: 2, size: 1 },
    tiers: [{ unit: 2 }, { unit: 1 }],
  });
  expect(Object.keys(reordered.params)).toEqual(["quality", "extra", "size"]);
  expect(reordered.tiers).toEqual([raw.tiers[1], raw.tiers[0]]);
  expect(merge(raw, before, { ...before, tiers: [{ unit: 2 }] }).tiers).toEqual([raw.tiers[1]]);
});

it("最后一个可见能力被删时，仍留下嵌套扩展；缺失首渠道时可补全", () => {
  expect(
    merge(
      { capabilities: { context: { window: 5, extra: 6 }, vendor: true } },
      { capabilities: { context: { window: 5 } } },
      {},
    ),
  ).toEqual({ capabilities: { context: { extra: 6 }, vendor: true } });
  expect(
    merge({ channels: [] }, body, {
      ...body,
      channels: [{ channel: "channel", upstream_model: "new" }],
    }).channels,
  ).toEqual([{ channel: "channel", upstream_model: "new" }]);
});

it("无效字段可由表单修复；桌面旧包络与带 config 扩展的标准正文不混淆", () => {
  const broken = { ...body, sort: "invalid" };
  expect(() => decodeModelBody(broken, [])).toThrow();
  const fixed = merge(broken, { ...body, sort: 0 }, { ...body, sort: 12 });
  expect(decodeModelBody(fixed, []).config.sort).toBe(12);
  expect(isLegacyModelDraft({ config: {}, pluginHash: "", settings: {} })).toBe(true);
  expect(
    merge({ ...body, config: { custom: true } }, body, { ...body, label: "新名" }).config,
  ).toEqual({ custom: true });
});
