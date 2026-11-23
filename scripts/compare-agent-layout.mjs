import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const workspace = process.cwd();
const reference = path.resolve(process.env.AGENT_REFERENCE_WEB ?? "../video-canvas/web");
const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const temp = await mkdtemp(path.join(tmpdir(), "link-layout-"));
const output = path.join(workspace, "test-results/agent-layout-parity");
const scenarios = [
  { name: "hidden" },
  { name: "hidden-moved", offset: { x: -130, y: -10 } },
  { name: "hidden-outside", offset: { x: -1000, y: -1000 } },
  { name: "pet-tl", pet: { x: 90, y: 140 } },
  { name: "pet-br", pet: { x: 1188, y: 601 } },
  { name: "pet-center", pet: { x: 600, y: 307 } },
  { name: "dock", docked: true },
  { name: "narrow-float", docked: true, width: 880 },
  { name: "sheet", docked: true, width: 700 },
].map((sample) => ({ width: 1280, height: 700, ...sample }));
const report = { revision, scope: "面板边界矩形，不比较内容像素", samples: {}, mismatches: [] };
const browser = await chromium.launch({ channel: "chrome" });
try {
  await mkdir(output, { recursive: true });
  execFileSync("git", [
    "-C",
    path.dirname(reference),
    "archive",
    "-o",
    path.join(temp, "web.tar"),
    revision,
    "web",
  ]);
  execFileSync("tar", ["-xf", path.join(temp, "web.tar"), "-C", temp]);
  const pinned = path.join(temp, "web");
  await symlink(path.join(reference, "node_modules"), path.join(pinned, "node_modules"), "dir");
  execFileSync(path.join(pinned, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: pinned,
  });
  for (const upstream of [true, false]) {
    const side = upstream ? "reference" : "desktop";
    const root = upstream ? pinned : workspace;
    const assets = path.join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const styles = (await readdir(assets)).filter((file) => /^index-.*\.css$/.test(file));
    if (styles.length !== 1) throw Error(`找不到唯一的 ${side} 样式表`);
    const component = upstream
      ? `
      import {AgentPanel} from './src/pages/canvas/agent/agent-panel';
      import {useAgentSettings} from './src/store/agent-settings';
      import {usePetStore} from './src/store/pet';
      import {TooltipProvider} from './src/components/ui/tooltip';
      import {ReactFlowProvider} from '@xyflow/react';
      usePetStore.setState({active:!!pet,placement:pet && {rect:pet,area:stage}});
      useAgentSettings.setState({docked:!!sample.docked,dockWidth:416,offset:{dx:offset.x,dy:offset.y}});
      const content=<TooltipProvider><ReactFlowProvider><AgentPanel ctl={{sessions:[],timeline:[],context:{tokens:0,window:0}}} models={[]} selection={[]} nodes={[]} refNodes={[]}/></ReactFlowProvider></TooltipProvider>;`
      : `import {AssistantFrame} from './src/renderer/workspace/assistant-frame';import {defaultAgentLayout} from '@link-studio/core';
      let layout={...defaultAgentLayout,mode:pet?'quiet':'hidden',docked:!!sample.docked,width:416,offset};
      window.desktop={settings:{agentLayout:async patch=>({ok:true,value:layout={...layout,...patch}})}};
      const content=<AssistantFrame visible bounds={{pet,stage}} close={()=>{}}>{()=>null}</AssistantFrame>;`;
    const entry = path.join(root, "layout-parity.jsx");
    const fixture = `import {createRoot} from 'react-dom/client'; const sample=window.sample;
      const stage={x:0,y:0,width:innerWidth,height:innerHeight}, offset=sample.offset??{x:0,y:0};
      const pet=sample.pet && {...sample.pet,width:80,height:87}; ${component}
      createRoot(document.querySelector('main')).render(content);`;
    const bundle = path.join(temp, side);
    await build({
      root,
      configFile: false,
      logLevel: "error",
      publicDir: false,
      define: { "process.env.NODE_ENV": '"production"' },
      resolve: { alias: { "@": path.join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "layout-fixture",
          resolveId(id) {
            if (id === entry) return entry;
          },
          load(id) {
            if (id === entry) return fixture;
          },
        },
      ],
      build: { outDir: bundle, lib: { entry, formats: ["es"], fileName: () => "fixture.js" } },
    });
    const page = await browser.newPage({ deviceScaleFactor: 1, reducedMotion: "reduce" });
    try {
      page.on("pageerror", (error) => console.error(side, error));
      await page.route("http://layout.test/**", async (route) => {
        const file = new URL(route.request().url()).pathname.slice(1);
        if (file === "fixture.js")
          return route.fulfill({ path: path.join(bundle, file), contentType: "text/javascript" });
        if (file === "index.css")
          return route.fulfill({ path: path.join(assets, styles[0]), contentType: "text/css" });
        if (file.endsWith(".woff2"))
          return route.fulfill({
            path: path.join(assets, path.basename(file)),
            contentType: "font/woff2",
          });
        const sample = scenarios.find((item) => item.name === file);
        if (!sample) return route.abort();
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/index.css><style>main{position:fixed;inset:0;display:flex;justify-content:flex-end}</style><main></main><script>window.sample=${JSON.stringify(sample)}</script><script type=module src=/fixture.js></script>`,
        });
      });
      for (const sample of scenarios) {
        await page.setViewportSize({ width: sample.width, height: sample.height });
        await page.goto(`http://layout.test/${sample.name}`);
        const frame = page.locator(upstream ? '[role="dialog"]' : ".assistant-frame").first();
        await frame.waitFor({ timeout: 5000 });
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          ),
        );
        const rect = await frame.boundingBox();
        report.samples[sample.name] ??= {};
        report.samples[sample.name][side] = rect;
        if (
          !upstream &&
          JSON.stringify(rect) !== JSON.stringify(report.samples[sample.name].reference)
        )
          report.mismatches.push(sample.name);
      }
    } finally {
      await page.close();
    }
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.mismatches.length) process.exitCode = 1;
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
