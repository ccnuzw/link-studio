import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = path.resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const temp = await mkdtemp(path.join(tmpdir(), "pet-run-bubble-"));
const entrance = process.argv.includes("--entrance");
const dots = process.argv.includes("--dots");
const output = path.resolve(
  `test-results/pet-run-bubble${entrance ? "-entrance" : ""}${dots ? "-dots" : ""}`,
);
const viewport = { width: 480, height: 160 };
const report = {
  revision,
  viewport,
  deviceScaleFactor: 1,
  background: dots ? "dots" : "none",
  states: [],
};
const captures = new Map();
let browser;
try {
  await mkdir(output, { recursive: true });
  const archive = path.join(temp, "web.tar"),
    pinned = path.join(temp, "web");
  execFileSync("git", ["-C", reference, "archive", "-o", archive, revision, "web"]);
  execFileSync("tar", ["-xf", archive, "-C", temp]);
  await symlink(path.join(reference, "web/node_modules"), path.join(pinned, "node_modules"), "dir");
  execFileSync(path.join(pinned, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: pinned,
  });
  const assets = path.join(pinned, "dist/assets");
  const index = await readFile(path.join(pinned, "dist/index.html"), "utf8");
  const refCss = index.match(/href="[^"]*\/assets\/(index-[^"/]+\.css)"/)[1];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const side of ["reference", "desktop"]) {
    const upstream = side === "reference";
    const root = upstream ? pinned : process.cwd(),
      entry = path.join(root, "run-bubble.jsx"),
      outDir = path.join(temp, side);
    const source = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
      ${upstream ? `import {PetBubble} from '@/pages/canvas/pet/pet-bubble'; import {runEndBubble} from '@/utils/pet/assistant-notice';` : `import {NoticeBubble} from './src/renderer/workspace/pet/notices'; import {runEndBubble} from './src/renderer/workspace/pet/assistant-notice'; import './src/renderer/styles.css'; import './src/renderer/workspace/canvas-workspace.css'; import './src/renderer/workspace/pet/pet.css';`}
      ${
        dots
          ? `import {ReactFlowProvider} from '@xyflow/react';
        import {CanvasBackgroundLayer} from '${upstream ? "@/components/canvas/canvas-background" : "./src/renderer/workspace/canvas-view-preferences"}';
        ${upstream ? "" : `import '@xyflow/react/dist/style.css';`}
        createRoot(document.querySelector('#flow')).render(<ReactFlowProvider><CanvasBackgroundLayer background="dots"/></ReactFlowProvider>);`
          : ""
      }
      ${upstream ? `import {applyTheme} from '@/lib/theme'; applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');` : ""}
      const root=createRoot(document.querySelector('#overlay'));
      const open=()=>window.opens++, dismiss=id=>{window.dismissed=id;root.render(null)};
      window.show=(status,error,paused=true,version=1)=>{window.opens=0;window.dismissed=null;
        const bubble={...${upstream ? `runEndBubble('r1',status,error)` : `runEndBubble({runId:'r1',status,error})`},count:1,version,onClick:open};
        const rect={x:status==='succeeded'?25:385,y:36,width:80,height:88},area={width:480,height:160};
        flushSync(()=>root.render(${upstream ? `<PetBubble bubble={bubble} rect={rect} area={area} paused={paused} onDismiss={dismiss}/>` : `<NoticeBubble bubble={bubble} rect={rect} area={area} pageVisible={!paused} dismiss={dismiss} open={open}/>`}));};`;
    await build({
      root,
      publicDir: false,
      configFile: false,
      logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"' },
      resolve: { alias: { "@": path.join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "bubble-fixture",
          resolveId: (id) => (id === entry ? entry : null),
          load: (id) => (id === entry ? source : null),
        },
      ],
      build: {
        outDir,
        lib: { entry, formats: ["es"], fileName: () => "fixture.js", cssFileName: "fixture" },
      },
    });
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport,
        colorScheme: theme,
        deviceScaleFactor: 1,
        reducedMotion: entrance ? "no-preference" : "reduce",
      });
      try {
        await page.route("http://localhost/**", (route) => {
          const file = path.basename(new URL(route.request().url()).pathname);
          if (file === "fixture.js" || file === "fixture.css")
            return route.fulfill({ path: path.join(outDir, file) });
          if (file === refCss || file.endsWith(".woff2"))
            return route.fulfill({ path: path.join(assets, file) });
          if (file) return route.abort();
          return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html class="${theme}" lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/${upstream ? refCss : "fixture.css"}"><main class="${upstream ? "bg-canvas" : "canvas-workspace"}" style="position:fixed;inset:0">${dots ? '<div class="react-flow" id="flow" style="position:absolute;inset:0"></div>' : ""}<div id="overlay" class="${upstream ? "" : "pet-stage"}"></div></main><script type="module" src="/fixture.js"></script></html>`,
          });
        });
        await page.goto("http://localhost/");
        if (dots) {
          await page.locator("#flow pattern circle").waitFor({ state: "attached" });
          assert.deepEqual(await page.locator("#flow svg").boundingBox(), {
            x: 0,
            y: 0,
            ...viewport,
          });
        }
        for (const [status, error, expected] of [
          ["timeout", "", "卡住了：运行超时"],
          ["failed", "服务暂不可用，请稍后重试。".repeat(4), "卡住了："],
          ["succeeded", "", "好啦，回复写完了"],
        ]) {
          await page.evaluate(
            ([status, error, entrance]) => {
              window.show(status, error);
              const animations = document.querySelector('[role="status"]').getAnimations();
              if (animations.length !== Number(entrance))
                throw Error(`Unexpected entrance animations: ${animations.length}`);
              if (entrance) {
                window.entranceAnimation = animations[0];
                if (window.entranceAnimation.effect.getTiming().duration !== 150)
                  throw Error("Expected 150 ms");
                window.entranceAnimation.pause();
              }
            },
            [status, error, entrance],
          );
          const bubble = page.getByRole("status"),
            button = bubble.getByRole("button").first();
          const text = await button.innerText();
          assert.ok(text.startsWith(expected));
          if (status === "failed") assert.ok(text.endsWith("…"));
          await page.evaluate(() => document.fonts.ready);
          for (const time of entrance ? [0, 37.5, 75, 150] : [null]) {
            if (time !== null)
              await page.evaluate((time) => {
                window.entranceAnimation.currentTime = time;
              }, time);
            const rect = await bubble.boundingBox();
            const key = `${theme}-${status}${entrance ? `-${time}ms` : ""}`;
            const image = await page.screenshot({ path: path.join(output, `${key}-${side}.png`) });
            if (upstream) captures.set(key, { image, text, rect });
            else {
              assert.equal(text, captures.get(key).text);
              const differences = await page.evaluate(
                async (images) => {
                  const pixels = await Promise.all(
                    images.map(async (data) => {
                      const image = new Image();
                      image.src = "data:image/png;base64," + data;
                      await image.decode();
                      const canvas = document.createElement("canvas");
                      canvas.width = image.width;
                      canvas.height = image.height;
                      const context = canvas.getContext("2d");
                      context.drawImage(image, 0, 0);
                      return new Uint32Array(
                        context.getImageData(0, 0, canvas.width, canvas.height).data.buffer,
                      );
                    }),
                  );
                  return pixels[0].reduce(
                    (sum, value, index) => sum + Number(value !== pixels[1][index]),
                    0,
                  );
                },
                [captures.get(key).image, image].map((bytes) => bytes.toString("base64")),
              );
              report.states.push({
                key,
                text,
                referenceRect: captures.get(key).rect,
                desktopRect: rect,
                differences,
              });
              console.log(key, differences);
            }
          }
          if (status === "failed") await page.keyboard.press("Escape");
          else await button.click();
          await bubble.waitFor({ state: "detached" });
          assert.deepEqual(await page.evaluate(() => [window.opens, window.dismissed]), [
            status === "failed" ? 0 : 1,
            "assistant:done:r1",
          ]);
          await page.mouse.move(0, 0);
        }
        if (!entrance && !dots) {
          await page.clock.install();
          await page.clock.pauseAt(new Date(Date.now() + 1000));
          const bubble = page.getByRole("status");
          const show = (paused = false, version = 1) =>
            page.evaluate(
              ([paused, version]) => window.show("succeeded", "", paused, version),
              [paused, version],
            );
          const advance = (ms) => page.clock.fastForward(ms);
          const visible = async () => assert.equal(await bubble.count(), 1);
          const dismissed = async () => {
            await bubble.waitFor({ state: "detached" });
            assert.equal(await page.evaluate(() => window.dismissed), "assistant:done:r1");
          };
          await show();
          await advance(2500);
          await show();
          await advance(1499);
          await visible();
          await advance(1);
          await dismissed();
          await show();
          await advance(3000);
          await show(false, 2);
          await advance(3999);
          await visible();
          await advance(1);
          await dismissed();
          await show();
          await advance(3000);
          await show(true);
          await advance(8000);
          await visible();
          await show();
          await advance(3999);
          await visible();
          await advance(1);
          await dismissed();
          await show();
          await advance(3000);
          await bubble.hover();
          await advance(8000);
          await visible();
          await page.mouse.move(0, 0);
          await advance(3999);
          await visible();
          await advance(1);
          await dismissed();
          report.timers ??= [];
          report.timers.push({
            side,
            theme,
            passed: ["rerender", "version-change", "background", "hover"],
          });
        }
      } finally {
        await page.close();
      }
    }
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  assert.ok(report.states.every((state) => state.differences === 0));
} finally {
  await browser?.close();
  await rm(temp, { recursive: true, force: true });
}
