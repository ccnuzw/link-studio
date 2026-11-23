import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const desktop = process.cwd();
const baseline = resolve(process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web");
const output = join(desktop, "test-results/group-toolbar-parity");
const temp = await mkdtemp(join(tmpdir(), "group-toolbar-parity-"));
const browser = await chromium.launch({ channel: "chrome" });
const geometry = {};
const captures = [];
await mkdir(output, { recursive: true });
try {
  for (const [name, root] of [
    ["upstream", baseline],
    ["desktop", desktop],
  ]) {
    const reference = name === "upstream";
    const assets = join(root, reference ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const subject = reference
      ? "/src/components/canvas-editor/group-toolbar"
      : "/src/renderer/workspace/group-toolbar";
    const fixture = join(root, "src/__group_toolbar_fixture.jsx");
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "toolbar-fixture",
          resolveId(id) {
            if (id === "/src/__group_toolbar_fixture.jsx") return fixture;
          },
          load(id) {
            if (id === fixture)
              return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {ReactFlow} from '@xyflow/react';import {GroupToolbar} from '${subject}';
          const nodes=[{id:'group',position:{x:420,y:350},width:440,height:240,data:{}},...['a','b'].map((id,index)=>({id,parentId:'group',position:{x:index*80,y:40},width:60,height:60,data:{}}))];
          createRoot(document.querySelector('#root')).render(<ReactFlow defaultNodes={nodes} proOptions={{hideAttribution:true}}><GroupToolbar id="group" data={{label:'组'}} colors={{}} memberCount={2}/></ReactFlow>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}audit`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="/built/${css}"><main class="${reference ? "" : "canvas-workspace"}" style="position:fixed;inset:0;display:block;background:oklch(.975 0 0)"><div id="root" style="height:100%"></div></main><script type="module" src="/src/__group_toolbar_fixture.jsx"></script>`,
        }),
      );
      await page.route(`${origin}built/**`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.goto(`${origin}audit`);
      const toolbar = page.locator(
        reference ? '[data-slot="chrome-pill"]' : ".canvas-group-toolbar",
      );
      await toolbar.waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map((animation) => animation.finished));
      });
      geometry[name] = {
        rect: await toolbar.boundingBox(),
        buttons: await toolbar.locator("button,kbd").evaluateAll((elements) =>
          elements.map((element) => ({
            name: element.textContent,
            width: element.getBoundingClientRect().width,
            font: getComputedStyle(element).font,
            spacing: getComputedStyle(element).letterSpacing,
          })),
        ),
      };
      const clip = { x: 400, y: 224, width: 480, height: 102 };
      const capture = await page.screenshot({ clip, path: join(output, `${name}.png`) });
      assert((await page.screenshot({ clip })).equals(capture));
      captures.push(`data:image/png;base64,${capture.toString("base64")}`);
    } finally {
      await page.close();
      await server.close();
    }
  }
  const comparison = await browser.newPage();
  geometry.differentPixels = await comparison.evaluate(async (images) => {
    const [original, replica] = await Promise.all(
      images.map(async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const context = new OffscreenCanvas(image.width, image.height).getContext("2d");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      }),
    );
    let differences = 0;
    for (let index = 0; index < original.length; index += 4) {
      if (
        original[index] !== replica[index] ||
        original[index + 1] !== replica[index + 1] ||
        original[index + 2] !== replica[index + 2]
      )
        differences++;
    }
    return differences;
  }, captures);
  await comparison.close();
  await writeFile(join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
  console.log(geometry);
  assert.equal(geometry.differentPixels, 0, "浅色默认态的分组工具条出现像素差异");
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
