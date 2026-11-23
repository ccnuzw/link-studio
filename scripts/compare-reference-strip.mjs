import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { auditVideoReference, videoFixture } from "./audit-video-reference.mjs";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned checkout");
const software = process.argv.includes("--software");
const video = process.argv.includes("--video");
const warnings = process.argv.includes("--warnings");
const reduce = !process.argv.includes("--motion");
const output = resolve(
  `test-results/reference-strip-parity${warnings ? "-warnings" : ""}${video ? "-video" : ""}${!reduce ? "-motion" : ""}${software ? "-software" : ""}`,
);
const cache = await mkdtemp(join(tmpdir(), "reference-strip-"));
const browser = await chromium.launch({
  channel: "chrome",
  args: software ? ["--disable-gpu"] : [],
});
const entry = "/src/__reference_strip_audit.tsx";
const seed = video
  ? ["镜头", "缺封面"].map((label, index) => {
      const id = index ? "bad" : "good";
      return { id, label, kind: "video", assetId: id, src: `/files/${id}.mp4`, used: true };
    })
  : [
      { id: "text", label: "对白", kind: "script", text: "台词", used: true },
      { id: "pic", label: "空图", kind: "image", used: true },
      {
        id: "audio",
        label: "环境音",
        kind: "audio",
        assetId: "clip",
        src: "/clip.ogg",
        used: false,
      },
    ];
