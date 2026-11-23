import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build, parseSync } from "vite";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = path.resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const overlayOnly = process.argv.includes("--drop-overlay");
const batchOnly = process.argv.includes("--batch-toolbar");
const toolbar = process.argv.includes("--breakdown-toolbar");
const interactions = process.argv.includes("--card-interactions");
const temp = await mkdtemp(path.join(tmpdir(), "drama-asset-cards-")),
  output = path.resolve(
    toolbar
      ? "test-results/drama-breakdown-toolbar-parity"
      : interactions
        ? "test-results/drama-asset-interaction-parity"
        : batchOnly
          ? "test-results/drama-asset-batch-parity"
          : overlayOnly
            ? "test-results/drama-asset-drop-parity"
            : "test-results/drama-asset-card-parity",
  );
const cases = [
  "idle",
  "running",
  "analyzing",
  "uploading",
  "error",
  "upload-error",
  "script",
  "audio",
  "image",
  "uploaded-image",
  "broken-image",
  "hover",
];
const report = {
  revision,
  scope:
    "完整单卡、普通及鼠标悬停、DPR 1、动画起始帧；文本、音频、解码完成的自供／生成图片，不含视频或解码过程",
  states: {},
};
if (overlayOnly)
  report.scope = "列表拖入文件：真实提示层，同尺寸双色底图，DPR 1；不包含资产卡和列表布局";
if (batchOnly)
  report.scope =
    "批量操作栏含阴影、位置及视口裁切；道具带估价／角色无估价、选中两项，不包含资产卡或整页";
if (toolbar)
  report.scope =
    "无资产时的完整顶栏，含视图切换、空生成槽、提交按钮与真实拆解进度；高按顶栏实际换行裁切，DPR 1";
