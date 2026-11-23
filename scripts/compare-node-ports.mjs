import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned web checkout");
const theme = process.argv.includes("--dark") ? "dark" : "light";
const output = resolve(`test-results/node-port-parity${theme === "dark" ? "-dark" : ""}`);
const cache = await mkdtemp(join(tmpdir(), "node-port-audit-"));
const entry = "/src/__node_port_audit.tsx";
const browser = await chromium.launch({ channel: "chrome" });
const records = {};
await mkdir(output, { recursive: true });

try {
  for (const upstream of [true, false]) {
    const name = upstream ? "upstream" : "desktop";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const stylesheet = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(stylesheet);
    const imports = upstream
      ? `import {NodeCard} from '/src/components/canvas/node-card';`
      : `import {NodePort} from '/src/renderer/workspace/node-port';import {motion} from 'motion/react';import {useConnectionTilt} from '/src/renderer/workspace/use-connection-tilt';`;
    const card = upstream
      ? `<NodeCard width={240} title="" canAcceptConnection={()=>id!=='reject'}><div style={{height:160}}/></NodeCard>`
      : `<motion.article className="creative-card" data-agent-mark={useAgentMark(id)} style={{width:240,height:160,border:0,...tilt}}><NodePort type="source"/><NodePort type="target"/></motion.article>`;
    const markImports = upstream
      ? `import {useAgentHighlight} from '@/store/agent-highlight';window.mark=(mode)=>mode==='touch'?useAgentHighlight.getState().touch(['node']):useAgentHighlight.getState().setDanger(mode==='danger'?['node']:[]);`
      : `import {AgentMarks,useAgentMark,createAgentMarks} from '/src/renderer/workspace/agent-marks';const marks=createAgentMarks();window.mark=(mode)=>mode==='touch'?marks.touch(['node']):marks.danger(mode==='danger'?['node']:[]);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(cache, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "node-port-fixture",
          resolveId(id) {
            if (id === entry) return join(root, entry);
          },
          load(id) {
            if (id !== join(root, entry)) return;
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {ReactFlow} from '@xyflow/react';${imports}${markImports}
          function Card({id}){${upstream ? "" : "const tilt=useConnectionTilt(id,'image');"}return (${card})} const nodeTypes={card:Card};const zoom=Number(location.search.slice(1))||1;
          const nodes=[{id:'node',type:'card',position:{x:0,y:0},data:{}}];if(location.search==='?tilt')nodes.push({id:'accept',type:'card',position:{x:320,y:0},data:{}},{id:'reject',type:'card',position:{x:320,y:220},data:{}});
          const content=<ReactFlow nodeTypes={nodeTypes} defaultNodes={nodes} isValidConnection={edge=>edge.target!=='reject'} defaultViewport={{x:160,y:150,zoom}} minZoom={0.2} maxZoom={2} nodesDraggable={false}/>;createRoot(document.querySelector('main')).render(${upstream ? "content" : "<AgentMarks.Provider value={marks}>{content}</AgentMarks.Provider>"});`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 900, height: 650 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}assets/**`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.route(`${origin}audit*`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${stylesheet}"><style>main{position:fixed;inset:0}</style><main class="${upstream ? "" : "canvas-workspace"}"></main><script type="module" src="${entry}"></script></html>`,
        }),
      );
      const samples = [];
      for (const zoom of [0.65, 1, 1.5]) {
        await page.goto(`${origin}audit?${zoom}`);
        const node = page.locator(".react-flow__node");
        await expect(node).toBeVisible();
        const captureFrame = async (state) => {
          if (zoom !== 1) return;
          await page.screenshot({
            clip: { x: 90, y: 90, width: 380, height: 300 },
            animations: "disabled",
            path: join(output, `${name}-${state}.png`),
          });
        };
        await page.mouse.move(10, 10);
        await captureFrame("idle");
        await node.hover();
        await captureFrame("hover");
        for (const side of ["right", "left"]) {
          const port = node.locator(`.react-flow__handle-${side}`);
          const icon = port.locator(":scope > :first-child");
          const anchor = await port.boundingBox();
          const center = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
          for (const [along, outward] of [
            [0, 40],
            [0, -12],
            [-84, 12],
            [74, 23],
            [100, 18],
            [0, 32],
          ]) {
            const x = Math.round(center.x + (side === "left" ? -1 : 1) * outward * zoom);
            const y = Math.round(center.y + along * zoom);
            await page.mouse.move(x, y);
            const hit = await port.evaluate(
              (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
              { x, y },
            );
            const shown = hit || outward === -12;
            await expect(icon).toHaveCSS("opacity", shown ? "1" : "0");
            samples.push({
              zoom,
              side,
              along,
              outward,
              hit,
              anchor,
              icon: await icon.boundingBox(),
            });
            if (zoom === 1 && side === "right" && along === 74)
              await page.screenshot({
                clip: { x: center.x + 2, y: y - 20, width: 45, height: 40 },
                path: join(output, `${name}-tracked.png`),
              });
          }
        }
        await node.click({ position: { x: 40, y: 50 } });
        await page.mouse.move(10, 10);
        await expect(node).toHaveClass(/selected/);
        await expect(node.locator(".react-flow__handle-right > :first-child")).toHaveCSS(
          "opacity",
          "1",
        );
        await captureFrame("selected");
        if (zoom === 1)
          for (const mode of ["touch", "danger", "clear"]) {
            await page.evaluate((mode) => window.mark(mode), mode);
            const marked = node.locator("[data-agent-mark]");
            if (mode === "clear") await expect(marked).toHaveCount(0);
            else
              await expect(marked).toHaveAttribute(
                "data-agent-mark",
                mode === "touch" ? "touched" : mode,
              );
            await captureFrame("mark-" + mode);
          }
        if (zoom === 1 && process.env.PORT_STYLES)
          console.log(
            name,
            await node.evaluate((element) =>
              [element, ...element.querySelectorAll('article,[tabindex="0"]')].map((child) => {
                const style = getComputedStyle(child);
                return { shadow: style.boxShadow, outline: style.outline, border: style.border };
              }),
            ),
          );
      }
      records[name] = samples;
      for (const reducedMotion of ["no-preference", "reduce"]) {
        await page.emulateMedia({ reducedMotion });
        await page.goto(`${origin}audit?tilt`);
        const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
        const body = (id) => node(id).locator(":scope > :first-child");
        await expect(node("reject")).toBeVisible();
        const source = await node("node").locator(".react-flow__handle-right").boundingBox();
        await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2);
        await page.mouse.down();
        const poses = {};
        for (const [state, x, y] of [
          ["corner", 690, 179],
          ["center", 600, 230],
          ["reject", 600, 420],
          ["outside", 769, 408],
          ["release", 769, 408],
        ]) {
          if (state === "release") await page.mouse.up();
          else await page.mouse.move(x, y, { steps: 4 });
          await expect(body("reject")).toHaveCSS("opacity", state === "release" ? "1" : "0.35");
          await page.waitForTimeout(650);
          poses[state] = await Promise.all(
            ["node", "accept", "reject"].map((id) =>
              body(id).evaluate((el) => [
                getComputedStyle(el).transform,
                getComputedStyle(el).opacity,
              ]),
            ),
          );
          const tilted =
            reducedMotion === "no-preference" && (state === "corner" || state === "center");
          assert.equal(poses[state][1][0] !== "none", tilted, `${name} ${reducedMotion} ${state}`);
          const shot = `${name}-tilt-${reducedMotion}-${state}.png`;
          await page.screenshot({
            clip: { x: 450, y: 115, width: 300, height: 235 },
            path: join(output, shot),
          });
        }
        await writeFile(
          join(output, `${name}-tilt-${reducedMotion}.json`),
          JSON.stringify(poses, null, 2),
        );
      }
    } finally {
      await page.close();
      await server.close();
    }
  }
  await writeFile(join(output, "geometry.json"), JSON.stringify(records, null, 2));
  assert.deepEqual(records.desktop, records.upstream);
  const decoder = await browser.newPage(),
    differences = {};
  for (const motion of ["no-preference", "reduce"]) {
    const poses = await Promise.all(
      ["upstream", "desktop"].map((side) =>
        readFile(join(output, `${side}-tilt-${motion}.json`), "utf8"),
      ),
    );
    assert.deepEqual(JSON.parse(poses[0]), JSON.parse(poses[1]));
    for (const phase of Object.keys(JSON.parse(poses[0]))) {
      const frames = await Promise.all(
        ["upstream", "desktop"].map((side) =>
          readFile(join(output, `${side}-tilt-${motion}-${phase}.png`)),
        ),
      );
      const differentPixels = await decoder.evaluate(
        async (encoded) => {
          const [original, replica] = await Promise.all(
            encoded.map(async (png) => {
              const image = new Image();
              image.src = "data:image/png;base64," + png;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(image, 0, 0);
              return new Uint32Array(ctx.getImageData(0, 0, image.width, image.height).data.buffer);
            }),
          );
          return original.reduce(
            (count, pixel, index) => count + Number(pixel !== replica[index]),
            0,
          );
        },
        frames.map((frame) => frame.toString("base64")),
      );
      differences[motion + "-" + phase] = differentPixels;
      console.log("Held connection frame", motion, phase, "different pixels:", differentPixels);
      if (
        process.argv.includes("--strict") ||
        phase === "release" ||
        (motion === "no-preference" && ["corner", "center"].includes(phase))
      )
        assert.equal(differentPixels, 0, `${motion} ${phase}`);
    }
  }
  await decoder.close();
  await writeFile(join(output, "tilt-pixels.json"), JSON.stringify(differences, null, 2));
  const files = await Promise.all(
    ["upstream", "desktop"].map((name) => readFile(join(output, `${name}-tracked.png`))),
  );
  assert(files[0].equals(files[1]), "Tracked port icon differs from the pinned build");
  for (const state of ["idle", "hover", "selected", "mark-touch", "mark-danger", "mark-clear"]) {
    const frames = await Promise.all(
      ["upstream", "desktop"].map((name) => readFile(join(output, `${name}-${state}.png`))),
    );
    assert(frames[0].equals(frames[1]), `Unexpected difference in ${state} node frame`);
    console.log("Empty node frame", state, frames[0].equals(frames[1]));
  }
  console.log(
    "Geometry samples:",
    records.desktop.length,
    "Tracked icon screenshots identical:",
    files[0].equals(files[1]),
  );
} finally {
  await browser.close();
  await rm(cache, { recursive: true, force: true });
}
