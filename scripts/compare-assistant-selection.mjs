import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const software = process.argv.includes("--software");
const output = resolve(`test-results/assistant-selection-parity${software ? "-software" : ""}`),
  scratch = await mkdtemp(join(tmpdir(), "selection-"));
const browser = await chromium.launch({
    channel: "chrome",
    args: software ? ["--disable-gpu"] : [],
  }),
  results = {},
  shots = {},
  geometry = {};
const entry = "/src/__assistant_selected.tsx";
await mkdir(output, { recursive: true });
try {
  for (const side of ["upstream", "desktop"]) {
    const original = side === "upstream",
      root = original ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, original ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const code = `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {ReactFlow,ReactFlowProvider,useReactFlow} from '@xyflow/react';
      ${original ? `import {SelectionRefs} from '@/pages/canvas/agent/selection-refs';import {useAgentHighlight} from '@/store/agent-highlight';import {MessageText} from '@/pages/canvas/agent/message-list';` : `import {AssistantSelection} from '/src/renderer/workspace/assistant-selection';import {AssistantUserBubble} from '/src/renderer/workspace/assistant-user-bubble';`}
      const text='先看@[站台](node:n1)@[模型](model:fixture/v1)\\n使用@[镜头](skill:shot)和@[这是一个很长很长需要省略的附件名称](asset:a1)，保留原文@[无效](other:x)';
      function Bubble(){return ${original ? `<div className="agent-inset bg-foreground/7 max-w-[88%] rounded-2xl rounded-br-sm px-3 py-2 text-[13.5px] leading-[1.7] break-words whitespace-pre-wrap"><MessageText text={text}/></div>` : `<AssistantUserBubble text={text}/>`};}
      const ids=['long','group','absent','long','audio','image'];
      const all=[['long','script','车厢内靠窗的乘客转过头看向窗外的站台'],['group','group','场景组'],['audio','audio',''],['image','image','站台']];
      function Subject(){const [rows,setRows]=useState(all);const flow=useReactFlow();window.rename=()=>setRows(rows.map(r=>r[0]==='long'?[r[0],r[1],'新标题']:r));window.remove=()=>setRows(rows.filter(r=>r[0]!=='group'));
        ${original ? `window.located=()=>flow.getNodes().filter(n=>n.selected && useAgentHighlight.getState().marks[n.id]==='touched').map(n=>n.id);return <SelectionRefs ids={ids} nodes={rows.map(([id,kind,label])=>({id,kind,label}))}/>;` : `return <AssistantSelection ids={ids} nodes={new Map(rows.map(([id,kind,label])=>[id,{id,type:kind==='group'?'group':'creative',data:{kind,label}}]))} locate={id=>window.located=()=>[id]}/>;`}}
      createRoot(document.querySelector('main')).render(<ReactFlowProvider><div style={{position:'absolute',width:400,height:280,top:260}}><ReactFlow defaultNodes={all.map(([id],index)=>({id,position:{x:index*80,y:16},data:{label:id}}))}/></div><section className="${original ? "" : "agent-user-turn"}" style={{width:340,display:'flex',flexDirection:'column',alignItems:'flex-end'}}><Subject/></section><section id="bubble" className="${original ? "" : "agent-user-turn"}" style={{position:'absolute',top:110,width:340,display:'flex',flexDirection:'column',alignItems:'flex-end'}}><Bubble/></section></ReactFlowProvider>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(scratch, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "selection-refs",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? code : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport: { width: 420, height: 540 },
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
              body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><style>body{margin:0;background:${theme === "light" ? "white" : "#171717"}}main.assistant-surface,main{position:fixed;top:16px;left:16px;padding:0;border:0;display:block;background:transparent;color-scheme:${theme}}</style><main class="${original ? "" : "assistant-surface canvas-assistant"}"></main><script type="module" src="${entry}"></script></html>`,
            }),
          );
          await page.goto(`${origin}audit`);
          const group = page.getByRole("group", { name: "引用了 5 个节点" }),
            more = group.getByRole("button", { name: "再展开 2 个节点" });
          await page.addStyleTag({
            content: `html,body{height:100%;background:${theme === "light" ? "white" : "#171717"}}main{width:400px;height:500px}main.assistant-surface{overflow:visible}`,
          });
          await group.waitFor();
          await page.evaluate(() => document.fonts.ready);
          if (process.env.SELECTION_STYLES)
            console.log(
              side,
              theme,
              await group.evaluate((el) =>
                [...el.children].map((btn) =>
                  Object.fromEntries(
                    [
                      "font",
                      "textRendering",
                      "webkitFontSmoothing",
                      "fontSynthesis",
                      "backgroundColor",
                      "borderRadius",
                      "boxShadow",
                      "opacity",
                      "color",
                      "outline",
                      "outlineOffset",
                      "letterSpacing",
                    ].map((k) => [k, getComputedStyle(btn)[k]]),
                  ),
                ),
              ),
            );
          async function capture(name) {
            const key = `${theme}-${name}`;
            await page.waitForTimeout(180);
            geometry[`${side}-${key}`] = await Promise.all(
              [group, ...(await group.getByRole("button").all())].map((item) => item.boundingBox()),
            );
            shots[`${side}-${key}`] = await page.screenshot({
              clip: { x: 12, y: 12, width: 352, height: 90 },
              path: join(output, `${side}-${key}.png`),
            });
          }
          await expect(group.getByRole("button")).toHaveCount(4);
          await expect(group.getByText("已删除的节点")).toBeDisabled();
          await capture("folded");
          await more.hover();
          await capture("more-hover");
          const hover = await more.evaluate((node) => getComputedStyle(node).color);
          await page.mouse.move(2, 2);
          await expect(more).not.toHaveCSS("color", hover);
          await more.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await expect(more).toBeFocused();
          await capture("focus");
          if (process.env.SELECTION_STYLES)
            console.log(
              side,
              theme,
              "focus",
              await more.evaluate((node) => getComputedStyle(node).boxShadow),
            );
          await more.press("Enter");
          await expect(group.getByRole("button")).toHaveCount(5);
          await expect(group.getByText("音频节点")).toBeVisible();
          await capture("expanded");
          await group.getByRole("button", { name: "场景组" }).click();
          await expect.poll(() => page.evaluate(() => window.located())).toEqual(["group"]);
          await page.evaluate(() => window.rename());
          await expect(group.getByText("新标题")).toBeVisible();
          await page.evaluate(() => window.remove());
          await expect(group.getByRole("button", { name: "已删除的节点" })).toHaveCount(2);
          await page.mouse.move(2, 2);
          await capture("changed");
          const bubble = page.locator("#bubble > div");
          await expect(bubble.locator("[title]")).toHaveCount(4);
          await expect(bubble).toContainText("@[无效](other:x)");
          const refs = ["node:n1", "model:fixture/v1", "skill:shot", "asset:a1"].map((title) =>
            bubble.getByTitle(title, { exact: true }),
          );
          const key = `${side}-${theme}-bubble`;
          geometry[key] = await Promise.all([bubble, ...refs].map((item) => item.boundingBox()));
          shots[key] = await page.screenshot({
            clip: { x: 12, y: 120, width: 352, height: 128 },
            path: join(output, `${key}.png`),
          });
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  const decode = await browser.newPage();
  for (const name of Object.keys(shots)
    .filter((key) => key.startsWith("desktop-"))
    .map((key) => key.slice(8))) {
    const [left, right] = ["upstream", "desktop"].map((side) =>
      shots[`${side}-${name}`].toString("base64"),
    );
    const pixels = await decode.evaluate(
      async (pair) => {
        const arrays = await Promise.all(
          pair.map(async (png) => {
            const img = new Image();
            img.src = `data:image/png;base64,${png}`;
            await img.decode();
            const cn = document.createElement("canvas");
            cn.width = img.width;
            cn.height = img.height;
            const ctx = cn.getContext("2d");
            ctx.drawImage(img, 0, 0);
            return new Uint32Array(ctx.getImageData(0, 0, cn.width, cn.height).data.buffer);
          }),
        );
        return arrays[0].reduce((sum, value, index) => sum + Number(value !== arrays[1][index]), 0);
      },
      [left, right],
    );
    results[name] = pixels;
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ geometry, results }, null, 2));
  console.table(results);
  for (const key of Object.keys(results)) {
    assert.deepEqual(geometry[`desktop-${key}`], geometry[`upstream-${key}`], key);
    if (software || process.argv.includes("--strict")) assert.equal(results[key], 0, key);
  }
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
