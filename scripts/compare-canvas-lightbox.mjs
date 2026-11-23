import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { makeVideo, replayVideo } from "./lightbox-video-replay.mjs";

assert(process.env.VIDEO_CANVAS_WEB);
const temp = await mkdtemp(join(tmpdir(), "lightbox-audit-"));
const dark = process.env.LIGHTBOX_THEME === "dark";
const retina = process.argv.includes("--retina");
const narrow = process.argv.includes("--narrow");
const compact = process.argv.includes("--compact");
const video = process.argv.includes("--video");
const dpr = retina ? 2 : 1;
const viewport = { width: compact ? 360 : narrow ? 620 : 1000, height: 680 };
const output = resolve(
  `test-results/canvas-lightbox${dark ? "-dark" : ""}-parity${compact ? "-compact" : narrow ? "-narrow" : ""}${retina ? "-retina" : ""}${video ? "-video" : ""}`,
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: video ? ["--autoplay-policy=no-user-gesture-required"] : [],
});
const entry = "/src/__lightbox_audit.tsx";
const image =
  '<svg xmlns="http://www.w3.org/2000/svg" width="576" height="324"><rect width="576" height="324" fill="#9db2bd"/><circle cx="288" cy="162" r="68" fill="#40627b"/></svg>';
const portrait = image.replace('width="576" height="324"', 'width="240" height="480"');
const rectangles = {};
const tooltips = {};
const tipFrames = {};
const states = {};
const { PNG } = createRequire(
  createRequire(import.meta.resolve("@playwright/test")).resolve("playwright"),
)("playwright-core/lib/utilsBundle");
async function stableFrame(page, name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
  });
  let previous,
    identical = 0,
    prior;
  try {
    await expect
      .poll(
        async () => {
          const current = await page.screenshot();
          prior = previous;
          identical = previous?.equals(current) ? identical + 1 : 0;
          previous = current;
          return identical;
        },
        { timeout: 8000, intervals: [100] },
      )
      .toBe(2);
  } catch (error) {
    if (prior && previous) {
      await writeFile(join(output, `${name}-unstable-a.png`), prior);
      await writeFile(join(output, `${name}-unstable-b.png`), previous);
    }
    throw error;
  }
  return previous;
}
function difference(source, actual) {
  assert.equal(actual.width, source.width);
  assert.equal(actual.height, source.height);
  let total = 0;
  for (let index = 0; index < source.data.length; index += 4)
    if (source.data.readUInt32BE(index) !== actual.data.readUInt32BE(index)) total++;
  return total;
}
function crop(frame, rect, padding = 0) {
  const left = Math.max(0, Math.floor((rect.x - padding) * dpr));
  const top = Math.max(0, Math.floor((rect.y - padding) * dpr));
  const right = Math.min(frame.width, Math.ceil((rect.x + rect.width + padding) * dpr));
  const bottom = Math.min(frame.height, Math.ceil((rect.y + rect.height + padding) * dpr));
  const area = new PNG({ width: right - left, height: bottom - top });
  PNG.bitblt(frame, area, left, top, area.width, area.height, 0, 0);
  return area;
}
try {
  const clip = video ? await makeVideo(temp) : null;
  for (const upstream of [true, false]) {
    const name = upstream ? "upstream" : "desktop";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const sheet = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(sheet, `缺少 ${assets} 的生产样式`);
    const stylesheet = await readFile(join(assets, sheet));
    const fixture = upstream
      ? `import {MediaLightbox} from '/src/components/canvas/media-lightbox';
      function Fixture(){const [id,select]=useState('A');return <MediaLightbox items={items} target={{id,origin:null}} onActiveChange={select} onLocate={()=>{}} onClose={()=>{}}/>}`
      : `import {ShotImagePreview} from '/src/renderer/workspace/shot-image-preview';
      window.desktop={projects:{getAssetPreview:async({assetId,variant})=>{if(window.holdSource)await window.holdSource;return window.failReads ? {ok:false} : {ok:true,value:{url:${video}?(variant==='poster'?'/files/movie.mp4?v=poster':'/files/movie.mp4'):location.search?'/' + assetId + '.svg':'/fixture.svg'}};}}};
      function Fixture(){const [id,select]=useState('A');return <ShotImagePreview items={items} activeId={id} select={select} projectHandle="test" locate={()=>{}} download={()=>{}} close={()=>{}} countLabel="相邻节点"/>}`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "canvas-lightbox-fixture",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return id;
            if (id.endsWith(".css")) return "\0built-lightbox-css";
          },
          load(id) {
            if (id === "\0built-lightbox-css") return "export {};";
            if (id === entry)
              return `import {createRoot} from 'react-dom/client';import {useState} from 'react';${fixture}
        const items=${video ? `[{id:'A',nodeId:'A',assetId:'A',label:'样片',src:'/files/movie.mp4',mediaType:'video',kind:'video',bytes:${clip.length}}]` : `['A','B'].map(id=>({id,assetId:id,nodeId:id,src:location.search?'/'+id+'.svg':'/fixture.svg',label:id,mediaType:'image',bytes:location.search && id==='A'?${Buffer.byteLength(portrait)}:${Buffer.byteLength(image)}}))`};createRoot(document.getElementById('root')).render(<Fixture/>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: dpr,
      colorScheme: dark ? "dark" : "light",
      reducedMotion: "reduce",
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}assets/**`, (route) => {
        const file = basename(new URL(route.request().url()).pathname);
        return file === sheet
          ? route.fulfill({ body: stylesheet, contentType: "text/css" })
          : route.fulfill({ path: join(assets, file) });
      });
      let failImage = false;
      await page.route(`${origin}fixture.svg`, (route) =>
        route.request().method() === "GET" && failImage
          ? route.fulfill({ status: 503, body: "unavailable" })
          : route.fulfill({
              contentType: "image/svg+xml",
              body: image,
              headers: { "content-length": String(Buffer.byteLength(image)) },
            }),
      );
      await page.route(`${origin}audit*`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${dark ? "dark" : ""}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${sheet}"><style>html:root,body{background:${dark ? "#333" : "#eee"};min-height:100vh}</style><div id="root"></div><script type="module" src="${entry}"></script></html>`,
        }),
      );
      if (video) {
        rectangles[name] = await replayVideo(page, origin, clip, async (key) => {
          const frame = await stableFrame(page, `${name}-${key}`);
          await writeFile(join(output, `${name}-${key}.png`), frame);
          states[key] ??= [];
          states[key].push(PNG.sync.read(frame));
        });
        continue;
      }
      await page.goto(`${origin}audit`);
      await page.getByText(`576×324 · ${Buffer.byteLength(image)} B`).waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode()));
        await Promise.all(
          document.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
      });
      rectangles[name] = {};
      for (const label of ["上一个", "下一个", "下载原文件", "关闭", "定位到节点", "A", "B"])
        rectangles[name][label] = await page
          .getByRole("button", { name: label, exact: true })
          .boundingBox();
      rectangles[name].stage = await page
        .getByRole("img", { name: "A", exact: true })
        .boundingBox();
      if (process.env.LIGHTBOX_STYLE_AUDIT) {
        await writeFile(
          join(output, `${name}-geometry.json`),
          JSON.stringify(rectangles[name], null, 2),
        );
        console.log(
          name,
          await page.getByRole("img", { name: "A", exact: true }).evaluate((image) => {
            const entries = [];
            for (
              let element = image;
              element && entries.length < 8;
              element = element.parentElement
            ) {
              const rule = getComputedStyle(element);
              entries.push([
                element.tagName,
                rule.borderRadius,
                rule.boxShadow,
                rule.transform,
                rule.backgroundColor,
              ]);
            }
            return entries;
          }),
        );
      }
      const capture = async (key) => {
        const frame = await stableFrame(page, `${name}-${key}`);
        await writeFile(join(output, `${name}${key === "initial" ? "" : "-" + key}.png`), frame);
        states[key] ??= [];
        states[key].push(PNG.sync.read(frame));
        return frame;
      };
      await capture("initial");
      tooltips[name] = {};
      for (const [label, text] of [
        ["关闭", "关闭（Esc）"],
        ["下载原文件", "下载原文件"],
        ["下一个", "下一个（→）"],
        ["上一个", "上一个（←）"],
      ]) {
        if (label === "上一个") await page.keyboard.press("ArrowRight");
        await page.getByRole("button", { name: label, exact: true }).hover();
        const tip = page.locator(upstream ? '[data-slot="tooltip-content"]' : ".strip-tip");
        await expect(tip).toBeVisible();
        await expect(tip).toHaveText(text);
        await tip.evaluate(async (el) => {
          await Promise.allSettled(el.getAnimations().map((animation) => animation.finished));
        });
        tooltips[name][label] = {
          side: await tip.getAttribute("data-side"),
          rect: await tip.boundingBox(),
        };
        const { rect } = tooltips[name][label];
        const clip = {
          x: Math.floor(rect.x * dpr) - 2 * dpr,
          y: Math.floor(rect.y * dpr) - 6 * dpr,
          width: Math.ceil(rect.width * dpr) + 4 * dpr,
          height: Math.ceil(rect.height * dpr) + 12 * dpr,
        };
        const full = PNG.sync.read(await stableFrame(page, `${name}-tooltip-${label}`));
        const crop = new PNG({ width: clip.width, height: clip.height });
        PNG.bitblt(full, crop, clip.x, clip.y, clip.width, clip.height, 0, 0);
        await writeFile(join(output, `${name}-tooltip-${label}.png`), PNG.sync.write(crop));
        tipFrames[label] ??= [];
        tipFrames[label].push(crop);
        await page.mouse.move(500, 320);
        await expect(tip).toBeHidden();
      }
      const back = page.getByRole("button", { name: "上一个", exact: true });
      await back.hover();
      await page.mouse.down();
      await capture("previous-pressed");
      await page.mouse.up();
      await expect(page.getByText("相邻节点 1 / 2", { exact: true })).toBeVisible();
      const second = page.getByRole("button", { name: "B", exact: true });
      await second.hover();
      await expect(second).toHaveCSS("opacity", "1");
      await capture("thumbnail-hover");
      await page.mouse.move(500, 320);
      await page.keyboard.press("Tab");
      await second.focus();
      await expect(second.locator("css=:scope:focus-visible")).toHaveCount(1);
      await capture("thumbnail-focus");
      failImage = true;
      await page.reload();
      const failed = page.getByRole("img", { name: "原图加载失败", exact: true });
      await expect(failed).toBeVisible();
      await expect(page.getByRole("img", { name: "图片加载失败", exact: true })).toHaveCount(2);
      await capture("read-failed");
      failImage = false;
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await expect(failed).toHaveCount(0);
      await page.getByText(`576×324 · ${Buffer.byteLength(image)} B`).waitFor();
      await capture("retried");
      if (!upstream) {
        await page.addInitScript(() => {
          window.failReads = !location.search;
        });
        await page.reload();
        await page.getByText("原图加载失败").waitFor();
        await page.evaluate(() => {
          window.failReads = false;
        });
        await page.getByText("重试", { exact: true }).click();
        await page.getByText(`576×324 · ${Buffer.byteLength(image)} B`).waitFor();
        await page.evaluate(() => {
          window.failReads = false;
        });
      }
      let available = false;
      for (const [file, body] of [
        ["A", portrait],
        ["B", image],
      ])
        await page.route(`${origin}${file}.svg`, (route) =>
          file === "A" && !available && route.request().method() === "GET"
            ? route.fulfill({ status: 503, body: "" })
            : route.fulfill({
                contentType: "image/svg+xml",
                body,
                headers: { "content-length": String(Buffer.byteLength(body)) },
              }),
        );
      await page.goto(`${origin}audit?sequence`);
      await expect(failed).toBeVisible();
      const nextPage = async (direction, label) => {
        await page.keyboard.press(direction);
        await expect(page.locator("[aria-live=polite]").filter({ hasText: label })).toBeVisible();
      };
      await nextPage("ArrowRight", "576×324");
      await expect(failed).toHaveCount(0);
      available = true;
      await nextPage("ArrowLeft", "240×480");
      await expect(failed).toHaveCount(0);
      await nextPage("ArrowRight", "576×324");
      await expect(page.getByRole("img", { name: "A", exact: true })).toHaveCount(0);
      if (!upstream)
        await page.evaluate(() => {
          window.holdSource = new Promise((resolve) => (window.releaseSource = resolve));
        });
      await nextPage("ArrowLeft", "240×480");
      if (!upstream) {
        await expect(page.getByRole("img", { name: "A", exact: true })).toHaveCount(0);
        await page.evaluate(() => window.releaseSource());
      }
      await expect(page.getByRole("img", { name: "A", exact: true })).toBeVisible();
      await capture("revisited-portrait");
    } finally {
      await page.close();
      await server.close();
    }
  }
  const stateDifferences = Object.fromEntries(
    Object.entries(states).map(([key, pair]) => [key, difference(...pair)]),
  );
  const diff = stateDifferences.initial;
  const controlDifferences = {};
  if (video) {
    for (const [name, frames] of Object.entries(states)) {
      const menu = name === "speed-menu";
      const rect =
        rectangles.upstream[
          menu
            ? "倍速菜单"
            : name === "video-failed"
              ? "失败舞台"
              : name === "poster"
                ? "封面"
                : "控制条"
        ];
      const crops = frames.map((frame) => crop(frame, rect, menu ? 8 : 0));
      controlDifferences[name] = difference(...crops);
    }
    console.table(controlDifferences);
  }
  console.table(stateDifferences);
  console.log(JSON.stringify({ diff, rectangles }, null, 2));
  const tooltipDifferences = Object.fromEntries(
    Object.entries(tipFrames).map(([label, pair]) => [label, difference(...pair)]),
  );
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      { diff, stateDifferences, controlDifferences, rectangles, tooltips, tooltipDifferences },
      null,
      2,
    ),
  );
  console.table(tooltipDifferences);
  assert.deepEqual(rectangles.desktop, rectangles.upstream);
  assert.deepEqual(tooltips.desktop, tooltips.upstream);
  if (process.argv.includes("--strict"))
    assert(
      [...Object.values(stateDifferences), ...Object.values(tooltipDifferences)].every(
        (value) => value === 0,
      ),
    );
} finally {
  await browser.close();
  await rm(temp, { force: true, recursive: true });
}
