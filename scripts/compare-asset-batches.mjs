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
const reference = await createServer({
  ...config,
  root,
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: [
      {
        find: /^@\/components\/canvas$/,
        replacement: join(root, "src/components/canvas/placeholder-icons"),
      },
      { find: "@", replacement: join(root, "src") },
    ],
  },
});
const desktop = await createServer({ ...config, root: process.cwd() });
try {
  const original = await reference.ssrLoadModule("/src/utils/canvas/asset-nodes.ts");
  const local = await desktop.ssrLoadModule("/src/renderer/workspace/asset-node-batch.ts");
  const picker = await reference.ssrLoadModule("/src/utils/assets/picker-selection.ts");
  const inputs = Array.from({ length: 23 }, (_, index) => {
    const [width, height] = [
      [90, 160],
      [160, 90],
      [0, 128],
      [undefined, undefined],
      [512, 512],
      [17, 5],
    ][index % 6];
    const name = ["相同.png", "相同.mp4", "   ", " .hidden", "🍎".repeat(46) + ".wav"][index % 5];
    return {
      id: String(index),
      kind: ["image", "video", "audio"][index % 3],
      width,
      height,
      fileName: name,
    };
  });
  const convert = (item) => ({
    assetId: item.id,
    mediaType: item.kind,
    displayName: item.fileName,
    metadata: { width: item.width, height: item.height },
  });
  const normalize = ({ id, position, data: { kind, label, assetId, uploaded, mediaAspect } }) => ({
    id,
    position,
    kind,
    label,
    assetId,
    uploaded,
    mediaAspect,
  });
  const generator = () => {
    let index = 0;
    return () => `node-${index++}`;
  };
  let batches = 0,
    operations = 0;
  for (const origin of [
    { x: 0, y: 0 },
    { x: -310.75, y: 211.5 },
  ])
    for (const length of [0, 1, 4, 5, 9, 20])
      for (const rows of [inputs, inputs.toReversed()]) {
        const assets = rows.slice(0, length),
          existing = ["相同", "相同 3", "视频"];
        const expected = original
          .planAssetNodes(assets, origin, existing, generator())
          .map(normalize);
        assert.deepEqual(
          local.planAssetNodes(assets.map(convert), origin, existing, generator()).map(normalize),
          expected,
        );
        batches++;
      }
  for (const limit of [1, 4, 20]) {
    let selected = [],
      expected = [];
    for (const append of [true, false, true, false])
      for (const asset of [...inputs, inputs[0], inputs[1]]) {
        expected = append
          ? picker.addPicked(expected, [asset], limit).selected
          : picker.toggleAsset(expected, asset, limit);
        selected = local.pickAsset(selected, convert(asset), append, limit);
        assert.deepEqual(
          selected.map((item) => item.assetId),
          expected.map((item) => item.id),
        );
        operations++;
      }
  }
  console.log(
    `${batches} mixed batches and ${operations} selection transitions match the pinned implementation.`,
  );
  const referenceCharacter = await reference.ssrLoadModule(
    "/src/utils/characters/node-character.ts",
  );
  const desktopCharacter = await desktop.ssrLoadModule("/src/renderer/workspace/character-pick.ts");
  let comparisons = 0;
  for (const primary of [undefined, "main"])
    for (let existing = 0; existing <= 4; existing++) {
      const extras = ["a", "b", "c", "d"].slice(0, existing);
      const media = (id) => ({ id, url: `/media/${id}` });
      const character = {
        name: "林舟",
        look: "夜班",
        description: "站台",
        extraAssetIds: extras,
        voice: { assetId: "v", origin: "upload" },
      };
      const data = {
        assetId: primary,
        character: {
          ...referenceCharacter.emptyCharacter(character.name),
          look: character.look,
          description: character.description,
          voice: { ...character.voice, src: "/media/v", mode: "audio" },
          extras: extras.map((assetId) => ({ assetId, src: `/media/${assetId}` })),
        },
      };
      for (const purpose of ["extra", "main", "voice"])
        for (const ids of [
          [],
          ["a"],
          ["main"],
          ["v"],
          ["e", "e", "a", "main", "b", "c", "f", "g"],
        ]) {
          const before = structuredClone(character);
          const next = {
            ...data,
            ...referenceCharacter.applyPickedAssets(data, ids.map(media), purpose).patch,
          };
          const actual = desktopCharacter.bindCharacterPick(character, primary, purpose, ids);
          const voice = next.character.voice;
          assert.deepEqual(actual, {
            primary: next.assetId,
            character: {
              ...character,
              extraAssetIds: next.character.extras.map((item) => item.assetId),
              voice: { assetId: voice.assetId, origin: voice.origin },
            },
          });
          assert.deepEqual(character, before);
          comparisons++;
        }
    }
  console.log(`${comparisons} character primary, extra-order and voice-binding results match.`);
} finally {
  await reference.close();
  await desktop.close();
}
