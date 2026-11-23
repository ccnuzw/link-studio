import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const desktop = process.cwd();
const upstream = resolve(process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web");
const state = process.argv[2] ?? "default";
if (!["default", "hover", "keyboard"].includes(state)) throw Error("Unknown menu state");
const output = join(desktop, "test-results/frame-menu-parity", state === "default" ? "" : state);
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "frame-menu-parity-"));
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const images = [];
  const geometry = [];
  for (const reference of [true, false]) {
    const name = reference ? "upstream" : "desktop";
    const root = reference ? upstream : desktop;
    const assetDir = join(root, reference ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assetDir)).filter((file) => /^index-.*\.css$/.test(file));
    if (css.length !== 1) throw Error(`Build ${name} before comparing`);
    const fixture = join(root, "src/__frame_menu_audit.jsx");
    const component = reference
      ? `import {NodeActionBar} from '/src/components/canvas/node-action-bar';import {NODE_TOOLBAR} from '/src/constants/node-toolbar';const subject=<NodeActionBar label="视频" config={{actions:[NODE_TOOLBAR.video.actions[0]],tail:[]}} gate={{actionsDisabled:false}}/>;`
      : `import {FrameMenu} from '/src/renderer/workspace/frame-menu';const subject=<FrameMenu disabled={false} choose={()=>{}}/>;`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "frame-menu-fixture",
          resolveId(id) {
            if (id === "/src/__frame_menu_audit.jsx") return fixture;
          },
          load(id) {
            if (id === fixture)
              return `import React from 'react';import {createRoot} from 'react-dom/client';${component}createRoot(document.getElementById('root')).render(subject);`;
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}parity`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="/built/${css[0]}"><style>#stage{position:fixed;inset:0;background:oklch(.975 0 0)}#root{position:absolute;left:200px;top:120px;display:inline-flex;width:auto;height:auto}</style><main id="stage"><div id="root" class="${reference ? "" : "canvas-workspace node-tools"}"></div></main><script type="module" src="/src/__frame_menu_audit.jsx"></script>`,
        }),
      );
      await page.route(`${origin}built/**`, (route) =>
        route.fulfill({ path: join(assetDir, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.goto(`${origin}parity`);
      await page.getByRole("button", { name: "截取帧" }).click();
      await page.mouse.move(1, 1);
      const menu = page.getByRole("menu");
      await menu.waitFor();
      if (state === "hover") await menu.getByRole("menuitem", { name: "尾帧" }).hover();
      if (state === "keyboard") {
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowDown");
      }
      if (
        state !== "default" &&
        !(await menu
          .getByRole("menuitem", { name: "尾帧" })
          .evaluate((item) => item === document.activeElement))
      )
        throw Error(`Missing ${state} focus: ${name}`);
      await page.waitForTimeout(400);
      await page.evaluate(() => document.fonts.ready);
      await menu.evaluate(async (element) => {
        await new Promise((done) => requestAnimationFrame(done));
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      geometry.push(
        await menu.evaluate((element) =>
          [element, ...element.querySelectorAll("[role=menuitem],svg")].map((item) => {
            const rect = item.getBoundingClientRect(),
              bounds = element.getBoundingClientRect(),
              style = getComputedStyle(item);
            return {
              x: rect.x - bounds.x,
              y: rect.y - bounds.y,
              w: rect.width,
              h: rect.height,
              font: style.font,
              color: style.color,
              stroke: style.stroke,
              strokeWidth: style.strokeWidth,
              svg: item instanceof SVGElement ? item.outerHTML : undefined,
              radius: style.borderRadius,
              shadow: style.boxShadow,
              spacing: style.letterSpacing,
              background: style.backgroundColor,
            };
          }),
        ),
      );
      const clip = await menu.boundingBox();
      if (
        !clip ||
        clip.x < 0 ||
        clip.y < 0 ||
        clip.x + clip.width > 1280 ||
        clip.y + clip.height > 800
      )
        throw Error(`Menu outside viewport: ${JSON.stringify(clip)}`);
      const capture = await page.screenshot({ clip, path: join(output, `${name}.png`) });
      for (let sample = 0; sample < 2; sample++)
        if (
          !(await page.screenshot({ clip, path: join(output, `${name}-repeat.png`) })).equals(
            capture,
          )
        )
          throw Error(`Unstable capture: ${name}`);
      images.push(capture.toString("base64"));
      await page.goto("about:blank");
    } finally {
      await server.close();
    }
  }
  const result = await page.evaluate(async (sources) => {
    const plots = await Promise.all(
      sources.map(async (source) => {
        const image = new Image();
        image.src = `data:image/png;base64,${source}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return {
          width: image.width,
          height: image.height,
          pixels: context.getImageData(0, 0, image.width, image.height),
        };
      }),
    );
    const [first, second] = plots;
    if (first.width !== second.width || first.height !== second.height)
      throw Error("Menu dimensions differ");
    const canvas = document.createElement("canvas");
    canvas.width = first.width;
    canvas.height = first.height;
    const context = canvas.getContext("2d");
    const diff = context.createImageData(first.width, first.height);
    let changed = 0;
    for (let offset = 0; offset < diff.data.length; offset += 4) {
      const different = [0, 1, 2, 3].some(
        (channel) => first.pixels.data[offset + channel] !== second.pixels.data[offset + channel],
      );
      if (different) changed++;
      diff.data.set(different ? [225, 25, 65, 255] : [245, 245, 245, 255], offset);
    }
    context.putImageData(diff, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      changed,
      diff: canvas.toDataURL().split(",")[1],
    };
  }, images);
  const { diff, ...metrics } = result;
  await writeFile(join(output, "diff.png"), Buffer.from(diff, "base64"));
  await writeFile(join(output, "metrics.json"), JSON.stringify({ metrics, geometry }, null, 2));
  console.log(metrics);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
