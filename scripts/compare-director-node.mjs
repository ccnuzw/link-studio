import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const output = resolve("test-results/director-body-parity"),
  temp = await mkdtemp(join(tmpdir(), "director-node-"));
const geometry = {},
  differences = {};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream",
      root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd(),
      assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const entry = "/src/__director_body_fixture.tsx";
    const code = `import {createRoot} from 'react-dom/client';import {DirectorNodeBody} from '${upstream ? "@/components/director/director-node-body" : "/src/renderer/workspace/director-node-body"}';
      const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="270" height="480"><rect width="270" height="480" fill="#d6c2ac"/><circle cx="135" cy="270" r="90" fill="#254e56"/></svg>');const ready=location.search==='?thumbnail';const scene={duration:5,cameras:[{id:'camera1',name:'机位1'},...(ready?[{id:'camera2',name:'外景'}]:[])],thumb:ready?{url:src}:undefined};const enter=()=>document.body.dataset.entered='true';createRoot(document.querySelector('article')).render(<DirectorNodeBody scene={scene} ${upstream ? "onEnter={enter}" : "enter={enter} thumbnail={scene.thumb?.url}"}/>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "director-node",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? code : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport: { width: 900, height: 520 },
          deviceScaleFactor: 1,
          colorScheme: theme,
        });
        try {
          await page.route(`${origin}assets/**`, (route) =>
            route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
          );
          await page.route(`${origin}audit*`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "" : "canvas-workspace"}" style="position:fixed;inset:0;background:${theme === "dark" ? "#171717" : "#fafafa"}"><article style="position:absolute;left:100px;top:100px;border-radius:8px;width:576px;background:${theme === "dark" ? "#171717" : "white"}"></article></main><script type="module" src="${entry}"></script></html>`,
            }),
          );
          for (const state of ["placeholder", "thumbnail"]) {
            await page.goto(`${origin}audit?${state}`);
            const button = page.getByRole("button", { name: "进入导演台" });
            await button.waitFor();
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all([...document.images].map((image) => image.decode()));
            });
            const body = page.locator("article > div"),
              rect = await body.boundingBox();
            assert.deepEqual(rect, { x: 100, y: 100, width: 576, height: 324 });
            if (process.env.DIRECTOR_GEOMETRY && state === "placeholder" && theme === "light")
              console.log(
                side,
                await body
                  .locator("button,span")
                  .evaluateAll((items) =>
                    items.map((item) => [
                      item.textContent,
                      getComputedStyle(item).font,
                      getComputedStyle(item).letterSpacing,
                      item.getBoundingClientRect().toJSON(),
                    ]),
                  ),
              );
            for (const phase of ["idle", "focus", "hover"]) {
              if (phase === "focus") await page.keyboard.press("Tab");
              if (phase === "hover") {
                await button.blur();
                await button.hover();
              }
              const key = `${theme}-${state}-${phase}`;
              geometry[`${side}-${key}`] = await button.boundingBox();
              await page.screenshot({
                clip: rect,
                path: join(output, `${side}-${key}.png`),
                animations: "disabled",
              });
              if (upstream) continue;
              const [before, after] = ["upstream", "desktop"].map((prefix) =>
                execFileSync(
                  resolve("out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
                  [
                    "-v",
                    "error",
                    "-i",
                    join(output, `${prefix}-${key}.png`),
                    "-pix_fmt",
                    "rgb24",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                  ],
                ),
              );
              let count = 0;
              for (let pos = 0; pos < before.length; pos += 3)
                if (before.readUIntBE(pos, 3) !== after.readUIntBE(pos, 3)) count++;
              differences[key] = count;
            }
            await button.press("Enter");
            await expect(page.locator("body")).toHaveAttribute("data-entered", "true");
            await page.mouse.move(1, 1);
          }
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ geometry, differences }, null, 2));
  console.table(differences);
  for (const key of Object.keys(differences))
    assert.deepEqual(geometry[`upstream-${key}`], geometry[`desktop-${key}`]);
  if (process.argv.includes("--strict"))
    assert(Object.values(differences).every((count) => count === 0));
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
