import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const scratch = await mkdtemp(join(tmpdir(), "canvas-aspect-"));
const browser = await chromium.launch({ channel: "chrome" });
try {
  const binary = resolve(
    `out/media/${process.platform}-${process.arch}/ffmpeg${process.platform === "win32" ? ".exe" : ""}`,
  );
  const make = (args, name) => execFileSync(binary, ["-v", "error", ...args, join(scratch, name)]);
  const encode =
    process.platform === "darwin"
      ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
      : ["-c:v", "libx264"];
  make(["-f", "lavfi", "-i", "color=blue:s=128x64", "-frames:v", "2", ...encode], "wide.mp4");
  make(["-display_rotation", "90", "-i", join(scratch, "wide.mp4"), "-c", "copy"], "rotated.mp4");
  make(
    ["-f", "lavfi", "-i", "color=red:s=64x64", "-vf", "setsar=2/1", "-frames:v", "2", ...encode],
    "anamorphic.mp4",
  );
  make(
    ["-f", "lavfi", "-i", "color=blue:s=64x48", "-vf", "setsar=2/3", "-frames:v", "2", ...encode],
    "narrow-samples.mp4",
  );
  make(["-f", "lavfi", "-i", "color=red:s=32x64", "-frames:v", "1"], "portrait.png");
  await writeFile(join(scratch, "broken.mp4"), "not a video");
  const expected = {
    "wide.mp4": 2,
    "rotated.mp4": 0.5,
    "anamorphic.mp4": 2,
    "narrow-samples.mp4": 64 / 72,
    "portrait.png": 0.5,
    "broken.mp4": null,
  };
  const results = {};
  for (const side of ["original", "desktop"]) {
    const original = side === "original",
      root = original ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(scratch, side),
      resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
    try {
      await server.listen();
      const page = await browser.newPage();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}fixture`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<input type="file" multiple><script type="module">import {${original ? "probeFileAspect" : "canvasFileAspect"} as probe} from '/src/${original ? "utils/canvas/media-aspect" : "renderer/workspace/canvas-file-aspect"}.ts';window.measure=probe</script>`,
        }),
      );
      await page.goto(`${origin}fixture`);
      await page.waitForFunction(() => typeof window.measure === "function");
      await page
        .locator("input")
        .setInputFiles(Object.keys(expected).map((name) => join(scratch, name)));
      results[side] = await page
        .locator("input")
        .evaluate(async (input) =>
          Object.fromEntries(
            await Promise.all(
              Array.from(input.files, async (file) => [
                file.name,
                (await window.measure(file, file.type.split("/")[0])) ?? null,
              ]),
            ),
          ),
        );
      await page.close();
    } finally {
      await server.close();
    }
  }
  console.table(results);
  assert.deepEqual(results.original, results.desktop);
  assert.deepEqual(results.original, expected);
  const output = resolve("test-results/canvas-file-aspect");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
