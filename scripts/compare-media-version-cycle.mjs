import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "vite";

assert(
  process.env.VIDEO_CANVAS_WEB && process.argv[2],
  "指定 VIDEO_CANVAS_WEB 与 Electron 回放生成的 media-version-cycle.json",
);
const root = await realpath(resolve(process.env.VIDEO_CANVAS_WEB));
const original = await createServer({
  root,
  configFile: false,
  resolve: { alias: { "@": join(root, "src") } },
  plugins: [
    {
      name: "omit-unused-ui-catalogs",
      enforce: "pre",
      transform(source, id) {
        if (id === join(root, "src/constants/canvas/index.ts"))
          return source.replace(/^export \* from "\.\/(model|node)-library";$/gm, "");
      },
    },
  ],
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const load = (path) => original.ssrLoadModule(`/src/utils/${path}.ts`);
  const { buildSubmittedPatch } = await load("tasks/submit");
  const { planBackfill } = await load("tasks/backfill");
  const { deriveVideoNodeView } = await load("tasks/node-view");
  const { restoreNodes } = await load("canvas/history");
  const { serializeGraph, deserializeNode } = await load("canvas/canvas-persistence");
  const { canSetMain } = await load("canvas/versions");
  const { selectOutput } = await load("canvas/outputs");
  let node = {
    id: "picture",
    type: "canvas",
    position: { x: 10, y: 10 },
    data: { kind: "image", label: "图片", prompt: "晴天的车站" },
  };
  let task;
  const cycle = [];
  const patch = (fields) => {
    node = { ...node, data: { ...node.data, ...fields } };
  };
  const submit = (id) => {
    task = { id, status: "running", task_ref: `ref-${id}` };
    patch(buildSubmittedPatch("image", [id], node.data));
  };
  const capture = (step) => {
    const { data } = node;
    cycle.push({
      step,
      phase: deriveVideoNodeView(data, task, 0).phase,
      prompt: data.prompt,
      versions: data.outputs.length,
      adopted: data.outputs.findIndex(
        (output) => output.assetId === data.assetId && output.id === data.activeOutputId,
      ),
    });
  };
  const reopen = () => {
    const graph = JSON.parse(JSON.stringify(serializeGraph([node], [], { x: 0, y: 0, zoom: 1 })));
    node = deserializeNode(graph.nodes[0]);
  };
  if (process.argv.includes("--batch")) {
    const captures = [];
    const success = (id) =>
      patch(
        planBackfill(node.data, {
          id,
          status: "succeeded",
          outputs: [{ asset_id: id, url: "/files/" + id + ".png", media_type: "image/png" }],
        }),
      );
    const record = (step) => {
      const { data } = node;
      const current =
        data.status === "done"
          ? data.outputs.findIndex((output) => output.id === data.activeOutputId)
          : -1;
      captures.push({
        step,
        versions: data.outputs.length,
        pending: data.pendingTaskIds?.length ?? 0,
        adopted: current < 0 ? null : String(current + 1),
        locked: !!canSetMain(data, data.outputs[0].id).reason,
        fast: data.status === "running",
      });
    };
    submit("old");
    success("old");
    patch(buildSubmittedPatch("image", ["first", "remaining"], node.data));
    record("submitted");
    success("first");
    record("first-result");
    patch({ ...selectOutput(node.data, "old"), status: "done" });
    record("choose-old");
    patch(planBackfill(node.data, { id: "remaining", status: "failed", error_message: "fixture" }));
    record("last-failed");
    assert.deepEqual(JSON.parse(await readFile(process.argv[2], "utf8")), captures);
    console.table(captures);
  } else {
    for (const id of ["first", "second"]) {
      submit(id);
      task = {
        ...task,
        status: "succeeded",
        outputs: [{ asset_id: id, url: `/media/${id}`, media_type: "image/png" }],
      };
      patch(planBackfill(node.data, task));
    }
    capture("two-results");
    const before = node;
    patch({ prompt: "失败后恢复旧版" });
    submit("third");
    capture("regenerate");
    const after = node;
    [node] = restoreNodes([before], [node]);
    capture("undo-draft");
    [node] = restoreNodes([after], [node]);
    capture("redo-draft");
    assert.deepEqual(canSetMain(node.data, "second"), {
      ok: false,
      reason: "生成中，出第一张后可切换",
    });
    task = { ...task, status: "failed", error_message: "fixture" };
    patch(planBackfill(node.data, task));
    capture("failure");
    reopen();
    capture("reopened-failure");
    assert.equal(canSetMain(node.data, "second").ok, true);
    patch({ ...selectOutput(node.data, "second"), status: "done", error: null });
    capture("choose-prior");
    reopen();
    capture("reopened-choice");
    assert.deepEqual(JSON.parse(await readFile(process.argv[2], "utf8")), cycle);
    console.table(cycle);
    console.log(`${cycle.length} 个检查点的卡面状态、提示词、版本数与采用序号均与固定原版一致。`);
  }
} finally {
  await original.close();
}
