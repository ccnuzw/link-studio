import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const coincident = process.argv.includes("--coincident"),
  overlap = coincident || process.argv.includes("--overlap"),
  drag = process.argv.includes("--drag"),
  cut = process.argv.includes("--cut") || drag || overlap,
  retina = process.argv.includes("--retina"),
  output = resolve(
    `test-results/edge-${coincident ? "coincident" : overlap ? "overlap" : drag ? "drag" : cut ? "cut" : "sweep"}-parity${retina ? "-retina" : ""}`,
  );
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "edge-sweep-")),
  entry = "/src/__sweep_audit.tsx";
const browser = await chromium.launch({ channel: "chrome", args: ["--disable-gpu"] });
const records = {},
  frames = new Set();
const hitAreas = {};
const geometry = {};
const selections = {};
async function overlapPlayback(page, side, theme, zoom) {
  const edges = page.locator(".react-flow__edge");
  const scissors = page.getByRole("button", { name: "断开连接" });
  await expect(edges).toHaveCount(2);
  const point = (id, fraction) =>
    edges
      .filter({ has: page.locator(`path[id="${id}"]`) })
      .locator(".react-flow__edge-path")
      .evaluate((path, fraction) => {
        const { x, y } = path
          .getPointAtLength(path.getTotalLength() * fraction)
          .matrixTransform(path.getScreenCTM());
        return { x, y };
      }, fraction);
  const click = async (id, fraction, modifier) => {
    const { x, y } = await point(id, fraction);
    if (modifier) await page.keyboard.down(modifier);
    try {
      await page.mouse.click(x, y);
    } finally {
      if (modifier) await page.keyboard.up(modifier);
    }
  };
  const capture = async (label, expected, remaining = ["falling", "rising"]) => {
    await page.mouse.move(1, 1);
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const key = `${theme}-${zoom}-${label}`;
    selections[side][key] = {
      selected: await edges.evaluateAll((elements) =>
        elements
          .filter((el) => el.classList.contains("selected"))
          .map((el) => el.dataset.id)
          .sort(),
      ),
      remaining: await edges.evaluateAll((elements) => elements.map((el) => el.dataset.id).sort()),
      cut: (await scissors.count()) ? await scissors.boundingBox() : null,
    };
    assert.deepEqual(selections[side][key].selected, expected, `${side}-${key}: selected`);
    assert.deepEqual(selections[side][key].remaining, remaining);
    assert.equal(Boolean(selections[side][key].cut), expected.length === 1);
    const bytes = await page.screenshot({ path: join(output, `${side}-${key}.png`) });
    assert(bytes.equals(await page.screenshot()), `${side}-${key} unstable`);
    frames.add(key);
  };
  const crossing = await point("rising", 0.5),
    other = await point("falling", 0.5);
  assert(Math.hypot(crossing.x - other.x, crossing.y - other.y) < 0.1);
  const stack = (point) =>
    page.evaluate(
      ({ x, y }) =>
        Array.from(
          new Set(
            document
              .elementsFromPoint(x, y)
              .map((el) => el.closest(".react-flow__edge")?.getAttribute("data-id"))
              .filter(Boolean),
          ),
        ),
      point,
    );
  assert.deepEqual(await stack(crossing), ["rising", "falling"]);
  if (coincident) {
    const paths = await edges
      .locator(".react-flow__edge-path")
      .evaluateAll((items) => items.map((item) => item.getAttribute("d")));
    assert.equal(paths[0], paths[1]);
    for (const fraction of [0.19, 0.5, 0.81]) {
      const sample = await point("rising", fraction);
      assert.deepEqual(await stack(sample), ["rising", "falling"]);
      await click("rising", fraction);
      await capture(`along-${fraction}`, ["rising"]);
      const box = await scissors.boundingBox();
      assert(Math.hypot(box.x + box.width / 2 - sample.x, box.y + box.height / 2 - sample.y) < 2);
    }
  } else {
    await click("rising", 0.5);
    await capture("crossing", ["rising"]);
    await click("falling", 0.24, "Shift");
    await capture("shift", ["falling"]);
    await click("rising", 0.79, "ControlOrMeta");
    await capture("multi", ["falling", "rising"]);
    await click("falling", 0.24, "ControlOrMeta");
    await capture("toggle", ["rising"]);
    await page.mouse.click(8, 8);
    await capture("clear", []);
    await click("falling", 0.24);
    await click("falling", 0.5);
    await capture("recross", ["rising"]);
  }
  await scissors.click();
  await expect(edges).toHaveCount(1);
  await capture("cut", [], ["falling"]);
  assert.deepEqual(await stack(crossing), ["falling"]);
  await click("falling", 0.5);
  await capture("revealed", ["falling"], ["falling"]);
  await scissors.press("Enter");
  await expect(edges).toHaveCount(0);
}
try {
  for (const upstream of [true, false]) {
    const side = upstream ? "original" : "desktop",
      root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets"),
      css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    selections[side] = {};
    const code = `import {createRoot} from 'react-dom/client';import {ReactFlowProvider,ReactFlow,Position,Handle,useReactFlow} from '@xyflow/react';import {useEffect} from 'react';
      ${upstream ? `import {AnimatedSvgEdge as Edge} from '@/components/canvas/animated-svg-edge';` : `import {CanvasEdge as Edge,RunningEdgeTargets} from '/src/renderer/workspace/canvas-edge';`}
      const state=location.search.slice(1),running=state.includes('run'),selected=state.includes('edge');
      const nodes=['source','target'].map(id=>({id,position:{x:0,y:0},selected:state===id,data:{status:running&&id==='target'?'running':'done'}}));
      const edge={id:'audit',source:'source',target:'target',sourceX:35,sourceY:32,targetX:345,targetY:152,sourcePosition:'right',targetPosition:'left',data:{shape:'sweep',duration:2},selected};
      const content=<svg id="surface" width="380" height="184"><g className={'react-flow__edge'+(selected?' selected':'')}><Edge {...edge}/></g></svg>;
      function CutProbe(){const flow=useReactFlow();useEffect(()=>{const disconnect=e=>flow.deleteElements({edges:[{id:e.detail}]});window.addEventListener('link-studio:disconnect-edge',disconnect);return ()=>window.removeEventListener('link-studio:disconnect-edge',disconnect)},[flow]);return null;}
      function Port(){const port={width:6,height:6,minWidth:0,minHeight:0,border:0,boxSizing:'border-box',top:3,transform:'none'};return <div style={{width:12,height:12}}><Handle style={{...port,left:-3}} type="target" position={Position.Left}/><Handle style={{...port,right:-3}} type="source" position={Position.Right}/></div>}
      const zoom=Number(state)||1,types={port:Port},edges={curve:Edge},cutNodes=nodes.map((node,index)=>({...node,type:'port',position:index?{x:${drag ? 180 : 300}/zoom,y:${drag ? 68 : 100}/zoom}:{x:${drag ? 120 : 0}/zoom,y:0}}));
      const crossed=cutNodes.concat(cutNodes.map(node=>({...node,id:node.id+'-other',position:{...node.position,y:${coincident ? "node.position.y" : "100/zoom-node.position.y"}}})));
      const pair=[{...edge,id:'falling',type:'curve'},{...edge,id:'rising',source:'source-other',target:'target-other',type:'curve'}];
      createRoot(document.querySelector('main')).render(${cut ? `<ReactFlow defaultNodes={${overlap ? "crossed" : "cutNodes"}} defaultEdges={${overlap ? "pair" : "[{...edge,type:'curve'}]"}} nodeTypes={types} edgeTypes={edges} defaultViewport={{x:30,y:30,zoom}} minZoom={.14} maxZoom={2} proOptions={{hideAttribution:true}}><CutProbe/></ReactFlow>` : `<ReactFlowProvider defaultNodes={nodes} defaultEdges={[edge]}>{${upstream ? "content" : `<RunningEdgeTargets.Provider value={new Set(running?['target']:[])}>{content}</RunningEdgeTargets.Provider>`}}</ReactFlowProvider>`});`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "edge-audit",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? code : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"])
        for (const reduced of cut ? [true] : [false, true]) {
          const page = await browser.newPage({
            viewport: { width: 380, height: 184 },
            deviceScaleFactor: retina ? 2 : 1,
            colorScheme: theme,
            reducedMotion: reduced ? "reduce" : "no-preference",
          });
          try {
            await page.route("**/audit.css", (route) =>
              route.fulfill({ path: join(assets, css), contentType: "text/css" }),
            );
            await page.route("**/audit?*", (route) =>
              route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html class="${theme}"><link rel="stylesheet" href="/audit.css"><style>body{margin:0}main{height:184px;width:380px}.react-flow__node-port{opacity:0}</style><div class="${upstream ? "" : "canvas-workspace"}"><main class="${cut ? "" : "react-flow"}"></main></div><script type="module" src="${entry}"></script></html>`,
              }),
            );
            if (overlap) {
              for (const zoom of [0.65, 1, 2]) {
                await page.goto(origin + "audit?" + zoom);
                await overlapPlayback(page, side, theme, zoom);
              }
              continue;
            }
            if (drag) {
              for (const zoom of [0.65, 1, 2]) {
                await page.goto(origin + "audit?" + zoom);
                const path = page.locator(".react-flow__edge-path"),
                  node = page.locator(".react-flow__node[data-id=target]"),
                  box = await node.boundingBox({ timeout: 30000 });
                await expect(path).toBeAttached();
                const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                await page.mouse.move(start.x, start.y);
                await page.mouse.down();
                start.x += 8;
                await page.mouse.move(start.x, start.y, { steps: 8 });
                await expect(path).toHaveClass(/edge-highlighted/);
                const originBox = await node.boundingBox(),
                  initial = await path.getAttribute("d");
                try {
                  for (const [dx, dy] of [
                    [70, 8],
                    [0, -20],
                    [-65, -40],
                    [-125, -50],
                    [-125, -15],
                    [-60, -15],
                    [0, 0],
                  ]) {
                    await page.mouse.move(start.x + dx, start.y + dy, { steps: 4 });
                    await expect
                      .poll(async () => {
                        const current = await node.boundingBox();
                        return Math.hypot(
                          current.x - originBox.x - dx,
                          current.y - originBox.y - dy,
                        );
                      })
                      .toBeLessThan(1.25);
                    const key = `${theme}-${zoom}-${dx}-${dy}`;
                    const trajectory = await path.evaluate((el) => ({
                      path: el.getAttribute("d"),
                      stroke: getComputedStyle(el).stroke,
                      highlight: el.classList.contains("edge-highlighted"),
                    }));
                    assert(trajectory.highlight);
                    geometry[`${side}-${key}`] = trajectory;
                    if (dx || dy) assert.notEqual(trajectory.path, initial);
                    else assert.equal(trajectory.path, initial);
                    if (!upstream) assert.deepEqual(trajectory, geometry[`original-${key}`]);
                    frames.add(key);
                    const bytes = await page.screenshot({
                      path: join(output, `${side}-${key}.png`),
                    });
                    assert(bytes.equals(await page.screenshot()), `${side}-${key} unstable`);
                  }
                } finally {
                  await page.mouse.up();
                }
                await expect(path).toHaveAttribute("d", initial);
              }
              continue;
            }
            if (cut) {
              for (const zoom of [0.14, 1, 2]) {
                await page.goto(origin + "audit?" + zoom);
                const path = page.locator(".react-flow__edge-path"),
                  hit = page.locator(".react-flow__edge-interaction");
                await expect(hit).toBeAttached({ timeout: 30000 });
                const point = await path.evaluate((el) => {
                  const { x, y } = el
                    .getPointAtLength(el.getTotalLength() * 0.31)
                    .matrixTransform(el.getScreenCTM());
                  return { x, y };
                });
                await page.mouse.click(point.x, point.y);
                const button = page.getByRole("button", { name: "断开连接" });
                await expect(button).toBeVisible();
                await page.mouse.move(1, 1);
                const settle = () =>
                  page.evaluate(() =>
                    Promise.all(
                      document
                        .getAnimations()
                        .filter((item) => item.effect?.getTiming().iterations !== Infinity)
                        .map((item) => item.finished.catch(() => {})),
                    ),
                  );
                await settle();
                const box = await button.boundingBox();
                assert(Math.abs(box.width - 36 * Math.max(0.8, Math.min(1.2, zoom ** 0.35))) < 0.1);
                assert(
                  Math.hypot(box.x + box.width / 2 - point.x, box.y + box.height / 2 - point.y) < 2,
                );
                const hits = await button.evaluate((el, zoom) => {
                  const box = el.getBoundingClientRect(),
                    center = { x: box.x + box.width / 2, y: box.y + box.height / 2 },
                    scale = box.width / 36;
                  return [0, 45, 90, 135, 180, 225, 270, 315].flatMap((angle) =>
                    [16, 19, 21, 23, 26].map((radius) => {
                      const radians = (angle * Math.PI) / 180,
                        x = center.x + Math.cos(radians) * radius * scale,
                        y = center.y + Math.sin(radians) * radius * scale;
                      return {
                        zoom,
                        angle,
                        radius,
                        hit: el.contains(document.elementFromPoint(x, y)),
                      };
                    }),
                  );
                }, zoom);
                assert(hits.filter((sample) => sample.radius === 16).every((sample) => sample.hit));
                assert(
                  hits.filter((sample) => sample.radius === 26).every((sample) => !sample.hit),
                );
                hitAreas[`${side}-${theme}-${zoom}`] = hits;
                if (!upstream) assert.deepEqual(hits, hitAreas[`original-${theme}-${zoom}`]);
                if (process.env.STYLES && zoom === 1)
                  console.log(
                    side,
                    theme,
                    await button.evaluate((el) =>
                      Object.fromEntries(
                        [
                          "backgroundColor",
                          "color",
                          "boxShadow",
                          "backdropFilter",
                          "border",
                          "display",
                          "transform",
                          "scale",
                          "outline",
                          "fontSize",
                        ].map((key) => [key, getComputedStyle(el)[key]]),
                      ),
                    ),
                    box,
                  );
                for (const mode of ["idle", "hover", "focus"]) {
                  if (mode === "hover") await button.hover();
                  if (mode === "focus") {
                    await page.mouse.move(1, 1);
                    await page.keyboard.press("Tab");
                    await button.focus();
                    await expect(button).toBeFocused();
                  }
                  await settle();
                  const key = `${theme}-${zoom}-${mode}`;
                  frames.add(key);
                  const bytes = await page.screenshot({ path: join(output, `${side}-${key}.png`) });
                  assert(bytes.equals(await page.screenshot()), key + " unstable");
                }
                await page.keyboard.press("Enter");
                await expect(path).toHaveCount(0);
                await expect(button).toHaveCount(0);
              }
              continue;
            }
            for (const state of ["idle", "source", "target", "edge", "running", "edge-running"]) {
              await page.goto(origin + "audit?" + state);
              const base = page.locator("#audit");
              await expect(base).toBeAttached({ timeout: 30000 });
              const animated = !reduced && state !== "idle",
                duration = state.includes("run") ? 1.1 : 2.6;
              const gradient = page.locator("animateTransform");
              await expect(gradient).toHaveCount(animated ? 1 : 0);
              if (animated) await expect(gradient).toHaveAttribute("dur", `${duration}s`);
              const distinct = new Set();
              for (const phase of animated ? [0, 0.32, 0.5, 0.68] : [0]) {
                await page.locator("#surface").evaluate((svg, seconds) => {
                  svg.pauseAnimations();
                  svg.setCurrentTime(seconds);
                }, phase * duration);
                const key = `${theme}-${reduced ? "reduced" : "motion"}-${state}-${phase}`;
                frames.add(key);
                const bytes = await page.screenshot({ path: join(output, `${side}-${key}.png`) });
                assert(bytes.equals(await page.screenshot()), `${side}-${key} unstable`);
                distinct.add(bytes.toString("base64"));
              }
              if (animated)
                assert.equal(distinct.size, 4, `${side}-${theme}-${state} did not sweep`);
            }
          } finally {
            await page.close();
          }
        }
    } finally {
      await server.close();
    }
  }
  for (const key of frames) {
    const [first, second] = await Promise.all(
      ["original", "desktop"].map((side) => readFile(join(output, `${side}-${key}.png`))),
    );
    let different = 0;
    if (!first.equals(second)) {
      const [original, desktop] = [first, second].map((input) =>
        execFileSync(
          resolve("out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
          [
            "-v",
            "error",
            "-f",
            "png_pipe",
            "-i",
            "pipe:0",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
          ],
          { input, maxBuffer: 4000000 },
        ),
      );
      assert.equal(original.length, desktop.length);
      for (let index = 0; index < original.length; index += 4)
        if (original.readUInt32BE(index) !== desktop.readUInt32BE(index)) different++;
    }
    records[key] = different;
  }
  console.log(records);
  await writeFile(join(output, "results.json"), JSON.stringify(records, null, 2));
  if (overlap) {
    await writeFile(join(output, "selections.json"), JSON.stringify(selections, null, 2));
    assert.deepEqual(selections.desktop, selections.original);
  } else if (drag)
    await writeFile(join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
  else if (cut) await writeFile(join(output, "hit-areas.json"), JSON.stringify(hitAreas, null, 2));
  if (process.argv.includes("--strict"))
    assert(Object.values(records).every((value) => value === 0));
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
