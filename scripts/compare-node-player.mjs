import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const temp = await mkdtemp(join(tmpdir(), "node-player-"));
const output = resolve("test-results/node-player-parity");
await mkdir(output, { recursive: true });
const ffmpeg = resolve(
  "out/media",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);
const clip = join(temp, "fixture.mp4");
const poster = join(temp, "poster.png");
const encoder =
  process.platform === "darwin"
    ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
    : ["-c:v", "libx264"];
execFileSync(ffmpeg, [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=#729ab1:s=192x108:r=24:d=4",
  ...encoder,
  clip,
]);
execFileSync(ffmpeg, ["-v", "error", "-i", clip, "-frames:v", "1", poster]);
const videoBytes = await readFile(clip);
const browser = await chromium.launch({ channel: "chrome" });
const entry = "/src/__video_audit.tsx";
const report = {};
try {
  for (const upstream of [true, false]) {
    const name = upstream ? "upstream" : "desktop";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    const fixture = upstream
      ? `import {VideoPlayer as Player} from '/src/components/video-player'`
      : `import {NodeVideoPlayer as Player} from '/src/renderer/workspace/node-video-player';window.desktop={projects:{getAssetPreview:async()=>({ok:true,value:{url:'/poster.png'}})}}`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "node-player-parity",
          resolveId(id) {
            if (id === entry) return id;
          },
          load(id) {
            if (id === entry)
              return `import {createRoot} from 'react-dom/client';${fixture};createRoot(document.querySelector('section')).render(<Player active src="/files/fixture.mp4" durationMs={4000} assetId="fixture" projectHandle="fixture" onFailure={console.error}/>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 800, height: 500 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    let failPlayback = false;
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}assets/**`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.route(`${origin}files/**`, (route) => {
        if (new URL(route.request().url()).searchParams.has("v"))
          return route.fulfill({ path: poster, contentType: "image/png" });
        if (failPlayback) return route.fulfill({ status: 404, body: "" });
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
        const start = Number(range?.[1] ?? 0);
        const end = Number(range?.[2] || videoBytes.length - 1);
        return route.fulfill({
          status: range ? 206 : 200,
          contentType: "video/mp4",
          headers: {
            "accept-ranges": "bytes",
            ...(range && { "content-range": `bytes ${start}-${end}/${videoBytes.length}` }),
          },
          body: videoBytes.subarray(start, end + 1),
        });
      });
      await page.route(`${origin}poster.png`, (route) => route.fulfill({ path: poster }));
      await page.route(`${origin}audit`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "" : "canvas-workspace"}"><article class="${upstream ? "" : "creative-card"}" data-visual="true"><section class="${upstream ? "" : "node-media"}" style="position:fixed;left:80px;top:80px;width:576px;height:324px;border-radius:0;padding:0;margin:0;background:#eee"></section></article></main><script type="module" src="${entry}"></script>`,
        }),
      );
      await page.goto(`${origin}audit`);
      await page.waitForFunction(() => document.querySelector("section img")?.naturalWidth > 0);
      const stage = page.locator("section");
      for (const state of ["idle", "paused"]) {
        if (state === "paused") {
          await page.getByRole("button", { name: "播放视频" }).click();
          await page.getByRole("button", { name: "暂停", exact: true }).click();
          await page.locator("video").evaluate((video) => {
            video.currentTime = 1;
          });
          await page.getByText("0:01 / 0:04").waitFor();
        }
        await page.mouse.move(10, 10);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            document.getAnimations().map((animation) => animation.finished.catch(() => {})),
          );
        });
        await stage.screenshot({ path: join(output, `${name}-${state}.png`) });
        const labels = state === "idle" ? ["播放视频"] : ["播放", "静音"];
        report[`${name}-${state}`] = Object.fromEntries(
          await Promise.all(
            labels.map(async (label) => [
              label,
              await page.getByRole("button", { name: label, exact: true }).boundingBox(),
            ]),
          ),
        );
        if (process.env.PLAYER_STYLE_AUDIT) {
          const text =
            state === "idle"
              ? page.getByText("0:04", { exact: true })
              : page.getByText("0:01 / 0:04", { exact: true });
          console.log(
            name,
            state,
            await text.evaluate((element) => {
              const style = getComputedStyle(element);
              return [
                element.getBoundingClientRect().toJSON(),
                style.font,
                style.lineHeight,
                style.color,
                style.borderRadius,
                style.webkitFontSmoothing,
                style.letterSpacing,
              ];
            }),
          );
          if (state === "idle")
            console.log(
              await page
                .getByRole("button", { name: "播放视频" })
                .locator("span")
                .first()
                .evaluate((element) => [
                  getComputedStyle(element).boxShadow,
                  getComputedStyle(element).backdropFilter,
                ]),
            );
        }
        if (state === "paused")
          report[`${name}-${state}`].slider = await page.getByRole("slider").boundingBox();
      }
      await page.reload();
      failPlayback = true;
      const start = page.getByRole("button", { name: "播放视频" });
      await start.click();
      await page.waitForFunction(
        () =>
          !document.querySelector("video") &&
          !document.querySelector('button[aria-label="播放视频"]').disabled,
      );
      failPlayback = false;
      await start.click();
      await page.getByRole("button", { name: "暂停", exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0);
    } finally {
      await page.close();
      await server.close();
    }
  }
  for (const state of ["idle", "paused"]) {
    const [first, second] = ["upstream", "desktop"].map((name) =>
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-i",
        join(output, `${name}-${state}.png`),
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ]),
    );
    assert.equal(first.length, second.length);
    let diff = 0;
    for (let offset = 0; offset < first.length; offset += 3)
      if (first.readUIntBE(offset, 3) !== second.readUIntBE(offset, 3)) diff++;
    report[state] = diff;
  }
  console.log(report);
  await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
