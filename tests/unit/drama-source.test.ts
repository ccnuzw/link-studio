import { expect, test } from "vitest";
import { importPastedDrama } from "../../src/main/project/drama-source";

test("保留序言与分集标记，空集和短插入语按原文预检规则移除", () => {
  const result = importPastedDrama(
    "\uFEFF序言\r\n第一集 初见\r\n内景：家中\r\n你好\r\n求月票\r\n第二集\r\n第三集 离开\r\n外景：路口\r\n再见",
  );
  expect(result.source).toMatchObject({ kind: "episode", total: 3 });
  expect(result.episodes).toMatchObject([
    {
      episode_no: 1,
      unit_from: 1,
      unit_to: 2,
      title: "第一集 初见",
      script_md: "序言\n\n第一集 初见\n**内景：家中**\n你好",
    },
    {
      episode_no: 2,
      unit_from: 3,
      unit_to: 3,
      title: "第三集 离开",
      script_md: "第三集 离开\n**外景：路口**\n再见",
    },
  ]);
});

test("无分集标记时先累计整场再切集，字符数按 Unicode 码点计算", () => {
  const result = importPastedDrama(
    `场景：入口\n${"🌳".repeat(600)}\n场景：大厅\n${"🔥".repeat(600)}\n场景：出口\n落幕`,
  );
  expect(result.source).toMatchObject({ kind: "scene", total: 3 });
  expect(result.episodes).toMatchObject([
    { unit_from: 1, unit_to: 2 },
    { unit_from: 3, unit_to: 3 },
  ]);
});

test("清理后空稿与非文本控制字符拒绝创建", () => {
  for (const text of ["   ", "求月票\n本章完", "开场\u0000结束"]) {
    expect(() => importPastedDrama(text)).toThrow();
  }
});
