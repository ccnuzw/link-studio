import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { animateArrangement } from "../src/renderer/workspace/arrange-animation.ts";

const baseline = process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web";
const { animatePositions } = await import(
  pathToFileURL(resolve(baseline, "src/components/canvas-editor/arrange-animation.ts"))
);
const origins = new Map([
  ["first", { x: -42.125, y: 121.75 }],
  ["second", { x: 212.5, y: 75.75 }],
  ["third", { x: 210, y: 16.25 }],
]);
const targets = new Map([
  ["first", { x: 65, y: 87.5 }],
  ["second", { x: -10.125, y: 87.5 }],
  ["third", { x: 210, y: 16.25 }],
]);
let now = 0;
let nextFrame;
performance.now = () => now;
globalThis.requestAnimationFrame = (callback) => {
  nextFrame = callback;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  nextFrame = undefined;
};
function sample(start) {
  let settled = false;
  let positions = origins;
  now = 0;
  start(
    (next) => {
      positions = next;
    },
    () => {
      settled = true;
    },
  );
  return [0, 1, 16, 50, 65, 100, 130, 194, 250, 259, 260, 300].map((timestamp) => {
    now = timestamp;
    const step = nextFrame;
    nextFrame = undefined;
    step?.(now);
    return { timestamp, settled, positions: Object.fromEntries(positions) };
  });
}
let nodes = Array.from(origins, ([id, position]) => ({ id, position }));
const upstream = sample((preview, finish) =>
  animatePositions(
    {
      getNodes: () => nodes,
      setNodes: (apply) => {
        nodes = apply(nodes);
        preview(new Map(nodes.map(({ id, position }) => [id, position])));
      },
    },
    targets,
    (result) => {
      finish();
      return result;
    },
  ),
);
const desktop = sample((preview, finish) =>
  animateArrangement(origins, targets, preview, () => {
    preview(targets);
    finish();
  }),
);
assert.deepEqual(desktop, upstream);
console.log(`两端 ${origins.size} 个节点、${desktop.length} 个时间点的坐标和完成状态一致。`);
