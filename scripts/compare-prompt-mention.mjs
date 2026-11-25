import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { readRenderedText } from "./read-rendered-text.mjs";

const desktop = process.cwd();
const baseline = resolve(process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web");
const dark = process.argv.includes("--dark");
const output = join(desktop, `test-results/prompt-mention-parity${dark ? "-dark" : ""}`);
const temp = await mkdtemp(join(tmpdir(), "prompt-mention-"));
const browser = await chromium.launch({ channel: "chrome" });
const results = {};
await mkdir(output, { recursive: true });
try {
  for (const [name, root] of [
    ["upstream", baseline],
    ["desktop", desktop],
  ]) {
    const upstream = name === "upstream";
    const fixture = join(root, "src/__prompt_mention_fixture.jsx");
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const stylesheet = await readFile(join(assets, css));
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "prompt-mention-fixture",
          resolveId(id) {
            if (id === "/src/__prompt_mention_fixture.jsx") return fixture;
          },
          load(id) {
            if (id !== fixture) return;
            return `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
        ${upstream ? `import {PromptEditor,PromptChipResolverProvider} from '/src/components/canvas/prompt-mention';` : `import {CanvasPromptEditor} from '/src/renderer/workspace/canvas-prompt-editor';`}
        const labels=location.hash==='#overflow'?Array.from({length:18},(_,index)=>'很长的素材名称'.repeat(5)+(index+1)):['剧本甲','剧本乙','场景'];
        const nodes=labels.map((label,i)=>({id:'n'+i,label,kind:'script',text:'正文'}));
        function Audit(){const [value,change]=useState('镜头'); const handle=React.useRef(null); const [linked,setLinked]=useState(new Set(['n0'])); const byId=new Map(nodes.map(node=>[node.id,node]));const link=id=>setLinked(prev=>new Set([...prev,id]));
        window.applyAuditPreset=(...args)=>handle.current.applyPreset(...args);
        return <><output hidden data-ids={[...linked].join(',')}>{value}</output>${upstream ? `<PromptChipResolverProvider value={id=>byId.get(id)}><PromptEditor ref={handle} value={value} onValueChange={change} onSubmit={()=>{}} placeholder="提示词" mention={{linkedIds:linked,list:()=>({linked:nodes.filter(n=>linked.has(n.id)),canvas:nodes.filter(n=>!linked.has(n.id))}),link:node=>link(node.id)}}/></PromptChipResolverProvider>` : `<CanvasPromptEditor ref={handle} value={value} change={change} disabled={false} expanded={false} placeholder="提示词" sources={{byId,linked,entries:nodes.map(source=>({source,linked:linked.has(source.id)}))}} link={link}/>`}</>;}createRoot(document.querySelector('#root')).render(<Audit/>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: dark ? "dark" : "light",
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}audit`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${dark ? "dark" : "light"}"><meta charset="utf-8"><link rel="stylesheet" href="/built/${css}"><main style="position:fixed;inset:0;background:${dark ? "#232323" : "#fafafa"};color:${dark ? "white" : "#0a0a0a"}"><div style="position:absolute;top:180px;left:280px;width:400px" id="root"></div></main><script type="module" src="/src/__prompt_mention_fixture.jsx"></script></html>`,
        }),
      );
      await page.route(`${origin}built/**`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.route(`${origin}assets/*.woff2`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.route(`${origin}built/${css}`, (route) =>
        route.fulfill({ contentType: "text/css", body: stylesheet }),
      );
      await page.goto(`${origin}audit`);
      const editor = page.getByRole("textbox");
      const list = page.getByRole("listbox");
      const state = page.locator("output");
      await editor.click();
      await editor.press("End");
      await page.keyboard.insertText("@");
      await expect(list.getByRole("option")).toHaveCount(3);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map((animation) => animation.finished));
      });
      let capture = await list.screenshot();
      await expect
        .poll(async () => {
          const next = await list.screenshot();
          const stable = next.equals(capture);
          capture = next;
          return stable;
        })
        .toBe(true);
      await writeFile(join(output, `${name}.png`), capture);
      const clip = { x: 240, y: 180, width: 420, height: 290 };
      await page.screenshot({ path: join(output, `${name}-full.png`), clip });
      const rect = await list.boundingBox();
      const metrics = await editor.evaluate((element) => {
        const range = document.getSelection().getRangeAt(0);
        return {
          caret: range.getBoundingClientRect().toJSON(),
          font: getComputedStyle(element).font,
          bounds: element.getBoundingClientRect().toJSON(),
        };
      });
      const options = await list.getByRole("option").allTextContents();
      await editor.press("ArrowUp");
      const wrap = await readRenderedText(list.locator('[aria-selected="true"]'));
      await page.screenshot({ path: join(output, `${name}-wrapped.png`), clip });
      await editor.press("ArrowDown");
      await page.keyboard.insertText("剧本");
      await expect(list.getByRole("option")).toHaveCount(2);
      await editor.press("ArrowDown");
      await editor.press("Tab");
      await expect(list).toBeHidden();
      await expect(editor.locator('[data-ref="n1"]')).toHaveText("剧本乙");
      const saved = await state.textContent();
      const ids = await state.getAttribute("data-ids");
      await editor.press("Backspace");
      await editor.press("Backspace");
      await expect(editor.locator("[data-ref]")).toHaveCount(0);
      const afterDelete = await state.textContent();
      await editor.press("Home");
      await editor.press("ArrowRight");
      const afterArrow = await editor.evaluate((element) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        range.setEnd(selection.focusNode, selection.focusOffset);
        return range.toString().length;
      });
      await editor.evaluate(async (element) => {
        const text = element.querySelector("p").firstChild;
        window.getSelection().setBaseAndExtent(text, 1, text, 1);
        document.dispatchEvent(new Event("selectionchange"));
        await new Promise(requestAnimationFrame);
      });
      const presetStates = [];
      for (const args of [
        ["style", "period_idol"],
        ["style", "wuxia"],
        ["motion", "static_shot"],
        ["motion", "tilt_up"],
        ["tpl", "storyboard_25_grid"],
      ]) {
        await page.evaluate((args) => {
          window.applyAuditPreset(...args);
        }, args);
        await expect(editor.locator(`[data-preset="${args.join("/")}"]`)).toHaveCount(1);
        presetStates.push(await state.textContent());
      }
      const motionIndex = await editor
        .locator("[data-preset]")
        .evaluateAll((elements) =>
          elements.findIndex((el) => el.dataset.preset === "motion/static_shot"),
        );
      assert(motionIndex >= 0);
      await page.evaluate((index) => {
        window.applyAuditPreset("motion", "tilt_up", index);
      }, motionIndex);
      presetStates.push(await state.textContent());
      await page.evaluate((index) => {
        window.applyAuditPreset("motion", "static_shot", index);
      }, motionIndex);
      await expect(editor.locator('[data-preset="motion/static_shot"]')).toHaveCount(0);
      presetStates.push(await state.textContent());
      await page.goto(`${origin}audit#overflow`);
      await page.reload();
      await page.locator("#root").evaluate((el) => {
        el.style.top = "640px";
      });
      await editor.click();
      await editor.press("End");
      await page.keyboard.insertText("@");
      await expect(list.getByRole("option")).toHaveCount(18);
      await editor.press("ArrowUp");
      await expect(list.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect.poll(() => list.evaluate((el) => el.style.bottom)).toMatch(/px$/);
      await page.evaluate(async () => {
        await Promise.all(
          document.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
      });
      const box = await list.boundingBox(),
        caret = await editor.evaluate(() =>
          document.getSelection().getRangeAt(0).getBoundingClientRect().toJSON(),
        );
      assert(box.y + box.height <= caret.top, JSON.stringify({ name, box, caret }));
      const scrolled = await list.evaluate((el) => ({
        top: el.scrollTop,
        extent: el.scrollHeight,
        width: el.clientWidth,
        box: el.getBoundingClientRect().toJSON(),
      }));
      const overflowClip = { x: 240, y: 213, width: 420, height: 510 };
      const photograph = async (suffix) => {
        await page.evaluate(async () => {
          await Promise.all(
            document.getAnimations().map((animation) => animation.finished.catch(() => {})),
          );
        });
        await page.screenshot({ path: join(output, `${name}-${suffix}.png`), clip: overflowClip });
      };
      await photograph("overflow");
      await page.keyboard.insertText("NoMATCH");
      await expect(list.getByText("没有匹配「NoMATCH」的素材")).toBeVisible();
      await photograph("empty");
      await editor.press("Escape");
      await expect(list).toHaveCount(0);
      await expect(editor).toBeFocused();
      results[name] = {
        scrolled,
        rect,
        metrics,
        options,
        wrap,
        saved,
        ids,
        afterDelete,
        afterArrow,
        presetStates,
      };
    } finally {
      await page.close();
      await server.close();
    }
  }
  const ffmpeg = resolve(
    "out/media",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  results.pixels = {};
  for (const suffix of ["", "-full", "-wrapped", "-overflow", "-empty"]) {
    const [before, after] = ["upstream", "desktop"].map((name) =>
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-i",
        join(output, `${name}${suffix}.png`),
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ]),
    );
    assert.equal(before.length, after.length);
    let different = 0;
    for (let offset = 0; offset < before.length; offset += 3)
      different += Number(before.readUIntBE(offset, 3) !== after.readUIntBE(offset, 3));
    results.pixels[suffix.slice(1) || "list"] = different;
  }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(results.pixels);
  for (const key of [
    "rect",
    "scrolled",
    "afterArrow",
    "options",
    "wrap",
    "saved",
    "ids",
    "afterDelete",
    "presetStates",
  ])
    assert.deepEqual(results.desktop[key], results.upstream[key]);
  assert.equal(results.desktop.saved, "镜头@[剧本乙](n1) ");
  if (process.argv.includes("--strict"))
    assert(Object.values(results.pixels).every((value) => value === 0));
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
