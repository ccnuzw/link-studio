import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const root = resolve(process.env.VIDEO_CANVAS_WEB);
const config = {
  configFile: false,
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
};
const original = await createServer({
  ...config,
  root,
  resolve: { alias: { "@": join(root, "src") } },
});
const desktop = await createServer({ ...config, root: process.cwd() });
try {
  const { nodeFrameSize, paramAspect, resolveNodeAspect } = await original.ssrLoadModule(
    "/src/utils/canvas/node-frame.ts",
  );
  const { mediaNodeFrame } = await desktop.ssrLoadModule(
    "/src/renderer/workspace/media-node-model.ts",
  );
  const ratios = ["16:9", "9:16", "1:1", "21:9", "4:3", "adaptive"];
  const caps = {
    params: {
      aspect_ratio: { type: "enum", open: true, label: "画幅", options: ratios, default: "4:3" },
    },
  };
  const model = {
    id: "one",
    config: { params: { aspectRatio: { open: true, values: ratios, default: "4:3" } } },
  };
  let checked = 0;
  for (const kind of ["image", "video", "audio"])
    for (const aspectRatio of [undefined, ...ratios])
      for (const declared of [undefined, 0.75])
        for (const measured of [undefined, 1.5])
          for (const online of [false, true]) {
            const selected = paramAspect(
              online ? caps : undefined,
              aspectRatio ? { aspect_ratio: aspectRatio } : {},
            );
            const expected = nodeFrameSize(
              resolveNodeAspect({
                measured: measured ?? null,
                declared,
                selected,
                mediaType: kind,
              }),
            );
            const data = {
              kind,
              mediaAspect: declared,
              generation: { providerId: "one", params: { aspectRatio } },
            };
            assert.deepEqual(
              mediaNodeFrame(data, online ? [model] : [], measured && { width: 300, height: 200 }),
              expected,
            );
            checked++;
          }
  console.log(
    `${checked} media frame sizes match the pinned implementation (CSS pixels, not screenshots).`,
  );
} finally {
  await original.close();
  await desktop.close();
}
