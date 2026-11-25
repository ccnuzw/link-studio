import { expect, test } from "vitest";
import {
  biographyPassages,
  cardDisplay,
  parseCharacters,
} from "../../src/renderer/workspace/drama-parse-characters";
import { requireTestValue } from "../require-test-value";

test("家族名单支持别名和合写人物；原稿中的阶段说明归到同一人", () => {
  const cards = parseCharacters(
    "## 柳家\n- **柳言（阿言）** — 十五岁时回乡。\n- **王氏、云氏** — 同访柳家。\n## 人物\n### 阿青\n#### 少年\n- 在书院读书。\n- 十三岁归家。\n#### 成年\n回乡授课。",
  );
  expect(cards.map((card) => card.name)).toEqual(["柳言", "王氏、云氏", "阿青"]);
  expect(cardDisplay(requireTestValue(cards[0]))).toMatchObject({ subtitle: "阿言" });
  expect(requireTestValue(cards[2]).fields).toEqual([
    { label: "少年", value: "在书院读书。\n十三岁归家。" },
    { label: "成年", value: "回乡授课。" },
  ]);
  const text = "原文一处写十二岁，另一处写十五岁。两处记载有出入。";
  const passages = biographyPassages(text);
  expect(requireTestValue(passages[0]).periods).toEqual(["十二岁", "十五岁"]);
  expect(passages.map((passage) => passage.text).join("")).toBe(text);
  expect(parseCharacters("这是一段没有具名人物的原文。")).toEqual([]);
});
