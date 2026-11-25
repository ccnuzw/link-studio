import { expect, test } from "vitest";
import { documentDraft, draftDocument } from "../../src/renderer/workspace/assistant-editor-doc";
import {
  rebaseMentions,
  serializeModels,
} from "../../src/renderer/workspace/assistant-model-mentions";
import { requireTestValue } from "../require-test-value";

const pair = [
  { start: 0, end: 3, id: "image-a", name: "模型" },
  { start: 4, end: 7, id: "video-b", name: "模型" },
];

test("跨行同名节点草稿还原各自的 ID、图标与位置", () => {
  const message = "甲@模型\n@模型";
  const mentions = [
    { start: 1, end: 4, id: "node-a", name: "模型", kind: "node" as const, nodeKind: "group" },
    { start: 5, end: 8, id: "node-b", name: "模型", kind: "node" as const, nodeKind: "character" },
  ];
  expect(documentDraft(draftDocument(message, mentions))).toEqual({ message, mentions });
  expect(serializeModels(message, mentions)).toBe("甲@[模型](node:node-a)\n@[模型](node:node-b)");
});

test("技能发送时保留 skill_read 所需的版本号，与同名模型区分", () => {
  expect(
    serializeModels("@模型 @模型", [
      requireTestValue(pair[0]),
      { ...requireTestValue(pair[1]), kind: "skill", id: "shot-list@2" },
    ]),
  ).toBe("@[模型](model:image-a) @[模型](skill:shot-list@2)");
});

test("同名模型保留各自的绑定和前后顺序，普通文字不会变成引用", () => {
  expect(serializeModels("@模型 @模型 @模型", pair)).toBe(
    "@[模型](model:image-a) @[模型](model:video-b) @模型",
  );
});

test("删除两个同名引用中的第一个，保留第二个的绑定", () => {
  const next = rebaseMentions(pair, "@模型 @模型", "@模型", 0);
  expect(serializeModels("@模型", next)).toBe("@[模型](model:video-b)");
});

test("从中间插入用途说明时移动后续引用，改写模型名后不再发送旧绑定", () => {
  const annotated = "@模型 接着用@模型";
  const shifted = rebaseMentions(pair, "@模型 @模型", annotated, 7);
  expect(serializeModels(annotated, shifted)).toBe(
    "@[模型](model:image-a) 接着用@[模型](model:video-b)",
  );
  const changed = "@模型 接着用@新模型";
  expect(serializeModels(changed, rebaseMentions(shifted, annotated, changed, 9))).toBe(
    "@[模型](model:image-a) 接着用@新模型",
  );
});
