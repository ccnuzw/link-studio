import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned checkout");
const output = resolve("test-results/asset-upload-parity");
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "asset-upload-parity-"));
const browser = await chromium.launch({ channel: "chrome" });
const results = {};
try {
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const entry = "/src/__asset_upload_audit.tsx";
    const component = upstream
      ? `import {UploadCard as Card} from '@/components/assets/upload-card';import {TooltipProvider as Provider} from '@/components/ui/tooltip';`
      : `import {AssetUploadCard as Card} from '/src/renderer/workspace/asset-upload-card';import {Fragment as Provider} from 'react';`;
    const props = upstream
      ? "onRetry={retry} onCancel={cancel}"
      : "container={container} retry={retry} cancel={cancel}";
    const source = `import {createRoot} from 'react-dom/client';${component}const container={current:document.querySelector('dialog')};window.events=[];createRoot(document.querySelector('section')).render(<Provider>{['queued','uploading','registering','failed'].map((status,index)=>{const task={file:new File([],['排队图像.png','镜头 02.png','配乐.wav','坏文件.mov'][index]),status,percent:[0,42,100,0][index],error:'文件无法读取或媒体内容无效'};const cancel=()=>window.events.push('cancel:'+status),retry=()=>window.events.push('retry:'+status);return <Card key={status} task={task} ${props}/>;})}</Provider>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "upload-card-fixture",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? source : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport: { width: 1200, height: 800 },
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
          const base = theme === "light" ? "#fff" : "#171717";
          const grid = `<section style="position:absolute;top:120px;left:80px;display:grid;grid-template-columns:repeat(4,200px);gap:12px"></section>`;
          await page.route(`${origin}audit`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><body style="background:${base}">${upstream ? grid : `<dialog class="asset-pick" style="margin:0;width:100vw;height:100vh;background:${base}">${grid}</dialog><script>document.querySelector('dialog').showModal()</script>`}<script type="module" src="${entry}"></script></body></html>`,
            }),
          );
          await page.goto(`${origin}audit`);
          const remove = page.getByRole("button", { name: "移除" });
          await remove.waitFor();
          await page.evaluate(() => document.fonts.ready);
          const cards = page.locator("section>[data-status]");
          assert.deepEqual(
            await page
              .getByRole("progressbar")
              .evaluateAll((elements) =>
                elements.map((item) => item.getAttribute("aria-valuenow")),
              ),
            ["0", "42", "100"],
          );
          const geometry = await cards.evaluateAll((elements) =>
            elements.map((card) =>
              [
                card,
                ...card.querySelectorAll('button,[role="progressbar"],svg,span:not(:empty)'),
              ].map((element) => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { tag: element.tagName, x, y, width, height };
              }),
            ),
          );
          const clip = { x: 70, y: 65, width: 856, height: 265 };
          const capture = async (state) => {
            await page.evaluate(() =>
              Promise.all(
                document
                  .getAnimations()
                  .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                  .map((a) => a.finished.catch(() => {})),
              ),
            );
            await expect
              .poll(
                async () => {
                  const shot = await page.screenshot({
                    clip,
                    path: join(output, `${side}-${theme}-${state}.png`),
                  });
                  return shot.equals(await page.screenshot({ clip }));
                },
                { message: `unstable ${side}/${theme}/${state}` },
              )
              .toBe(true);
          };
          await capture("idle");
          await remove.hover();
          const tooltip = page.locator(
            upstream ? '[data-slot="tooltip-content"]' : ".asset-upload-tip",
          );
          await expect(tooltip).toHaveText("移除");
          await capture("hover");
          const tip = await tooltip.boundingBox();
          await remove.click();
          await page.getByRole("button", { name: "重试" }).click();
          await page.mouse.move(1, 1);
          await page.keyboard.press("Shift+Tab");
          await expect(remove).toBeFocused();
          await expect(tooltip).toHaveText("移除");
          await capture("focus");
          await page.keyboard.press("Escape");
          await expect(tooltip).toBeHidden();
          assert.deepEqual(await page.evaluate(() => window.events), [
            "cancel:failed",
            "retry:failed",
          ]);
          results[`${side}-${theme}`] = { geometry, tip };
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  const ffmpeg =
    process.env.FFMPEG_PATH ?? resolve(`out/media/${process.platform}-${process.arch}/ffmpeg`);
  results.differentPixels = {};
  for (const theme of ["light", "dark"])
    for (const state of ["idle", "hover", "focus"]) {
      const buffers = ["upstream", "desktop"].map((side) =>
        execFileSync(ffmpeg, [
          "-loglevel",
          "error",
          "-i",
          join(output, `${side}-${theme}-${state}.png`),
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]),
      );
      const [original, current] = buffers;
      assert.equal(original.length, current.length);
      let count = 0;
      for (let offset = 0; offset < original.length; offset += 3)
        if (
          original[offset] !== current[offset] ||
          original[offset + 1] !== current[offset + 1] ||
          original[offset + 2] !== current[offset + 2]
        )
          count++;
      results.differentPixels[`${theme}-${state}`] = count;
    }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(results.differentPixels);
  for (const theme of ["light", "dark"])
    assert.deepEqual(results[`desktop-${theme}`], results[`upstream-${theme}`]);
  if (process.env.PARITY_EXACT === "1")
    for (const [state, count] of Object.entries(results.differentPixels))
      assert.equal(count, 0, state);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
