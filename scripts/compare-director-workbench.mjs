import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { auditDirectorChrome } from "./audit-director-chrome.mjs";
import { auditDirectorSidebar } from "./audit-director-sidebar.mjs";
import { auditDenseDirectorKeys, auditDirectorTimeline } from "./audit-director-timeline.mjs";
import { auditDirectorViewMenu } from "./audit-director-view-menu.mjs";

assert(process.env.VIDEO_CANVAS_WEB);
const dpr = Number(process.env.DIRECTOR_DPR ?? 1);
const denseKeys = process.argv.includes("--dense-keys");
const output = resolve(
    `test-results/director-workbench-${denseKeys ? "dense-keys" : "parity"}` +
      (dpr === 1 ? "" : `-dpr${dpr}`),
  ),
  scratch = await mkdtemp(join(tmpdir(), "director-layout-"));
const fixture = {
  version: 1,
  duration: 5,
  activeCameraId: "cam",
  characters: [
    {
      id: "actor",
      name: "角色A",
      model: "male",
      pose: "stand",
      color: "#d4d4d8",
      scale: 1,
      x: 0,
      z: 0,
      yaw: 180,
      keys: [],
    },
  ],
  props: [],
  cameras: [
    {
      id: "cam",
      name: "机位1",
      x: 0,
      y: 1.6,
      z: 4,
      yaw: 0,
      pitch: -4.2891533,
      fov: 50,
      aspect: "16:9",
      keys: [],
    },
  ],
};
if (denseKeys) {
  const poses = [0.01, 0.02, 2.5].map((t, index) => ({
    t,
    x: index + 1,
    z: 0,
    yaw: 0,
    ease: index ? "smooth" : "linear",
  }));
  fixture.characters[0].keys = poses;
  fixture.cameras[0].keys = poses.map((pose) => ({ ...pose, y: 1.6, pitch: -4, fov: 50 }));
  fixture.cameras[0].keys[2].t = 2.501;
  fixture.cameras[0].keys.push({ ...fixture.cameras[0].keys[2], t: 2.503, x: 4 });
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" }),
  records = {},
  images = {},
  thumbs = {},
  phases = [
    "floating",
    "split",
    "split-nudge",
    "camera",
    "compact",
    "props",
    "assets-drag",
    "assets-collapsed",
  ];
const timeline = {},
  sidebar = {},
  chrome = {},
  view = {};
try {
  await compareWorkbench();
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
async function compareWorkbench() {
  for (const upstream of [true, false]) {
    const side = upstream ? "upstream" : "desktop",
      root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd(),
      assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    const entry = "/src/__audit_workbench.tsx";
    const code = `import {createRoot} from 'react-dom/client';const scene=${JSON.stringify(fixture)};const noop=()=>{};let saved=scene;${upstream ? `import {ReactFlowProvider} from '@xyflow/react';import Editor from '@/components/director/director-editor';import {useDirectorStore} from '@/store/director';useDirectorStore.getState().open('example',scene);window.auditScene=()=>useDirectorStore.getState().scene;createRoot(document.querySelector('#root')).render(<ReactFlowProvider><Editor/></ReactFlowProvider>);` : `import {DirectorDialog} from '/src/renderer/workspace/director-dialog';window.auditScene=()=>saved;createRoot(document.querySelector('#root')).render(<DirectorDialog initial={scene} label="导演台" projectHandle="local" place={noop} checkCapacity={noop} write={next=>{saved=next}} finish={noop}/>);`}`;
    const mocks = upstream
      ? {
          "@/api/asset":
            'export const uploadAsset=()=>{throw Error("This workbench audit does not upload assets")}',
          "./director-export-dialog": "export const DirectorExportDialog=()=>null",
        }
      : {};
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(scratch, side),
      resolve: { alias: { "@": join(root, "src") } },
      assetsInclude: ["**/*.glb"],
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "audit-workbench",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return id;
            if (id in mocks) return "\0" + id;
          },
          load(id) {
            return id === entry ? code : mocks[id.slice(1)];
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: dpr,
        colorScheme: "dark",
      });
      try {
        page.on("pageerror", (e) => console.error(side, e));
        await page.route(origin + "assets/**", (route) =>
          route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
        );
        await page.route(origin + "audit", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><div id="root" class="${upstream ? "" : "canvas-workspace"}"></div><script type="module" src="${entry}"></script></html>`,
          }),
        );
        await page.goto(origin + "audit");
        await page.getByTitle("切换视角").waitFor();
        if (denseKeys) {
          records[side] = await auditDenseDirectorKeys(page, async (name, lanes) => {
            const key = `${side}-${name}`;
            const styles = await lanes.evaluate((el) =>
              [el.firstElementChild, ...el.querySelectorAll('[title*="右键切换"]')].map((node) => {
                const style = getComputedStyle(node);
                return {
                  title: node.title,
                  left: node.style.left,
                  box: node.getBoundingClientRect().toJSON(),
                  color: style.color,
                  background: style.backgroundColor,
                  border: style.borderBottomColor,
                  font: style.font,
                };
              }),
            );
            await writeFile(join(output, key + ".json"), JSON.stringify(styles, null, 2));
            images[key] = await lanes.screenshot({ path: join(output, key + ".png") });
          });
          continue;
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1200);
        const main = page.getByRole("dialog").locator("main"),
          monitor = main.getByRole("button", { name: "机位1", exact: true }).locator("../..");
        const assetsPanel = page.getByRole("complementary", { name: "资产", exact: true });
        thumbs[side] = {};
        async function collectThumbs(expected) {
          await assetsPanel
            .locator("img")
            .nth(expected - 1)
            .waitFor();
          for (const img of await assetsPanel.locator("img").all()) {
            const title = await img.locator("xpath=ancestor::button").getAttribute("title");
            const url = await img.getAttribute("src");
            thumbs[side][title] = createHash("sha256")
              .update(Buffer.from(url.split(",")[1], "base64"))
              .digest("hex");
          }
        }
        await collectThumbs(2);
        async function assetLayout(phase) {
          const items = [
            assetsPanel,
            assetsPanel.getByRole("tablist"),
            assetsPanel.getByPlaceholder("搜索素材").locator(".."),
            assetsPanel.getByRole("button", { name: "全部", exact: true }),
            assetsPanel.locator("section").first(),
            assetsPanel.locator("section button").first(),
            assetsPanel.locator("img").first(),
            assetsPanel.locator("section button").first().getByText("预设"),
          ];
          records[side + "-asset-" + phase] = await Promise.all(
            items.map((item) => item.boundingBox()),
          );
        }
        await assetLayout("people");
        async function capture(name) {
          await page.mouse.move(4, 4);
          await page.evaluate(() => document.activeElement?.blur?.());
          await page.waitForTimeout(150);
          const key = side + "-" + name;
          const boxes = await Promise.all(
            [
              page.getByRole("dialog").locator("header").first(),
              page.getByRole("navigation", { name: "工具" }),
              main,
              main.locator("canvas").first(),
              monitor,
              monitor.locator("canvas"),
              page.getByTitle("切换视角"),
              page.getByRole("separator", { name: "时间轴高度" }),
            ].map((loc) => loc.boundingBox()),
          );
          records[key] = boxes;
          images[key] = await page.screenshot({ path: join(output, key + ".png") });
        }
        await capture("floating");
        await main.getByRole("button", { name: "左右分栏" }).click();
        await capture("split");
        await page.getByRole("separator", { name: "机位画面宽度" }).press("ArrowLeft");
        await capture("split-nudge");
        await page.getByTitle("切换视角").click();
        await page.getByRole("menuitemradio", { name: "机位1" }).press("Enter");
        await capture("camera");
        await page.setViewportSize({ width: 1024, height: 700 });
        await capture("compact");
        view[side] = await auditDirectorViewMenu(page, side, output);
        assert.match(await page.getByTitle("切换视角").innerText(), /机位视角/);
        await page.setViewportSize({ width: 1280, height: 800 });
        await assetsPanel.getByRole("tab", { name: "物体" }).click();
        await collectThumbs(14);
        await capture("props");
        const divider = page.getByRole("separator", { name: "资产面板宽度" }),
          bounds = await divider.boundingBox();
        await page.mouse.move(bounds.x + 4, bounds.y + 100);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 36, bounds.y + 100, { steps: 4 });
        await page.mouse.up();
        assert.equal((await assetsPanel.boundingBox()).width, 304);
        await capture("assets-drag");
        await divider.dblclick();
        assert.equal((await assetsPanel.boundingBox()).width, 272);
        await assetsPanel.getByRole("button", { name: "折叠资产面板" }).click();
        await capture("assets-collapsed");
        timeline[side] = await auditDirectorTimeline(page, side, output);
        sidebar[side] = await auditDirectorSidebar(page, side, output);
        chrome[side] = await auditDirectorChrome(page, side, output);
      } finally {
        await page.close();
      }
    } finally {
      await server.close();
    }
  }
  if (denseKeys) {
    await writeFile(join(output, "results.json"), JSON.stringify(records, null, 2));
    assert.deepEqual(records.desktop, records.upstream);
    console.log("Matched dense-key states:", Object.keys(records.desktop).join(", "));
    const page = await browser.newPage();
    const pixels = {};
    for (const phase of Object.keys(records.desktop))
      pixels[phase] = await countPixels(page, phase);
    await writeFile(join(output, "pixels.json"), JSON.stringify(pixels, null, 2));
    console.table(pixels);
    if (process.argv.includes("--strict"))
      assert.ok(Object.values(pixels).every((count) => count === 0));
    return;
  }
  const page = await browser.newPage(),
    results = {};
  for (const name of Object.keys(timeline.upstream.images)) {
    const phase = "timeline-" + name;
    phases.push(phase);
    for (const side of ["upstream", "desktop"]) {
      images[side + "-" + phase] = timeline[side].images[name];
      records[side + "-" + phase] = timeline[side].rectangles[name];
    }
  }
  await writeFile(
    join(output, "timeline.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(timeline).map(([side, { states, rectangles }]) => [
          side,
          { states, rectangles },
        ]),
      ),
      null,
      2,
    ),
  );
  assert.deepEqual(timeline.desktop.states, timeline.upstream.states);
  await writeFile(
    join(output, "view.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(view).map(([side, { states, rectangles }]) => [
          side,
          { states, rectangles },
        ]),
      ),
      null,
      2,
    ),
  );
  assert.deepEqual(view.desktop.states, view.upstream.states);
  for (const name of Object.keys(view.upstream.images)) {
    const phase = "view-" + name;
    phases.push(phase);
    for (const side of ["upstream", "desktop"]) {
      images[side + "-" + phase] = view[side].images[name];
      records[side + "-" + phase] = view[side].rectangles[name];
    }
  }
  await writeFile(
    join(output, "sidebar.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(sidebar).map(([side, { states, rectangles }]) => [
          side,
          { states, rectangles },
        ]),
      ),
      null,
      2,
    ),
  );
  assert.deepEqual(sidebar.desktop.states, sidebar.upstream.states);
  for (const name of Object.keys(sidebar.upstream.images)) {
    const phase = "sidebar-" + name;
    phases.push(phase);
    for (const side of ["upstream", "desktop"]) {
      images[side + "-" + phase] = sidebar[side].images[name];
      records[side + "-" + phase] = sidebar[side].rectangles[name];
    }
  }
  await writeFile(
    join(output, "chrome.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(chrome).map(([side, { states, rectangles }]) => [
          side,
          { states, rectangles },
        ]),
      ),
      null,
      2,
    ),
  );
  assert.deepEqual(chrome.desktop.states, chrome.upstream.states);
  for (const name of Object.keys(chrome.upstream.images)) {
    const phase = "chrome-" + name;
    phases.push(phase);
    for (const side of ["upstream", "desktop"]) {
      images[side + "-" + phase] = chrome[side].images[name];
      records[side + "-" + phase] = chrome[side].rectangles[name];
    }
  }
  for (const phase of phases) {
    const left = records["upstream-" + phase],
      right = records["desktop-" + phase];
    const pixelDiff = await countPixels(page, phase);
    results[phase] = {
      differentPixels: pixelDiff,
      rectanglesMatched: left.filter((box, i) => JSON.stringify(box) === JSON.stringify(right[i]))
        .length,
    };
  }
  function countPixels(page, phase) {
    const pair = ["upstream", "desktop"].map((side) => images[side + "-" + phase]);
    assert.ok(
      pair[0].subarray(16, 24).equals(pair[1].subarray(16, 24)),
      `Screenshot dimensions differ: ${phase}`,
    );
    return page.evaluate(
      async (pair) => {
        const imgs = await Promise.all(
          pair.map(async (data) => {
            const img = new Image();
            img.src = "data:image/png;base64," + data;
            await img.decode();
            const cv = document.createElement("canvas");
            cv.width = img.width;
            cv.height = img.height;
            const ctx = cv.getContext("2d");
            ctx.drawImage(img, 0, 0);
            return new Uint32Array(ctx.getImageData(0, 0, cv.width, cv.height).data.buffer);
          }),
        );
        return imgs[0].reduce((n, v, i) => n + Number(v !== imgs[1][i]), 0);
      },
      pair.map((image) => image.toString("base64")),
    );
  }
  for (const phase of phases.filter(
    (phase) =>
      phase.startsWith("view-") ||
      phase === "chrome-no-camera-menu" ||
      phase === "chrome-long-camera-menu",
  ))
    assert.equal(results[phase].differentPixels, 0, phase);
  console.table(results);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ records, results, thumbs }, null, 2),
  );
  assert.equal(Object.keys(thumbs.upstream).length, 16);
  assert.deepEqual(thumbs.desktop, thumbs.upstream);
  if (process.argv.includes("--strict") || process.argv.includes("--strict-geometry")) {
    assert.deepEqual(records["desktop-asset-people"], records["upstream-asset-people"]);
    for (const [phase, record] of Object.entries(results)) {
      assert.equal(record.rectanglesMatched, records["upstream-" + phase].length, phase);
      if (process.argv.includes("--strict")) assert.equal(record.differentPixels, 0);
    }
  }
}
