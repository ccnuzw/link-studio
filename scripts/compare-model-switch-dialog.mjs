import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const temp = await mkdtemp(join(tmpdir(), "switch-dialog-"));
const output = resolve("test-results/model-switch-dialog-parity");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const results = {};
try {
  for (const name of ["upstream", "desktop"]) {
    const upstream = name === "upstream";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const fixture = "/src/__switch_dialog_parity.tsx";
    let component = `import {ModelSwitchDialog} from '/src/renderer/workspace/model-switch-dialog';`;
    if (upstream) {
      const path = join(root, "src/components/canvas-editor/video-node.tsx");
      const source = await readFile(path, "utf8");
      const dialog = source.match(/^function SwitchModelDialog\([\s\S]*?^\}/m)?.[0];
      assert(dialog);
      component = `import {Button} from '@/components/ui/button';import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from '@/components/ui/dialog';\n${dialog}`;
    }
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "switch-dialog-audit",
          resolveId: (id) => (id === fixture ? id : undefined),
          load: (id) =>
            id === fixture
              ? `import {useState} from 'react';import {createRoot} from 'react-dom/client';${component}
      function Audit(){const [state,set]=useState('open');const labels=['画质','参考图片'];const cancel=()=>set('cancel'),confirm=()=>set('confirm');return state!=='open'?<output>{state}</output>:${upstream ? "<SwitchModelDialog vm={{pendingSwitch:{droppedLabels:labels},cancelSwitch:cancel,confirmSwitch:confirm}}/>" : "<ModelSwitchDialog labels={labels} cancel={cancel} confirm={confirm}/>"};} createRoot(document.querySelector('main')).render(<Audit/>);`
              : undefined,
        },
      ],
    });
    try {
      await server.listen();
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport: { width: 1200, height: 800 },
          deviceScaleFactor: 1,
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        try {
          const origin = server.resolvedUrls.local[0];
          await page.route(`${origin}assets/**`, (route) =>
            route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
          );
          await page.route(`${origin}audit`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "" : "canvas-workspace"}" style="position:fixed;inset:0;background:${theme === "light" ? "#fafafa" : "#171717"}"></main><script type="module" src="${fixture}"></script></html>`,
            }),
          );
          await page.goto(`${origin}audit`);
          const dialog = page.getByRole("dialog", { name: "切换模型" });
          const approve = dialog.getByRole("button", { name: "继续切换" });
          await expect(approve).toBeVisible();
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(
              document.getAnimations().map((animation) => animation.finished.catch(() => {})),
            );
          });
          const rects = {};
          for (const [key, locator] of Object.entries({
            dialog,
            title: dialog.getByRole("heading"),
            description: dialog.locator("p"),
            cancel: dialog.getByRole("button", { name: "取消" }),
            approve,
          }))
            rects[key] = await locator.boundingBox();
          results[`${name}-${theme}`] = rects;
          console.log(name, theme, rects);
          if (process.env.PARITY_STYLES)
            console.log(
              name,
              theme,
              await dialog.evaluate((element) =>
                [
                  element,
                  ...element.querySelectorAll("h2,p,footer,[data-slot=dialog-footer],button"),
                ].map((node) => {
                  const css = getComputedStyle(node);
                  return [
                    node.tagName,
                    node.textContent,
                    css.color,
                    css.backgroundColor,
                    css.borderColor,
                    css.font,
                    css.boxShadow,
                    css.transform,
                    css.translate,
                    node.matches(":focus-visible"),
                  ];
                }),
              ),
            );
          const frame = { x: 400, y: 285, width: 400, height: 230 };
          const image = await page.screenshot({
            clip: frame,
            path: join(output, `${name}-${theme}.png`),
          });
          assert(image.equals(await page.screenshot({ clip: frame })), `${name} ${theme} unstable`);
          await page.keyboard.press("Escape");
          await expect(page.locator("output")).toHaveText("cancel");
          await page.reload();
          await approve.click();
          await expect(page.locator("output")).toHaveText("confirm");
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  const ffmpeg = resolve(
    "out/media",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  for (const theme of ["light", "dark"]) {
    assert.deepEqual(results[`upstream-${theme}`], results[`desktop-${theme}`]);
    const [first, second] = ["upstream", "desktop"].map((name) =>
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-i",
        join(output, `${name}-${theme}.png`),
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ]),
    );
    let count = 0;
    for (let index = 0; index < first.length; index += 3)
      if (first.readUIntBE(index, 3) !== second.readUIntBE(index, 3)) count++;
    results[`${theme}-different-pixels`] = count;
    console.log(theme, count, "of", first.length / 3);
  }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  if (process.env.PARITY_EXACT === "1")
    assert(
      ["light", "dark"].every((theme) => results[`${theme}-different-pixels`] === 0),
      "Dialog differs from reference",
    );
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
