import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const desktop = process.cwd();
const baseline = resolve(process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web");
const output = join(desktop, "test-results/text-editor-parity");
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "text-editor-parity-"));
const browser = await chromium.launch({ channel: "chrome" });
const states = {};
try {
  for (const [name, root] of [
    ["upstream", baseline],
    ["desktop", desktop],
  ]) {
    const reference = name === "upstream";
    const assets = join(root, reference ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const module = reference
      ? 'import {TextEditorDialog as Subject} from "/src/components/canvas/text-editor-dialog";'
      : 'import Subject from "/src/renderer/workspace/text-editor-dialog";';
    const fixture = join(root, "src/__text_editor_audit.jsx");
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "text-editor-fixture",
          resolveId(id) {
            if (id === "/src/__text_editor_audit.jsx") return fixture;
          },
          load(id) {
            if (id === fixture)
              return `${module}import React from 'react';import {createRoot} from 'react-dom/client';const save=(text)=>document.body.dataset.saved=text;const root=createRoot(document.getElementById('root'));const close=()=>root.unmount();root.render(<Subject open title="文本" text="镜头" editable onSave={save} save={save} close={close} onOpenChange={close}/>);`;
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
          body: `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="/built/${css}"><main style="position:fixed;inset:0;background:oklch(.975 0 0)"><div id="root"></div></main><script type="module" src="/src/__text_editor_audit.jsx"></script>`,
        }),
      );
      await page.route(`${origin}built/**`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.route(`${origin}assets/*.woff2`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.goto(`${origin}audit`);
      const editor = page.getByRole("textbox", { name: "文本内容" });
      await editor.fill("镜头记录");
      await editor.press("ControlOrMeta+a");
      const dialog = page.getByRole("dialog");
      const selection = () => editor.evaluate(() => window.getSelection()?.toString());
      const selectionSteps = { initial: await selection() };
      for (const action of ["加粗", "二级标题", "斜体", "撤销", "重做"]) {
        await dialog.getByRole("button", { name: action, exact: true }).click();
        selectionSteps[action] = await selection();
      }
      await page.mouse.move(1, 1);
      await page.evaluate(() => document.fonts.ready);
      const html = await editor.innerHTML();
      const geometry = await dialog.evaluate((element) =>
        [element, ...element.querySelectorAll("h2,button,[role=textbox]")].map((item) => ({
          label: item.getAttribute("aria-label") ?? item.tagName,
          rect: item.getBoundingClientRect().toJSON(),
          font: getComputedStyle(item).font,
        })),
      );
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().map((animation) => animation.finished));
      });
      const capture = await page.screenshot({ path: join(output, `${name}.png`), caret: "hide" });
      const editorState = await editor.evaluate((element) => ({
        focused: document.activeElement === element,
        selection: window.getSelection()?.toString(),
        styles: [...element.closest('[role="dialog"]').querySelectorAll("button")].map(
          (button) => ({
            label: button.getAttribute("aria-label"),
            pressed: button.getAttribute("aria-pressed"),
            background: getComputedStyle(button).backgroundColor,
          }),
        ),
      }));
      for (let sample = 0; sample < 2; sample++)
        assert(
          (await page.screenshot({ caret: "hide" })).equals(capture),
          `Unstable ${name} frame`,
        );
      await editor.press("Escape");
      const saved = await page.locator("body").getAttribute("data-saved");
      assert(saved?.includes("镜头记录"));
      states[name] = { saved, html, geometry, editorState, selectionSteps };
    } finally {
      await page.close();
      await server.close();
    }
  }
  await writeFile(join(output, "results.json"), JSON.stringify(states, null, 2));
  assert.equal(states.desktop.saved, states.upstream.saved);
  assert.equal(states.desktop.html, states.upstream.html);
  assert.deepEqual(states.desktop.selectionSteps, states.upstream.selectionSteps);
  assert.equal(states.desktop.editorState.focused, states.upstream.editorState.focused);
  console.log(states.desktop.saved);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
