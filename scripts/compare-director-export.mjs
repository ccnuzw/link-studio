import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const output = resolve("test-results/director-export-parity"),
  temp = await mkdtemp(join(tmpdir(), "director-take-parity-"));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" }),
  records = {},
  pictures = {};
try {
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream",
      root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets"),
      css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    const entry = "/src/__audit_take.tsx";
    const scene = {
      version: 1,
      duration: 5,
      activeCameraId: "p",
      props: [],
      characters: [],
      cameras: [
        { id: "l", name: "机位1", aspect: "16:9", keys: [] },
        { id: "p", name: "机位2", aspect: "9:16", keys: [] },
      ],
    };
    const code = `import {createRoot} from 'react-dom/client';const scene=${JSON.stringify(scene)};const noop=()=>{};${upstream ? `import {ReactFlowProvider} from '@xyflow/react';import {DirectorExportDialog} from '@/components/director/director-export-dialog';import {useDirectorStore} from '@/store/director';useDirectorStore.setState({scene,nodeId:'director'});createRoot(document.querySelector('main')).render(<ReactFlowProvider><DirectorExportDialog nodeId="director" onClose={noop} onBackToCanvas={noop}/></ReactFlowProvider>);` : `import {DirectorExportDialog} from '/src/renderer/workspace/director-export-dialog';createRoot(document.querySelector('main')).render(<DirectorExportDialog scene={scene} label="导演台" projectHandle="local" place={noop} checkCapacity={noop} close={noop} back={noop}/>);`}`;
    const mocks = upstream
      ? {
          "@/utils/director/export-engine": `export const canExportVideo=async()=>true,createExportEngine=()=>{},UNSUPPORTED_EXPORT_MESSAGE='';`,
          "@/utils/canvas/upload-runner": "export const uploadRunner={};",
        }
      : {
          "./director-export": "export const exportDirectorTake=()=>{};",
        };
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "audit",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return id;
            if (id in mocks) return "\0" + id;
          },
          load(id) {
            return id === entry ? code : mocks[id.slice(1)];
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const [key, width, height] of [
        ["wide", 1000, 700],
        ["phone", 390, 844],
      ]) {
        const page = await browser.newPage({
          viewport: { width, height },
          deviceScaleFactor: 1,
          colorScheme: "dark",
        });
        try {
          page.on("pageerror", console.error);
          await page.route(`${origin}assets/**`, (route) =>
            route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
          );
          await page.route(`${origin}audit`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="dark"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "dark" : "canvas-workspace image-doodle-dialog director-dialog"}" style="position:fixed;inset:0;background:#171717"></main><script type="module" src="${entry}"></script></html>`,
            }),
          );
          await page.goto(origin + "audit");
          const panel = page.getByRole("dialog", { name: "导出运镜预览视频" });
          await panel.waitFor();
          await page.evaluate(async () => {
            await document.fonts.ready;
            document.activeElement?.blur?.();
          });
          for (const phase of ["idle", "multi"]) {
            if (phase === "multi") {
              await panel.getByRole("checkbox").first().check();
              await panel.getByLabel("1080p").check();
              await page.mouse.move(1, 1);
              await page.evaluate(() => document.activeElement?.blur?.());
            }
            await page.waitForTimeout(350);
            const name = key + "-" + phase;
            records[side + "-" + name] = await panel.evaluate((root) =>
              [
                root.querySelector(".director-export-panel") ?? root,
                ...root.querySelectorAll("h3,p,input,button"),
              ].map((node) => {
                const { x, y, width, height } = node.getBoundingClientRect();
                return { type: node.tagName, x, y, width, height };
              }),
            );
            pictures[side + "-" + name] = await page.screenshot({
              path: join(output, side + "-" + name + ".png"),
            });
          }
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  const page = await browser.newPage(),
    differences = {};
  for (const key of ["wide-idle", "wide-multi", "phone-idle", "phone-multi"]) {
    const pair = ["upstream", "desktop"].map((side) =>
      pictures[side + "-" + key].toString("base64"),
    );
    differences[key] = await page.evaluate(async (pair) => {
      const pixels = await Promise.all(
        pair.map(async (png) => {
          const img = new Image();
          img.src = "data:image/png;base64," + png;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          return new Uint32Array(ctx.getImageData(0, 0, img.width, img.height).data.buffer);
        }),
      );
      return pixels[0].reduce((count, value, index) => count + (value !== pixels[1][index]), 0);
    }, pair);
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ records, differences }, null, 2));
  console.table(differences);
  for (const key of Object.keys(differences)) {
    assert.deepEqual(
      records["desktop-" + key],
      records["upstream-" + key],
      key + " control rectangles",
    );
    if (process.argv.includes("--strict")) assert.equal(differences[key], 0, key + " pixels");
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
