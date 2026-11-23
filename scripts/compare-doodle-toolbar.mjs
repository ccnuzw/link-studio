import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const testRequire = createRequire(import.meta.resolve("@playwright/test"));
const { PNG } = createRequire(testRequire.resolve("playwright"))("playwright-core/lib/utilsBundle");
const dpr = process.argv.includes("--retina") ? 2 : 1;
const output = resolve(`test-results/doodle-toolbar-parity-${dpr}`);
const scratch = await mkdtemp(join(tmpdir(), "canvas-doodle-"));
const browser = await chromium.launch({ channel: "chrome" });
const geometry = {},
  images = {},
  differences = {};
await mkdir(output, { recursive: true });
try {
  for (const side of ["original", "desktop"]) {
    const original = side === "original";
    const root = original ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, original ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const entry = "/src/__doodle_toolbar.tsx";
    const fixture = `import {useState} from 'react';import {createRoot} from 'react-dom/client';
      import {DoodleToolbar} from '${original ? "@/components/canvas/doodle-toolbar" : "/src/renderer/workspace/doodle-toolbar"}';
      function Fixture(){const [tool,setTool]=useState('pen'),[color,setColor]=useState('#ef4444'),[width,setWidth]=useState(6);const noop=()=>{};
      return <DoodleToolbar tool={tool} color={color} width={width} onToolChange={setTool} onColorChange={setColor} onWidthChange={setWidth} canUndo={false} canRedo={false} saveDisabled={false} onUndo={noop} onRedo={noop} onSave={noop} onClose={noop} onInteract={noop}/>;}createRoot(document.querySelector('main')).render(<Fixture/>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(scratch, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "doodle-toolbar",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? fixture : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"])
        for (const width of [1280, 620]) {
          const page = await browser.newPage({
            viewport: { width, height: 700 },
            deviceScaleFactor: dpr,
            colorScheme: theme,
          });
          try {
            await page.route(origin + "assets/**", (route) =>
              route.fulfill({
                path: join(assets, basename(new URL(route.request().url()).pathname)),
              }),
            );
            await page.route(origin + "audit", (route) =>
              route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:${theme === "light" ? "#f7f7f7" : "#171717"}"></main><script type="module" src="${entry}"></script></html>`,
              }),
            );
            await page.goto(origin + "audit");
            const toolbar = page.getByRole("toolbar");
            await toolbar.waitFor();
            await page.evaluate(() => document.fonts.ready);
            const capture = async (state) => {
              await expect
                .poll(() =>
                  toolbar
                    .getByRole("button")
                    .evaluateAll((buttons) =>
                      buttons.every((button) => getComputedStyle(button).transform === "none"),
                    ),
                )
                .toBe(true);
              await page.evaluate(async () => {
                await Promise.allSettled(
                  document.getAnimations().map((animation) => animation.finished),
                );
              });
              const key = `${width}-${theme}-${state}`;
              const frame = await page.screenshot();
              for (let repeat = 0; repeat < 2; repeat++) {
                await page.evaluate(
                  () =>
                    new Promise((resolve) =>
                      requestAnimationFrame(() => requestAnimationFrame(resolve)),
                    ),
                );
                assert(frame.equals(await page.screenshot()), `${side}-${key} 尚非稳定静帧`);
              }
              const full = PNG.sync.read(frame);
              const crop = new PNG({ width: 620 * dpr, height: 142 * dpr });
              PNG.bitblt(
                full,
                crop,
                ((width - 620) * dpr) / 2,
                306 * dpr,
                crop.width,
                crop.height,
                0,
                0,
              );
              const image = PNG.sync.write(crop);
              await writeFile(join(output, `${side}-${key}.png`), image);
              (images[key] ??= []).push(image.toString("base64"));
              geometry[`${side}-${key}`] = await page
                .locator('[role=toolbar], [role=toolbar] button,[title="粗细"],[role=dialog]')
                .evaluateAll((elements) =>
                  elements.map((element) => ({
                    name: element.ariaLabel ?? element.title,
                    rect: element.getBoundingClientRect().toJSON(),
                    font: getComputedStyle(element).font,
                    color: getComputedStyle(element).color,
                  })),
                );
            };
            await expect(toolbar.getByRole("button", { name: "撤销" })).toBeDisabled();
            await expect(toolbar.getByRole("button", { name: "画笔" })).toHaveAttribute(
              "aria-pressed",
              "true",
            );
            assert.equal(
              await toolbar.getByText("画笔", { exact: true }).isVisible(),
              width >= 768,
            );
            await capture("initial");
            await toolbar.getByRole("button", { name: "框选" }).click();
            await toolbar.getByRole("button", { name: "颜色", exact: true }).click();
            await page.mouse.move(10, 10);
            const palette = page.getByRole("dialog");
            await expect(palette.getByRole("button")).toHaveCount(8);
            await capture("palette");
            await palette.getByRole("button", { name: "颜色 #facc15" }).press("Enter");
            await expect(palette).toBeHidden();
            await toolbar.getByRole("slider").press("End");
            await expect(toolbar.getByRole("slider")).toHaveValue("20");
            await capture("slider-focus");
          } finally {
            await page.close();
          }
        }
    } finally {
      await server.close();
    }
  }
  const diffPage = await browser.newPage();
  for (const [key, pair] of Object.entries(images))
    differences[key] = await diffPage.evaluate(async (pair) => {
      const [source, actual] = await Promise.all(
        pair.map(async (value) => {
          const img = new Image();
          img.src = "data:image/png;base64," + value;
          await img.decode();
          const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d");
          ctx.drawImage(img, 0, 0);
          return new Uint32Array(ctx.getImageData(0, 0, img.width, img.height).data.buffer);
        }),
      );
      return source.reduce((sum, pixel, index) => sum + Number(pixel !== actual[index]), 0);
    }, pair);
  await writeFile(join(output, "results.json"), JSON.stringify({ geometry, differences }, null, 2));
  console.table(differences);
  if (process.argv.includes("--strict"))
    assert(Object.values(differences).every((value) => value === 0));
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
