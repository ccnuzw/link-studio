import { expect, it } from "vitest";
import type { ProjectCanvasView } from "../../packages/link-studio-core/src/canvas";
import type { CanvasAgentArrange } from "../../packages/link-studio-core/src/canvas-agent";
import { compileArrange } from "../../src/main/project/canvas-agent-layout";
import fixtures from "../fixtures/canvasgraph/arrange-cases.json";

for (const fixture of fixtures.cases) {
  it(`小镜布局坐标对照 · ${fixture.name}`, () => {
    const canvas: ProjectCanvasView = {
      nodes: fixture.nodes.map(({ id, x, y, kind }) => ({
        id,
        type: "creative",
        position: { x, y },
        data: { kind: kind as "script" | "image" | "video", label: id, text: "" },
      })),
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const positions = new Map(canvas.nodes.map((node) => [node.id, node.position]));
    const { operations } = compileArrange(
      canvas,
      { layout: fixture.layout as CanvasAgentArrange["layout"], nodeIds: [...positions.keys()] },
      {},
    );
    for (const op of operations)
      if (op.type === "putNode") positions.set(op.node.id, op.node.position);
    expect(Object.fromEntries(positions)).toEqual(fixture.expected);
  });
}
