import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned web directory");
const output = resolve("test-results/character-detail-parity");
const cache = await mkdtemp(join(tmpdir(), "character-detail-"));
const browser = await chromium.launch({ channel: "chrome" });
const results = {};
const entry = "/src/__character_detail_audit.tsx";
const upstreamFixture = `import {ReactFlowProvider} from '@xyflow/react';
import {CharacterDetailDialog} from '/src/components/canvas-editor/character-detail-dialog';
function Fixture(){const [open,setOpen]=React.useState(false);return <ReactFlowProvider><button onClick={()=>setOpen(true)}>编辑角色卡</button><CharacterDetailDialog open={open} onOpenChange={setOpen} id="actor" data={{label:'未命名角色'}} voiceGen={{models:[],options:[],modelsStatus:'ready',task:{phase:'idle'}}}/></ReactFlowProvider>}`;
const desktopFixture = `import {CharacterDialog} from '/src/renderer/workspace/character-dialog';
function Fixture(){const [open,setOpen]=React.useState(false);return <><button onClick={()=>setOpen(true)}>编辑角色卡</button>{open && <CharacterDialog character={{name:'未命名角色',look:'基础形象',description:'',extraAssetIds:[]}} projectHandle="actor" assets={[]} jobs={[]} settings={{providers:[],plugins:[]}} close={()=>setOpen(false)}/>}</>}`;

function pixelDifference(page, original, desktop, visual = false) {
  return page.evaluate(
    async ({ pictures, visual }) => {
      const pixels = await Promise.all(
        pictures.map(async (data) => {
          const image = new Image();
          image.src = "data:image/png;base64," + data;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return new Uint32Array(context.getImageData(0, 0, image.width, image.height).data.buffer);
        }),
      );
      const count = pixels[0].reduce(
        (total, value, index) => total + Number(value !== pixels[1][index]),
        0,
      );
      if (!visual) return { count };
      const canvas = document.createElement("canvas");
      canvas.width = innerWidth;
      canvas.height = innerHeight;
      const context = canvas.getContext("2d");
      const image = context.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < pixels[0].length; index++) {
        const offset = index * 4;
        const different = pixels[0][index] !== pixels[1][index];
        const grey = 152 + Math.round((pixels[1][index] & 255) * 0.4);
        image.data.set(different ? [204, 24, 52, 255] : [grey, grey, grey, 255], offset);
      }
      context.putImageData(image, 0, 0);
      return { count, png: canvas.toDataURL("image/png").split(",")[1] };
    },
    { pictures: [original, desktop].map((item) => item.toString("base64")), visual },
  );
}

