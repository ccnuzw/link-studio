import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = path.resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const output = path.resolve("test-results/canvas-text-body-parity");
const viewport = { width: 768, height: 480 };
const clip = { x: 96, y: 78, width: 576, height: 324 };
const states = [
  { textStatus: "error", text: "旧稿", textError: "生成失败，请重试" },
  ...["task", "copied"].map((view) => ({
    view,
    textStatus: "error",
    text: "旧稿",
    textError: "生成失败，请重试",
    textFailureTask: { id: "job-1", reference: "task-4277" },
  })),
  { textStatus: "done", text: "## 第一集\n\n林夏读完 **来信**。" },
  { textStatus: "idle", text: "" },
];
const report = { revision, viewport, clip, deviceScaleFactor: 1, states, comparisons: [] };
const temp = await mkdtemp(path.join(tmpdir(), "text-body-parity-"));
const pinned = path.join(temp, "web");
let browser;
try {
  await mkdir(output, { recursive: true });
  const archive = path.join(temp, "web.tar");
  execFileSync("git", ["-C", reference, "archive", "-o", archive, revision, "web"]);
  execFileSync("tar", ["-xf", archive, "-C", temp]);
  await symlink(path.join(reference, "web/node_modules"), path.join(pinned, "node_modules"), "dir");
  execFileSync(path.join(pinned, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: pinned,
  });
  const index = await readFile(path.join(pinned, "dist/index.html"), "utf8");
  const css = index.match(/href="[^"]*\/assets\/(index-[^"/]+\.css)"/)[1];
  const app = await readFile("src/renderer/workspace/app.tsx", "utf8");
  const body = app.match(/<div className="canvas-text-frame">[\s\S]+?<\/section>\s*<\/div>/g);
  assert.equal(body?.length, 1);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const side of ["reference", "desktop"]) {
    const upstream = side === "reference";
    const root = upstream ? pinned : process.cwd();
    const entry = path.join(root, "audit-text-body.jsx");
    const outDir = path.join(temp, side);
    const imports = upstream
      ? `
      import { BaseNode } from '@/components/canvas/base-node';
      import { NodeTextBody } from '@/components/canvas/node-body';
      import { TextPlaceholderIcon } from '@/components/canvas/placeholder-icons';`
      : `
      import './src/renderer/styles.css';
      import './src/renderer/workspace/canvas-workspace.css';
      import './src/renderer/workspace/node-port.css';
      import './src/renderer/workspace/text-editor.css';
      import { CanvasTextMarkdown } from './src/renderer/workspace/canvas-text-markdown';
      import { TextFailureTask } from './src/renderer/workspace/text-failure-task';
      import { Loader2, TriangleAlert } from 'lucide-react';`;
    const markup = upstream
      ? `<BaseNode><NodeTextBody status={data.textStatus} text={data.text}
      error={data.textError} taskRef={data.textFailureTask?.reference} icon={<TextPlaceholderIcon className="size-10"/>}
      placeholder="双击输入文字" onEdit={openText}/></BaseNode>`
      : `<article className="creative-card" data-card-kind="script">${body[0]}</article>`;
    const fixture = `${imports}
      import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
      const root = createRoot(document.querySelector('#card'));
      const openText = () => {}, textRunning = false, id = 'text';
      window.show = state => { const data = {...state, label:'文本'}; flushSync(()=>root.render(${markup})); };`;
    await build({
      root,
      configFile: false,
      publicDir: false,
      logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"' },
      resolve: { alias: { "@": path.join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "text-body-fixture",
          resolveId: (id) => (id === entry ? entry : null),
          load: (id) => (id === entry ? fixture : null),
        },
      ],
      build: {
        outDir,
        lib: { entry, formats: ["es"], fileName: () => "fixture.js", cssFileName: "fixture" },
      },
    });
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport, colorScheme: theme, deviceScaleFactor: 1 });
      page.on("pageerror", (error) => console.error(side, error));
      try {
        await page.route("http://localhost/**", (route) => {
          const name = path.basename(new URL(route.request().url()).pathname);
          if (name === "fixture.js")
            return route.fulfill({ path: path.join(outDir, name), contentType: "text/javascript" });
          if (name === "fixture.css" && !upstream)
            return route.fulfill({ path: path.join(outDir, name), contentType: "text/css" });
          if (upstream && (name === css || name.endsWith(".woff2")))
            return route.fulfill({ path: path.join(pinned, "dist/assets", name) });
          if (name) return route.abort();
          return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html lang="zh-CN" class="${theme}"><meta charset=utf-8><link rel="stylesheet" href="/${upstream ? css : "fixture.css"}"><body><main class="${upstream ? "bg-canvas" : "canvas-workspace"}" style="position:fixed;inset:0"><div class="react-flow__node" id="card" style="position:absolute;left:${clip.x}px;top:${clip.y}px;width:${clip.width}px"></div></main><script type="module" src="/fixture.js"></script></body></html>`,
          });
        });
        await page.goto("http://localhost/");
        await page.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            value: {
              writeText: async (value) => {
                window.copiedTask = value;
              },
            },
          }),
        );
        for (const state of states) {
          await page.evaluate((state) => window.show(state), state);
          const content = page.locator(
            upstream ? '[data-slot="base-node-content"]' : ".canvas-text-frame",
          );
          assert.deepEqual(await content.boundingBox(), clip);
          const expected = state.textError ?? (state.text ? "来信" : "双击输入文字");
          assert.ok((await content.innerText()).includes(expected));
          if (state.view === "copied") {
            await page
              .getByRole("button", { name: `任务 ID ${state.textFailureTask.reference}，点击复制` })
              .click();
            await page.mouse.move(0, 0);
            await page.getByText("已复制任务 ID", { exact: true }).waitFor();
            assert.equal(
              await page.evaluate(() => window.copiedTask),
              state.textFailureTask.reference,
            );
          }
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(async () => {
            await Promise.all(document.getAnimations().map((animation) => animation.finished));
          });
          const key = `${theme}-${state.view ?? state.textStatus}`;
          const capture = await page.screenshot({
            clip,
            path: path.join(output, `${key}-${side}.png`),
          });
          assert.ok((await page.screenshot({ clip })).equals(capture), `Unstable ${side} ${key}`);
          if (!upstream) {
            const baseline = await readFile(path.join(output, `${key}-reference.png`));
            const pair = await page.evaluate(
              async (images) => {
                const canvas = document.createElement("canvas");
                const bitmaps = await Promise.all(
                  images.map(async (image) =>
                    createImageBitmap(await (await fetch(`data:image/png;base64,${image}`)).blob()),
                  ),
                );
                const { width, height } = bitmaps[0];
                canvas.width = width * 2;
                canvas.height = height;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                const pixels = bitmaps.map((bitmap, index) => {
                  context.drawImage(bitmap, index * width, 0);
                  return new Uint32Array(
                    context.getImageData(index * width, 0, width, height).data.buffer,
                  );
                });
                let difference = 0;
                for (let index = 0; index < pixels[0].length; index++)
                  if (pixels[0][index] !== pixels[1][index]) difference++;
                return { difference, image: canvas.toDataURL().split(",")[1] };
              },
              [baseline, capture].map((buffer) => buffer.toString("base64")),
            );
            await writeFile(
              path.join(output, `${key}-pair.png`),
              Buffer.from(pair.image, "base64"),
            );
            report.comparisons.push({ key, differentPixels: pair.difference });
            console.log(key, pair.difference);
          }
        }
      } finally {
        await page.close();
      }
    }
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  assert.ok(
    report.comparisons.every((result) => result.differentPixels === 0),
    "Text body pixels differ",
  );
} finally {
  await browser?.close();
  await rm(temp, { recursive: true, force: true });
}
