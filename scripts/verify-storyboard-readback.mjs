import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";
import {
  exportVideoCanvas,
  prepareVideoCanvasExchange,
} from "../packages/link-studio-core/src/video-canvas-exchange.ts";
import { verifyDesktopStoryboardPanel } from "./verify-desktop-storyboard-panel.mjs";
import { verifyStoryboardPanel } from "./verify-storyboard-panel.mjs";

const revision = "ccffac4e2f628c2b3a3655cafeffd4b38524ab22";
const upstream = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "../video-canvas",
);
const fixture = JSON.parse(
  readFileSync(
    new URL("../tests/fixtures/upstream-storyboard.canvas.json", import.meta.url),
    "utf8",
  ),
);
const video = fixture.canvas.nodes.find((node) => node.data.kind === "video");
Object.assign(video.data.params, { duration: 8, op: "i2v" });
const [hash, image] = Object.entries(fixture.assets)[0];
const assets = [
  {
    assetId: "11111111-1111-4111-8111-111111111111",
    sha256: hash,
    availability: "ready",
    mediaType: image.kind,
    mimeType: image.mimeType,
    sizeBytes: image.byteSize,
    displayName: image.fileName,
    metadata: { width: image.width, height: image.height },
  },
];
const imported = prepareVideoCanvasExchange(fixture, assets).document;
const exported = exportVideoCanvas(
  { ...imported, viewport: { x: 0, y: 0, zoom: 1 } },
  fixture.canvas.title,
  assets,
);
assert.equal(exported.skippedAssets, 0);
assert.deepEqual(Object.keys(JSON.parse(exported.json).assets), [hash]);

const temp = mkdtempSync(join(tmpdir(), "link-storyboard-readback-"));
try {
  const archive = execFileSync(
    "git",
    ["-C", upstream, "archive", revision, "backend/internal/canvasdoc", "web/src"],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", temp], { input: archive });
  const backend = join(temp, "backend");
  writeFileSync(join(backend, "go.mod"), "module readback\n\ngo 1.22\n");
  writeFileSync(
    join(backend, "main.go"),
    `package main
import ("io"; "os"; "readback/internal/canvasdoc")
func check(err error) { if err != nil { panic(err) } }
func main() {
  raw, err := io.ReadAll(os.Stdin); check(err)
  doc, err := canvasdoc.Parse(raw); check(err); check(doc.Validate(canvasdoc.DefaultLimits()))
  assets := map[string]canvasdoc.RestoredAsset{"${hash}": {ID:"42", URL:"/assets/42"}}
  graph, report, err := canvasdoc.Restore(canvasdoc.RestoreInput{Doc:doc, Assets:assets}); check(err)
  if report.EdgesDropped != 0 || len(report.MissingAssets) != 0 { panic("incomplete restore") }
  _, err = os.Stdout.Write(graph); check(err)
}`,
  );
  const graph = JSON.parse(
    execFileSync("go", ["run", "."], {
      cwd: backend,
      input: exported.json,
      env: { ...process.env, GOWORK: "off", GOPROXY: "off" },
    }),
  );
  const web = join(temp, "web");
  symlinkSync(join(upstream, "web/node_modules"), join(web, "node_modules"), "dir");
  writeFileSync(
    join(web, "readback.ts"),
    'export { deserializeGraph, serializeGraph } from "./src/utils/canvas/canvas-persistence";',
  );
  await build({
    configFile: false,
    root: web,
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    resolve: { alias: { "@": join(web, "src") } },
    build: {
      lib: {
        entry: join(web, "readback.ts"),
        name: "readback",
        formats: ["iife"],
        fileName: () => "readback.js",
      },
    },
  });
  function checkGraph({ nodes, edges }) {
    const shots = nodes.find((node) => node.id === "board").data.storyboard.shots;
    assert.equal(shots[0].videoNodeId, video.id);
    assert.equal(shots[0].imageNodeId, "image");
    assert.deepEqual(nodes.find((node) => node.id === shots[0].videoNodeId).data.params, {
      prompt: "列车进站",
      op: "i2v",
      duration: 8,
    });
    assert.equal(nodes.find((node) => node.id === shots[0].imageNodeId).data.assetId, "42");
    assert.equal(shots[1].image.assetId, "42");
    assert.deepEqual(
      edges.map(({ id, source, target }) => ({ id, source, target })),
      fixture.canvas.edges,
    );
  }
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = "http://localhost/readback";
    await page.route("**/*", (route) =>
      route.request().url() === origin
        ? route.fulfill({ contentType: "text/html", body: "<!doctype html><main></main>" })
        : route.abort(),
    );
    await page.goto(origin);
    await page.addScriptTag({ path: join(web, "dist/readback.js") });
    assert.deepEqual(errors, []);
    const states = await page.evaluate((graph) => {
      const { deserializeGraph, serializeGraph } = window.readback;
      const opened = deserializeGraph(graph);
      const saved = serializeGraph(opened.nodes, opened.edges, opened.viewport);
      return [opened, deserializeGraph(JSON.parse(JSON.stringify(saved)))];
    }, graph);
    for (const state of states) checkGraph(state);
    const desktopPanel = process.argv.includes("--desktop-panel");
    if (desktopPanel || process.argv.includes("--panel")) {
      const baseline = await verifyStoryboardPanel(browser, web, graph);
      if (desktopPanel) {
        const restored = prepareVideoCanvasExchange(JSON.parse(exported.json), assets).document;
        await verifyDesktopStoryboardPanel(browser, temp, restored, assets, baseline);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(
    "固定版导入、前端读档、序列化重开均通过：i2v、8 秒、提示词、镜头关联、素材引用和来源线。",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
