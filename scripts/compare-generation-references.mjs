import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB, "指定固定版 VIDEO_CANVAS_WEB");
const root = resolve(process.env.VIDEO_CANVAS_WEB);
const config = {
  configFile: false,
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
};
const upstream = await createServer({
  ...config,
  root,
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
});
const desktop = await createServer({ ...config, root: process.cwd() });
try {
  const { buildTaskInput, resolveBindings, REF_KEYS } = await upstream.ssrLoadModule(
    "/src/utils/tasks/capabilities.ts",
  );
  const { mediaGenerationDraft } = await desktop.ssrLoadModule(
    "/src/renderer/workspace/media-generation-draft.ts",
  );
  const assets = Array.from({ length: 9 }, (_, index) => ({
    assetId: String(index + 1),
    mediaType: index < 6 ? "image" : index < 8 ? "audio" : "video",
    availability: "ready",
    sizeBytes: 1,
    metadata: {},
  }));
  const role = (id, avatar, extras, voice) => ({
    id,
    type: "creative",
    data: {
      kind: "image",
      label: id,
      text: "",
      assetId: avatar,
      character: { name: id, extraAssetIds: extras, voice: voice ? { assetId: voice } : undefined },
    },
  });
  const ordinary = (id, assetId, kind = "image") => ({
    id,
    type: "creative",
    data: { kind, label: id, assetId, text: "" },
  });
  const first = role("甲", "1", ["2", "3"], "7"),
    second = role("乙", "4", ["3", "5"], "8");
  const fixtures = [
    [[], []],
    [[ordinary("图", "1")], ["1", "1"]],
    [[ordinary("图", "1"), ordinary("另图", "2")], ["3"]],
    [[first, second], []],
    [
      [first, second],
      ["2", "6"],
    ],
    [[role("甲", "1", ["2", "3"]), role("乙", "4", ["5"])], []],
    [[first, ordinary("声音", "8", "audio"), ordinary("片段", "9", "video")], ["6"]],
    [[role("甲", undefined, ["2"], "7")], []],
    [[first], [], ["甲"]],
    [[first], [], [], ["甲"]],
    [[role("甲", "1", ["2"])], ["1"]],
    [
      [first, role("乙", "1", ["3"], "7")],
      ["1", "2", "7"],
    ],
    [[ordinary("空图", undefined)], []],
    [[ordinary("处理中", "1")], [], [], ["处理中"]],
    [[ordinary("空视频", undefined, "video")], []],
    [[first], ["1", "2", "7"], [], ["甲"]],
  ];
  let checks = 0;
  for (const op of ["i2i", "i2v", "omni", "t2v"])
    for (const max of [1, 2])
      for (const sound of [false, true])
        for (const soundField of op === "omni"
          ? [undefined, { open: false, default: false }, { open: true, default: true }]
          : [undefined])
          for (const [nodes, manual, pending = [], running = []] of fixtures) {
            const kind = op === "i2i" ? "image" : "video";
            const counts = {
              image: max,
              audio: op === "omni" && sound ? 1 : 0,
              video: op === "omni" ? 1 : 0,
            };
            const refs = Object.fromEntries(
              Object.entries(counts).map(([key, limit]) => [
                key,
                { on: limit > 0, max: limit, max_mb: 10, mb: 10 },
              ]),
            );
            const caps = {
              ops: [op],
              refs,
              prompt: { max_length: 5000 },
              params: soundField
                ? { generate_audio: { type: "boolean", label: "声音", ...soundField } }
                : {},
            };
            const data = {
              kind,
              text: "推近",
              label: "目标",
              generation: { params: { generateAudio: !soundField?.open } },
              videoMode: kind === "video" ? op : undefined,
              imageMode: kind === "image" ? op : undefined,
              manualReferenceIds: manual,
            };
            const graph = {
              nodes: [...nodes, { id: "target", type: "creative", data }],
              edges: nodes.map((node) => ({ id: node.id, source: node.id, target: "target" })),
            };
            const links = nodes.map(({ id, data }) => ({
              sourceId: id,
              edgeId: id,
              sourceLabel: id,
              sourceKind: data.character ? "character" : data.kind,
              targetHandle: null,
              assetId: running.includes(id) ? undefined : data.assetId,
              character: data.character && {
                id,
                name: id,
                avatarAssetId: running.includes(id) ? "" : (data.assetId ?? ""),
                extraAssetIds:
                  running.includes(id) || !data.assetId ? [] : data.character.extraAssetIds,
                voiceAssetId: data.character.voice?.assetId,
                voicePending: pending.includes(id),
              },
            }));
            const params = {
              prompt: data.text,
              generate_audio: data.generation.params.generateAudio,
              ...Object.fromEntries(
                REF_KEYS.map((ref) => [
                  ref.key,
                  manual.filter(
                    (id) => assets.find((asset) => asset.assetId === id)?.mediaType === ref.kind,
                  ),
                ]),
              ),
            };
            const bindings = resolveBindings(caps, op, links, params);
            const expected = buildTaskInput(caps, params, bindings, op, links);
            const settings = {
              plugins: [
                {
                  origin: "builtin",
                  key: kind === "video" ? "doubao-video" : "openai-image",
                  hash: "adapter",
                  auth: "none",
                  kind,
                },
              ],
              providers: [
                {
                  enabled: true,
                  id: "model",
                  pluginHash: "adapter",
                  model: kind === "video" ? "doubao-seedance-2-0" : "gpt-image-1",
                  config: { modes: [op], refs, generateAudio: soundField },
                },
              ],
            };
            const actual = mediaGenerationDraft({
              id: "target",
              data,
              graph,
              settings,
              assets,
              draft: data.text,
              template: false,
              pendingVoices: new Set(pending),
              referenceRunningNodes: new Set(running),
              urls: Object.fromEntries(
                assets.map((asset) => [asset.assetId, "https://example.com/ref"]),
              ),
            });
            const context = JSON.stringify({ op, max, sound, links, manual });
            for (const ref of REF_KEYS)
              assert.deepEqual(
                actual.chosenReferences
                  .filter((asset) => asset.mediaType === ref.kind)
                  .map((asset) => Number(asset.assetId)),
                expected.input[ref.key] ?? [],
                context,
              );
            assert.equal(actual.requestPrompt, expected.input.prompt, context);
            assert.deepEqual(actual.media.notices, bindings.notices, context);
            assert.equal(
              actual.referenceIssue,
              REF_KEYS.map((ref) => expected.errors[ref.key]).find(Boolean),
              context,
            );
            assert.equal(actual.voiceNeedsSound, Boolean(expected.errors.generate_audio), context);
            assert.equal(!actual.blockedReason, Object.keys(expected.errors).length === 0, context);
            checks++;
          }
  console.log(`两端 ${checks} 组：素材 ID 与顺序、最终提示词、首条素材错误、提醒和可提交状态一致`);
} finally {
  await Promise.all([desktop.close(), upstream.close()]);
}
