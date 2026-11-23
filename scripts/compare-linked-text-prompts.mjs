import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

assert(
  process.env.VIDEO_CANVAS_WEB && process.argv[2],
  "指定固定版 VIDEO_CANVAS_WEB 和 Electron 请求记录 linked-text-prompts.json",
);
const root = await realpath(process.env.VIDEO_CANVAS_WEB);
const server = await createServer({
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
  const load = (path) => server.ssrLoadModule(`/src/utils/${path}.ts`);
  const { referencedText } = await load("canvas/text-body");
  const { buildSubmittedPatch } = await load("tasks/submit");
  const { planBackfill } = await load("tasks/backfill");
  const { buildTaskInput, resolveBindings } = await load("tasks/capabilities");
  const caps = { ops: ["t2i"], refs: {}, prompt: { max_length: 5000 }, params: {} };
  const compose = (data) => {
    const links = [
      {
        edgeId: "ref",
        sourceId: "source",
        sourceKind: "script",
        sourceLabel: "对白",
        targetHandle: null,
        text: referencedText(data),
      },
    ];
    const built = buildTaskInput(
      caps,
      { prompt: "特写" },
      resolveBindings(caps, "t2i", links),
      "t2i",
      links,
    );
    assert.deepEqual(built.errors, {});
    return built.input.prompt;
  };
  const before = { kind: "script", label: "对白", text: "原来的对白" };
  const running = { ...before, ...buildSubmittedPatch("script", "123", before) };
  const done = {
    ...running,
    ...planBackfill(running, { id: "123", status: "succeeded", outputs: [{ text: "回填对白" }] }),
  };
  const expected = [before, running, done].map(compose);
  assert.deepEqual(JSON.parse(await readFile(process.argv[2], "utf8")), expected);
  console.log("原版组装结果与 Electron 三次 HTTP 请求一致：", expected);
} finally {
  await server.close();
}