if (interactions) report.scope = "空道具卡含外圈：鼠标、键盘与触屏模拟；每个状态均从未选中进入";
const browser = await chromium.launch({ channel: "chrome" });
async function repaintAfterEntrance(page) {
  await page.locator("main").evaluate(async (region) => {
    const nextPaint = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    region.style.display = "none";
    await nextPaint();
    region.style.removeProperty("display");
    await nextPaint();
  });
}
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
      entry = path.join(root, toolbar ? "asset-fixture.tsx" : "asset-fixture.jsx"),
      outDir = path.join(temp, side);
    const fixture = `${upstream ? "" : "window.desktop={projects:{getAssetPreview:async({assetId})=>({ok:true,value:{url:assetId==='broken-image'?'/broken.png':'/sample.png'}})}};"}import {createRoot} from 'react-dom/client';import {AssetCard} from '${upstream ? "./src/pages/drama/workspace/asset-card" : "./src/renderer/workspace/drama-asset-browser"}';${upstream ? "import {assetStatusOf} from './src/utils/drama/assets';" : ""}
    function card(state){const name='来客的信封',look='雨夜',id=state,type=state==='idle'?'character':state==='script'?'text':state==='audio'?'audio':'prop',kind=type==='text'?'script':type==='audio'?'audio':'image',episodes=state==='idle'?null:state==='audio'?[]:[1,2];
    const data={label:name,kind,text:state==='script'?'信封右下角的蓝色蜡印。':'',uploaded:state==='uploaded-image'||state==='audio'||state==='upload-error',character:type==='character'?{name,look,extraAssetIds:[]}:undefined};const base={id,type,name,look};
    ${upstream ? `if(type==='character')data.kind='character'; if(state.endsWith('image'))data.src=state==='broken-image'?'/broken.png':'/sample.png';if(state==='audio')data.src='/sample.wav';if(state==='uploading')data.uploadProgress=42;if(state==='running')data.status='running';if(state.endsWith('error')){data.status='error';data.error='信封图暂时无法生成，请重新提交。';}return <AssetCard key={id} index={0} multi={false} item={{...base,episodes,data,status:assetStatusOf(data,{analyzing:state==='analyzing'})}}/>;` : `if(state.endsWith('image'))data.assetId=state;if(state==='audio')data.assetId='audio';if(state==='upload-error')data.uploadFailed=true;const jobs=new Map([[id,[{id:'task',nodeId:id,kind,status:state==='running'?'running':'failed',errorMessage:'信封图暂时无法生成，请重新提交。',outputs:[]}]]]);return <AssetCard key={id} handle="demo" analyzing={state==='analyzing'} editor={{jobs:['error','running'].includes(state)?jobs:new Map(),progress:new Map(state==='uploading'?[[id,42]]:[])}} item={{...base,numbers:episodes,node:{id,type:'creative',data}}}/>;`}}
    const root=createRoot(document.querySelector('#cards'));window.showCard=state=>root.render(card(state));`;
    let source = fixture;
    if (interactions)
      source += `import {cloneElement,useState} from 'react';function Interactive({state}){const [selected,select]=useState(false),multi=state.startsWith('multi'),toggle=()=>select(value=>!value);return cloneElement(card(state),{multi,${upstream ? "selected,onToggle:toggle" : "checked:selected,toggle"}});}window.showCard=state=>root.render(<Interactive key={state} state={state}/>);`;
    if (batchOnly) {
      const upstreamSource = await readFile(
        path.join(pinned, "src/pages/drama/workspace/assets-overlay.tsx"),
        "utf8",
      );
      const jsx = upstreamSource.match(
          /ui\.multi && selectedItems\.length > 0 && \(\s*(<div[\s\S]*?<\/motion\.div>\s*<\/div>)/,
        )?.[1],
        credits = upstreamSource.match(
          /function Credits\(\{ value \}: \{ value: number \}\)([\s\S]*?\n\})/,
        )?.[1];
      assert.ok(jsx && credits);
      source = `import {createRoot} from 'react-dom/client';${upstream ? `import {motion} from 'motion/react';import {Button} from './src/components/ui/button';import {EASE_OUT,DURATION} from './src/lib/motion';function Credits({value})${credits}` : `import {AssetBatchToolbar} from './src/renderer/workspace/drama-asset-browser';`}
      const root=createRoot(document.querySelector('#cards'));window.showCard=(type)=>{const ui={type},estimate=type==='prop'?8:0,voiceEstimate=0,selectedItems=[1,2],selectable=[1,2,3],batching=false,run=()=>{};root.render(${upstream ? jsx : `<AssetBatchToolbar count={2} character={type==='character'} estimate={estimate} voiceEstimate={voiceEstimate} selectAll={()=>{}}/>`});};`;
    }
    if (overlayOnly) {
      const original = await readFile(
        path.join(pinned, "src/pages/drama/workspace/assets-overlay.tsx"),
        "utf8",
      );
      const jsx = original.match(
        /\{fileOver && \(\s*(<div\s+aria-hidden[\s\S]*?<\/span>\s*<\/div>)\s*\)\}/,
      )?.[1];
      assert.ok(jsx?.includes("松手上传"));
      source = `import {createRoot} from 'react-dom/client';${upstream ? "import {Upload} from 'lucide-react'" : "import {AssetFileOverlay} from './src/renderer/workspace/drama-asset-browser'"};createRoot(document.querySelector('#cards')).render(${upstream ? jsx : "<AssetFileOverlay/>"});`;
    }
    if (toolbar) {
      const original = await readFile(
        path.join(pinned, "src/pages/drama/workspace/assets-area.tsx"),
        "utf8",
      );
      const declaration = parseSync("assets-area.tsx", original).program.body.find(
        (statement) =>
          statement.type === "ExportNamedDeclaration" &&
          statement.declaration?.id?.name === "ViewToggle",
      );
      assert.ok(declaration);
      const toggle = original.slice(declaration.start, declaration.end),
        bar = original.match(
          /<div className="border-border flex shrink-0 flex-wrap[\s\S]*?<\/Button>\s*<\/div>/,
        )?.[0];
      assert.ok(bar);
      source = `import {createRoot} from 'react-dom/client';import {useState} from 'react';${upstream ? `import {LayoutGrid,Frame} from 'lucide-react';import {cn} from '@/lib/utils';import {BreakdownProgress} from './src/pages/drama/workspace/breakdown-progress';import {Button} from '@/components/ui/button';import {busyReason} from '@/utils/drama/jobs';${toggle}` : `import {StageAssets} from './src/renderer/workspace/drama-asset-browser';`}
      function Toolbar({phase}){const [view,setView]=useState('list'),ui={setView},setGenerateAllTarget=()=>{},onBreakdownOpen=()=>{},ready=phase!=='disabled',jobs=window.jobs;
      ${upstream ? `const breakdownBlocked=busyReason(jobs)??(ready?null:'没有可拆解的集：先写好剧本');return <DramaWorkspaceContext.Provider value={{drama:{id:'fixture'},jobs}}>${bar}</DramaWorkspaceContext.Provider>` : `return <StageAssets doc={{jobs,episodes:[{episode_no:1,script_md:ready?'有信。':'',script_status:ready?'ready':'empty'}]}} ep={0} handle="fixture" editor={{graph:{nodes:[]},jobs:new Map(),progress:new Map(),ready:true}} saved={()=>{}} openBreakdown={()=>{}}/>`};}
      ${upstream ? "import {DramaWorkspaceContext} from './src/pages/drama/workspace/context';" : ""}import {flushSync} from 'react-dom';const root=createRoot(document.querySelector('#cards'));window.showCard=phase=>{window.jobs=['queued','20','80'].includes(phase)?[{id:'1',step:'breakdown',lane:'user',episodes:[1,2],progress:Number(phase)||0,status:phase==='queued'?'queued':'running'}]:[];flushSync(()=>root.render(<Toolbar key={phase} phase={phase}/>));};`;
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
          name: "asset-fixture",
          resolveId: (id) => (id === entry ? entry : null),
          load: (id) => (id === entry ? source : null),
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
      for (const width of [1024, 390])
        for (const hasTouch of interactions ? [false, true] : [false]) {
          const page = await browser.newPage({
            viewport: { width, height: width === 390 ? 844 : 768 },
            colorScheme: theme,
            reducedMotion: "reduce",
            deviceScaleFactor: 1,
            hasTouch,
          });
          try {
            if (toolbar) page.on("pageerror", (error) => console.error(side, error));
            await page.route("http://localhost/**", (route) => {
              const name = new URL(route.request().url()).pathname.slice(1);
              if (name === "sample.png")
                return route.fulfill({
                  path: path.resolve("resources/icons/icon-32.png"),
                  contentType: "image/png",
                });
              if (name === "fixture.js")
                return route.fulfill({
                  path: path.join(outDir, name),
                  contentType: "text/javascript",
                });
              if (name === "index.css" || name.endsWith(".woff2"))
                return route.fulfill({
                  path: path.join(assets, name === "index.css" ? css : path.basename(name)),
                  contentType: name === "index.css" ? "text/css" : "font/woff2",
                });
              if (name) return route.abort();
              return route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html class="${theme}"><meta charset=utf-8><link rel=stylesheet href=/index.css><style>main{position:absolute;inset:0;padding:0!important;margin:0}#cards{display:grid;grid-template-columns:repeat(${width === 390 ? 2 : 4},${width === 390 ? 132 : 160}px);align-items:start;gap:12px;padding:16px;list-style:none}#cards svg{animation-play-state:paused!important}</style><main class="${upstream ? "drama-theme bg-background text-foreground" : "drama-studio"}"><div id="cards" class="${upstream ? "" : "drama-asset-browser"}"></div></main><script type=module src=/fixture.js></script>`,
              });
            });
            await page.goto("http://localhost/");
            if (overlayOnly) {
              await page.addStyleTag({
                content:
                  "#cards {display:block;position:relative;width:100%;height:360px;box-sizing:border-box;background:linear-gradient(105deg,#658397 42%,#c4b597 42%)}",
              });
              const region = page.locator("#cards"),
                pill = region.getByText("松手上传");
              await pill.waitFor();
              await page.evaluate(() => document.fonts.ready);
              const key = `${theme}-${width}-drop`;
              (report.states[key] ??= {})[side] = await pill.boundingBox();
              await region.screenshot({ path: path.join(output, `${side}-${key}.png`) });
              continue;
            }
            await page.waitForFunction(() => typeof window.showCard === "function");
            if (toolbar) {
              await page.addStyleTag({ content: "#cards{display:block;padding:0;width:100%}" });
              for (const state of ["idle", "disabled", "queued", "20", "80", "canvas"]) {
                await page.evaluate((state) => window.showCard(state), state);
                const start = page.getByRole("button", { name: "资产拆解", exact: true });
                await start.waitFor();
                const active = ["queued", "20", "80"].includes(state);
                assert.equal(await start.isDisabled(), active || state === "disabled");
                if (active)
                  await page
                    .getByRole("status")
                    .getByText(state === "queued" ? "排队中" : `${state}%`)
                    .waitFor();
                if (state === "canvas") {
                  const toggle = page.getByRole("button", { name: "画布", exact: true });
                  await toggle.click();
                  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
                }
                await page.mouse.move(0, 300);
                await page.evaluate(async () => {
                  await document.fonts.ready;
                  await Promise.all(
                    document.getAnimations().map((a) => a.finished.catch(() => {})),
                  );
                });
                const region = start.locator(".."),
                  key = `${theme}-${width}-${state}`;
                (report.states[key] ??= {})[side] = await region.boundingBox();
                await region.screenshot({ path: path.join(output, `${side}-${key}.png`) });
              }
              continue;
            }
            if (interactions) {
              assert.equal(await page.evaluate(() => matchMedia("(hover:none)").matches), hasTouch);
              await page.evaluate(() => {
                const start = document.createElement("button");
                start.id = "start";
                start.style = "position:fixed;left:-100px";
                document.body.prepend(start);
              });
              for (const state of hasTouch
                ? ["touch"]
                : [
                    "cover",
                    "upload",
                    "library",
                    "tab-upload",
                    "tab-library",
                    "tab-locate",
                    "multi",
                    "multi-hover",
                    "multi-checked",
                    "multi-cover-focus",
                    "multi-focus",
                  ]) {
                await page.mouse.move(0, 0);
                await page.locator("#start").focus();
                await page.evaluate((state) => window.showCard(state), state);
                const card = page.locator(`[data-asset-id="${state}"]`),
                  key = `${theme}-${width}-${state}`;
                await card.waitFor();
                await page.evaluate(() => document.fonts.ready);
                await page.waitForFunction((id) => {
                  const el = document.querySelector(`[data-asset-id="${id}"]`),
                    s = getComputedStyle(el);
                  return (
                    s.opacity === "1" &&
                    (s.transform === "none" || new DOMMatrix(s.transform).isIdentity)
                  );
                }, state);
                await repaintAfterEntrance(page);
                if (["cover", "multi-hover", "multi-checked"].includes(state))
                  await card.hover({ position: { x: 20, y: 40 } });
                if (["upload", "library"].includes(state))
                  await card
                    .getByRole("button", {
                      name: state === "upload" ? "上传" : "素材库",
                      exact: true,
                    })
                    .hover();
                if (state === "multi-checked") {
                  await card.getByRole("button", { name: "选择", exact: true }).click();
                  await page.mouse.move(0, 0);
                }
                if (state.startsWith("tab-") || state.endsWith("focus")) {
                  const stops = {
                    "tab-upload": 1,
                    "tab-library": 2,
                    "tab-locate": 3,
                    "multi-cover-focus": 1,
                    "multi-focus": 2,
                  };
                  for (let index = 0; index < stops[state]; index++)
                    await page.keyboard.press("Tab");
                  if (state === "multi-focus") await page.keyboard.press("Space");
                }
                await page.evaluate(async () => {
                  await new Promise(requestAnimationFrame);
                  await Promise.all(
                    document
                      .getAnimations()
                      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                      .map((animation) => animation.finished.catch(() => {})),
                  );
                  await new Promise(requestAnimationFrame);
                });
                const box = await card.boundingBox();
                await page.screenshot({
                  path: path.join(output, `${side}-${key}.png`),
                  clip: {
                    x: box.x - 3,
                    y: box.y - 3,
                    width: box.width + 6,
                    height: Math.ceil(box.height) + 6,
                  },
                });
                if (
                  process.env.PARITY_STYLES &&
                  theme === "light" &&
                  width === 1024 &&
                  state === "upload"
                )
                  console.log(
                    side,
                    JSON.stringify(
                      await card.evaluate((el) =>
                        [
                          el,
                          el.firstElementChild,
                          ...[...el.querySelectorAll("button")]
                            .slice(0, 1)
                            .flatMap((button) => [
                              button.parentElement.parentElement,
                              button.parentElement,
                              button,
                              button.firstElementChild,
                            ]),
                        ].map((child) => {
                          const s = getComputedStyle(child);
                          return [
                            child.getBoundingClientRect().toJSON(),
                            s.transform,
                            s.translate,
                            s.backgroundColor,
                            s.color,
                            s.font,
                            s.boxShadow,
                            s.backdropFilter,
                            s.borderRadius,
                            s.transition,
                            s.willChange,
                            s.lineHeight,
                            s.fontSynthesis,
                            s.textRendering,
                            s.contain,
                          ];
                        }),
                      ),
                    ),
                  );
                const observed = await card.evaluate((el) => {
                  const focus = el.querySelector(":focus-visible"),
                    upload = [...el.querySelectorAll("button")].find(
                      (button) => button.textContent === "上传",
                    );
                  return {
                    focus: focus?.getAttribute("aria-label") ?? focus?.textContent ?? null,
                    selected:
                      el.querySelector("[aria-pressed]")?.getAttribute("aria-pressed") ?? null,
                    pill: upload ? getComputedStyle(upload.parentElement).opacity : null,
                  };
                });
                assert.equal(
                  observed.focus,
                  {
                    "tab-upload": "上传",
                    "tab-library": "素材库",
                    "tab-locate": "在画布中打开 来客的信封",
                    "multi-cover-focus": "待生成",
                    "multi-focus": "取消选择",
                  }[state] ?? null,
                );
                assert.equal(
                  observed.selected,
                  state.startsWith("multi")
                    ? String(["multi-checked", "multi-focus"].includes(state))
                    : null,
                );
                if (["cover", "upload", "library", "multi-hover"].includes(state)) {
                  const target = card.getByRole("button", {
                    name: {
                      cover: "在画布中打开 来客的信封",
                      upload: "上传",
                      library: "素材库",
                      "multi-hover": "选择",
                    }[state],
                    exact: true,
                  });
                  assert.equal(await target.evaluate((button) => button.matches(":hover")), true);
                }
                assert.equal(
                  observed.pill,
                  state.startsWith("multi") ? null : state === "tab-locate" ? "0" : "1",
                );
                (report.states[key] ??= {})[side] = observed;
              }
              continue;
            }
            if (batchOnly) {
              await page.addStyleTag({
                content:
                  "#cards{box-sizing:border-box;position:relative;display:block;width:100%;height:120px;min-height:0;padding:0}",
              });
              for (const state of ["prop", "character"]) {
                const key = `${theme}-${width}-${state}`;
                await page.evaluate((state) => window.showCard(state), state);
                const bar = page.getByRole("toolbar");
                await bar.waitFor();
                await page.evaluate(() => document.fonts.ready);
                await page.waitForFunction(() => {
                  const style = getComputedStyle(document.querySelector("[role=toolbar]"));
                  return (
                    style.opacity === "1" &&
                    (style.transform === "none" || new DOMMatrix(style.transform).isIdentity)
                  );
                });
                (report.states[key] ??= {})[side] = await bar.boundingBox();
                if (
                  process.env.PARITY_STYLES &&
                  theme === "light" &&
                  width === 390 &&
                  state === "prop"
                )
                  console.log(
                    side,
                    await bar
                      .locator("button")
                      .last()
                      .evaluate((el) => {
                        const s = getComputedStyle(el);
                        return [
                          el.getBoundingClientRect().toJSON(),
                          s.backgroundClip,
                          s.borderRadius,
                          s.border,
                          s.padding,
                          s.boxShadow,
                          s.lineHeight,
                          s.font,
                          s.backgroundColor,
                          s.appearance,
                        ];
                      }),
                  );
                await page.screenshot({
                  clip: { x: 0, y: 0, width, height: 120 },
                  path: path.join(output, `${side}-${key}.png`),
                });
              }
              continue;
            }
            for (const state of cases) {
              const card = page.locator(`[data-asset-id="${state}"]`),
                key = `${theme}-${width}-${state}`;
              await page.mouse.move(0, 0);
              await page.evaluate((state) => window.showCard(state), state);
              await card.waitFor();
              await page.evaluate(() => document.fonts.ready);
              await page.waitForFunction((id) => {
                const el = document.querySelector(`[data-asset-id="${id}"]`),
                  style = getComputedStyle(el);
                return (
                  style.opacity === "1" &&
                  (style.transform === "none" || new DOMMatrix(style.transform).isIdentity)
                );
              }, state);
              if (
                process.env.PARITY_STYLES &&
                width === 1024 &&
                theme === "light" &&
                ["error", "audio", "script"].includes(state)
              )
                console.log(
                  side,
                  state,
                  JSON.stringify(
                    await card.evaluate((el) =>
                      [...el.querySelectorAll("*")]
                        .filter(
                          (el) =>
                            !["path", "circle", "BUTTON", "svg", "SECTION", "I"].includes(
                              el.tagName,
                            ),
                        )
                        .map((child) => {
                          const style = getComputedStyle(child),
                            rect = child.getBoundingClientRect();
                          return [
                            child.tagName,
                            child.textContent?.slice(0, 12),
                            rect.x,
                            rect.y,
                            rect.width,
                            rect.height,
                            style.fontSize,
                            style.lineHeight,
                            style.color,
                            style.backgroundImage,
                            style.borderColor,
                          ];
                        }),
                    ),
                  ),
                );
              await card.scrollIntoViewIfNeeded();
              if (state === "broken-image") await card.locator("[role=img] svg").waitFor();
              else if (state.endsWith("image"))
                await card.locator("img").evaluate(async (el) => {
                  await el.decode();
                });
              if (state.endsWith("image"))
                await page.waitForFunction((id) => {
                  const card = document.querySelector(`[data-asset-id="${id}"]`);
                  return (
                    !card.querySelector("[data-slot=media-skeleton],.drama-cover-skeleton") &&
                    [...card.querySelectorAll("img")].every(
                      (el) => getComputedStyle(el).opacity === "1",
                    )
                  );
                }, state);
              await repaintAfterEntrance(page);
              if (state === "hover") {
                await card.hover({ position: { x: 4, y: 4 } });
                await page.waitForFunction((id) => {
                  const button = [
                    ...document.querySelectorAll(`[data-asset-id="${id}"] button`),
                  ].find((el) => el.textContent === "上传");
                  return button && getComputedStyle(button.parentElement).opacity === "1";
                }, state);
                await page.evaluate(() =>
                  Promise.all(
                    document
                      .getAnimations()
                      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                      .map((a) => a.finished.catch(() => {})),
                  ),
                );
              }
              await card.screenshot({
                path: path.join(output, `${side}-${key}.png`),
                animations: "disabled",
              });
              (report.states[key] ??= {})[side] = await card.evaluate((el) => ({
                width: el.offsetWidth,
                height: el.offsetHeight,
              }));
            }
          } finally {
            await page.close();
          }
        }
  }
  const differences = {},
    reader = await browser.newPage();
  try {
    for (const key of Object.keys(report.states)) {
      const images = await Promise.all(
        ["reference", "desktop"].map(async (side) =>
          (await readFile(path.join(output, `${side}-${key}.png`))).toString("base64"),
        ),
      );
      differences[key] = await reader.evaluate(async (images) => {
        const [left, right] = await Promise.all(
          images.map(async (data) => {
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
        return left.width !== right.width || left.height !== right.height
          ? -1
          : left.pixels.reduce(
              (count, color, index) => count + Number(color !== right.pixels[index]),
              0,
            );
      }, images);
    }
  } finally {
    await reader.close();
  }
  for (const [key, count] of Object.entries(differences)) {
    report.states[key].differentPixels = count;
    console.log(key, count);
    if (count !== 0) process.exitCode = 1;
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  if (interactions) {
    const sheet = await browser.newPage({ viewport: { width: 855, height: 590 } });
    try {
      const cells = [];
      for (const side of ["reference", "desktop"])
        for (const state of ["upload", "tab-library", "tab-locate", "multi-focus", "touch"]) {
          const image = await readFile(path.join(output, `${side}-light-1024-${state}.png`));
          cells.push(
            `<figure>${side === "reference" ? "小镜" : "小灵"} · ${state}<img src="data:image/png;base64,${image.toString("base64")}"></figure>`,
          );
        }
      await sheet.setContent(
        "<style>body{margin:3px;display:grid;grid-template-columns:repeat(5,166px);gap:4px;background:#ecebea}figure{margin:0;font:14px/24px sans-serif}img{display:block}</style>" +
          cells.join(""),
      );
      await sheet.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
      await sheet.screenshot({ path: path.join(output, "comparison.png"), fullPage: true });
    } finally {
      await sheet.close();
    }
  } else if (overlayOnly || batchOnly || toolbar) {
    const sheet = await browser.newPage({
      viewport: { width: 800, height: toolbar ? 238 : batchOnly ? 306 : 786 },
      deviceScaleFactor: 1,
    });
    try {
      const cells = [];
      for (const theme of ["light", "dark"])
        for (const side of ["reference", "desktop"]) {
          const png = await readFile(
            path.join(
              output,
              `${side}-${theme}-390-${toolbar ? "80" : batchOnly ? "prop" : "drop"}.png`,
            ),
          );
          cells.push(
            `<figure><figcaption>${side === "reference" ? "小镜 · 4277d16f" : "小灵 · link-studio"} / ${theme === "light" ? "浅色" : "深色"}</figcaption><img src="data:image/png;base64,${png.toString("base64")}"></figure>`,
          );
        }
      await sheet.setContent(
        "<style>*{box-sizing:border-box}body{margin:0;padding:6px;display:grid;grid-template-columns:repeat(2,390px);gap:6px;background:#292827;color:white}figure{margin:0}figcaption{font:14px/24px system-ui}img{display:block}</style>" +
          cells.join(""),
      );
      await sheet.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
      await sheet.screenshot({ path: path.join(output, "comparison.png") });
    } finally {
      await sheet.close();
    }
  } else {
    const sheet = await browser.newPage({ viewport: { width: 990, height: 650 } });
    try {
      const cells = [];
      for (const side of ["reference", "desktop"])
        for (const state of ["idle", "analyzing", "uploading", "error", "script", "audio"]) {
          const image = await readFile(path.join(output, `${side}-light-1024-${state}.png`));
          cells.push(
            `<figure>${side === "reference" ? "小镜" : "小灵"} · ${state}<img src="data:image/png;base64,${image.toString("base64")}"></figure>`,
          );
        }
      await sheet.setContent(
        "<style>body{display:grid;grid-template-columns:repeat(6,160px);gap:4px;background:#ecebea}figure{margin:0;font:14px/28px sans-serif}img{display:block}</style>" +
          cells.join(""),
      );
      await sheet.screenshot({ path: path.join(output, "comparison.png") });
    } finally {
      await sheet.close();
    }
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
