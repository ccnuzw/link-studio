import { describe, expect, it } from "vitest";
import { canLinkKinds, type LinkKind, linkKind } from "../../src/renderer/workspace/link-rules";

const kinds = ["script", "image", "video", "audio", "character", "storyboard", "director"] as const;
const expected: Record<LinkKind, string> = {
  script: "0111010",
  image: "0111000",
  video: "0010000",
  audio: "0010000",
  character: "0110000",
  storyboard: "0110000",
  director: "0000000",
};

describe("上游七类节点手动连线", () => {
  for (const source of kinds) {
    for (const [index, target] of kinds.entries()) {
      it(`${source} → ${target}`, () => {
        expect(canLinkKinds(source, target)).toBe(expected[source][index] === "1");
      });
    }
  }
  it("空分镜仍按分镜类型处理", () => {
    expect(linkKind({ kind: "script", label: "分镜", text: "", storyboard: [] })).toBe(
      "storyboard",
    );
  });
});
