import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const root = resolve(process.env.VIDEO_CANVAS_WEB);
const evidence = resolve("test-results/canvas-jpeg-orientation");
const scratch = await mkdtemp(join(tmpdir(), "jpeg-reference-"));
const server = await createServer({
  root,
  configFile: false,
  cacheDir: scratch,
  resolve: { alias: { "@": join(root, "src") } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
const browser = await chromium.launch({ channel: "chrome" });
try {
  await server.listen();
  const page = await browser.newPage();
  const fixture = `${server.resolvedUrls.local[0]}jpeg-grid`;
  await page.route(fixture, (route) =>
    route.fulfill({ contentType: "text/html", body: '<input type="file" multiple>' }),
  );
  await page.goto(fixture);
  await page
    .locator("input")
    .setInputFiles(
      Array.from({ length: 8 }, (_, index) => join(evidence, `source-${index + 1}.jpg`)),
    );
  const original = await page.locator("input").evaluate(async (input) => {
    const { probeFileAspect } = await import("/src/utils/canvas/media-aspect.ts");
    const { planTiles, cutTile } = await import("/src/utils/canvas/grid-split.ts");
    const files = Array.from(input.files);
    const aspects = await Promise.all(files.map((file) => probeFileAspect(file, "image")));
    const image = new Image();
    image.src = URL.createObjectURL(files[6]);
    await image.decode();
    const tiles = [];
    for (const tile of planTiles([0.5], [0.5], image.naturalWidth, image.naturalHeight)) {
      const bitmap = await createImageBitmap(await cutTile(image, tile));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      tiles.push(Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data));
      bitmap.close();
    }
    URL.revokeObjectURL(image.src);
    return { aspects, tiles };
  });
  assert.deepEqual(original.aspects, [2, 2, 2, 2, 0.5, 0.5, 0.5, 0.5]);
  const differences = [];
  for (const [index, bytes] of original.tiles.entries()) {
    const desktop = await readFile(
      join(evidence, `grid-${1 + Math.floor(index / 2)}-${1 + (index % 2)}.png.rgba`),
    );
    assert.equal(bytes.length, desktop.length);
    let pixels = 0;
    for (let offset = 0; offset < bytes.length; offset += 4) {
      if (
        bytes
          .slice(offset, offset + 4)
          .some((value, channel) => value !== desktop[offset + channel])
      )
        pixels++;
    }
    differences.push(pixels);
  }
  const report = { aspects: original.aspects, tilePixelDifferences: differences };
  await writeFile(join(evidence, "comparison.json"), JSON.stringify(report, null, 2));
  console.log(report);
  assert.deepEqual(differences, [0, 0, 0, 0]);
} finally {
  await browser.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
