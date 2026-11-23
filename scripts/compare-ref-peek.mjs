import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const desktop = process.cwd();
assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned web checkout");
const output = join(desktop, "test-results/ref-peek-parity");
const cache = await mkdtemp(join(tmpdir(), "peek-compare-"));
const browser = await chromium.launch({ channel: "chrome" });
const results = new Map();
try {
  await mkdir(output, { recursive: true });
  for (const [name, root, component, assets] of [
    [
      "upstream",
      resolve(process.env.VIDEO_CANVAS_WEB),
      "components/canvas/use-ref-peek",
      "dist/assets",
    ],
    ["desktop", desktop, "renderer/workspace/use-ref-peek", "out/renderer/assets"],
  ]) {
    const fixture = "/src/__peek_audit.jsx";
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(cache, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "peek-fixture",
          resolveId(id) {
            if (id === fixture) return join(root, fixture);
          },
          load(id) {
            if (id === join(root, fixture))
              return `import React from 'react';import {createRoot} from 'react-dom/client';import {RefPeek} from '/src/${component}';createRoot(document.querySelector('main')).render(<RefPeek target={{kind:'image',src:'/sample.png'}} alt="sample">{bind=><button {...bind} style={{position:'fixed',top:340,left:220,width:40,height:24,background:'#999',border:0,padding:0}}/>}</RefPeek>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 520, height: 400 },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      const css = (await readdir(join(root, assets))).find((file) => /^index-.*\.css$/.test(file));
      assert(css);
      await page.route(`${origin}sample.png`, (route) =>
        route.fulfill({ path: join(desktop, "resources/icons/icon-512.png") }),
      );
      await page.route(`${origin}styles.css`, (route) =>
        route.fulfill({ path: join(root, assets, css) }),
      );
      await page.route(`${origin}audit`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><link rel="stylesheet" href="/styles.css"><main style="position:fixed;inset:0;background:#eee"></main><script type="module" src="${fixture}"></script>`,
        }),
      );
      await page.goto(`${origin}audit`);
      for (const placement of ["above", "below"]) {
        const anchor = page.getByRole("button");
        await page.mouse.move(510, 396);
        const photo = page.getByRole("img", { name: "sample" });
        await expect(photo).toHaveCount(0);
        if (placement === "below")
          await anchor.evaluate((el) => Object.assign(el.style, { top: "8px", left: "2px" }));
        await anchor.hover();
        await expect.poll(() => photo.evaluate((el) => el.naturalWidth)).toBe(512);
        await expect
          .poll(() => photo.evaluate((el) => getComputedStyle(el.parentElement).transform))
          .toBe("none");
        const rect = await photo.boundingBox();
        const clip = {
          x: Math.max(0, rect.x - 50),
          y: Math.max(0, rect.y - 25),
          width: Math.min(356, 520 - Math.max(0, rect.x - 50)),
          height: Math.min(338, 400 - Math.max(0, rect.y - 25)),
        };
        const image = await page.screenshot({
          clip,
          path: join(output, `${name}-${placement}.png`),
        });
        if (name === "upstream") results.set(placement, { rect, image });
        else {
          assert.deepEqual(rect, results.get(placement).rect);
          console.log(placement, rect, "identical PNG", image.equals(results.get(placement).image));
          assert(image.equals(results.get(placement).image));
        }
      }
    } finally {
      await page.close();
      await server.close();
    }
  }
} finally {
  await browser.close();
  await rm(cache, { recursive: true, force: true });
}