try {
  await mkdir(output, { recursive: true });
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const files = (await readdir(assets)).filter((name) => /^index-.*\.css$|\.woff2$/.test(name));
    const css = files.find((name) => name.endsWith(".css"));
    assert(css);
    const resources = new Map(
      await Promise.all(files.map(async (file) => [file, await readFile(join(assets, file))])),
    );
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(cache, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "character-detail-fixture",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return join(root, entry);
            if (id.endsWith(".css")) return "\0built-css";
          },
          load(id) {
            if (id === "\0built-css") return "export {};";
            if (id === join(root, entry))
              return `import React from 'react';import {createRoot} from 'react-dom/client';${upstream ? upstreamFixture : desktopFixture}createRoot(document.getElementById('root')).render(<Fixture/>);`;
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const width of [1000, 390])
        for (const theme of ["light", "dark"]) {
          const key = `${width}-${theme}`;
          const page = await browser.newPage({
            viewport: { width, height: 680 },
            deviceScaleFactor: 1,
            colorScheme: theme,
          });
          try {
            page.on("pageerror", (err) => console.error(side, err.message));
            await page.route(`${origin}assets/**`, (route) => {
              const file = basename(new URL(route.request().url()).pathname);
              return route.fulfill({
                contentType: file.endsWith(".css") ? "text/css" : "font/woff2",
                body: resources.get(file),
              });
            });
            await page.route(`${origin}audit`, (route) =>
              route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><style>body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(30deg,#63828f 0 18px,#d4c7ba 18px 36px)}#root>button{position:fixed;left:50%;top:50%;border:0;border-radius:0;background:#fff;color:#111;padding:0;font:14px/20px sans-serif}</style><body><main class="${upstream ? "" : "canvas-workspace canvas-modal-scope"}" id="root"></main><script type="module" src="${entry}"></script>`,
              }),
            );
            await page.goto(`${origin}audit`);
            const trigger = page.getByRole("button", { name: "编辑角色卡" });
            await trigger.waitFor();
            await page.evaluate(() => document.fonts.ready);
            const closed = await page.screenshot({
              path: join(output, `${side}-${key}-closed.png`),
            });
            const triggerBox = await trigger.boundingBox();
            const triggerStyle = await trigger.evaluate((button) =>
              Object.fromEntries(
                [
                  "background",
                  "color",
                  "padding",
                  "border",
                  "box-shadow",
                  "opacity",
                  "font",
                  "text-rendering",
                  "-webkit-font-smoothing",
                  "appearance",
                  "filter",
                  "outline",
                  "backdrop-filter",
                  "overflow",
                  "transform",
                ].map((key) => [key, getComputedStyle(button).getPropertyValue(key)]),
              ),
            );
            await trigger.click();
            await page.mouse.move(0, 0);
            const modal = page.getByRole("dialog");
            await modal.waitFor();
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all(
                document
                  .getAnimations()
                  .filter(
                    (animation) => animation.effect?.getComputedTiming().iterations !== Infinity,
                  )
                  .map((animation) => animation.finished.catch(() => {})),
              );
            });
            const close = modal.getByRole("button", {
              name: upstream ? "Close" : "关闭角色卡",
              exact: true,
            });
            const photo = modal.getByRole("button", { name: "从真人库引入" });
            const name = modal.getByLabel("角色名称", { exact: true });
            const rect = await modal.boundingBox();
            const button = await close.boundingBox();
            const imageControl = await photo.boundingBox();
            const field = await name.boundingBox();
            const file = `${side}-${key}.png`;
            const bytes = await page.screenshot({ path: join(output, file) });
            results[key] ??= {};
            results[key][side] = {
              triggerBox,
              triggerStyle,
              rect,
              button,
              imageControl,
              field,
              file,
            };
            results[key][side].focus = await page.evaluate(() =>
              document.activeElement?.textContent?.trim().slice(0, 40),
            );
            if (!upstream) {
              const original = await readFile(join(output, results[key].upstream.file));
              const difference = await pixelDifference(page, original, bytes, true);
              results[key].different = difference.count;
              const diffFile = `difference-${key}.png`;
              await writeFile(join(output, diffFile), Buffer.from(difference.png, "base64"));
              results[key].diffFile = diffFile;
              results[key].closedDifferent = (
                await pixelDifference(
                  page,
                  await readFile(join(output, `upstream-${key}-closed.png`)),
                  closed,
                )
              ).count;
            }
            await page.mouse.click(3, 3);
            await modal.waitFor({ state: "hidden", timeout: 1000 }).catch(() => {});
            results[key][side].outsideDismissed = await modal.isHidden();
          } finally {
            await page.close();
          }
        }
    } finally {
      await server.close();
    }
  }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  for (const [key, result] of Object.entries(results))
    console.log(
      key,
      result.different,
      result.upstream.rect,
      result.desktop.rect,
      result.upstream.outsideDismissed,
      result.desktop.outsideDismissed,
    );
  for (const result of Object.values(results))
    assert(result.upstream.outsideDismissed && result.desktop.outsideDismissed);
  for (const result of Object.values(results)) {
    assert.equal(result.desktop.focus, result.upstream.focus);
    for (const field of ["triggerBox", "rect", "button", "imageControl", "field"])
      assert.deepEqual(result.desktop[field], result.upstream[field]);
  }
  if (process.argv.includes("--strict"))
    assert(
      Object.values(results).every(
        (result) =>
          !result.different && result.upstream.outsideDismissed === result.desktop.outsideDismissed,
      ),
    );
} finally {
  await browser.close();
  await rm(cache, { recursive: true, force: true });
}
