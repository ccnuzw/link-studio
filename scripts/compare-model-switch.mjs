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
  const { switchModelParams, currentOp } = await original.ssrLoadModule(
    "/src/utils/tasks/capabilities.ts",
  );
  const { planModelSwitch } = await desktop.ssrLoadModule(
    "/src/renderer/workspace/model-switch.ts",
  );
  const { modelGenerationOptions } = await desktop.ssrLoadModule(
    "/packages/link-studio-core/src/media-generation.ts",
  );
  const modes = ["t2v", "i2v", "omni"];
  const source = {
    ...modelGenerationOptions("video", "doubao-video", "doubao-seedance-2-0"),
    modes,
    parameterLabels: { aspectRatio: "画面比例", duration: "时长" },
  };
  const caps = {
    ops: modes,
    refs: { image: { on: true }, video: { on: true } },
    params: {
      aspect_ratio: { type: "enum", label: "画面比例", options: source.ratios },
      duration: { type: "number", label: "时长", min: 4, max: 15 },
    },
  };
  const assets = [
    { assetId: "12", mediaType: "image" },
    { assetId: "14", mediaType: "video" },
  ];
  for (const duration of [4, 8])
    for (const op of ["omni", "i2v", "t2v"])
      for (const ops of [modes, ["t2v", "i2v"], ["i2v", "t2v"]]) {
        const before = { op, duration, aspect_ratio: "16:9", images: ["12"], videos: ["14"] };
        const expected = switchModelParams(
          caps,
          {
            ...caps,
            ops,
            params: { ...caps.params, duration: { ...caps.params.duration, max: 6 } },
          },
          before,
        );
        const actual = planModelSwitch(
          source,
          { ...source, modes: ops, omni: ops.includes("omni"), durationRange: { min: 4, max: 6 } },
          {
            params: { duration, aspectRatio: "16:9" },
            mode: op,
            size: "",
            duration: "",
            references: ["12", "14"],
          },
          assets,
          true,
        );
        assert.deepEqual(actual.droppedLabels, expected.droppedLabels);
        assert.deepEqual(actual.references, [
          ...(expected.params.images ?? []),
          ...(expected.params.videos ?? []),
        ]);
        assert.equal(actual.mode, expected.params.op);
        assert.equal(actual.effectiveMode, currentOp({ ...caps, ops }, expected.params));
        assert.equal(actual.params.duration, expected.params.duration);
        assert.equal(actual.params.aspectRatio, expected.params.aspect_ratio);
      }
  console.log(
    "18/18 model switch plans match upstream: mode, ratio, duration, manual references and loss labels.",
  );
} finally {
  await original.close();
  await desktop.close();
}
