import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { annotateWithComposition } from "../tests/e2e/doodle-composition.ts";

assert(process.env.VIDEO_CANVAS_WEB);
const root = resolve(process.env.VIDEO_CANVAS_WEB),
  assets = join(root, "dist/assets");
const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
assert(css);
const composition = process.argv.includes("--composition");
const output = resolve(
  composition ? "test-results/doodle-composition" : "test-results/doodle-lifecycle",
);
const desktop =
  composition || process.argv.includes("--compare-output")
    ? JSON.parse(await readFile(join(output, "desktop-geometry.json"), "utf8"))
    : null;
const position = desktop ? { x: desktop.rect.x, y: desktop.rect.y } : { x: 350, y: 220 };
const zoom = desktop?.zoom ?? 1;
const scratch = await mkdtemp(join(tmpdir(), "annotation-ref-"));
const entry = "/src/__annotation_replay.tsx";
const fixture = `import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {ReactFlowProvider} from '@xyflow/react';import {TooltipProvider} from '@/components/ui/tooltip';import {Flow} from '@/pages/canvas/flow';
const graph={nodes:[{id:'source',type:'canvas',position:{x:0,y:0},data:{kind:'image',label:'底图',status:'done',mediaType:'image',mediaAspect:${composition ? 2 : 1},uploaded:true,assetId:'12',src:'/input.png',fileName:'底图.png'}}],edges:[],viewport:{...${JSON.stringify(position)},zoom:${zoom}}};
const canvas={id:'1001',version:1,title:'标注回放',description:null,graph,createdAt:'2026-11-20T12:00:00Z',updatedAt:'2026-11-20T12:00:00Z'};
createRoot(document.querySelector('main')).render(<MemoryRouter initialEntries={['/canvas/1001']}><TooltipProvider><ReactFlowProvider><Flow canvas={canvas} recovery={null} onConflict={()=>{}}/></ReactFlowProvider></TooltipProvider></MemoryRouter>);`;
const server = await createServer({
  root,
  configFile: false,
  cacheDir: scratch,
  define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/api/v1") },
  resolve: { alias: { "@": join(root, "src") } },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "annotation-replay",
      resolveId: (id) => (id === entry ? join(root, entry) : undefined),
      load: (id) => (id === join(root, entry) ? fixture : undefined),
    },
  ],
});
const browser = await chromium.launch({ channel: "chrome" });
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  const page = await browser.newPage({
    viewport: { width: 1440, height: 888 },
    deviceScaleFactor: desktop?.dpr ?? 1,
    colorScheme: "light",
  });
  page.on("pageerror", (error) => console.error(error.message));
  await page.route(origin + "assets/**", (route) =>
    route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
  );
  await page.route(origin + "input.png", (route) =>
    route.fulfill({
      path: composition ? join(output, "input.png") : resolve("resources/icons/icon-32.png"),
    }),
  );
  await page.route(origin + "api/**", (route) =>
    route.fulfill({ json: { code: 0, msg: "ok", data: [] } }),
  );
  let uploads = 0;
  let originalPng;
  await page.route(origin + "derived.png", (route) =>
    route.fulfill({ contentType: "image/png", body: originalPng }),
  );
  await page.route("**/api/v1/assets", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploads++;
    const request = route.request();
    const form = await new Response(request.postDataBuffer(), {
      headers: { "content-type": request.headers()["content-type"] },
    }).formData();
    const file = form.get("file");
    assert.equal(file.name, "doodle.png");
    const png = Buffer.from(await file.arrayBuffer());
    if (originalPng) assert(originalPng.equals(png));
    else originalPng = png;
    if (!composition && uploads === 1)
      return route.fulfill({ status: 503, json: { code: 503, msg: "回放故障" } });
    return route.fulfill({
      json: {
        code: 0,
        msg: "ok",
        data: {
          id: 101,
          url: "/derived.png",
          kind: "image",
          file_name: "doodle.png",
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
          mime_type: "image/png",
          byte_size: png.length,
        },
      },
    });
  });
  await page.route(origin + "audit", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="zh-CN"><meta charset=utf-8><link rel="stylesheet" href="/assets/${css}"><main></main><script type="module" src="${entry}"></script>`,
    }),
  );
  await page.goto(origin + "audit");
  const source = page.getByTestId("rf__node-source"),
    toolbar = page.getByRole("toolbar", { name: "图片标注工具栏" }),
    save = toolbar.getByRole("button", { name: "保存", exact: true });
  const cards = page.locator(".react-flow__node"),
    edges = page.locator(".react-flow__edge");
  let drawingRect;
  const start = async () => {
    await source.click();
    await page.getByRole("button", { name: "图片编辑", exact: true }).click();
    await expect(save).toBeEnabled();
    await toolbar.getByRole("button", { name: "框选" }).click();
    const rect = await page.locator("canvas.upper-canvas").boundingBox();
    assert(rect);
    if (desktop)
      for (const field of ["x", "y", "width", "height"])
        assert(Math.abs(rect[field] - desktop.rect[field]) < 0.01, field);
    drawingRect = rect;
    await page.mouse.move(rect.x + 26, rect.y + 26);
    await page.mouse.down();
    await page.mouse.move(rect.x + 82, rect.y + 88, { steps: 8 });
    await page.mouse.up();
    await page.evaluate(() => {
      const prototype = HTMLCanvasElement.prototype,
        original = prototype.toBlob;
      prototype.toBlob = function (callback, ...args) {
        prototype.toBlob = original;
        window.releaseDoodle = (fail) =>
          fail ? callback(null) : original.call(this, callback, ...args);
      };
    });
    await save.click();
    await expect(toolbar).toBeHidden();
    await expect(cards).toHaveCount(2);
    await expect(edges).toHaveCount(1);
    await expect(source).toHaveClass(/selected/);
    const pending = cards.filter({ hasText: "底图 标注" });
    await expect(pending).toContainText("0%");
    await page.waitForFunction(() => typeof window.releaseDoodle === "function");
    return pending;
  };
  const release = (fail) =>
    page.evaluate((fail) => {
      window.releaseDoodle(fail);
      delete window.releaseDoodle;
    }, fail);
  let report;
  if (composition) {
    await source.click();
    await page.getByRole("button", { name: "图片编辑", exact: true }).click();
    const sample = await annotateWithComposition(page);
    await expect
      .poll(() =>
        page
          .locator('img[src$="/derived.png"]')
          .first()
          .evaluate((img) => img.naturalWidth),
      )
      .toBe(4096);
    assert.equal(uploads, 1);
    await expect(edges).toHaveCount(1);
    for (const field of ["x", "y", "width", "height"])
      assert(Math.abs(sample.rect[field] - desktop.rect[field]) < 0.01, field);
    assert.deepEqual(sample.events, desktop.events);
    assert.deepEqual(sample.afterEscape, desktop.afterEscape);
    report = { ...sample, uploads };
  } else {
    await start();
    await release(true);
    await expect(cards).toHaveCount(1);
    await expect(edges).toHaveCount(0);
    assert.equal(uploads, 0);
    const pending = await start();
    const deleted = await pending.getAttribute("data-id");
    await pending.click();
    await page.keyboard.press("Backspace");
    await expect(cards).toHaveCount(1);
    await release(false);
    await page.keyboard.press("ControlOrMeta+z");
    const shell = page.getByTestId("rf__node-" + deleted);
    await expect(shell).toContainText("上传已中断，请删除后重新上传");
    await expect(shell.getByRole("button", { name: "重试" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(shell).toHaveCount(0);
    assert.equal(uploads, 0);
    const retry = await start();
    const retryId = await retry.getAttribute("data-id");
    await release(false);
    await expect(retry).toContainText("上传失败，请重试");
    await retry.getByRole("button", { name: "重试" }).click();
    await expect(
      page
        .getByTestId("rf__node-" + retryId)
        .locator("img")
        .first(),
    ).toBeVisible();
    await expect(edges).toHaveCount(1);
    assert.equal(uploads, 2);
    report = {
      geometry: { rect: drawingRect, dpr: await page.evaluate(() => devicePixelRatio) },
      encodeFailure: { nodes: 1, edges: 0, uploads: 0 },
      deletedWhileEncoding: { undo: "上传已中断，请删除后重新上传", retry: false, uploads: 0 },
      retried: { id: retryId, nodes: await cards.count(), edges: await edges.count(), uploads },
    };
  }
  await writeFile(join(output, "reference-result.png"), originalPng);
  if (desktop) {
    const driver = createRequire(import.meta.resolve("@playwright/test"));
    const { PNG } = createRequire(driver.resolve("playwright"))("playwright-core/lib/utilsBundle");
    const [before, after] = [originalPng, await readFile(join(output, "desktop-result.png"))].map(
      (bytes) => PNG.sync.read(bytes),
    );
    assert.equal(before.width, after.width);
    assert.equal(before.height, after.height);
    let different = 0;
    for (let index = 0; index < before.data.length; index += 4)
      if (before.data.readUInt32BE(index) !== after.data.readUInt32BE(index)) different++;
    report.output = { width: before.width, height: before.height, different };
    if (composition) {
      const redIn = (left, top, right, bottom) => {
        let pixels = 0;
        for (let row = top; row < bottom; row++)
          for (let col = left; col < right; col++)
            if (before.data.readUInt32BE((row * before.width + col) * 4) === 0xef4444ff) pixels++;
        assert(pixels > 500, `没有检测到笔迹: ${left},${top}`);
        return pixels;
      };
      report.output.redPixels = {
        firstLine: redIn(220, 250, 510, 410),
        secondLine: redIn(220, 420, 510, 575),
        stroke: redIn(1460, 900, 2030, 1300),
      };
      for (const [col, row, rgba] of [
        [10, 10, 0x233852ff],
        [4000, 10, 0x92aeb9ff],
        [4000, 2000, 0],
      ])
        assert.equal(before.data.readUInt32BE((row * before.width + col) * 4), rgba);
    }
  }
  await writeFile(join(output, "reference.json"), JSON.stringify(report, null, 2));
  console.log(report);
  if (desktop) assert.equal(report.output.different, 0, "同位置、同 DPR 的标注 PNG 不一致");
} finally {
  await browser.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
