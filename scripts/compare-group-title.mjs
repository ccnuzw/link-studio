import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const cards = process.argv.includes("--cards");
const output = resolve(`test-results/${cards ? "card" : "group"}-title-parity`);
const scratch = await mkdtemp(join(tmpdir(), "group-title-parity-"));
const browser = await chromium.launch({ channel: "chrome", args: ["--disable-gpu"] });
const samples = new Map();
await mkdir(output, { recursive: true });
try {
  for (const original of [true, false]) {
    const side = original ? "original" : "desktop";
    const root = original ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const built = join(root, original ? "dist/assets" : "out/renderer/assets");
    const files = await readdir(built);
    const assets = join(scratch, `${side}-styles`);
    await mkdir(assets);
    await Promise.all(
      files
        .filter((name) => /\.(css|woff2)$/.test(name))
        .map((name) => copyFile(join(built, name), join(assets, name))),
    );
    const css = files.find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    const entry = "/src/__group_title_audit.jsx";
    const fixture = cards
      ? `import {createRoot} from 'react-dom/client'; import {useState} from 'react'; import {ReactFlow} from '@xyflow/react';
      ${original ? `import {NodeCard} from '@/components/canvas/node-card'; import {NODE_META} from '@/constants/canvas/node-library';` : `import {CardHeading} from '/src/renderer/workspace/node-title';`}
      const [zoom,kind] = location.search.slice(1).split('&');
      function Card(){const [label,rename]=useState(kind==='audio'?'第一场 Camera 12 配乐和环境音轨的长名称检查'.repeat(2):'镜头 Camera 12');
        const width=kind==='audio'?324:576;
        ${
          original
            ? `const Icon=NODE_META.get(kind).icon; const emptyStatus=['image','video','script','audio'].includes(kind)?<></>:undefined;
          return <NodeCard title={label} width={width} icon={<Icon/>} onRename={rename} handles={[]} status={emptyStatus}><div style={{height:324}}/></NodeCard>`
            : `return <article className="creative-card" data-card-kind={kind} data-visual={['image','audio','video','character'].includes(kind)} data-director={kind==='director'||undefined} data-storyboard={kind==='storyboard'||undefined} style={{width,height:324}}><CardHeading kind={kind} label={label} commit={rename}/></article>`
        }}
      createRoot(document.querySelector('#root')).render(<ReactFlow defaultNodes={[{id:'card',type:'card',position:{x:0,y:0},data:{}}]} defaultViewport={{x:40,y:100,zoom:Number(zoom)}} nodeTypes={{card:Card}} proOptions={{hideAttribution:true}}/>);`
      : `import {createRoot} from 'react-dom/client'; import {useState} from 'react';
      import {ReactFlow} from '@xyflow/react';
      ${
        original
          ? `import {GroupNodeView as Card} from '@/components/canvas-editor/group-node';
        import {GroupUiProvider,useGroupUiState} from '@/components/canvas-editor/group-ui';
        function Provider({children}) {return <GroupUiProvider value={useGroupUiState(()=>{})}>{children}</GroupUiProvider>}`
          : `import {RenameTitle} from '/src/renderer/workspace/node-title';
          import {GroupNodeCard as Card} from '/src/renderer/workspace/group-card';
          function Provider({children}) {const [id,start]=useState();return <RenameTitle.Provider value={{id,start}}>{children}</RenameTitle.Provider>}`
      }
      const [zoom,mode]=location.search.slice(1).split('&');
      const nodes=[{id:'group',type:'group',position:{x:0,y:0},width:220,height:140,data:{label:mode==='long'?'第一场 Camera 12 的片头分镜与音轨合成检查'.repeat(2):'场景 Camera 12',labelColor:mode==='long'?'blue':undefined,color:mode==='long'?'red':undefined}}];
      createRoot(document.querySelector('#root')).render(<Provider><ReactFlow defaultNodes={nodes} defaultViewport={{x:40,y:100,zoom:Number(zoom)}} nodeTypes={{group:Card}} proOptions={{hideAttribution:true}}/></Provider>);`;
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
          name: "group-title",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? fixture : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"])
        for (const dpr of [1, 2]) {
          const page = await browser.newPage({
            viewport: { width: cards ? 960 : 520, height: 360 },
            colorScheme: theme,
            deviceScaleFactor: dpr,
          });
          await page.route(origin + "assets/**", (route) =>
            route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
          );
          await page.route(origin + "audit*", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset=utf-8><link rel=stylesheet href="/assets/${css}"><main class="${original ? "" : "canvas-workspace"}" style="position:fixed;inset:0;display:block;background:${theme === "dark" ? "#232323" : "#fafafa"}"><div id="root" style="height:100%"></div></main><script type=module src="${entry}"></script></html>`,
            }),
          );
          for (const zoom of [0.5, 1, 1.5])
            for (const mode of cards
              ? ["script", "image", "video", "audio", "director", "storyboard", "character"]
              : ["short", "long"]) {
              await page.goto(`${origin}audit?${zoom}&${mode}`);
              const title = cards
                ? page
                    .locator(
                      original
                        ? '.react-flow__node-card [tabindex="0"] > div:first-child'
                        : ".canvas-card-heading",
                    )
                    .first()
                : page.locator(original ? '[data-slot="group-title"]' : ".canvas-group-name");
              await expect(title).toBeVisible();
              await page.evaluate(() => document.fonts.ready);
              await page.mouse.move(0, 0);
              for (const phase of cards ? ["idle", "edit"] : ["idle", "hover", "edit"]) {
                if (phase === "hover") await title.locator("svg").hover();
                if (phase === "edit") {
                  await (cards ? title.getByTitle("双击重命名") : title.locator("svg")).dblclick();
                  await expect(
                    title.getByRole("textbox", { name: cards ? "节点名称" : "组名" }),
                  ).toBeFocused();
                }
                const key = `${theme}-${dpr}-${zoom}-${mode}-${phase}`;
                await page.evaluate(() =>
                  Promise.all(document.getAnimations().map((animation) => animation.finished)),
                );
                const clip = cards
                  ? {
                      x: 35,
                      y: 45,
                      width: Math.ceil((mode === "audio" ? 324 : 576) * zoom) + 10,
                      height: 52,
                    }
                  : { x: 30, y: 32, width: 360, height: 290 };
                const rect = await title.boundingBox();
                assert(
                  rect.y >= clip.y &&
                    rect.x + rect.width <= clip.x + clip.width &&
                    rect.y + rect.height <= clip.y + clip.height,
                );
                const image = await page.screenshot({
                  clip,
                  path: join(output, `${key}-${side}.png`),
                });
                assert(image.equals(await page.screenshot({ clip })), `${key}: unstable ${side}`);
                if (!samples.has(key)) samples.set(key, []);
                samples.get(key).push({ rect, image: image.toString("base64") });
              }
            }
          await page.close();
        }
    } finally {
      await server.close();
    }
  }
  const comparator = await browser.newPage();
  const results = {};
  for (const [key, pair] of samples) {
    const different = await comparator.evaluate(async (pair) => {
      const [left, right] = await Promise.all(
        pair.map(async ({ image }) => {
          const bitmap = new Image();
          bitmap.src = "data:image/png;base64," + image;
          await bitmap.decode();
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          return new Uint32Array(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer);
        }),
      );
      return left.reduce((sum, value, index) => sum + (value !== right[index]), 0);
    }, pair);
    results[key] = { different, rectangles: pair.map((item) => item.rect) };
  }
  await writeFile(join(output, "comparison.json"), JSON.stringify(results, null, 2));
  const mismatches = Object.entries(results).filter(([, result]) => result.different);
  console.log(
    `${samples.size - mismatches.length}/${samples.size} exact`,
    mismatches.map(([key, { different }]) => [key, different]),
  );
  if (process.argv.includes("--strict")) assert.equal(mismatches.length, 0);
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
