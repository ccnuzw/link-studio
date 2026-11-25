import { expect, test } from "vitest";
import { boardPrompt, boardTemplateError } from "../../packages/link-studio-core/src/drama-board";

test("故事板提示词必须含画面，占位符成对且受支持", () => {
  expect(boardTemplateError("{{行数}} × {{列数}}，{{格数}}格 {{比例}}\n{{画面}}")).toBeUndefined();
  expect(boardTemplateError("水彩画")).toContain("{{画面}}");
  expect(boardTemplateError("{{风格}}{{画面}}")).toContain("不认识");
  expect(boardTemplateError("{{行数\n{{画面}}")).toContain("没写完整");
});

test("保留画面、站位和素材引用，过滤对白与音效，超过九镜合并在末格", () => {
  const prompt = [
    "【站位】@[林宁](role)在门外。",
    "【时间轴】",
    ...Array.from(
      { length: 10 },
      (_, index) => `${index}-${index + 1}秒：第${index + 1}镜推门。台词『进来』。音效吱呀。`,
    ),
    "【备注】",
    "10-11秒：不绘制。",
  ].join("\n");
  const built = boardPrompt(prompt, "{{列数}}×{{行数}}/{{格数}}/{{比例}}\n{{画面}}");
  expect(built).toMatchObject({
    layout: "3x3",
    shotCount: 10,
    notice: "镜头过多（10 个），第 9 格合并了剩下的镜头，建议拆段",
  });
  expect(built.text).toContain("3×3/9/16:9\n站位：@[林宁](role)在门外。");
  expect(built.text).toContain("9. 第9镜推门。；第10镜推门。");
  expect(built.text).not.toMatch(/台词|吱呀|不绘制/);
});

test("五镜与六镜用三列两行，缺时间轴按四格并保留整段原稿", () => {
  for (const count of [5, 6])
    expect(boardPrompt(`【时间轴】\n${"0–1.5秒：回头。\n".repeat(count)}`)).toMatchObject({
      layout: "3x2",
      shotCount: count,
    });
  expect(boardPrompt("  门口的手写信。 ", "宫格")).toEqual({
    layout: "2x2",
    shotCount: 0,
    notice: "没识别到时间轴，按 4 格生成",
    text: "宫格\n按下面的片段内容拆成 4 个镜头：\n门口的手写信。",
  });
});