const records = {};
const upstreamBody = `<RefStrip items={items} manual={manual?[{key:'audio',assetId:'manual',asset:{fileName:'手动音轨',mediaType:'audio',url:'/clip.ogg'}}]:[]} onRemoveManual={()=>setManual(false)} candidates={()=>choices} onLink={add} onUnlink={remove} uploadKinds={upload?[{key:'images',kind:'image',label:'参考图片',maxMb:1}]:[]} errors={[]} />`;
const desktopBody = `<ReferenceStrip error={error} tiles={[...items.map(source=><ReferenceTile key={source.id} projectHandle={${video ? "'fixture'" : "undefined"}} source={source} used={source.used} disabled={false} locate={()=>{}} remove={()=>remove(source.id)}/>),...(manual?[<ReferenceTile key="manual" source={{id:'manual',assetId:'manual',kind:'audio',label:'手动音轨'}} used disabled={false} remove={()=>setManual(false)}/>]:[])]} menu={<ReferenceMenu candidates={choices} disabled={false} link={id=>add(choices.find(item=>item.id===id))} kinds={upload?[{kind:'image',label:'图片',maxBytes:1048576}]:[]} setError={setError}/>}/>`;
try {
  await mkdir(output, { recursive: true });
  const media = video && (await videoFixture(cache));
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    const stylesheet = await readFile(join(assets, css));
    const source = `import React from 'react';import {createRoot} from 'react-dom/client';${upstream ? `import {ReactFlowProvider as Provider} from '@xyflow/react';import {RefStrip} from '/src/components/canvas/ref-strip';` : `import {RefHighlightProvider as Provider} from '/src/renderer/workspace/ref-highlight';import {ReferenceStrip} from '/src/renderer/workspace/reference-strip';import {ReferenceTile} from '/src/renderer/workspace/reference-tile';import {ReferenceMenu} from '/src/renderer/workspace/reference-menu';`}
    function Fixture(){const [items,setItems]=React.useState(${JSON.stringify(seed)});const [manual,setManual]=React.useState(location.hash==='#manual');const upload=location.hash==='#upload';const [error,setError]=React.useState('');const choices=(upload?[]:[1,2,3,4]).map(num=>({id:'actor'+num,kind:'character',label:'角色 '+num,used:true})).filter(item=>!items.some(existing=>existing.id===item.id));const add=source=>setItems(current=>[...current,source]);const remove=id=>setItems(current=>current.filter(source=>source.id!==id));return <Provider>${upstream ? upstreamBody : desktopBody}</Provider>};createRoot(document.getElementById('strip')).render(<Fixture/>);`;
    const warningProps =
      `notices={['参考图最多 2 张，多余补充图未带入','当前模型不支持参考音频，角色卡声音未生效']} ` +
      (upstream
        ? `errors={['参考图片最多 2 个，请移除多余的','次要错误']}`
        : `error="参考图片最多 2 个，请移除多余的"`);
    const fixture = warnings
      ? source.replace(upstream ? "errors={[]}" : "error={error}", warningProps)
      : source;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(cache, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "strip-fixture",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return join(root, entry);
            if (id.endsWith(".css")) return "\0build-css";
          },
          load(id) {
            if (id === join(root, entry)) return fixture;
            if (id === "\0build-css") return "export {};";
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"])
        for (const dpr of video ? [1, 2] : [1])
          for (const zoom of video ? [0.75, 1, 1.5] : [1]) {
            const label = video ? `${theme}-dpr${dpr}-z${zoom}` : theme;
            const page = await browser.newPage({
              viewport: { width: 560, height: 440 },
              deviceScaleFactor: dpr,
              colorScheme: theme,
              ...(video && { reducedMotion: reduce ? "reduce" : "no-preference" }),
            });
            try {
              await page.route(`${origin}assets/*`, (route) =>
                route.fulfill({
                  path: join(assets, new URL(route.request().url()).pathname.split("/").pop()),
                }),
              );
              await page.route(`${origin}assets/${css}`, (route) =>
                route.fulfill({ contentType: "text/css", body: stylesheet }),
              );
              await page.route(`${origin}audit`, (route) =>
                route.fulfill({
                  contentType: "text/html",
                  body: `<!DOCTYPE html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><style>#strip{position:fixed;left:40px;top:40px;width:272px;margin:0;padding:0;border:0;border-radius:0;box-shadow:none;background:transparent}html,body,#stage{background:${theme === "dark" ? "#232323" : "#fff"}}</style><body><main id="stage" class="${upstream ? "" : "canvas-workspace"}"><section class="${upstream ? "" : "canvas-surface media-generation"}" id="strip"></section></main><script type="module" src="${entry}"></script>`,
                }),
              );
              if (!video) await page.goto(`${origin}audit`);
              const add = page.getByRole("button", { name: "引用画布里的素材" });
              if (!video) {
                await add.waitFor();
                await page.evaluate(() => document.fonts.ready);
              }
              const row = add.locator("..");
              const capture = async (step, clip) => {
                const name = `${side}-${label}-${step}.png`;
                await page.evaluate(async () => {
                  await new Promise((done) =>
                    requestAnimationFrame(() => requestAnimationFrame(done)),
                  );
                  await Promise.all(
                    document
                      .getAnimations()
                      .filter((animation) => animation.playState !== "paused")
                      .map((animation) => animation.finished.catch(() => {})),
                  );
                });
                if (step.endsWith("menu")) {
                  await expect.poll(() => add.evaluate((el) => el.matches(":hover"))).toBe(false);
                  await expect
                    .poll(() => add.evaluate((el) => getComputedStyle(el).color))
                    .toBe(theme === "dark" ? "oklch(0.708 0 0)" : "oklch(0.556 0 0)");
                }
                await page.screenshot({ path: join(output, name), clip });
                const key = `${label}-${step}`;
                records[key] ??= {};
                const record = records[key];
                record[side] = {
                  name,
                  layout: await row.evaluate((el) => ({
                    height: el.clientHeight,
                    width: el.clientWidth,
                    extent: el.scrollWidth,
                    left: el.scrollLeft,
                    titles: [
                      ...el.querySelectorAll(
                        'button.reference-locate,button[aria-label^="引用："]',
                      ),
                    ].map((button) => button.title),
                  })),
                };
                if (step.endsWith("menu"))
                  record[side].layout.menu = await page.getByRole("menu").evaluate((el) =>
                    [el, ...el.querySelectorAll('[role="menuitem"]')].map((item) => ({
                      label: item === el ? "" : item.textContent,
                      box: item.getBoundingClientRect().toJSON(),
                    })),
                  );
                if (!upstream) {
                  const [original, desktop] = await Promise.all(
                    [record.upstream.name, name].map(async (file) =>
                      (await readFile(join(output, file))).toString("base64"),
                    ),
                  );
                  record.different = await page.evaluate(
                    async (images) => {
                      const pixels = await Promise.all(
                        images.map(async (url) => {
                          const image = new Image();
                          image.src = "data:image/png;base64," + url;
                          await image.decode();
                          const canvas = document.createElement("canvas");
                          canvas.width = image.width;
                          canvas.height = image.height;
                          const ctx = canvas.getContext("2d");
                          ctx.drawImage(image, 0, 0);
                          return new Uint32Array(
                            ctx.getImageData(0, 0, image.width, image.height).data.buffer,
                          );
                        }),
                      );
                      return pixels[0].reduce(
                        (count, pixel, index) => count + (pixel !== pixels[1][index]),
                        0,
                      );
                    },
                    [original, desktop],
                  );
                }
              };
              if (video) {
                await page.addInitScript((scale) => {
                  document.addEventListener("DOMContentLoaded", () => {
                    const strip = document.querySelector("#strip");
                    strip.style.transformOrigin = "top left";
                    strip.style.transform = `scale(${scale})`;
                  });
                }, zoom);
                await auditVideoReference({ page, origin, media, capture, zoom, reduce });
                continue;
              }
              const stripClip = { x: 36, y: 36, width: 280, height: 56 };
              if (warnings) {
                if (!upstream)
                  await page
                    .locator("#strip")
                    .evaluate((element) => element.classList.add("media-generation-form"));
                await expect(page.locator("#strip p")).toHaveCount(3);
                for (const width of [272, 176]) {
                  await page
                    .locator("#strip")
                    .evaluate((element, width) => (element.style.width = width + "px"), width);
                  await capture(`warnings-${width}`, {
                    x: 32,
                    y: 32,
                    width: width + 16,
                    height: 186,
                  });
                }
                continue;
              }
              await capture("initial", stripClip);
              const empty = page.getByRole("button", { name: "引用：空图，点击定位到节点" });
              await empty.hover();
              await capture("hover-empty", stripClip);
              await page.mouse.move(4, 4);
              await page.keyboard.press("Tab");
              await empty.focus();
              await expect(empty).toBeFocused();
              await capture("focus-empty", stripClip);
              await empty.blur();
              for (let index = 1; index <= 4; index++) {
                if (index === 2) {
                  await add.focus();
                  await page.keyboard.press("ArrowDown");
                } else await add.click();
                const menu = page.getByRole("menu");
                await expect(menu).toBeVisible();
                if (index === 1) {
                  await page.mouse.move(4, 4);
                  await page.evaluate(async () => {
                    await Promise.all(
                      document
                        .getAnimations()
                        .map((animation) => animation.finished.catch(() => {})),
                    );
                  });
                  await capture("menu", { x: 32, y: 32, width: 500, height: 300 });
                }
                const item = menu.getByRole("menuitem", { name: `角色 ${index}` });
                if (index === 2) {
                  await expect(item).toBeFocused();
                  await page.keyboard.press("Escape");
                  await expect(menu).toHaveCount(0);
                  await expect(add).toBeFocused();
                  await page.keyboard.press("ArrowDown");
                  await expect(item).toBeFocused();
                  await page.keyboard.press("Enter");
                } else await item.click();
                await expect(
                  page.getByRole("button", { name: `断开「角色 ${index}」的引用` }),
                ).toHaveCount(1);
                await expect
                  .poll(() => row.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft))
                  .toBe(0);
              }
              await page.mouse.move(4, 4);
              await expect
                .poll(() =>
                  page
                    .getByRole("button", { name: "断开「角色 4」的引用" })
                    .evaluate((el) => getComputedStyle(el.parentElement).opacity),
                )
                .toBe("1");
              await capture("overflow", stripClip);
              await page.getByRole("button", { name: "断开「角色 4」的引用" }).click();
              await expect(page.getByRole("button", { name: "断开「角色 4」的引用" })).toHaveCount(
                0,
              );
              await page.mouse.move(4, 4);
              await capture("removed", stripClip);
              await page.goto(`${origin}audit#manual`);
              await page.reload();
              const manual = page.getByTitle("手动音轨（手动添加）");
              await expect(manual).toBeVisible();
              await capture("manual", stripClip);
              await manual.getByRole("button", { name: "移除这份素材" }).click();
              await expect(manual).toHaveCount(0);
              await expect(row.getByRole("button", { name: /^断开/ })).toHaveCount(3);
              await page.goto(`${origin}audit#upload`);
              await page.reload();
              await add.click();
              await page.getByText("画布里没有能接进来的素材").waitFor();
              await page.mouse.move(4, 4);
              await capture("upload-menu", { x: 32, y: 32, width: 500, height: 300 });
              for (const [filename, mimeType, bytes, message] of [
                ["错型.txt", "text/plain", 3, "当前生成方式用不了这种文件"],
                ["大图.png", "image/png", 1048577, "单个参考图片不能超过 1 MB"],
              ]) {
                const chooser = page.waitForEvent("filechooser");
                await page.getByRole("menuitem", { name: /上传参考素材/ }).click();
                await (await chooser).setFiles({
                  name: filename,
                  mimeType,
                  buffer: Buffer.alloc(bytes),
                });
                await page.getByText(message, { exact: true }).waitFor();
                await page.mouse.move(4, 4);
                await capture(bytes === 3 ? "wrong-type" : "oversize", {
                  x: 36,
                  y: 36,
                  width: 280,
                  height: 86,
                });
                if (bytes === 3) await add.click();
              }
            } finally {
              await page.close();
            }
          }
    } finally {
      await server.close();
    }
  }
  await writeFile(join(output, "results.json"), JSON.stringify(records, null, 2));
  for (const [key, result] of Object.entries(records)) {
    console.log(key, result.different, result.desktop.layout.left);
    assert.deepEqual(result.desktop.layout, result.upstream.layout);
  }
  if (process.argv.includes("--strict"))
    assert(Object.values(records).every((record) => record.different === 0));
} finally {
  await browser.close();
  await rm(cache, { recursive: true, force: true });
}
