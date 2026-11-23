import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const output = resolve("test-results/node-action-strip"),
  temp = await mkdtemp(join(tmpdir(), "action-strip-"));
const kinds = ["script", "storyboard", "image", "video", "audio"];
const browser = await chromium.launch({ channel: "chrome" }),
  geometry = {},
  diffs = {};
await mkdir(output, { recursive: true });
try {
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream",
      root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets"),
      css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    const entry = "/src/__node_strip_fixture.tsx";
    const imports = upstream
      ? `import {NodeActionBar} from '@/components/canvas/node-action-bar';import {NODE_TOOLBAR} from '@/constants/node-toolbar';import {TooltipProvider} from '@/components/ui/tooltip';`
      : `import {NodeActionStrip} from '/src/renderer/workspace/node-action-strip';`;
    const subject = upstream
      ? `<TooltipProvider><NodeActionBar label={kind} config={NODE_TOOLBAR[kind]} gate={{visible:true,actionsDisabled:disabled}} onTail={disabled?{}:{addToLibrary:()=>{}}}/></TooltipProvider>`
      : `<NodeActionStrip kind={kind} label={kind} ready={true} running={disabled} history={true} room={100} action={()=>{}} frame={()=>{}} grid={()=>{}}/>`;
    const code = `import {createRoot} from 'react-dom/client';${imports} const kinds=${JSON.stringify(kinds)};createRoot(document.querySelector('main')).render(<>{[...kinds,'audio'].map((kind,index)=>{const disabled=index===kinds.length;return <section key={index} style={{position:'absolute',left:16,top:72+index*86}}>${subject}</section>;})}</>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "strip-fixture",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? code : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const width of [1200, 390])
        for (const theme of ["light", "dark"]) {
          const page = await browser.newPage({
            viewport: { width, height: width === 390 ? 844 : 800 },
            deviceScaleFactor: 1,
            colorScheme: theme,
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
                body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "" : "canvas-workspace"}" style="position:fixed;inset:0;display:block;background:${theme === "light" ? "#fafafa" : "#171717"}"></main><script type="module" src="${entry}"></script></html>`,
              }),
            );
            await page.goto(`${origin}audit`);
            const bars = page.getByRole("toolbar");
            await expect(bars).toHaveCount(6);
            await page.evaluate(() => document.fonts.ready);
            await expect(bars.last().getByRole("button", { name: "音频修剪" })).toBeDisabled();
            await expect(bars.last().getByRole("button", { name: "下载" })).toBeDisabled();
            await expect(bars.last().getByRole("button", { name: "加入资产库" })).toHaveCount(0);
            geometry[`${side}-${width}-${theme}`] = await bars.evaluateAll((elements) =>
              elements.map((el) => ({
                width: el.getBoundingClientRect().width,
                buttons: [...el.querySelectorAll("button")].map((button) => ({
                  label: button.ariaLabel,
                  width: button.getBoundingClientRect().width,
                  font: getComputedStyle(button).font,
                  disabled: button.disabled,
                  opacity: getComputedStyle(button).opacity,
                })),
              })),
            );
            await bars.first().getByRole("button", { name: "复制文本" }).hover();
            await expect(page.getByText("复制文本", { exact: true })).toBeVisible();
            await page.waitForTimeout(350);
            for (const [index, kind] of [...kinds, "disabled-audio"].entries()) {
              const key = `${width}-${theme}-${kind}`,
                path = join(output, `${side}-${key}.png`);
              await page.screenshot({
                path,
                clip: {
                  x: 0,
                  y: index * 86 + (index ? 52 : 8),
                  width: Math.min(520, width),
                  height: index ? 80 : 124,
                },
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
              let different = 0;
              for (let pos = 0; pos < before.length; pos += 3)
                if (before.readUIntBE(pos, 3) !== after.readUIntBE(pos, 3)) different++;
              diffs[key] = different;
            }
          } finally {
            await page.close();
          }
        }
    } finally {
      await server.close();
    }
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ geometry, diffs }, null, 2));
  for (const width of [1200, 390])
    for (const theme of ["light", "dark"]) {
      assert.deepEqual(
        geometry[`desktop-${width}-${theme}`],
        geometry[`upstream-${width}-${theme}`],
      );
    }
  console.table(diffs);
  if (process.argv.includes("--strict"))
    assert(
      Object.values(diffs).every((count) => count === 0),
      "工具栏仍有非零 RGB 差",
    );
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
