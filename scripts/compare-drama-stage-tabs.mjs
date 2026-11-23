import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build, parseSync, transformWithOxc } from "vite";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = path.resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const temp = await mkdtemp(path.join(tmpdir(), "stage-tabs-"));
const views = process.argv.includes("--asset-views");
const overview = process.argv.includes("--overview-next");
const pill = process.argv.includes("--script-next");
const storyboard = process.argv.includes("--storyboard");
const gate = storyboard || process.argv.includes("--studio-gate");
const output = path.resolve(
  "test-results",
  storyboard
    ? "drama-storyboard-parity"
    : gate
      ? "drama-studio-gate-parity"
      : pill
        ? "drama-script-next-parity"
        : overview
          ? "drama-overview-next-parity"
          : views
            ? "drama-asset-views-parity"
            : "drama-stage-tabs-parity",
);
const labels = views ? ["列表", "画布"] : ["总览", "剧本", "资产管理", "片场", "成片"];
const report = {
  revision,
  scope: views
    ? "资产管理视图切换组及外缘 16px，DPR 1"
    : "仅制作工序标签组及外缘 16px；剧本待办、片场运行中，减少动态效果，DPR 1",
  states: {},
};
const images = new Map();
if (gate)
  report.scope =
    "片场前置引导内容区，不含片场批量工具栏。空、缺稿、可拆、本集拆解、另集拆解、键盘焦点和悬停。";
if (storyboard)
  report.scope =
    "已锁集的片场内容区：待估价、报价、失败重试、同集合成占用、排队、运行、无任务详情。";
if (pill)
  report.scope = "剧本页底部下一步，含整段底部 208px 和投影；报价、超过 200 集、禁用、拆解及隐藏。";
if (overview)
  report.scope =
    "总览「下一步」完整卡片。1024 宽取 340px 侧栏，390 宽取 358px，含长集号截断、运行禁用、悬停和键盘焦点；不含总览外壳。";
