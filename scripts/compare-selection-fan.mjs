import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const dark = process.argv.includes("--dark"),
  retina = process.argv.includes("--retina");
const whole = process.argv.includes("--whole"),
  notice = process.argv.includes("--notice");
const scratch = await mkdtemp(join(tmpdir(), "fan-compare-")),
  output = resolve(
    "test-results/selection-fan-parity" + (dark ? "-dark" : "") + (retina ? "-retina" : ""),
  );
const browser = await chromium.launch({ channel: "chrome" }),
  entry = "/src/__fan_compare.tsx",
  results = {};
await mkdir(output, { recursive: true });
try {
  for (const side of ["original", "desktop"]) {
    const original = side === "original",
      root = original ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, original ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const stylesheet = await readFile(join(assets, css));
    const code = notice
      ? `import {createRoot} from 'react-dom/client';${original ? `import {Toaster} from '@/components/ui/sonner';import {useSettingsStore} from '@/store/settings';import {toast} from 'sonner';useSettingsStore.getState().updateSettings('theme','${dark ? "dark" : "light"}');window.notify=text=>toast.info(text);` : `import {CanvasToaster as Toaster,reportLinkNotice} from '/src/renderer/workspace/canvas-toaster';window.notify=reportLinkNotice;`}createRoot(document.querySelector('main')).render(<Toaster/>);`
      : `import {createRoot} from 'react-dom/client';import {ReactFlow,ReactFlowProvider,ViewportPortal} from '@xyflow/react';
      ${original ? `import {SelectionFanHandle} from '@/components/canvas-editor/selection-fan-handle';` : `import {SelectionFan} from '/src/renderer/workspace/selection-fan';`}
      const ids=['one','two'];const nodes=ids.map((id,index)=>({id,position:{x:60,y:50+140*index},style:{width:150,height:90},data:{label:id}}));
      const zoom=Number(location.search.slice(1));window.drops=[];const report=(to,froms)=>window.drops.push({to,froms:froms.map(({x,y})=>({x,y}))});
      createRoot(document.querySelector('main')).render(<ReactFlowProvider><ReactFlow defaultNodes={nodes} defaultViewport={{x:10,y:20,zoom}}><ViewportPortal>
        ${original ? `<SelectionFanHandle ids={ids} x={234} y={160} onFanOut={(to,group)=>report(to,group.froms)}/>` : `<SelectionFan ids={ids} anchor={{x:234,y:160}} open={({to,exits})=>report(to,exits)}/>`}
      </ViewportPortal></ReactFlow></ReactFlowProvider>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(scratch, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "selection-fan",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? code : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      const page = await browser.newPage({
        viewport: { width: 780, height: 580 },
        deviceScaleFactor: retina ? 2 : 1,
        colorScheme: dark ? "dark" : "light",
      });
      await page.route(origin + "assets/**", (route) =>
        basename(new URL(route.request().url()).pathname) === css
          ? route.fulfill({ contentType: "text/css", body: stylesheet })
          : route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
      );
      await page.route(origin + "audit*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="zh-CN" class="${dark ? "dark" : "light"}"><link rel="stylesheet" href="/assets/${css}"><style>main{position:fixed;inset:0;${original && notice ? "background:var(--canvas-bg)" : ""}}.react-flow{background:oklch(${dark ? ".13" : ".975"} 0 0)}</style><main class="${original ? "" : "canvas-workspace"}"></main><script type="module" src="${entry}"></script></html>`,
        }),
      );
      if (notice) {
        for (const [phase, text] of [
          ["skip", "1 个节点接不到视频上，已跳过"],
          ["loose", "4 个节点接不到刚才那根线上，已单独放下"],
        ]) {
          await page.goto(origin + "audit");
          await page.locator("section[aria-live=polite]").waitFor({ state: "attached" });
          await page.evaluate((text) => window.notify(text), text);
          const item = page.locator("[data-sonner-toast][data-type=info]");
          await expect(item).toHaveText(text);
          await expect(item).toHaveAttribute("data-mounted", "true");
          await page.waitForFunction(() => {
            const item = document.querySelector("[data-sonner-toast]");
            return (
              item?.getBoundingClientRect().y === 24 &&
              !item.getAnimations().some((animation) => animation.playState === "running")
            );
          });
          results[side + "-" + phase] = await item.boundingBox();
          let last,
            stable = 0;
          for (let attempt = 0; attempt < 15 && stable < 3; attempt++) {
            const next = await page.screenshot();
            stable = last?.equals(next) ? stable + 1 : 1;
            last = next;
          }
          assert.equal(stable, 3);
          await writeFile(join(output, side + "-" + phase + ".png"), last);
        }
      } else
        for (const zoom of [0.65, 1, 1.5]) {
          await page.goto(origin + "audit?" + zoom);
          const button = page.getByRole("button", { name: "引用选中的节点生成" });
          await expect(button).toHaveCSS("opacity", "1");
          await expect(button).toHaveCSS("transform", "none");
          const box = await button.boundingBox();
          assert(box);
          const x = Math.round(box.x + box.width / 2),
            y = Math.round(box.y + box.height / 2);
          const lines = page.locator('body > svg[aria-hidden="true"] > path');
          async function record(stage) {
            const key = side + "-" + zoom + "-" + stage;
            const bounds = await button.boundingBox();
            results[key] = {
              bounds,
              lines: await lines.evaluateAll((paths) => paths.map((p) => p.getAttribute("d"))),
            };
            if (zoom === 1) {
              const clip = {
                x: Math.round(bounds.x) - 5,
                y: Math.round(bounds.y) - 5,
                width: 38,
                height: 38,
              };
              await page.screenshot({ clip, path: join(output, key + ".png") });
            }
            if (whole) {
              let last,
                stable = 0;
              for (let attempt = 0; attempt < 15 && stable < 3; attempt++) {
                const next = await page.screenshot({ animations: "disabled" });
                stable = last?.equals(next) ? stable + 1 : 1;
                last = next;
              }
              assert.equal(stable, 3, "Unstable " + key);
              await writeFile(join(output, key + "-whole.png"), last);
            }
          }
          await record("idle");
          await page.mouse.move(x, y);
          await page.waitForTimeout(200);
          await record("hover");
          await page.mouse.down();
          await page.mouse.move(x + 6, y);
          await expect(lines).toHaveCount(0);
          await record("threshold");
          await page.mouse.up();
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + 45, y + 26, { steps: 6 });
          await expect(lines).toHaveCount(2);
          await record("drag");
          if (zoom === 1)
            await page.screenshot({
              clip: { x: 226, y: 105, width: 134, height: 163 },
              path: join(output, side + "-1-guides.png"),
            });
          await page.mouse.up();
          await expect(lines).toHaveCount(0);
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + 9, y + 18, { steps: 4 });
          await expect(lines).toHaveCount(2);
          await button.dispatchEvent("pointercancel", { pointerId: 1 });
          await page.mouse.up();
          await expect(lines).toHaveCount(0);
          const drops = await page.evaluate(() => window.drops);
          assert.equal(drops.length, 2);
          results[side + "-" + zoom + "-drops"] = drops;
        }
      await page.close();
    } finally {
      await server.close();
    }
  }
  for (const key of Object.keys(results).filter((key) => key.startsWith("original-")))
    assert.deepEqual(results["desktop-" + key.slice(9)], results[key], key);
  const decode = await browser.newPage();
  const differences = {},
    frames = {};
  async function diff(suffix) {
    const images = await Promise.all(
      ["original", "desktop"].map(async (side) =>
        (await readFile(join(output, `${side}-${suffix}.png`))).toString("base64"),
      ),
    );
    return decode.evaluate(async (pair) => {
      const buffers = await Promise.all(
        pair.map(async (src) => {
          const image = new Image();
          image.src = "data:image/png;base64," + src;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          return new Uint32Array(ctx.getImageData(0, 0, image.width, image.height).data.buffer);
        }),
      );
      if (buffers[0].length !== buffers[1].length) throw Error("size mismatch");
      return buffers[0].reduce((sum, value, index) => sum + Number(value !== buffers[1][index]), 0);
    }, images);
  }
  if (notice) for (const phase of ["skip", "loose"]) frames[phase] = await diff(phase);
  else {
    for (const stage of ["idle", "hover", "threshold", "drag", "guides"])
      differences[stage] = await diff(`1-${stage}`);
    if (whole)
      for (const zoom of [0.65, 1, 1.5])
        for (const phase of ["idle", "hover", "threshold", "drag"])
          frames[`${zoom}-${phase}`] = await diff(`${zoom}-${phase}-whole`);
  }
  await writeFile(
    join(output, notice ? "notice.json" : whole ? "results-whole.json" : "results.json"),
    JSON.stringify({ results, differences, frames }, null, 2),
  );
  console.table(differences);
  if (whole || notice) console.table(frames);
  if (process.argv.includes("--strict"))
    assert([...Object.values(differences), ...Object.values(frames)].every((value) => value === 0));
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
