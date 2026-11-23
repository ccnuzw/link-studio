import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned web checkout");
const dark = process.argv.includes("--dark"),
  narrow = process.argv.includes("--narrow"),
  retina = process.argv.includes("--retina");
const software = process.argv.includes("--software");
const output = resolve(
  `test-results/shot-select-parity${dark ? "-dark" : ""}${narrow ? "-narrow" : ""}${retina ? "-retina" : ""}${software ? "-software" : ""}`,
);
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "shot-select-parity-"));
const browser = await chromium.launch({
  channel: "chrome",
  args: software ? ["--disable-gpu"] : [],
});
const records = {};
const frames = new Set();
try {
  for (const upstream of [true, false]) {
    const name = upstream ? "upstream" : "desktop";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const fixture = "/src/__shot_select_audit.jsx";
    const components = upstream
      ? `import {ShotSizeSelect,CameraMoveSelect} from '/src/components/storyboard/shot-select';`
      : `import {ShotSelect} from '/src/renderer/workspace/shot-select';`;
    const controls = upstream
      ? `<ShotSizeSelect value={shot} onChange={setShot}/><CameraMoveSelect value={camera} onChange={setCamera}/>`
      : `<ShotSelect label="景别" value={shot} change={setShot} container={container}/><ShotSelect label="运镜" value={camera} change={setCamera} container={container}/>`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "shot-select-fixture",
          resolveId(id) {
            if (id === fixture) return join(root, fixture);
          },
          load(id) {
            if (id === join(root, fixture))
              return `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';${components}function Fixture(){const container=useRef(document.body);const [shot,setShot]=useState('中景'),[camera,setCamera]=useState('固定');return <>${controls}</>}createRoot(document.querySelector('main')).render(<Fixture/>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: narrow ? { width: 420, height: 320 } : { width: 1280, height: 800 },
      deviceScaleFactor: retina ? 2 : 1,
      colorScheme: dark ? "dark" : "light",
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}assets/**`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.route(`${origin}audit`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${dark ? "dark" : "light"}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><style>html:root,body{margin:0;width:100%;height:100%;background:${dark ? "#171717" : "white"};color-scheme:${dark ? "dark" : "light"}}main{position:fixed;${narrow ? "right:4px" : "left:300px"};top:100px;display:grid;grid-template-columns:104px 104px;gap:4px}</style><main></main><script type="module" src="${fixture}"></script></html>`,
        }),
      );
      await page.goto(`${origin}audit`);
      records[name] = {};
      for (const [label, key, target] of [
        ["景别", "framing", "特写 BCU"],
        ["运镜", "camera", "航拍"],
      ]) {
        const control = page.getByRole("combobox", { name: label });
        const capture = async (suffix, clip) => {
          const frame = key + suffix;
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            await Promise.all(
              document.getAnimations().map((animation) => animation.finished.catch(() => {})),
            );
          });
          const photo = await page.screenshot({ clip, path: join(output, `${name}-${frame}.png`) });
          assert(photo.equals(await page.screenshot({ clip })), `Unstable ${name} ${frame}`);
          frames.add(frame);
        };
        const trigger = await control.boundingBox();
        const triggerClip = {
          x: trigger.x - 2,
          y: trigger.y - 2,
          width: trigger.width + 4,
          height: trigger.height + 4,
        };
        const settle = () =>
          control.evaluate((el) =>
            Promise.all(el.getAnimations().map((animation) => animation.finished)),
          );
        await page.mouse.move(1, 1);
        await settle();
        await capture("-idle", triggerClip);
        await control.hover();
        await settle();
        await capture("-hover", triggerClip);
        await control.click();
        const list = page.getByRole("listbox");
        const popup = page.locator(
          upstream ? "[data-slot=select-content][data-open]" : ".shot-select-popup[data-open]",
        );
        await list.waitFor();
        await page.mouse.move(1, 1);
        await page.evaluate(() => document.fonts.ready);
        await popup.evaluate((element) =>
          Promise.all(element.getAnimations().map((animation) => animation.finished)),
        );
        const bounds = await popup.boundingBox();
        if (process.env.SHOT_SELECT_GEOMETRY && key === "framing")
          console.log(
            name,
            await popup.evaluate((element) =>
              [
                element,
                element.querySelector("[aria-selected=true]"),
                element.querySelector(":focus"),
              ]
                .filter(Boolean)
                .map((item) => {
                  const style = getComputedStyle(item);
                  return [
                    style.borderRadius,
                    style.boxShadow,
                    style.color,
                    style.backgroundColor,
                    style.backdropFilter,
                    style.animation,
                    style.transform,
                    style.scale,
                    element.scrollTop,
                  ];
                }),
            ),
          );
        if (process.env.SHOT_SELECT_GEOMETRY && key === "framing")
          console.log(
            name,
            await list
              .getByRole("option")
              .first()
              .evaluate((option) =>
                [option, ...option.querySelectorAll("span,svg,small")].map((node) => {
                  const { x, y, width, height } = node.getBoundingClientRect(),
                    style = getComputedStyle(node);
                  return {
                    tag: node.tagName,
                    x,
                    y,
                    width,
                    height,
                    font: style.font,
                    color: style.color,
                    spacing: style.letterSpacing,
                    align: style.alignItems,
                  };
                }),
              ),
          );
        await capture("", bounds);
        const options = await list.getByRole("option").allTextContents();
        if (narrow) {
          const last = list.getByRole("option").last();
          await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + bounds.height / 2);
          await page.mouse.wheel(0, 600);
          await expect
            .poll(() =>
              popup.evaluate(
                (element) => element.scrollTop + element.clientHeight - element.scrollHeight,
              ),
            )
            .toBeGreaterThanOrEqual(-1);
          await page.mouse.move(1, 1);
          await capture("-scrolled", bounds);
          await page.keyboard.press("Home");
          await expect(list.getByRole("option").first()).toBeFocused();
          await page.keyboard.press("End");
          await expect(last).toBeFocused();
          await expect
            .poll(() => popup.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0);
          await capture("-end", bounds);
          await page.keyboard.press("Enter");
          await expect(control).toContainText(key === "camera" ? "航拍" : "大特写");
          await expect(control).toBeFocused();
          await settle();
          if (process.env.SHOT_SELECT_GEOMETRY)
            console.log(
              name,
              "trigger focus",
              await control.evaluate((el) => {
                const style = getComputedStyle(el);
                return [
                  style.color,
                  style.backgroundColor,
                  style.boxShadow,
                  style.outline,
                  style.borderRadius,
                  style.transition,
                ];
              }),
            );
          await capture("-focus", triggerClip);
        } else {
          await list.getByRole("option", { name: target, exact: true }).click();
          await expect(control).toContainText(target.split(" ")[0]);
        }
        records[name][key] = { bounds, options };
      }
    } finally {
      await page.close();
      await server.close();
    }
  }
  const compare = await browser.newPage();
  records.differentPixels = {};
  assert.deepEqual(records.desktop, records.upstream);
  for (const key of frames) {
    const images = await Promise.all(
      ["upstream", "desktop"].map((name) => readFile(join(output, `${name}-${key}.png`), "base64")),
    );
    records.differentPixels[key] = await compare.evaluate(async (images) => {
      const pixels = await Promise.all(
        images.map(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return new Uint32Array(context.getImageData(0, 0, image.width, image.height).data.buffer);
        }),
      );
      return pixels[0].reduce(
        (count, value, index) => count + Number(value !== pixels[1][index]),
        0,
      );
    }, images);
  }
  await compare.close();
  await writeFile(join(output, "results.json"), JSON.stringify(records, null, 2));
  console.log(records.differentPixels);
  if (process.argv.includes("--strict"))
    assert(Object.values(records.differentPixels).every((count) => count === 0));
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