const browser = await chromium.launch({ channel: "chrome" });
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
  for (const side of ["reference", "desktop"]) {
    const upstream = side === "reference",
      root = upstream ? pinned : process.cwd(),
      entry = path.join(root, "stage-fixture.jsx"),
      outDir = path.join(temp, side);
    const module = upstream
      ? "./src/pages/drama/workspace/stage-tabs"
      : "./src/renderer/workspace/drama-stage-tabs";
    let fixture = `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {MotionConfig} from 'motion/react';import {${upstream ? "StageTabs" : "DramaStageTabs"} as Tabs} from '${module}';function Fixture(){const [stage,go]=useState('overview');return <Tabs stage={stage} hints={{script:'todo',studio:'run'}} ${upstream ? "onChange" : "go"}={go}/>;}createRoot(document.querySelector('header')).render(<MotionConfig reducedMotion="user"><Fixture/></MotionConfig>);`;
    if (views) {
      const source = path.join(
        root,
        upstream
          ? "src/pages/drama/workspace/assets-area.tsx"
          : "src/renderer/workspace/drama-asset-browser.tsx",
      );
      const text = await readFile(source, "utf8"),
        name = upstream ? "ViewToggle" : "DramaAssetViewToggle";
      const toggle = parseSync(source, text).program.body.find(
        (statement) =>
          statement.type === "ExportNamedDeclaration" && statement.declaration?.id?.name === name,
      );
      assert.ok(toggle);
      fixture = `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {Frame,LayoutGrid} from 'lucide-react';${upstream ? "import {cn} from '@/lib/utils';" : ""}${text.slice(toggle.start, toggle.end)}function Fixture(){const [view,change]=useState('list');return <${name} view={view} ${upstream ? "onChange" : "change"}={change}/>;}createRoot(document.querySelector('header')).render(<Fixture/>);`;
      fixture = (
        await transformWithOxc(fixture, "view-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (overview) {
      const file = path.join(pinned, "src/pages/drama/workspace/overview-area.tsx"),
        text = await readFile(file, "utf8");
      const item = parseSync(file, text).program.body.find(
        (node) => node.type === "FunctionDeclaration" && node.id.name === "NextItem",
      );
      assert.ok(item);
      const section = text.match(
        /<section className="bg-card border-border rounded-2xl border pb-2">[\s\S]*?<\/section>/,
      )?.[0];
      assert.ok(section);
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${upstream ? `import {Button} from '@/components/ui/button';import {ArrowRight,ScanSearch,Clapperboard,ScrollText} from 'lucide-react';import {nextStep} from '@/utils/drama/episodes';import {cn} from '@/lib/utils';${text.slice(item.start, item.end)}` : `import {DramaOverviewNext} from './src/renderer/workspace/drama-overview-next';`}
      const root=createRoot(document.querySelector('#next'));window.show=phase=>{const onGo=()=>{},onBreakdownOpen=()=>{},count=phase==='missing'?32:3,episodes=Array.from({length:count},(_,index)=>({no:index+1,episode_no:index+1,title:'来信',locked:(phase==='empty'||phase==='finished'||index===count-1),scriptStatus:phase==='missing'&&index<count-1?'empty':'ready',script_md:phase==='missing'&&index<count-1?'':'一封信。',segmentCount:phase==='empty'?1:0,doneSegmentCount:phase==='empty'?1:0}));
      const jobs=['blocked','missing'].includes(phase)?[{id:'1',step:phase==='missing'?'scripts':'breakdown',episodes:[1],status:'running'}]:[],drama={episodes,jobs,segments:phase==='empty'?episodes.map(ep=>({episode_no:ep.no,chosen_task_id:'done'})):[]};${upstream ? `const next=nextStep(drama,jobs),toShoot=episodes.filter(ep=>ep.locked&&!(ep.segmentCount>0&&ep.doneSegmentCount>=ep.segmentCount));` : ""}flushSync(()=>root.render(${upstream ? section : `<DramaOverviewNext doc={drama} go={onGo} openBreakdown={onBreakdownOpen}/>`}));};`;
      fixture = (
        await transformWithOxc(fixture, "next-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (gate) {
      const file = path.join(pinned, "src/pages/drama/workspace/studio-area.tsx"),
        text = await readFile(file, "utf8");
      const nodes = parseSync(file, text).program.body.map((node) => node.declaration ?? node);
      const source = (name) => {
        const node = nodes.find(
          (node) => node.type === "FunctionDeclaration" && node.id.name === name,
        );
        assert.ok(node);
        return text.slice(node.start, node.end);
      };
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${upstream ? `import {Button} from '@/components/ui/button';import {Clapperboard,Lock,Users,ScrollText} from 'lucide-react';import {episodeCardView} from '@/utils/drama/episode-cards';import {jobConflictReason,isActiveJob} from '@/utils/drama/jobs';const useWorkspace=()=>data,useDramaVideoModel=()=>({maxSeconds:10}),useStoryboardStart=()=>({}),GateFrame=({children})=>children;${source("Gate")};${source("StudioArea")}` : `import {DramaStudioGate,studioPrerequisite} from './src/renderer/workspace/drama-studio-gate';`}
      const root=createRoot(document.querySelector('#gate'));let data;window.show=phase=>{const status=phase==='missing'?'empty':'ready',episode={no:3,episode_no:3,scriptStatus:status,script_status:status,storyboardStatus:'empty',storyboard_status:'empty',locked:false},jobs=['breaking','other','hover','focus'].includes(phase)?[{step:'breakdown',status:'running',episodes:[phase==='other'?2:3]}]:[];data={drama:{episodes:phase==='empty'?[]:[episode],jobs},jobs};flushSync(()=>root.render(${upstream ? "<StudioArea key={phase} ep={3} onGo={()=>{}} onBreakdownOpen={()=>{}}/>" : "<DramaStudioGate key={phase} kind={studioPrerequisite(data.drama,data.drama.episodes[0])} no={3} go={()=>{}} openBreakdown={()=>{}}/>"}));};`;
      if (storyboard) {
        const extract = async (module, name) => {
          const file = path.join(pinned, "src/pages/drama/workspace", module + ".tsx"),
            text = await readFile(file, "utf8"),
            node = parseSync(file, text)
              .program.body.map((entry) => entry.declaration ?? entry)
              .find((entry) => entry.type === "FunctionDeclaration" && entry.id.name === name);
          assert.ok(node);
          return text.slice(node.start, node.end);
        };
        const referenceParts = upstream
          ? `import {Button} from '@/components/ui/button';import {Loader2,Clapperboard} from 'lucide-react';import {motion} from 'motion/react';import {SPRING} from '@/lib/motion';import {cn} from '@/lib/utils';import {episodeCardView} from '@/utils/drama/episode-cards';import {activeStoryboardJob,jobConflictReason} from '@/utils/drama/jobs';const useWorkspace=()=>data,useDramaVideoModel=()=>({maxSeconds:15}),useStoryboardStart=()=>({}),useEstimate=()=>({status:phase==='waiting'?'loading':'ready',credits:37}),useCancelJob=()=>({}),GateFrame=({children})=>children;${source("Gate")};${source("InlineProgress")};${source("StudioArea")};${await extract("storyboard-start", "StoryboardButton")};${await extract("job-bar", "JobProgressBar")}`
          : `import {DramaStoryboardGate} from './src/renderer/workspace/drama-storyboard-gate';window.desktop={projects:{estimateDramaStoryboard:async()=>phase==='waiting'?new Promise(()=>{}):{ok:true,value:{credits:37}}}};`;
        fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${referenceParts};let data,phase;const root=createRoot(document.querySelector('#gate'));window.show=value=>{phase=value;const generating=['queued','running','unknown'].includes(phase),status=generating?'generating':phase==='failed'?'failed':'empty',episode={no:3,episode_no:3,locked:true,storyboardStatus:status,storyboard_status:status},jobs=(generating&&phase!=='unknown'||phase==='blocked')?[{id:'job',step:phase==='blocked'?'compose':'storyboard',episodes:[3],progress:phase==='running'?40:0,status:phase==='queued'?'queued':'running'}]:[];data={drama:{episodes:[episode],jobs},jobs};flushSync(()=>root.render(${upstream ? "<StudioArea key={phase} ep={3} onGo={()=>{}} onBreakdownOpen={()=>{}}/>" : '<DramaStoryboardGate key={phase} doc={data.drama} episode={episode} projectHandle="fixture" maxSeconds={15} saved={()=>{}}/>'}));};`;
      }
      fixture = (
        await transformWithOxc(fixture, "gate-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (pill) {
      const file = path.join(pinned, "src/pages/drama/workspace/script-area.tsx"),
        text = await readFile(file, "utf8");
      const node = parseSync(file, text).program.body.find(
        (node) => node.type === "FunctionDeclaration" && node.id.name === "NextStepPill",
      );
      assert.ok(node);
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {AnimatePresence,motion} from 'motion/react';${upstream ? `import {Button} from '@/components/ui/button';import {DURATION,EASE_OUT} from '@/lib/motion';import {nextStep,MAX_JOB_EPISODES} from '@/utils/drama/episodes';const useWorkspace=()=>data,useEstimate=()=>({status:phase==='waiting'?'loading':'ready',credits:17});${text.slice(node.start, node.end)}` : `import {DramaScriptNext,scriptNextStep} from './src/renderer/workspace/drama-script-next';window.desktop={projects:{estimateDramaScripts:async()=>phase==='waiting'?new Promise(()=>{}):{ok:true,value:17}}};`}
      let phase,data;const root=createRoot(document.querySelector('#pill'));window.show=value=>{phase=value;const missing=['waiting','quoted','many'].includes(phase),episodes=Array.from({length:phase==='many'?204:3},(_,index)=>({episode_no:index+1,no:index+1,script_md:missing?'':'来信',scriptStatus:missing?'empty':'ready',locked:phase==='none'})),jobs=phase==='blocked'?[{step:'breakdown',episodes:[1],status:'running'}]:[];data={drama:{episodes,jobs},jobs};flushSync(()=>root.render(${upstream ? "<NextStepPill key={phase} onScripts={()=>{}} onBreakdown={()=>{}}/>" : '<DramaScriptNext key={phase} step={scriptNextStep(data.drama)} projectHandle="fixture" order={1} open={()=>{}}/>'}));};`;
      fixture = (
        await transformWithOxc(fixture, "pill-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
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
          name: "stage-fixture",
          resolveId: (id) => (id === entry ? entry : null),
          load: (id) => (id === entry ? fixture : null),
        },
      ],
      build: { outDir, lib: { entry, formats: ["es"], fileName: () => "fixture.js" } },
    });
    const assets = upstream
      ? path.join(root, "dist/assets")
      : path.resolve(process.env.DRAMA_DESKTOP_ASSETS ?? "out/renderer/assets");
    const index = await readFile(path.join(assets, "../index.html"), "utf8"),
      css = index.match(/href="[^"\n]*\/assets\/(index-[^"/]+\.css)"/)?.[1];
    assert.ok(css);
    for (const theme of ["light", "dark"])
      for (const width of [1024, 390]) {
        const page = await browser.newPage({
          viewport: { width, height: width === 390 ? 844 : 768 },
          colorScheme: theme,
          reducedMotion: "reduce",
          deviceScaleFactor: 1,
        });
        try {
          await page.route("http://localhost/**", (route) => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (name === "fixture.js")
              return route.fulfill({
                path: path.join(outDir, name),
                contentType: "text/javascript",
              });
            if (name === "index.css")
              return route.fulfill({ path: path.join(assets, css), contentType: "text/css" });
            if (name.endsWith(".woff2"))
              return route.fulfill({
                path: path.join(assets, path.basename(name)),
                contentType: "font/woff2",
              });
            if (name) return route.abort();
            const bg = theme === "dark" ? "oklch(.145 .002 286)" : "oklch(.95 .007 85)";
            const scope = upstream
              ? "drama-theme bg-background text-foreground"
              : overview || pill || gate
                ? "drama-columns"
                : "drama-studio";
            const mount = gate
              ? `<div id="gate" style="position:absolute;inset:0 0 auto auto;width:${width === 390 ? 390 : 946}px;height:360px;display:${upstream ? "block" : "flex"};background:${bg}"></div>`
              : pill
                ? `<div id="pill" style="position:absolute;inset:0 0 auto auto;width:${width === 390 ? 390 : 946}px;height:240px;background:${bg}"></div>`
                : overview
                  ? `<article style="display:block;padding:16px"><div id="next" style="width:${width === 390 ? 358 : 340}px"></div></article>`
                  : `<header style="display:flex;align-items:center;height:100px;padding:0;width:100%;background:${bg}"></header>`;
            return route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset=utf-8><link rel=stylesheet href=/index.css><main class="${scope}">${mount}</main><script type=module src=/fixture.js></script>`,
            });
          });
          await page.goto("http://localhost/");
          if (views)
            await page.locator("header").evaluate((el) => {
              el.style.justifyContent = "center";
              el.style.position = "relative";
            });
          const tabs = views
            ? page.getByRole("group", { name: "视图" })
            : page.getByRole("tablist", { name: "制作工序" });
          if (!overview && !pill && !gate) {
            await tabs.waitFor();
            await page.evaluate(() => document.fonts.ready);
          }
          for (const label of storyboard
            ? ["waiting", "quoted", "failed", "blocked", "queued", "running", "unknown"]
            : gate
              ? ["empty", "missing", "ready", "breaking", "other", "hover", "focus"]
              : pill
                ? ["waiting", "quoted", "many", "ready", "blocked", "none"]
                : overview
                  ? ["missing", "ready", "blocked", "finished", "empty", "hover", "focus"]
                  : labels) {
            let clip;
            const key = `${theme}-${width}-${label}`,
              row = (report.states[key] ??= {});
            if (gate) {
              await page.mouse.move(0, 500);
              await page.evaluate((phase) => window.show(phase), label);
              const host = page.locator("#gate"),
                button = host.getByRole("button");
              await host.getByRole("heading").waitFor();
              if (storyboard && ["quoted", "failed", "blocked"].includes(label))
                await host.getByText("37", { exact: true }).waitFor();
              await page.evaluate(() => document.fonts.ready);
              if (label === "hover") await button.hover();
              if (label === "focus") {
                await page.keyboard.press("Tab");
                assert.ok(await button.evaluate((el) => el.matches(":focus-visible")));
              }
              await page.evaluate(() =>
                Promise.all(
                  document.getAnimations().map((animation) => animation.finished.catch(() => {})),
                ),
              );
              clip = await host.boundingBox();
              row[side] = await host.evaluate((el) => ({
                text: el.innerText,
                parts: [...el.firstElementChild.children].map((part) => {
                  const rect = part.getBoundingClientRect();
                  return [rect.x, rect.y, rect.width, rect.height];
                }),
              }));
            } else if (pill) {
              await page.evaluate((phase) => window.show(phase), label);
              const host = page.locator("#pill");
              if (["quoted", "many"].includes(label))
                await host.getByText("17", { exact: true }).waitFor();
              await page.waitForTimeout(380);
              await page.evaluate(() => document.fonts.ready);
              const box = await host.boundingBox();
              clip = { x: box.x, y: 32, width: box.width, height: 208 };
              row[side] = await host.evaluate((region) => ({
                text: region.innerText,
                buttons: [...region.querySelectorAll("button")].map((button) => [
                  button.textContent,
                  button.disabled,
                  button.title,
                ]),
                parts: [...(region.firstElementChild?.children ?? [])].map((el) => ({
                  x: el.getBoundingClientRect().x,
                  width: el.getBoundingClientRect().width,
                  font: getComputedStyle(el).fontVariantNumeric,
                })),
                height: region.firstElementChild?.getBoundingClientRect().height ?? 0,
              }));
            } else if (overview) {
              await page.mouse.move(0, 300);
              await page.evaluate((phase) => window.show(phase), label);
              const card = page.locator("#next>section");
              await card.waitFor();
              await page.evaluate(() => document.fonts.ready);
              const target = card.getByRole("button", { name: "拆解", exact: true });
              if (label === "hover") await target.hover();
              if (label === "focus") {
                await page.keyboard.press("Tab");
                assert.ok(await target.evaluate((el) => el.matches(":focus-visible")));
              }
              if (label === "blocked")
                assert.equal(
                  await target.getAttribute("title"),
                  "有进行中的任务：资产拆解 · 第 1 集",
                );
              if (label === "missing")
                assert.equal(
                  await card
                    .locator("small")
                    .first()
                    .evaluate((el) => el.scrollWidth > el.clientWidth),
                  true,
                );
              await page.evaluate(() =>
                Promise.all(
                  document.getAnimations().map((animation) => animation.finished.catch(() => {})),
                ),
              );
              const box = await card.boundingBox();
              clip = { x: box.x, y: box.y, width: box.width, height: Math.ceil(box.height) };
              row[side] = await card.evaluate((region) => ({
                text: region.innerText,
                height: region.getBoundingClientRect().height,
                buttons: [...region.querySelectorAll("button")].map((button) => [
                  button.textContent,
                  button.disabled,
                ]),
              }));
            } else {
              const role = views ? "button" : "tab",
                button = tabs.getByRole(role, { name: label, exact: true });
              await button.click();
              await page.mouse.move(0, 0);
              assert.equal(
                await button.getAttribute(views ? "aria-pressed" : "aria-selected"),
                "true",
              );
              await page.waitForFunction(
                () =>
                  document
                    .querySelector(
                      "[aria-selected=true] > :first-child,[aria-pressed=true] > :first-child",
                    )
                    ?.getBoundingClientRect().width > 0,
              );
              await page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              const box = await tabs.boundingBox();
              clip = {
                x: Math.floor(box.x) - 16,
                y: Math.floor(box.y) - 16,
                width: Math.ceil(box.width) + 32,
                height: Math.ceil(box.height) + 32,
              };
              row[side] = await tabs.getByRole(role).evaluateAll((elements) =>
                elements.map((el) => ({
                  name: el.ariaLabel ?? el.textContent,
                  x: el.offsetLeft - elements[0].offsetLeft,
                  y: el.offsetTop - elements[0].offsetTop,
                  width: el.offsetWidth,
                  height: el.offsetHeight,
                  selected: el.ariaSelected ?? el.ariaPressed,
                })),
              );
            }
            const png = await page.screenshot({
              clip,
              animations: "disabled",
              path: path.join(output, `${side}-${key}.png`),
            });
            if (upstream) images.set(key, png);
            else {
              row.differentPixels = await page.evaluate(
                async (pair) => {
                  const parts = await Promise.all(
                    pair.map(async (data) => {
                      const image = new Image();
                      image.src = "data:image/png;base64," + data;
                      await image.decode();
                      const canvas = document.createElement("canvas");
                      canvas.width = image.width;
                      canvas.height = image.height;
                      const context = canvas.getContext("2d");
                      context.drawImage(image, 0, 0);
                      return {
                        width: image.width,
                        height: image.height,
                        pixels: new Uint32Array(
                          context.getImageData(0, 0, image.width, image.height).data.buffer,
                        ),
                      };
                    }),
                  );
                  if (parts[0].width !== parts[1].width || parts[0].height !== parts[1].height)
                    return -1;
                  return parts[0].pixels.reduce(
                    (count, color, index) => count + Number(color !== parts[1].pixels[index]),
                    0,
                  );
                },
                [images.get(key), png].map((buffer) => buffer.toString("base64")),
              );
            }
          }
        } finally {
          await page.close();
        }
      }
  }
  const comparison = await browser.newPage({
    viewport: { width: 730, height: gate ? 760 : pill ? 476 : overview ? 436 : 224 },
  });
  try {
    const panels = [];
    for (const theme of ["light", "dark"])
      for (const side of ["reference", "desktop"]) {
        const image = await readFile(
          path.join(
            output,
            `${side}-${theme}-${storyboard ? "390-running" : gate ? "390-breaking" : pill ? "390-many" : "1024-" + (overview ? "ready" : views ? "画布" : "资产管理")}.png`,
          ),
        );
        panels.push(
          `<figure>${side === "reference" ? "小镜 · 4277d16f" : "小灵 · link-studio"}<img style="max-width:100%" src="data:image/png;base64,${image.toString("base64")}"></figure>`,
        );
      }
    await comparison.setContent(
      "<style>body{margin:0;background:#ecebea;display:grid;grid-template-columns:1fr 1fr}figure{margin:6px 0;text-align:center;font:14px/28px sans-serif}img{display:block;margin:auto}</style>" +
        panels.join(""),
    );
    await comparison.screenshot({ path: path.join(output, "comparison.png") });
  } finally {
    await comparison.close();
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  for (const [key, row] of Object.entries(report.states)) {
    console.log(key, row.differentPixels);
    if (row.differentPixels !== 0 || JSON.stringify(row.reference) !== JSON.stringify(row.desktop))
      process.exitCode = 1;
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
