import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const software = process.argv.includes("--software");
const dpr = process.argv.includes("--retina") ? 2 : 1;
const output = resolve(
  "test-results/add-node-menu-parity" +
    (software ? "-software" : "") +
    (dpr === 2 ? "-retina" : ""),
);
const scratch = await mkdtemp(join(tmpdir(), "canvas-add-menu-"));
const browser = await chromium.launch({
  channel: "chrome",
  args: software ? ["--disable-gpu"] : [],
});
const states = {},
  images = {};
await mkdir(output, { recursive: true });
try {
  for (const side of ["original", "desktop"]) {
    const original = side === "original";
    const root = original ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, original ? "dist/assets" : "out/renderer/assets");
    const stylesheet = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(stylesheet);
    const entry = "/src/__canvas_add_menu.tsx";
    const fixture = `import {useState} from 'react'; import {createRoot} from 'react-dom/client';
      ${
        original
          ? `import {AddNodeMenu,AddNodeMenuBody,ADD_NODE_MENU_CONTENT_CLASS} from '@/components/canvas/add-node-menu';
        import {buildAddNodeItems} from '@/pages/canvas/chrome/add-node-items';
        import {DropdownMenu,DropdownMenuContent,DropdownMenuTrigger} from '@/components/ui/dropdown-menu';`
          : `import {AddNodeMenu} from '/src/renderer/workspace/add-node-menu';`
      }
      function Canvas(){const [point,set]=useState(null);const [tool,setTool]=useState(false);
        const fan=location.search.includes('fan');const pending=fan||location.search.includes('link');const label=fan?'引用选中的 2 个节点生成':pending?'引用该节点生成':'添加节点';
        const disabled=kind=>pending&&['script','character','director'].includes(kind);const choose=kind=>{window.chosen=kind;set(null);setTool(false)};
        const button=<button style={{position:'fixed',left:25,top:260,width:38,height:38,background:'transparent',border:0}} aria-label="添加节点">+</button>;
        const props={label,disabled,choose,uploadDisabled:fan,upload:()=>choose('upload'),assets:()=>choose('assets')};
        return <><main style={{position:'fixed',inset:0}} onDoubleClick={event=>set({x:event.clientX,y:event.clientY})}/>
        ${
          original
            ? `<AddNodeMenu position={point} label={label} items={buildAddNodeItems(disabled).map(item=>fan&&item.label==='上传素材'?{...item,disabled:true}:item)} onSelect={choose} onClose={()=>set(null)} />
          <DropdownMenu modal={false} open={tool} onOpenChange={setTool}><DropdownMenuTrigger render={button}/><DropdownMenuContent side="right" align="start" sideOffset={14} className={ADD_NODE_MENU_CONTENT_CLASS}><AddNodeMenuBody items={buildAddNodeItems()} onSelect={choose}/></DropdownMenuContent></DropdownMenu>`
            : `<AddNodeMenu {...props} open={!!point} point={point} onOpenChange={open=>{if(!open)set(null)}}/>
          <AddNodeMenu {...props} trigger={button} open={tool} label="添加节点" disabled={()=>false} onOpenChange={setTool}/>`
        }</>}
      createRoot(document.querySelector('#root')).render(<Canvas/>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(scratch, side),
      assetsInclude: ["**/*.glb"],
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "add-node-menu-audit",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? fixture : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport: { width: 900, height: 650 },
          deviceScaleFactor: dpr,
          colorScheme: theme,
        });
        await page.route(origin + "assets/**", (route) =>
          route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
        );
        await page.route(origin + "fixture*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${stylesheet}"><style>main{background:${theme === "light" ? "#f7f7f7" : "#171717"}}</style><div id="root" class="${original ? "" : "canvas-workspace"}"></div><script type="module" src="${entry}"></script></html>`,
          }),
        );
        for (const scenario of ["blank", "link", "fan", "edge", "toolbar"]) {
          const key = `${theme}-${scenario}`;
          await page.goto(origin + "fixture?" + scenario);
          const trigger = page.getByRole("button", { name: "添加节点", exact: true });
          await trigger.waitFor();
          if (scenario === "toolbar") await trigger.click();
          else
            await page.mouse.dblclick(
              scenario === "edge" ? 886 : 280,
              scenario === "edge" ? 553 : 86,
            );
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(400);
          const snapshot = () =>
            menu.evaluate((el) => ({
              rect: el.getBoundingClientRect().toJSON(),
              scroll: el.scrollTop,
              focus:
                document.activeElement?.getAttribute("role") === "menuitem"
                  ? document.activeElement.textContent
                  : document.activeElement?.getAttribute("role"),
              items: Array.from(el.querySelectorAll("[role=menuitem]"), (item) => [
                item.textContent,
                item.getAttribute("aria-disabled"),
              ]),
            }));
          const result = (states[side + "-" + key] = [await snapshot()]);
          const rect = await menu.boundingBox();
          assert(rect);
          if (scenario === "blank")
            await writeFile(
              join(output, `${side}-${theme}-style.json`),
              JSON.stringify(
                await menu.evaluate((el) =>
                  [
                    el,
                    el.querySelector("[role=group]").firstChild,
                    el.querySelector("[role=menuitem]"),
                    el.querySelector("svg"),
                    el.querySelector("[role=separator]"),
                  ].map((node) => {
                    const css = getComputedStyle(node);
                    return Object.fromEntries(
                      [
                        "font",
                        "color",
                        "backgroundColor",
                        "boxShadow",
                        "borderRadius",
                        "padding",
                        "margin",
                        "textRendering",
                        "webkitFontSmoothing",
                        "fontSynthesis",
                        "transition",
                        "animation",
                        "width",
                        "height",
                      ].map((key) => [key, css[key]]),
                    );
                  }),
                ),
                null,
                2,
              ),
            );
          const clip = {
            x: Math.max(0, rect.x - 15),
            y: Math.max(0, rect.y - 8),
            width: Math.min(900 - Math.max(0, rect.x - 15), rect.width + 30),
            height: Math.min(650 - Math.max(0, rect.y - 8), rect.height + 34),
          };
          async function capture(stage) {
            const image = await page.screenshot({
              clip,
              path: join(output, `${side}-${key}-${stage}.png`),
            });
            assert(
              image.equals(await page.screenshot({ clip })),
              `${side}-${key}-${stage} unstable`,
            );
            (images[key + "-" + stage] ??= []).push(image.toString("base64"));
          }
          await capture("opened");
          for (const input of ["Home", "ArrowDown", "ArrowDown", "End", "ArrowDown"]) {
            await page.keyboard.press(input);
            await page.evaluate(
              () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
            );
            result.push(await snapshot());
            if (input === "End") await capture("end");
          }
          if (scenario === "link" || scenario === "fan") {
            const disabledItem = menu.getByRole("menuitem", { name: "文本", exact: true });
            await page.keyboard.press("Home");
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("ArrowDown");
            await expect(disabledItem).toBeFocused();
            await page.keyboard.press("Enter");
            await expect(menu).toBeVisible();
            assert.equal(await page.evaluate(() => window.chosen), undefined);
            const video = menu.getByRole("menuitem", { name: "视频生成" });
            await video.hover();
            await expect(video).toBeFocused();
            await capture("hover");
            await page.keyboard.press("Enter");
            await expect.poll(() => page.evaluate(() => window.chosen)).toBe("video");
          } else if (scenario === "edge") await page.mouse.click(240, 130);
          else await page.keyboard.press("Escape");
          await expect(menu).toBeHidden();
          if (scenario === "toolbar") await expect(trigger).toBeFocused();
        }
        await page.close();
      }
    } finally {
      await server.close();
    }
  }
  const page = await browser.newPage(),
    differences = {};
  for (const [name, pair] of Object.entries(images))
    differences[name] = await page.evaluate(async (sources) => {
      const pixels = await Promise.all(
        sources.map(async (src) => {
          const image = new Image();
          image.src = "data:image/png;base64," + src;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return new Uint32Array(context.getImageData(0, 0, image.width, image.height).data.buffer);
        }),
      );
      return pixels[0].length !== pixels[1].length
        ? -1
        : pixels[0].reduce((sum, value, index) => sum + Number(value !== pixels[1][index]), 0);
    }, pair);
  await writeFile(join(output, "results.json"), JSON.stringify({ states, differences }, null, 2));
  console.table(differences);
  for (const key of Object.keys(states).filter((key) => key.startsWith("original-")))
    assert.deepEqual(states[key], states["desktop-" + key.slice(9)], key);
  if (process.argv.includes("--strict"))
    assert(Object.values(differences).every((value) => value === 0));
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
