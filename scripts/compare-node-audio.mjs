import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the built reference web directory");
const temp = await mkdtemp(join(tmpdir(), "canvas-audio-"));
const output = resolve("test-results/node-audio-parity");
await mkdir(output, { recursive: true });
const ffmpeg = resolve(
  "out/media",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);
const audio = join(temp, "fixture.wav");
const samples = Buffer.alloc(64000 * 2);
for (let index = 16000; index < 64000; index++) {
  samples.writeInt16LE(
    Math.round((Math.sin((index * Math.PI) / 8) * 24000 * index) / 64000),
    index * 2,
  );
}
const header = Buffer.alloc(44);
header.write("RIFF");
header.writeUInt32LE(samples.length + 36, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(8000, 24);
header.writeUInt32LE(16000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(samples.length, 40);
await writeFile(audio, Buffer.concat([header, samples]));
const states = ["idle", "head-focus", "button-focus", "hover"];
const report = {};
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const name of ["upstream", "desktop"]) {
    const upstream = name === "upstream";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const entry = "/src/__audio_audit.tsx";
    const fixture = upstream
      ? `import {AudioPlayer as Player} from '/src/components/canvas/audio-player';`
      : `
      import {NodeAudioPlayer as Player} from '/src/renderer/workspace/node-audio-player';
      window.desktop = {projects:{readAudioForWaveform: async () => ({ok:true,value:{bytes:new Uint8Array(await (await fetch('/fixture.wav')).arrayBuffer())}})}};`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      publicDir: temp,
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "audio-audit",
          resolveId(id) {
            if (id === entry) return id;
          },
          load(id) {
            if (id === entry)
              return `import {createRoot} from 'react-dom/client';${fixture}
          createRoot(document.querySelector('section')).render(<Player active src="/fixture.wav" assetId="fixture" projectHandle="fixture"/>);`;
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport: { width: 800, height: 500 },
          deviceScaleFactor: 1,
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        try {
          await page.route(`${origin}assets/**`, (route) =>
            route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
          );
          await page.route(`${origin}audit`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "" : "canvas-workspace"}"><article class="${upstream ? "bg-card" : "creative-card"}" data-visual="true" style="position:fixed;left:80px;top:80px;width:324px;height:324px;padding:0;border:0;border-radius:0"><section class="${upstream ? "bg-muted/40" : "node-media"}" data-kind="audio" style="position:relative;width:324px;height:324px;border-radius:0;padding:0;margin:0"></section></article></main><script type="module" src="${entry}"></script></html>`,
            }),
          );
          await page.goto(`${origin}audit`);
          const bars = '[data-slot="audio-wave"] > :first-child > span';
          await page.waitForFunction(
            (selector) =>
              document.querySelectorAll(selector)[55]?.getBoundingClientRect().height > 200 &&
              document.querySelector("audio")?.duration === 8,
            bars,
          );
          const head = page.getByRole("slider");
          const button = page.getByRole("button", { name: "播放" });
          for (const state of states) {
            if (state === "head-focus") {
              await page.keyboard.press("Tab");
              assert(await head.evaluate((element) => element.matches(":focus-visible")));
              for (let step = 0; step < 3; step++) await head.press("ArrowRight");
              assert.equal(await head.getAttribute("aria-valuenow"), "3");
            } else if (state === "button-focus") {
              await page.keyboard.press("Tab");
              assert(await button.evaluate((element) => element.matches(":focus-visible")));
            } else if (state === "hover") {
              await button.blur();
              await button.hover();
            }
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all(
                document.getAnimations().map((animation) => animation.finished.catch(() => {})),
              );
            });
            const geometry = await page
              .locator(
                `section [data-slot="audio-wave"], ${bars}, section [role="slider"], section [aria-live="off"], section button`,
              )
              .evaluateAll((elements) =>
                elements.map((element) => element.getBoundingClientRect().toJSON()),
              );
            assert.equal(geometry.length, 60);
            const key = `${theme}-${state}`;
            const screenshot = join(output, `${name}-${key}.png`);
            await page.locator("section").screenshot({ path: screenshot });
            if (upstream) report[key] = { geometry };
            else {
              const reference = join(output, `upstream-${key}.png`);
              const pixels = [reference, screenshot].map((path) =>
                execFileSync(ffmpeg, [
                  "-v",
                  "error",
                  "-i",
                  path,
                  "-pix_fmt",
                  "rgb24",
                  "-f",
                  "rawvideo",
                  "pipe:1",
                ]),
              );
              assert.equal(pixels[0].length, 324 * 324 * 3);
              assert.equal(pixels[0].length, pixels[1].length);
              let differences = 0;
              for (let offset = 0; offset < pixels[0].length; offset += 3)
                if (pixels[0].readUIntBE(offset, 3) !== pixels[1].readUIntBE(offset, 3))
                  differences++;
              report[key].matchingRects = geometry.filter(
                (box, index) => JSON.stringify(box) === JSON.stringify(report[key].geometry[index]),
              ).length;
              report[key].pixelDifferences = differences;
              console.log(
                key,
                report[key].matchingRects,
                "of 60 rectangles match;",
                differences,
                "different pixels",
              );
            }
          }
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
  const comparison = await browser.newPage({
    viewport: { width: 708, height: 770 },
    deviceScaleFactor: 1,
  });
  try {
    const pairs = [];
    for (const theme of ["light", "dark"]) {
      const images = await Promise.all(
        ["upstream", "desktop"].map(async (name) => {
          const bytes = await readFile(join(output, `${name}-${theme}-head-focus.png`));
          return `<img width="324" height="324" src="data:image/png;base64,${bytes.toString("base64")}">`;
        }),
      );
      pairs.push(
        `<p>${theme === "light" ? "浅色" : "暗色"} · 3 秒 · 播放头键盘焦点</p><div>${images.join("")}</div>`,
      );
    }
    await comparison.setContent(
      `<meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:16px 20px;background:#e4e6e8;color:#242528;font:14px system-ui}header,div{display:grid;grid-template-columns:324px 324px;gap:20px}p{margin:12px 0 6px}strong{font-size:16px}</style><header><strong>video-canvas · 原版</strong><strong>Link Studio · 桌面</strong></header>${pairs.join("")}`,
    );
    await comparison.screenshot({ path: join(output, "comparison.png") });
  } finally {
    await comparison.close();
  }
  for (const [key, value] of Object.entries(report)) {
    assert.equal(value.matchingRects, 60, key);
    if (process.env.PARITY_EXACT === "1") assert.equal(value.pixelDifferences, 0, key);
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
