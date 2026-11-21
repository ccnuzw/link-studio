import { describe, expect, it } from "vitest";
import { parseStoryboardOutput } from "../../src/main/project/generation";

describe("storyboard split output", () => {
  it("parses fenced JSON and normalizes camera vocabulary", () => {
    const shots = parseStoryboardOutput(
      '```json\n[{"scene":"车站入口","shot":"中近景特写","camera":"缓慢推镜","action":"人物抬头","dialogue":"到了。","duration":2.25}]\n```',
    );
    expect(shots).toEqual([
      expect.objectContaining({
        scene: "车站入口",
        shot: "中近景",
        camera: "推",
        duration: 2.3,
      }),
    ]);
  });

  it("rejects non-array model output", () => {
    expect(() => parseStoryboardOutput("我无法拆分")).toThrow();
  });
});
