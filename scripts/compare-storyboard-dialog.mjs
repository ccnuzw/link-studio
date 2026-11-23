import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import {
  historyFixture,
  historyLifecycleFixture,
  replayHistory,
  replayHistoryLifecycle,
} from "./canvas-task-history-fixture.mjs";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned checkout");
const inspectModels = process.argv.includes("--models");
const boardMotion = process.argv.includes("--board-motion");
const overwriteMotion = process.argv.includes("--overwrite-motion");
const overwrite = overwriteMotion || process.argv.includes("--overwrite");
const batchMotion = process.argv.includes("--batch-motion");
const inspectBatch = batchMotion || process.argv.includes("--batch");
const inspectFocus = process.argv.includes("--focus");
const inspectRows = inspectFocus || process.argv.includes("--rows");
const inspectVideo = process.argv.includes("--video-cells");
const theme = process.argv.includes("--dark") ? "dark" : "light";
const retina = process.argv.includes("--retina");
const compact = process.argv.includes("--compact");
const narrow = process.argv.includes("--narrow");
const edit = process.argv.includes("--edit");
const rowMenus = process.argv.includes("--row-menus");
const pattern = process.argv
  .find((arg) => arg.startsWith("--pattern="))
  ?.slice("--pattern=".length);
const auditPatterns = process.argv.includes("--audit-patterns");
const moreMotion = process.argv.includes("--more-motion");
const moreMenu = moreMotion || process.argv.includes("--more-menu");
const defaultModels = process.argv.includes("--default-models");
const shortcuts = process.argv.includes("--shortcuts");
const controls = process.argv.includes("--controls");
const historyLifecycle = process.argv.includes("--history-lifecycle");
const historyLayers = process.argv.includes("--history-layers");
const historyRows = historyLifecycle || process.argv.includes("--history-rows");
const editTools = historyRows || historyLayers || process.argv.includes("--edit-tools");
const auditSettings =
  editTools ||
  controls ||
  shortcuts ||
  defaultModels ||
  moreMenu ||
  process.argv.includes("--view-settings");
if (pattern) assert(["dots", "lines", "cross", "none"].includes(pattern));
const phases = ["none", "idle", "queued", "running", "finalizing", "done", "failed"];
const scenes = rowMenus
  ? Array.from({ length: 8 }, (_, index) => `画面 ${index + 1}`)
  : boardMotion || inspectBatch || inspectRows || edit || overwrite
    ? ["站台清晨", ""]
    : [];
const shots = scenes.map((scene, index) => ({
  id: `shot-${index}`,
  scene,
  action: "",
  dialogue: "",
  shot: "中景",
  camera: "固定",
  duration: 3,
}));
const models =
  inspectModels || overwrite
    ? [
        { key: "first", label: "分镜模型 A", vendor: "openai" },
        { key: "second", label: "分镜模型 B", vendor: "gemini" },
      ]
    : [];
const desktopModels = models.map(({ key, label, vendor }) => ({
  id: key,
  model: key,
  channelId: "fixture-channel",
  channelEnabled: true,
  config: { name: label, logo: vendor, kind: "agent" },
  enabled: true,
  pluginHash: "openai",
  agentEnabled: true,
  hasSecret: true,
}));
const output = resolve(
  (auditSettings
    ? "test-results/canvas-settings-parity"
    : auditPatterns
      ? "test-results/canvas-background-parity"
      : boardMotion
        ? "test-results/storyboard-shell-motion-parity"
        : overwriteMotion
          ? "test-results/storyboard-overwrite-motion-parity"
          : overwrite
            ? "test-results/storyboard-overwrite-parity"
            : rowMenus
              ? "test-results/storyboard-row-menu-parity"
              : edit
                ? "test-results/storyboard-edit-parity"
                : inspectFocus
                  ? "test-results/storyboard-focus-parity"
                  : inspectRows
                    ? "test-results/storyboard-rows-parity"
                    : inspectVideo
                      ? "test-results/shot-video-cell-parity"
                      : batchMotion
                        ? "test-results/storyboard-batch-motion-parity"
                        : inspectBatch
                          ? "test-results/storyboard-batch-parity"
                          : inspectModels
                            ? "test-results/storyboard-model-parity"
                            : "test-results/storyboard-dialog-parity") +
    (pattern ? `-${pattern}` : "") +
    (theme === "dark" ? "-dark" : "") +
    (compact ? "-compact" : "") +
    (narrow ? "-narrow" : "") +
    (retina ? "-retina" : ""),
);
const captureDirectory = historyLayers
  ? join(output, "history-layers")
  : historyLifecycle
    ? join(output, "history-lifecycle")
    : historyRows
      ? join(output, "history-rows")
      : editTools
        ? join(output, "edit-tools")
        : controls
          ? join(output, "controls")
          : shortcuts
            ? join(output, "shortcuts")
            : defaultModels
              ? join(output, "default-models")
              : moreMenu
                ? join(output, moreMotion ? "more-motion" : "more-menu")
                : output;
await mkdir(captureDirectory, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "storyboard-dialog-parity-"));
const browser = await chromium.launch({ channel: "chrome" });
const measurements = {};
const captures = [];
const menuFrames = new Map();
async function stableFrame(page, name, animations = "disabled") {
  const options = { animations, caret: "hide" };
  let screenshot = await page.screenshot(options);
  let consecutive = 1;
  for (let attempt = 0; attempt < 15 && consecutive < 3; attempt++) {
    const next = await page.screenshot(options);
    consecutive = next.equals(screenshot) ? consecutive + 1 : 1;
    screenshot = next;
  }
  assert.equal(consecutive, 3, `Unstable ${name} frame`);
  await writeFile(join(captureDirectory, `${name}.png`), screenshot);
  return screenshot;
}
try {
  for (const upstream of [true, false]) {
    const name = upstream ? "upstream" : "desktop";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const stylesheet = await readFile(join(assets, css));
    const entry = "/src/__board_dialog_audit.jsx";
    const cellFixture = () => {
      const cells = phases
        .map((phase) => {
          const job = {
            status: { finalizing: "downloading", done: "succeeded" }[phase] ?? phase,
            progress: phase === "running" ? 42 : phase === "finalizing" ? 99 : 0,
            error: "测试失败",
          };
          const props = upstream
            ? `shot={{videoNodeId:${phase === "none" ? "undefined" : JSON.stringify(phase)}}} onGenerate={()=>act('create')} onLocate={act}`
            : `nodeId={${phase === "none" ? "undefined" : JSON.stringify(phase)}} assetId={${phase === "done" ? "'asset'" : "undefined"}} job={${["none", "idle"].includes(phase) ? "undefined" : JSON.stringify(job)}} prepare={()=>act('create')} locate={act}`;
          return `<div data-phase="${phase}"><ShotVideoCell ${props}/></div>`;
        })
        .join("");
      const nodes = phases.slice(1).map((phase) => ({
        id: phase,
        position: { x: 0, y: 0 },
        data: {
          kind: "video",
          status: ["queued", "running", "finalizing"].includes(phase)
            ? "running"
            : phase === "failed"
              ? "error"
              : "idle",
          src: phase === "done" ? "asset" : "",
          error: "测试失败",
          taskId: phase,
        },
      }));
      const imports = upstream
        ? `import {ReactFlowProvider} from '@xyflow/react';import {useTasksStore} from '/src/store/tasks';import {ShotVideoCell} from '/src/components/storyboard/shot-video-cell';useTasksStore.setState({tasks:{queued:{status:'pending'},running:{status:'running',progress:42},finalizing:{status:'finalizing',progress:99}}});`
        : `import {ShotVideoCell} from '/src/renderer/workspace/shot-video-cell';`;
      return `import React from 'react';import {createRoot} from 'react-dom/client';${imports}const act=id=>document.body.dataset.action=id;createRoot(document.querySelector('main')).render(${upstream ? `<ReactFlowProvider initialNodes={${JSON.stringify(nodes)}}>` : ""}<section id="cells" className="${upstream ? "" : "image-doodle-dialog storyboard-dialog"}" style={{position:'fixed',left:100,top:100,width:120,height:'auto',padding:0,border:0,borderRadius:0,boxShadow:'none',background:'white'}}>${cells}</section>${upstream ? "</ReactFlowProvider>" : ""});`;
    };
    const imports = upstream
      ? `import {MemoryRouter} from 'react-router';import {ReactFlowProvider,useNodesData} from '@xyflow/react';import {StoryboardDialog} from '/src/components/storyboard/storyboard-dialog';${overwrite ? "import {SplitOverwriteDialog} from '/src/components/storyboard/split-ui';" : ""}`
      : `import {StoryboardDialog} from '/src/renderer/workspace/storyboard-dialog';`;
    const focusId = JSON.stringify(inspectFocus ? "shot-1" : null);
    const liveBoard = upstream
      ? `const rows=useNodesData('board').data.storyboard.shots;`
      : `const [rows,change]=React.useState(${JSON.stringify(shots)});`;
    const board = upstream
      ? `${overwrite ? '<SplitOverwriteDialog id="board"/>' : ""}<StoryboardDialog id="board" label="雨夜分镜" board={{shots:rows}} open={shown} focusShotId={${focusId}} onOpenChange={setShown}/>`
      : `{shown && <StoryboardDialog close={()=>setShown(false)} title="雨夜分镜" boardId="board" projectHandle="fixture" initialFocusId={${focusId}} initial={rows} change={change} linkedNodes={{image:[],video:[]}} jobs={[]} settings={{providers:${JSON.stringify(desktopModels)},plugins:[{hash:'openai',kind:'text'}]}} script={{connected:${overwrite},text:'${overwrite ? "雨夜" : ""}'}}/>}`;
    const subject = upstream
      ? `<MemoryRouter><ReactFlowProvider defaultNodes={[{id:'board',position:{x:0,y:0},data:{kind:'storyboard',storyboard:{shots:${JSON.stringify(shots)}}}}${overwrite ? ",{id:'script',position:{x:0,y:0},data:{kind:'script',text:'雨夜'}}" : ""}]} defaultEdges={${overwrite ? "[{id:'link',source:'script',target:'board'}]" : "[]"}}><Board/></ReactFlowProvider></MemoryRouter>`
      : "<Board/>";
    const backgroundFixture =
      !pattern && !auditPatterns
        ? ""
        : `import {ReactFlow} from '@xyflow/react';import {CanvasBackgroundLayer} from '${upstream ? "/src/components/canvas/canvas-background" : "/src/renderer/workspace/canvas-view-preferences"}';function Backdrop(){const [background,setBackground]=React.useState(${JSON.stringify(pattern ?? "dots")});return <div style={{position:'absolute',inset:0}}><ReactFlow defaultViewport={{x:7,y:13,zoom:1}} minZoom={.14} proOptions={{hideAttribution:true}} onInit={flow=>{window.setAuditView=(mode,zoom)=>{setBackground(mode);return flow.setViewport({x:7,y:13,zoom});};}}><CanvasBackgroundLayer background={background}/></ReactFlow></div>}`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "board-dialog-fixture",
          resolveId(id) {
            if (id === entry) return join(root, entry);
          },
          load(id) {
            if (id === join(root, entry) && historyLifecycle)
              return historyLifecycleFixture(upstream, theme);
            if (id === join(root, entry) && historyRows) return historyFixture(upstream, theme);
            if (id === join(root, entry) && editTools) {
              const fixture = upstream
                ? `import {BottomToolbar} from '/src/pages/canvas/chrome/bottom-toolbar';import {ChromeZone} from '/src/components/canvas/chrome/chrome';import {TooltipProvider} from '/src/components/ui/tooltip';import {useSettingsStore} from '/src/store/settings';useSettingsStore.getState().updateSettings('theme',${JSON.stringify(theme)});function Toolbar(){const [hand,set]=React.useState(false),[added,add]=React.useState(false);return <TooltipProvider><ChromeZone position="left-center"><BottomToolbar tool={hand?'pan':'select'} onToolChange={tool=>set(tool==='pan')} onAdd={()=>add(true)} onUpload={()=>{}} onOpenAssets={()=>{}} canUndo={added} canRedo={false} onUndo={()=>add(false)} onRedo={()=>{}}/></ChromeZone></TooltipProvider>;}`
                : `import {CanvasEditToolbar} from '/src/renderer/workspace/canvas-edit-toolbar';import {CanvasTaskHistory} from '/src/renderer/workspace/canvas-task-history';window.desktop={projects:{listJobs:async()=>({ok:true,value:{jobs:[]}})}};function Toolbar(){const [hand,set]=React.useState(false),[added,add]=React.useState(false),[open,show]=React.useState(false),[tasksOpen,tasks]=React.useState(false);return <><CanvasEditToolbar addMenu={{open,onOpenChange:show,label:'添加节点',disabled:()=>false,uploadDisabled:false,choose:()=>add(true),upload:()=>{},assets:()=>{}}} locked={false} hand={hand} chooseHand={set} canUndo={added} canRedo={false} undo={()=>add(false)} redo={()=>{}} assetsDisabled={false} openAssets={()=>{}} tasksOpen={tasksOpen} openTasks={()=>tasks(true)}/><CanvasTaskHistory open={tasksOpen} setOpen={tasks} nodes={[]} jobs={[]} projectHandle="fixture" pick={()=>false}/></>;}`;
              return `import React from 'react';import {createRoot} from 'react-dom/client';import {ReactFlowProvider} from '@xyflow/react';${fixture}createRoot(document.querySelector('main')).render(<ReactFlowProvider><Toolbar/></ReactFlowProvider>);`;
            }
            if (id === join(root, entry) && controls) {
              const fixture = upstream
                ? `import {ViewControls} from '/src/pages/canvas/chrome/view-controls';import {ChromeZone} from '/src/components/canvas/chrome/chrome';import {TooltipProvider} from '/src/components/ui/tooltip';import {useSettingsStore} from '/src/store/settings';useSettingsStore.getState().updateSettings('theme',${JSON.stringify(theme)});useSettingsStore.getState().updateSettings('background','dots');function Controls({map,setMap}){return <TooltipProvider><ChromeZone position="bottom-left" className="max-md:hidden"><ViewControls minimap={map} onMinimapChange={setMap} onOpenShortcuts={()=>{}}/></ChromeZone></TooltipProvider>;}function MapOverlay(){return <MiniMap position="bottom-left" pannable zoomable className="canvas-overlay-interactive !bottom-16 !left-[76px] overflow-hidden rounded-xl shadow-lg ring-1 ring-chrome-border" nodeColor="var(--muted-foreground)" nodeBorderRadius={12}/>;}`
                : `import {CanvasViewControls} from '/src/renderer/workspace/canvas-view-controls';import {CanvasMiniMap as MapOverlay} from '/src/renderer/workspace/canvas-minimap';function Controls({map,setMap}){const flow=useReactFlow(),[background,setBackground]=React.useState('dots');return <CanvasViewControls background={background} setBackground={setBackground} minimap={map} toggleMap={()=>setMap(!map)} openShortcuts={()=>{}} changeView={action=>action==='in'?flow.zoomIn({duration:300}):action==='out'?flow.zoomOut({duration:300}):action==='reset'?flow.zoomTo(1,{duration:300}):flow.fitView({duration:300,padding:.2})}/>;}`;
              const toolbar = "<Controls map={map} setMap={setMap}/>";
              return `import React from 'react';import {createRoot} from 'react-dom/client';import {ReactFlow,ReactFlowProvider,MiniMap,useReactFlow} from '@xyflow/react';${fixture}function Fixture(){const [map,setMap]=React.useState(false);return <ReactFlowProvider><ReactFlow defaultNodes={[{id:'distant',type:'default',position:{x:1600,y:300},width:300,height:180,data:{label:'镜头'}}]} proOptions={{hideAttribution:true}}>{map&&<MapOverlay/>}${upstream ? "" : toolbar}</ReactFlow>${upstream ? toolbar : ""}</ReactFlowProvider>;}createRoot(document.querySelector('main')).render(<Fixture/>);`;
            }
            if (id === join(root, entry) && shortcuts) {
              const imports = upstream
                ? `import {ShortcutsDialog} from '/src/pages/canvas/chrome/shortcuts-dialog';import {useSettingsStore} from '/src/store/settings';useSettingsStore.getState().updateSettings('theme',${JSON.stringify(theme)});`
                : `import {CanvasShortcutsDialog as ShortcutsDialog} from '/src/renderer/workspace/canvas-shortcuts-dialog';`;
              return `import React from 'react';import {createRoot} from 'react-dom/client';${imports}${backgroundFixture}function Fixture(){const [open,setOpen]=React.useState(false);return <>${backgroundFixture ? "<Backdrop/>" : ""}<button aria-label="快捷键" style={{position:'absolute',left:24,top:24,width:24,height:24,padding:0,border:0,borderRadius:4,outline:0,background:'gray'}} onClick={()=>setOpen(true)}/><ShortcutsDialog open={open} onOpenChange={setOpen}/></>}createRoot(document.querySelector('main')).render(<Fixture/>);`;
            }
            if (id === join(root, entry) && moreMenu) {
              const fixture = upstream
                ? `import {MemoryRouter} from 'react-router';import {ChromeZone} from '/src/components/canvas/chrome/chrome';import {TooltipProvider} from '/src/components/ui/tooltip';import {TopRightBar} from '/src/pages/canvas/chrome/top-right-bar';import {useSettingsStore} from '/src/store/settings';useSettingsStore.getState().updateSettings('theme',${JSON.stringify(theme)});function Fixture(){return <MemoryRouter><TooltipProvider><ChromeZone position="top-right"><TopRightBar onOpenSettings={()=>{}} onOpenShortcuts={()=>{}}/></ChromeZone></TooltipProvider></MemoryRouter>;}`
                : `import {CanvasViewSettings} from '/src/renderer/workspace/canvas-view-settings';import {defaultCanvasView} from '@link-studio/core';function Fixture(){const [prefs,set]=React.useState({...defaultCanvasView,theme:${JSON.stringify(theme)}});return <CanvasViewSettings preferences={prefs} change={patch=>{set(current=>({...current,...patch}));if(patch.theme)window.applyAuditTheme(patch.theme);}} openGuide={()=>{}} openModels={()=>{}}/>;}`;
              return `import React from 'react';import {createRoot} from 'react-dom/client';${fixture}createRoot(document.querySelector('main')).render(<Fixture/>);`;
            }
            if (id === join(root, entry) && auditSettings) {
              const groups = defaultModels
                ? [
                    ["script", "文本"],
                    ["image", "图片"],
                    ["video", "视频"],
                    ["audio", "音频"],
                  ].map(([kind, label]) => ({
                    kind,
                    label,
                    models: [1, 2].map((index) => ({
                      id: `${kind}-${index}`,
                      label: `${label}模型 ${index}`,
                      hint: `模型说明 ${index}`,
                      credits: index,
                      price: `${index} 积分`,
                    })),
                  }))
                : [];
              const settings = upstream
                ? `import {SettingsDialog} from '/src/components/setting/settings-dialog';import {Type,Image,Video,Music} from 'lucide-react';import {useSettingsStore} from '/src/store/settings';useSettingsStore.getState().updateSettings('theme',${JSON.stringify(theme)});function Fixture(){return <SettingsDialog open onOpenChange={()=>{}} modelGroups={${JSON.stringify(groups)}.map(group=>{const Icon={script:Type,image:Image,video:Video,audio:Music}[group.kind];return {...group,icon:<Icon/>};})}/>;}`
                : `import {CanvasPreferencesDialog} from '/src/renderer/workspace/canvas-view-settings';import {defaultCanvasView} from '@link-studio/core';function Fixture(){const [prefs,set]=React.useState({...defaultCanvasView,theme:${JSON.stringify(theme)}});return <CanvasPreferencesDialog open setOpen={()=>{}} preferences={prefs} change={patch=>{set(current=>({...current,...patch}));if(patch.theme)window.applyAuditTheme(patch.theme);}} modelGroups={${JSON.stringify(groups)}}/>;}`;
              return `import React from 'react';import {createRoot} from 'react-dom/client';${settings}createRoot(document.querySelector('main')).render(<Fixture/>);`;
            }
            if (id === join(root, entry) && inspectVideo) return cellFixture();
            if (id === join(root, entry))
              return `import React from 'react';import {createRoot} from 'react-dom/client';${imports}${backgroundFixture}function Board(){${liveBoard}const [shown,setShown]=React.useState(${!boardMotion});return <><output hidden data-board-rows={JSON.stringify(rows)}/>${boardMotion ? '<button aria-label="打开分镜表" style={{position:"fixed",left:48,top:48,width:32,height:32,display:"grid",placeItems:"center",background:"white",border:0,borderRadius:4,padding:0,outline:0}} onClick={()=>setShown(true)}><svg width="16" height="16" viewBox="0 0 16 16"><path fill="none" stroke="black" d="M2 3h12v10H2zM2 7h12M7 3v10"/></svg></button>' : ""}${board}</>}createRoot(document.querySelector('main')).render(<>${backgroundFixture ? "<Backdrop/>" : ""}${auditPatterns ? "" : subject}</>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: narrow
        ? { width: 560, height: 740 }
        : compact
          ? { width: 1024, height: 700 }
          : { width: 1280, height: 800 },
      deviceScaleFactor: retina ? 2 : 1,
      colorScheme: theme,
    });
    try {
      const pageErrors = [];
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
        console.error(name, error.message);
      });
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}assets/**`, (route) =>
        basename(new URL(route.request().url()).pathname) === css
          ? route.fulfill({ body: stylesheet, contentType: "text/css" })
          : route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
      );
      await page.route(`${origin}api/**`, (route) =>
        route.fulfill({ json: { code: 0, data: [] } }),
      );
      if (moreMenu) await page.route("**/credits", (route) => route.abort("internetdisconnected"));
      await page.route(`${origin}audit`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "" : "canvas-workspace"}" style="position:fixed;inset:0;background:${auditSettings ? "var(--canvas-bg)" : `oklch(${theme === "dark" ? ".13" : ".975"} 0 0)`}"></main><script type="module" src="${entry}"></script>`,
        }),
      );
      if (auditSettings && !upstream)
        await page.exposeFunction("applyAuditTheme", (value) =>
          page.emulateMedia({ colorScheme: value === "system" ? theme : value }),
        );
      await page.goto(`${origin}audit`);
      if (editTools) {
        const select = page.getByRole("radio", { name: "选择", exact: true }),
          pan = page.getByRole("radio", { name: "抓手" }),
          add = page.getByRole("button", { name: "添加节点" }),
          tasks = page.getByRole("button", { name: "任务历史" });
        measurements[name] = {};
        const checks = measurements[name];
        const checkpoint = async (key) => {
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
            ),
          );
          const frame = await stableFrame(page, `${name}-${key}`);
          if (!menuFrames.has(key)) menuFrames.set(key, []);
          menuFrames.get(key).push(frame.toString("base64"));
        };
        if (historyLifecycle) {
          checks.lifecycle = await replayHistoryLifecycle(page, upstream, expect, checkpoint);
          assert.deepEqual(pageErrors, []);
          continue;
        }
        if (historyRows) {
          checks.boxes = await replayHistory(page, upstream, expect, checkpoint);
          assert.deepEqual(pageErrors, []);
          continue;
        }
        await expect(select).toBeChecked();
        await checkpoint("select");
        checks.buttons = await Promise.all(
          (narrow ? [add, select, pan] : [add, select, pan, tasks]).map((button) =>
            button.boundingBox(),
          ),
        );
        await pan.click();
        await expect(pan).toBeChecked();
        await page.mouse.move(500, 300);
        await checkpoint("pan");
        await select.hover();
        await expect(
          page.locator(upstream ? "[data-slot=tooltip-content]" : ".canvas-control-tip"),
        ).toContainText("选择");
        await checkpoint("tip");
        await add.click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.mouse.move(500, 300);
        await checkpoint("add-menu");
        await page.getByRole("menuitem", { name: "文本", exact: true }).click();
        await expect(page.getByRole("button", { name: "撤销" })).toBeEnabled();
        if (narrow) await expect(tasks).toBeHidden();
        else {
          await tasks.click();
          await expect(page.getByRole("dialog", { name: "任务历史" })).toBeVisible();
          await page.mouse.move(500, 300);
          await checkpoint("history");
          checks.sheet = await page.getByRole("dialog").boundingBox();
          if (historyLayers) {
            const selector = upstream ? "[data-slot=sheet-overlay]" : ".canvas-task-backdrop";
            for (const [phase, rule] of Object.entries({
              underlay: "visibility:hidden!important",
              blur: "background:transparent!important",
              tint: "backdrop-filter:none!important",
            })) {
              const override = await page.addStyleTag({ content: `${selector}{${rule}}` });
              await checkpoint(phase);
              await override.evaluate((element) => element.remove());
            }
            await checkpoint("restored");
          }
          measurements.overlayLayers ??= {};
          measurements.overlayLayers[name] = await page
            .locator(upstream ? "[data-slot=sheet-overlay]" : ".canvas-task-backdrop")
            .evaluate((element) => {
              const chain = [];
              for (let layer = element; layer; layer = layer.parentElement) {
                const style = getComputedStyle(layer);
                chain.push({
                  tag: layer.tagName,
                  classes: layer.className,
                  background: style.backgroundColor,
                  backdrop: style.backdropFilter,
                  opacity: style.opacity,
                  transform: style.transform,
                  isolation: style.isolation,
                  position: style.position,
                  zIndex: style.zIndex,
                  box: layer.getBoundingClientRect().toJSON(),
                });
              }
              return chain;
            });
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
        }
        assert.deepEqual(pageErrors, []);
        continue;
      }
      if (controls) {
        const zoom = page.getByRole("button", { name: "缩放", exact: true }),
          dots = page.getByRole("radio", { name: "点阵背景" }),
          none = page.getByRole("radio", { name: "无背景" }),
          map = page.getByRole("button", { name: "小地图" });
        measurements[name] = {};
        const checks = measurements[name];
        const checkpoint = async (key) => {
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
            ),
          );
          const frame = await stableFrame(page, `${name}-${key}`);
          if (!menuFrames.has(key)) menuFrames.set(key, []);
          menuFrames.get(key).push(frame.toString("base64"));
        };
        await page
          .locator(upstream ? "[data-position=bottom-left]" : ".canvas-controls")
          .waitFor({ state: "attached" });
        if (narrow) {
          await expect(zoom).toBeHidden();
          await checkpoint("hidden");
        } else {
          await expect(dots).toBeChecked();
          await checkpoint("idle");
          checks.boxes = await Promise.all(
            [dots, none, zoom, map, page.getByRole("button", { name: "快捷键" })].map((button) =>
              button.boundingBox(),
            ),
          );
          await none.click();
          await page.mouse.move(410, 410);
          await expect(none).toBeChecked();
          await checkpoint("none");
          await map.click();
          await page.mouse.move(410, 410);
          await expect(map).toHaveAttribute("aria-pressed", "true");
          await checkpoint("map");
          await zoom.press("Enter");
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          await checkpoint("zoom-menu");
          checks.menu = await menu.boundingBox();
          await page.getByRole("menuitem", { name: /^放大/ }).click();
          await expect
            .poll(() =>
              page
                .locator(".react-flow__viewport")
                .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a),
            )
            .toBeCloseTo(1.2, 4);
          await page.mouse.move(410, 410);
          await checkpoint("zoom-in");
          await page.getByRole("button", { name: "快捷键" }).hover();
          await expect(
            page.locator(upstream ? "[data-slot=tooltip-content]" : ".canvas-control-tip"),
          ).toContainText("快捷键");
          await checkpoint("help-tip");
        }
        assert.deepEqual(pageErrors, []);
        continue;
      }
      if (shortcuts) {
        const trigger = page.getByRole("button", { name: "快捷键" }),
          dialog = page.getByRole("dialog", { name: "快捷键" }),
          close = dialog.getByRole("button", { name: "Close" });
        measurements[name] = {};
        const checks = measurements[name];
        const snapshot = async (phase) => {
          await page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
            ),
          );
          const image = await stableFrame(page, `${name}-${phase}`);
          if (!menuFrames.has(phase)) menuFrames.set(phase, []);
          menuFrames.get(phase).push(image.toString("base64"));
        };
        await trigger.press("Enter");
        await expect(close).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await snapshot("keyboard");
        checks.elements = await dialog.evaluate((el) =>
          [el, ...el.querySelectorAll("h2,dt,kbd,button")].map((node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return [
              node.tagName,
              node.tagName === "KBD" || node.tagName === "DT" ? node.textContent : null,
              x,
              y,
              width,
              height,
            ];
          }),
        );
        await page.keyboard.press("Tab");
        await expect(close).toBeFocused();
        checks.tab = true;
        await snapshot("tab");
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        checks.restore = await trigger.evaluate((node) => node === document.activeElement);
        await snapshot("closed");
        await trigger.click();
        await expect(close).toBeVisible();
        await close.hover();
        await snapshot("hover");
        await close.click();
        await expect(dialog).toHaveCount(0);
        await trigger.click();
        await page.mouse.click(12, 12);
        await expect(dialog).toHaveCount(0);
        assert.deepEqual(pageErrors, []);
        continue;
      }
      if (moreMotion) {
        const trigger = page.getByRole("button", { name: "更多", exact: true });
        const selector = upstream ? "[data-slot=dropdown-menu-content]" : ".canvas-view-menu";
        const paused = await page.addStyleTag({
          content: `${selector}{animation-play-state:paused!important}`,
        });
        await trigger.press("Enter");
        await page.evaluate(() => document.fonts.ready);
        measurements[name] = {};
        const motion = measurements[name];
        for (const phase of ["open", "closed"]) {
          if (phase === "closed") await page.keyboard.press("Escape");
          const popup = page.locator(`${selector}[data-${phase}]`);
          await expect(popup).toHaveCount(1);
          for (const time of [0, 25, 50, 75, 99]) {
            const key = `${phase}-${time}`;
            motion[key] = await popup.evaluate(async (el, time) => {
              const animation = el
                .getAnimations()
                .find((animation) => animation instanceof CSSAnimation);
              await animation.ready;
              animation.currentTime = time;
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
              const css = getComputedStyle(el);
              return [
                animation.effect.getTiming().duration,
                css.opacity,
                css.transform,
                css.filter,
              ];
            }, time);
            assert.equal(motion[key][0], 100);
            const frame = await stableFrame(page, `${name}-${key}`, "allow");
            if (!menuFrames.has(key)) menuFrames.set(key, []);
            menuFrames.get(key).push(frame.toString("base64"));
          }
        }
        await paused.evaluate((style) => style.remove());
        await expect(page.locator(selector)).toHaveCount(0);
        await expect(trigger).toBeFocused();
        assert.deepEqual(pageErrors, []);
        continue;
      }
      if (moreMenu) {
        const trigger = page.getByRole("button", { name: "更多", exact: true });
        const zone = page.locator(upstream ? "[data-slot=chrome-zone]" : ".canvas-view-zone");
        const tip = page.locator(upstream ? "[data-slot=tooltip-content]" : ".canvas-more-tip");
        measurements[name] = {};
        const checks = measurements[name];
        async function capture(phase, element, anchor = trigger) {
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .map((a) => a.finished.catch(() => {})),
            ),
          );
          const whole = await stableFrame(page, `${name}-${phase}`);
          const local = await element.screenshot({
            path: join(captureDirectory, `${name}-${phase}-popup.png`),
          });
          measurements.menuPlacement ??= {};
          measurements.menuPlacement[`${name}-${phase}`] = {
            trigger: await anchor.boundingBox(),
            popup: await element.boundingBox(),
          };
          for (const [key, image] of [
            [phase, whole],
            [`${phase}-popup`, local],
          ]) {
            if (!menuFrames.has(key)) menuFrames.set(key, []);
            menuFrames.get(key).push(image.toString("base64"));
          }
          checks[phase] = await element.evaluate((el) => {
            const outer = el.getBoundingClientRect();
            return {
              width: outer.width,
              height: outer.height,
              items: Array.from(el.querySelectorAll('[role^="menuitem"]'), (item) => {
                const box = item.getBoundingClientRect();
                return [
                  item.textContent,
                  item.getAttribute("aria-checked"),
                  box.x - outer.x,
                  box.y - outer.y,
                  box.width,
                  box.height,
                ];
              }),
            };
          });
        }
        await expect(trigger).toBeVisible();
        await capture("idle", zone);
        await trigger.hover();
        await expect(tip).toBeVisible();
        await capture("tooltip", tip);
        await trigger.click();
        const mainMenu = page
          .getByRole("menu")
          .filter({ has: page.getByRole("menuitem", { name: "画布设置" }) });
        await capture("open", mainMenu);
        await page.getByRole("menuitem", { name: "主题", exact: true }).press("ArrowRight");
        const radio = page.getByRole("menuitemradio", { name: "跟随系统" });
        const submenu = page.getByRole("menu").filter({ has: radio });
        await capture("submenu", submenu);
        await radio.click();
        await expect(radio).toBeChecked();
        await capture("system", submenu);
        await page.keyboard.press("ArrowLeft");
        await expect(page.getByRole("menuitem", { name: "主题", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
        const credit = page.getByRole("button", { name: "积分，实时进度未连接", exact: true });
        await credit.click();
        const balance = page.locator(
          upstream ? "[data-slot=popover-content]" : ".canvas-credit-popup",
        );
        await expect(balance.locator("dd")).toHaveText(["—", "—"]);
        await capture("credit", balance, credit);
        await page.keyboard.press("Escape");
        await expect(credit).toBeFocused();
        const account = page.getByRole("button", { name: "账户", exact: true });
        await account.press("Enter");
        const accountMenu = page
          .getByRole("menu")
          .filter({ has: page.getByRole("menuitem", { name: "个人中心" }) });
        await capture("account", accountMenu, account);
        await page.keyboard.press("Escape");
        await expect(account).toBeFocused();
        assert.deepEqual(pageErrors, []);
        continue;
      }
      if (auditSettings) {
        const dialog = page.getByRole("dialog");
        measurements[name] = {};
        const checks = measurements[name];
        if (defaultModels) {
          await dialog.getByRole("button", { name: "模型设置", exact: true }).click();
          const trigger = dialog.getByRole("button", { name: "选择视频节点的默认模型" });
          for (const phase of ["default", "open", "picked", "closed", "reset"]) {
            if (phase === "open") await trigger.press("Enter");
            if (phase === "picked")
              await page.getByRole("menuitemradio", { name: /视频模型 2/ }).click();
            if (phase === "closed") {
              await page.keyboard.press("Escape");
              await expect(trigger).toBeFocused();
            }
            if (phase === "reset") await dialog.getByRole("button", { name: "恢复默认" }).click();
            await page.mouse.move(1, 1);
            await page.evaluate(() => document.fonts.ready);
            await expect(trigger).toHaveText(
              phase === "picked" || phase === "closed" ? "视频模型 2" : "视频模型 1",
            );
            if (phase === "picked")
              await expect(page.getByRole("menuitemradio", { name: /视频模型 2/ })).toBeChecked();
            const buttons = dialog.getByRole("button", { name: /节点的默认模型$/ });
            await expect(buttons).toHaveCount(4);
            const frame = await stableFrame(page, `${name}-${phase}`);
            checks[phase] = await buttons.evaluateAll((elements) =>
              elements.map((el) => [el.textContent, el.getBoundingClientRect().toJSON()]),
            );
            if (phase === "open" || phase === "picked")
              checks[phase].push(await page.getByRole("menu").boundingBox());
            if (!menuFrames.has(phase)) menuFrames.set(phase, []);
            menuFrames.get(phase).push(frame.toString("base64"));
          }
          assert.deepEqual(pageErrors, []);
          continue;
        }
        for (const [phase, choice] of [
          ["default", null],
          ["cross", "十字"],
          ["zoom", "缩放画布"],
          ["reset", "恢复默认"],
          ["general", "通用设置"],
          ["light", "浅色"],
          ["hints-off", "switch"],
          ["system", "跟随系统"],
          ["general-reset", "恢复默认"],
        ]) {
          if (choice === "switch") await dialog.getByRole("switch").click();
          else if (choice) await dialog.getByRole("button", { name: choice, exact: true }).click();
          const general = (await dialog.getByRole("switch").count()) > 0;
          const rows = dialog
            .getByText(general ? "操作提示" : "背景网格", { exact: true })
            .locator("../..")
            .locator("..");
          if (choice === "恢复默认" || choice === "浅色" || choice === "跟随系统") {
            const dark = choice === "恢复默认" || (choice === "跟随系统" && theme === "dark");
            await expect
              .poll(() =>
                page.evaluate(
                  (upstream) =>
                    upstream
                      ? document.documentElement.classList.contains("dark")
                      : matchMedia("(prefers-color-scheme: dark)").matches,
                  upstream,
                ),
              )
              .toBe(dark);
          }
          await page.mouse.move(1, 1);
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .map((a) => a.finished.catch(() => {})),
            ),
          );
          const frame = await stableFrame(page, `${name}-${phase}`);
          const body = await rows.screenshot({ path: join(output, `${name}-${phase}-rows.png`) });
          for (const [key, image] of [
            [phase, frame],
            [`${phase}-rows`, body],
          ]) {
            if (!menuFrames.has(key)) menuFrames.set(key, []);
            menuFrames.get(key).push(image.toString("base64"));
          }
          checks[phase] = await rows
            .getByRole("button")
            .evaluateAll((buttons) =>
              buttons.map((button) => [
                button.textContent,
                button.getAttribute("aria-pressed"),
                button.getBoundingClientRect().toJSON(),
              ]),
            );
          checks[phase].push(
            await page.locator("main").evaluate((el) => getComputedStyle(el).backgroundColor),
          );
          checks[phase].push(
            await dialog
              .locator("nav button")
              .evaluateAll((buttons) =>
                buttons.map((el) => [el.textContent, el.getBoundingClientRect().toJSON()]),
              ),
          );
          if (general)
            checks[phase].push(
              await rows
                .getByRole("switch")
                .evaluate((el) => [
                  "switch",
                  el.getAttribute("aria-checked"),
                  el.getBoundingClientRect().toJSON(),
                ]),
            );
        }
        assert.deepEqual(pageErrors, []);
        continue;
      }
      if (pattern || auditPatterns)
        await page.waitForFunction(() => typeof window.setAuditView === "function");
      if (auditPatterns) {
        if (upstream)
          await page.evaluate(
            async (theme) => (await import("/src/lib/theme.ts")).applyTheme(theme),
            theme,
          );
        measurements[name] = {};
        const checks = measurements[name];
        for (const mode of ["dots", "lines", "cross", "none"])
          for (const zoom of [0.14, 0.2, 0.49, 0.5, 1, 1.5]) {
            await page.evaluate(
              async ([mode, zoom]) => {
                await window.setAuditView(mode, zoom);
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
              },
              [mode, zoom],
            );
            const key = `${mode}-${zoom}`,
              hidden = mode === "none" || (mode === "dots" && zoom < 0.5);
            const tile = page.locator(".react-flow__background pattern");
            await expect(tile).toHaveCount(hidden ? 0 : 1);
            if (!hidden) {
              await expect(tile).toHaveAttribute("width", String(20 * zoom));
              if (mode === "dots") await expect(tile.locator("circle")).toHaveAttribute("r", "1");
            }
            checks[key] = await tile.evaluateAll((elements) =>
              elements.map((el) => [
                el.getAttribute("x"),
                el.getAttribute("y"),
                el.getAttribute("patternTransform"),
                el.firstElementChild.outerHTML,
              ]),
            );
            const frame = await stableFrame(page, `${name}-${key}`);
            if (!menuFrames.has(key)) menuFrames.set(key, []);
            menuFrames.get(key).push(frame.toString("base64"));
          }
        assert.deepEqual(pageErrors, []);
        continue;
      }
      if (inspectVideo) {
        const cells = page.locator("#cells");
        await cells.waitFor();
        if (upstream)
          await page.evaluate(
            async (theme) => (await import("/src/lib/theme.ts")).applyTheme(theme),
            theme,
          );
        await page.addStyleTag({
          content:
            "#cells *, #cells *::before, #cells *::after { animation: none !important; transition: none !important; }",
        });
        await page.evaluate(() => document.fonts.ready);
        if (process.env.SHOT_CELL_METRICS) {
          const metrics = await cells.locator("[data-phase]").evaluateAll((rows) =>
            rows.map((row) => ({
              phase: row.dataset.phase,
              elements: Array.from(row.querySelectorAll("div,button,i,span,svg")).map((element) => {
                const style = getComputedStyle(element);
                const { x, y, width, height } = element.getBoundingClientRect();
                return [
                  element.tagName,
                  x,
                  y,
                  width,
                  height,
                  style.color,
                  style.font,
                  style.padding,
                  style.gap,
                ];
              }),
            })),
          );
          await writeFile(join(output, `${name}-metrics.json`), JSON.stringify(metrics, null, 2));
        }
        const screenshot = await cells.screenshot({
          path: join(output, `${name}.png`),
          animations: "disabled",
        });
        assert(screenshot.equals(await cells.screenshot({ animations: "disabled" })));
        captures.push(screenshot.toString("base64"));
        measurements[name] = {};
        for (const phase of phases) {
          const cell = cells.locator(`[data-phase=${phase}]`);
          const text = (await cell.textContent()).trim();
          const button = cell.getByRole("button").first();
          await button.focus();
          await page.keyboard.press("Enter");
          const action = await page.locator("body").getAttribute("data-action");
          assert.equal(action, phase === "none" ? "create" : phase);
          measurements[name][phase] = { text, action, rect: await cell.boundingBox() };
        }
        continue;
      }
      const dialog = page.getByRole("dialog", { name: "雨夜分镜" });
      if (boardMotion) {
        if (upstream)
          await page.evaluate(
            async (theme) => (await import("/src/lib/theme.ts")).applyTheme(theme),
            theme,
          );
        const launch = page.getByRole("button", { name: "打开分镜表" });
        const selector = upstream
          ? "[data-slot=dialog-overlay],[data-slot=dialog-content]"
          : ".storyboard-backdrop,.storyboard-dialog";
        const paused = await page.addStyleTag({
          content: `${selector}{animation-play-state:paused!important}`,
        });
        await launch.click();
        await page.mouse.move(1, 1);
        await dialog.waitFor();
        await page.evaluate(() => document.fonts.ready);
        measurements[name] = {};
        const motion = measurements[name];
        for (const [phase, duration] of [
          ["open", 200],
          ["closed", 150],
        ]) {
          if (phase === "closed") await page.keyboard.press("Escape");
          const layers = page.locator(selector).and(page.locator(`[data-${phase}]`));
          await expect(layers).toHaveCount(2);
          for (const time of [0, duration / 4, duration / 2, (duration * 3) / 4, duration - 1]) {
            const key = `${phase}-${time}`;
            motion[key] = await layers.evaluateAll(async (elements, time) => {
              const animations = elements.map((el) =>
                el.getAnimations().find((animation) => animation instanceof CSSAnimation),
              );
              await Promise.all(animations.map((animation) => animation.ready));
              for (const animation of animations) animation.currentTime = time;
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
              return elements.map((el, index) => [
                animations[index].effect.getTiming().duration,
                getComputedStyle(el).opacity,
                getComputedStyle(el).transform,
              ]);
            }, time);
            assert(motion[key].every(([actual]) => actual === duration));
            const frame = await stableFrame(page, `${name}-${key}`, "allow");
            if (!menuFrames.has(key)) menuFrames.set(key, []);
            menuFrames.get(key).push(frame.toString("base64"));
          }
        }
        await paused.evaluate((style) => style.remove());
        const shell = page.locator(selector);
        await expect(shell).toHaveCount(0);
        for (const method of ["outside", "close", "Escape", "Tab-Escape"]) {
          await launch.click();
          const scene = dialog.locator("textarea").first();
          await scene.fill(method);
          if (method === "outside") await page.mouse.click(1, 1);
          else if (method === "close")
            await dialog
              .locator(upstream ? "[data-slot=dialog-close]" : ".storyboard-close")
              .click();
          else {
            if (method === "Tab-Escape") await scene.press("Tab");
            await page.keyboard.press("Escape");
          }
          await expect(shell).toHaveCount(0);
          await expect
            .poll(() =>
              page.locator("output").evaluate((el) => JSON.parse(el.dataset.boardRows)[0].scene),
            )
            .toBe(method === "Escape" ? "close" : method);
        }
        assert.deepEqual(pageErrors, []);
        continue;
      }
      await dialog.waitFor({ timeout: 15000 });
      if (upstream)
        await page.evaluate(
          async (theme) => (await import("/src/lib/theme.ts")).applyTheme(theme),
          theme,
        );
      if (overwrite) {
        if (upstream)
          await page.evaluate(async (models) => {
            const { useModelsStore } = await import("/src/store/models.ts");
            useModelsStore.setState({
              byKind: { agent: { status: "ready", models, loadedAt: Date.now() } },
            });
          }, models);
        const trigger = dialog.getByRole("button", { name: "从剧本拆分镜" }),
          popup = page.getByRole("alertdialog", { name: "分镜表里已有 2 个镜头" }),
          trace = [];
        const remember = async (key) =>
          trace.push([
            key,
            await page.evaluate(async () => {
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
              return document.activeElement === document.body
                ? "BODY"
                : document.activeElement?.textContent?.trim().slice(0, 25);
            }),
          ]);
        await trigger.click();
        await expect(popup).toBeVisible();
        await page.mouse.move(1, 1);
        await remember("open");
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((item) => item.effect?.getTiming().iterations !== Infinity)
              .map((item) => item.finished.catch(() => {})),
          ),
        );
        captures.push((await stableFrame(page, name)).toString("base64"));
        const rects = await popup.evaluate((el) =>
          [el, ...el.querySelectorAll("h2,h3,button")].map((item) => ({
            text: item === el ? "popup" : item.textContent,
            ...item.getBoundingClientRect().toJSON(),
          })),
        );
        const closed = () =>
          page
            .locator("[role=alertdialog]")
            .filter({ hasText: "追加到末尾" })
            .waitFor({ state: "detached" });
        const checkpoint = async (key, paused = false) => {
          if (!paused)
            await page.evaluate(() =>
              Promise.all(
                document
                  .getAnimations()
                  .filter((item) => item.effect?.getTiming().iterations !== Infinity)
                  .map((item) => item.finished.catch(() => {})),
              ),
            );
          const image = await stableFrame(page, `${name}-${key}`, paused ? "allow" : "disabled");
          if (!menuFrames.has(key)) menuFrames.set(key, []);
          menuFrames.get(key).push(image.toString("base64"));
        };
        for (const [index, key] of ["Tab", "Tab", "Shift+Tab", "Escape"].entries()) {
          await page.keyboard.press(key);
          if (key === "Escape") await closed();
          await remember(key);
          if (index < 2) await checkpoint(index ? "cancel-focus" : "replace-focus");
        }
        await trigger.click();
        await popup.getByRole("button", { name: "覆盖" }).hover();
        await checkpoint("replace-hover");
        await popup.getByRole("button", { name: "追加到末尾" }).hover();
        await checkpoint("append-hover");
        await page.keyboard.press("Escape");
        await closed();
        await trigger.click();
        await page.mouse.click(1, 1);
        await expect(popup).toBeVisible();
        await remember("outside");
        await popup.getByRole("button", { name: "取消" }).click();
        await closed();
        await remember("cancel");
        await expect(trigger).toBeVisible();
        const motion = {};
        if (overwriteMotion) {
          const selector = upstream
            ? "[data-slot=alert-dialog-overlay],[data-slot=alert-dialog-content]"
            : ".shot-confirm-backdrop,.shot-confirm[data-small]";
          const paused = await page.addStyleTag({
            content: `${selector}{animation-play-state:paused!important}`,
          });
          await trigger.press("Enter");
          for (const [phase, duration] of [
            ["open", 200],
            ["closed", 150],
          ]) {
            if (phase === "closed") await page.keyboard.press("Escape");
            const layers = page.locator(selector).and(page.locator(`[data-${phase}]`));
            await expect(layers).toHaveCount(2);
            for (const time of [0, duration / 4, duration / 2, (duration * 3) / 4, duration - 1]) {
              const key = `${phase}-${time}`;
              motion[key] = await layers.evaluateAll(async (elements, time) => {
                const animations = elements.map((el) =>
                  el.getAnimations().find((animation) => animation instanceof CSSAnimation),
                );
                await Promise.all(animations.map((animation) => animation.ready));
                for (const animation of animations) animation.currentTime = time;
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
                return elements.map((el, index) => ({
                  duration: animations[index].effect.getTiming().duration,
                  opacity: getComputedStyle(el).opacity,
                  transform: getComputedStyle(el).transform,
                  title: el.querySelector("h2,h3")?.textContent ?? "",
                }));
              }, time);
              assert(motion[key].every((layer) => layer.duration === duration));
              await checkpoint(key, true);
            }
          }
          await paused.evaluate((style) => style.remove());
          await closed();
        }
        await trigger.click();
        await expect(popup.getByRole("button", { name: "追加到末尾" })).toBeFocused();
        for (const button of ["覆盖", "取消"]) {
          await page.keyboard.press("Tab");
          await expect(popup.getByRole("button", { name: button })).toBeFocused();
        }
        await page.mouse.click(1, 1);
        await expect(popup).toBeVisible();
        await page.keyboard.press("Escape");
        await closed();
        await page.locator("[role=dialog][data-closed]").waitFor({ state: "detached" });
        await remember("outside-escape");
        trace.push(["outside-escape-parent", await dialog.count()]);
        assert.deepEqual(pageErrors, []);
        measurements[name] = { trace, rects, motion };
        continue;
      }
      if (rowMenus) {
        const popup = page.locator(
          upstream ? "[data-slot=popover-content][data-open]" : ".shot-row-menu[data-open]",
        );
        const trigger = (index) => dialog.getByRole("button", { name: `第 ${index} 镜的操作` });
        await trigger(1).evaluate(async (element) => {
          await document.fonts.ready;
          await new Promise(requestAnimationFrame);
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished),
          );
          let scroller = element.parentElement;
          while (scroller && getComputedStyle(scroller).overflowX !== "auto")
            scroller = scroller.parentElement;
          if (!scroller) throw new Error("未找到分镜横向滚动容器");
          scroller.scrollLeft = scroller.scrollWidth;
        });
        measurements[name] = {};
        const trace = measurements[name];
        const saveFrame = async (key) => {
          const png = await stableFrame(page, `${name}-${key}`);
          if (!menuFrames.has(key)) menuFrames.set(key, []);
          menuFrames.get(key).push(png.toString("base64"));
        };
        const frame = async (key) => {
          await popup.waitFor();
          await saveFrame(key);
          trace[key] = {
            side: await popup.getAttribute("data-side"),
            box: await popup.boundingBox(),
            buttons: await popup.getByRole("button").allTextContents(),
          };
        };
        await trigger(1).click();
        await popup.getByRole("button", { name: "在下方插入" }).hover();
        await frame("hover");
        await popup.getByRole("button", { name: "删除镜头" }).click();
        await frame("confirm");
        await popup.getByRole("button", { name: "取消" }).click();
        await expect(popup.getByRole("button", { name: "复制镜头" })).toBeVisible();
        trace.afterCancelFocus = await popup.evaluate(
          (element) => document.activeElement === element,
        );
        await page.keyboard.press("Escape");
        await expect(trigger(1)).toBeFocused();
        await trigger(shots.length).click();
        await page.mouse.move(1, 1);
        await frame("last");
        await page.keyboard.press("Escape");
        await expect(trigger(shots.length)).toBeFocused();
        await expect(popup).toHaveCount(0);
        await saveFrame("escape");
        assert.deepEqual(
          await page
            .locator("output[data-board-rows]")
            .evaluate((el) => JSON.parse(el.dataset.boardRows).map((shot) => shot.id)),
          shots.map((shot) => shot.id),
        );
        await trigger(1).click();
        await popup.getByRole("button", { name: "删除镜头" }).click();
        await popup.getByRole("button", { name: "删除", exact: true }).click();
        await expect(dialog.locator("[data-shot-id]")).toHaveCount(shots.length - 1);
        trace.remainingIds = await page
          .locator("output[data-board-rows]")
          .evaluate((el) => JSON.parse(el.dataset.boardRows).map((shot) => shot.id));
        assert.deepEqual(
          trace.remainingIds,
          shots.slice(1).map((shot) => shot.id),
        );
        continue;
      }
      if (edit) {
        const rows = dialog.locator("[data-shot-id]");
        const snapshots = {};
        const checkpoint = async (key, scenes) => {
          const stored = () =>
            page
              .locator("output[data-board-rows]")
              .evaluate((el) => JSON.parse(el.dataset.boardRows));
          await expect.poll(async () => (await stored()).map((row) => row.scene)).toEqual(scenes);
          snapshots[key] = (await stored()).map(({ id, ...fields }) => fields);
        };
        const menuAction = async (index, action) => {
          await rows
            .nth(index)
            .getByRole("button", { name: `第 ${index + 1} 镜的操作` })
            .click();
          const opened = page.locator(
            upstream ? "[data-slot=popover-content][data-open]" : ".shot-row-menu[data-open]",
          );
          await opened.getByRole("button", { name: action, exact: true }).click();
        };
        const duration = rows.first().getByRole("textbox", { name: "时长（秒）" });
        await duration.fill("61.2");
        await duration.press("Enter");
        await expect(duration).toHaveValue("60");
        await duration.fill(" ");
        await duration.press("Tab");
        await expect(duration).toHaveValue("60");
        await duration.fill("3.16");
        await duration.press("ArrowUp");
        await expect(duration).toHaveValue("3.7");
        await checkpoint("duration", ["站台清晨", ""]);
        assert.equal(snapshots.duration[0].duration, 3.7);
        await menuAction(0, "复制镜头");
        await checkpoint("duplicate", ["站台清晨", "站台清晨", ""]);
        await menuAction(1, "在下方插入");
        const scene = rows.nth(2).getByRole("textbox", { name: /画面描述/ });
        await expect(scene).toBeFocused();
        await scene.fill("乘客进站");
        await scene.press("Tab");
        await checkpoint("insert", ["站台清晨", "站台清晨", "乘客进站", ""]);
        await menuAction(1, "删除镜头");
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await page.keyboard.press("Escape");
        await checkpoint("cancel", ["站台清晨", "站台清晨", "乘客进站", ""]);
        await menuAction(1, "删除镜头");
        await page.getByRole("button", { name: "删除", exact: true }).click();
        await checkpoint("remove", ["站台清晨", "乘客进站", ""]);
        const moving = rows.nth(1).getByRole("button", { name: "拖动第 2 镜排序" });
        await moving.hover();
        const destination = await rows
          .first()
          .getByRole("button", { name: "拖动第 1 镜排序" })
          .boundingBox();
        assert(destination);
        await page.mouse.down();
        try {
          await page.mouse.move(destination.x + 8, destination.y + 4, { steps: 16 });
          await expect(rows.first().getByRole("textbox", { name: /画面描述/ })).toHaveValue(
            "乘客进站",
          );
          await checkpoint("dragging", ["站台清晨", "乘客进站", ""]);
        } finally {
          await page.mouse.up();
        }
        await checkpoint("drop", ["乘客进站", "站台清晨", ""]);
        await rows
          .last()
          .getByRole("textbox", { name: /画面描述/ })
          .focus();
        await page.keyboard.press("Tab");
        await expect(rows.last().getByRole("textbox", { name: /画面描述/ })).toHaveAttribute(
          "aria-invalid",
          "true",
        );
        measurements[name] = snapshots;
        if (!upstream) assert.deepEqual(snapshots, measurements.upstream);
      }
      let addScroll;
      if (inspectBatch) {
        const add = dialog.getByRole("button", { name: "添加镜头" });
        addScroll = await add.evaluate(async (button) => {
          await document.fonts.ready;
          await new Promise(requestAnimationFrame);
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished),
          );
          let body = button.parentElement;
          while (
            body &&
            !(
              body.scrollWidth > body.clientWidth &&
              ["auto", "scroll"].includes(getComputedStyle(body).overflowX)
            )
          )
            body = body.parentElement;
          if (!body) throw new Error("缺少可横向滚动的表格");
          const before = button.getBoundingClientRect().toJSON();
          body.scrollLeft = 120;
          await new Promise(requestAnimationFrame);
          const after = button.getBoundingClientRect().toJSON();
          const offset = body.scrollLeft;
          body.scrollLeft = 0;
          return { before, after, offset };
        });
        assert(addScroll.offset > 0);
        assert.equal(addScroll.before.x, addScroll.after.x);
        await dialog.getByRole("button", { name: "批量生成分镜图" }).click();
        await page.getByRole("alertdialog", { name: "生成 1 张分镜图？" }).waitFor();
      }
      if (inspectModels) {
        if (upstream)
          await page.evaluate(async (models) => {
            const { useModelsStore } = await import("/src/store/models.ts");
            useModelsStore.setState({
              byKind: { agent: { status: "ready", models, loadedAt: Date.now() } },
            });
          }, models);
        await dialog.getByRole("button", { name: /分镜模型 A/ }).click();
        await page.getByRole("button", { name: /分镜模型 A.*默认/ }).waitFor();
      }
      await page.mouse.move(1, 1);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished),
        );
      });
      const heading = dialog.getByRole("heading", {
        name: "雨夜分镜",
        includeHidden: inspectBatch,
      });
      if (inspectRows || inspectBatch) {
        assert.equal(await dialog.getByRole("button", { name: /拆为(图片|视频)节点/ }).count(), 0);
        assert.equal(await dialog.getByRole("group", { name: "生成类型" }).count(), 0);
      }
      if (process.env.SHOT_HEADER_METRICS) {
        const header = await heading.evaluate((title) =>
          Array.from(title.parentElement.querySelectorAll("*")).map((element) => {
            const style = getComputedStyle(element);
            return [
              element.tagName,
              element.textContent,
              element.getBoundingClientRect().toJSON(),
              style.font,
              style.backgroundColor,
              style.color,
              style.boxShadow,
            ];
          }),
        );
        await writeFile(join(output, `${name}-header.json`), JSON.stringify(header, null, 2));
      }
      const stats = dialog.getByTitle("共 0 秒");
      const empty = dialog.getByText("还没有镜头", { exact: true });
      if (edit) {
        await dialog.getByRole("heading", { name: "雨夜分镜" }).click();
      } else if (inspectRows) {
        const row = dialog.locator('[data-shot-id="shot-0"]');
        if (inspectFocus) {
          const scene = dialog.locator('[data-shot-id="shot-1"] textarea').first();
          assert(
            await scene.evaluate((element) => element === document.activeElement),
            `${name} 未聚焦到指定镜头的画面描述`,
          );
        }
        measurements[name] = {
          row: await row.boundingBox(),
          head: await dialog.getByText("画面描述", { exact: false }).first().boundingBox(),
          image: await row
            .locator(upstream ? "[data-slot=shot-image-cell]" : ".shot-image-frame")
            .boundingBox(),
          text: await row.locator("textarea").first().boundingBox(),
          menu: await row.locator("button").last().boundingBox(),
          add: await dialog.getByRole("button", { name: "添加镜头" }).boundingBox(),
        };
      } else if (inspectBatch) {
        const confirmation = page.getByRole("alertdialog");
        measurements[name] = {
          addScroll,
          confirm: await confirmation.boundingBox(),
          start: await confirmation.getByRole("button", { name: "开始生成" }).boundingBox(),
        };
        await confirmation.screenshot({ path: join(output, `${name}-confirm.png`) });
      } else
        measurements[name] = {
          dialog: await dialog.boundingBox(),
          title: await heading.boundingBox(),
          stats: await stats.boundingBox(),
          empty: await empty.boundingBox(),
          add: await dialog.getByRole("button", { name: "添加镜头" }).boundingBox(),
        };
      const screenshot = await stableFrame(page, name);
      if (inspectModels) {
        const menu = page.locator(upstream ? "[data-slot=popover-content]" : ".shot-model-popup");
        if (process.env.SHOT_HEADER_METRICS)
          await writeFile(
            join(output, `${name}-menu.json`),
            JSON.stringify(
              await menu.evaluate((popup) =>
                [popup, ...popup.querySelectorAll("button,button > *")].map((element) => {
                  const style = getComputedStyle(element);
                  return {
                    tag: element.tagName,
                    text: element.textContent,
                    box: element.getBoundingClientRect(),
                    focus: element === document.activeElement,
                    shadow: style.boxShadow,
                    radius: style.borderRadius,
                    background: style.backgroundColor,
                    color: style.color,
                    font: style.font,
                  };
                }),
              ),
              null,
              2,
            ),
          );
        measurements[name].menu = await menu.boundingBox();
        await menu.screenshot({ path: join(output, `${name}-menu.png`) });
        const modelTrigger = dialog
          .locator("button[aria-haspopup=dialog]")
          .filter({ hasText: /分镜模型/ });
        await menu.getByRole("button", { name: /分镜模型 B/ }).click();
        await expect(modelTrigger).toHaveText(/分镜模型 B/);
        await modelTrigger.press("Enter");
        await expect(
          menu.getByRole("button", { name: /分镜模型 B/ }).locator("svg.lucide-check"),
        ).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(modelTrigger).toBeFocused();
        await modelTrigger.press("Enter");
        await menu.getByRole("button", { name: /分镜模型 A.*默认/ }).click();
        await expect(modelTrigger).toHaveText(/分镜模型 A/);
      }
      if (inspectBatch) {
        const alert = page.getByRole("alertdialog", { name: "生成 1 张分镜图？" });
        const batch = dialog.getByRole("button", { name: "批量生成分镜图" });
        const start = alert.getByRole("button", { name: "开始生成" });
        const cancel = alert.getByRole("button", { name: "取消" });
        const focusTrace = [];
        const remember = async (label) =>
          focusTrace.push([
            label,
            await page.evaluate(async () => {
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
              const active = document.activeElement;
              if (active === document.body) return "body";
              if (active?.matches("[data-slot=dialog-close],.storyboard-close"))
                return "close-board";
              return active?.textContent?.trim().slice(0, 20);
            }),
          ]);
        await expect(start).toBeFocused();
        for (const [key, button] of [
          ["Tab", cancel],
          ["Tab", start],
          ["Shift+Tab", cancel],
        ]) {
          await page.keyboard.press(key);
          await expect(button).toBeFocused();
          await remember(key);
        }
        await page.keyboard.press("Escape");
        await expect(alert).toHaveCount(0);
        await remember("Escape");
        await batch.click();
        await expect(start).toBeFocused();
        await page.mouse.click(1, 1);
        await expect(alert).toBeVisible();
        await remember("outside");
        await page.keyboard.press("Tab");
        await remember("outside-tab");
        await cancel.click();
        await expect(alert).toHaveCount(0);
        await remember("cancel");
        measurements[name].focusTrace = focusTrace;
        await expect(batch).toBeVisible();
        if (batchMotion) {
          const modal = page.locator("[role=alertdialog]").filter({ hasText: "生成 1 张分镜图？" });
          const paused = await page.addStyleTag({
            content: "[role=alertdialog]{animation-play-state:paused!important}",
          });
          measurements[name].motion = {};
          const motion = measurements[name].motion;
          await batch.press("Enter");
          for (const [phase, duration] of [
            ["open", 200],
            ["closed", 150],
          ]) {
            if (phase === "closed") await page.keyboard.press("Escape");
            const panel = modal.and(page.locator(`[data-${phase}]`));
            await panel.waitFor({ state: "attached" });
            for (const time of [0, duration / 4, duration / 2, (duration * 3) / 4, duration - 1]) {
              const key = `${phase}-${time}`;
              motion[key] = await panel.evaluate(async (element, time) => {
                const animation = element
                  .getAnimations()
                  .find((animation) => animation instanceof CSSAnimation);
                if (!animation) throw new Error("确认框缺少 CSS 动画");
                await animation.ready;
                animation.currentTime = time;
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
                const style = getComputedStyle(element);
                return {
                  duration: animation.effect.getTiming().duration,
                  opacity: style.opacity,
                  transform: style.transform,
                };
              }, time);
              assert.equal(motion[key].duration, duration);
              const frame = await stableFrame(page, `${name}-${key}`, "allow");
              if (!menuFrames.has(key)) menuFrames.set(key, []);
              menuFrames.get(key).push(frame.toString("base64"));
            }
          }
          await paused.evaluate((style) => style.remove());
          await expect(modal).toHaveCount(0);
        }
        assert.deepEqual(pageErrors, []);
      }
      captures.push(screenshot.toString("base64"));
    } finally {
      await page.close();
      await server.close();
    }
  }
  const compare = await browser.newPage();
  if (inspectVideo) assert.deepEqual(measurements.desktop, measurements.upstream);
  const difference = (images) =>
    compare.evaluate(async (images) => {
      const pixels = await Promise.all(
        images.map(async (image) => {
          const bitmap = new Image();
          bitmap.src = `data:image/png;base64,${image}`;
          await bitmap.decode();
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d");
          context.drawImage(bitmap, 0, 0);
          return new Uint32Array(
            context.getImageData(0, 0, canvas.width, canvas.height).data.buffer,
          );
        }),
      );
      if (pixels[0].length !== pixels[1].length) throw new Error("对拍图像大小不同");
      return pixels[0].reduce(
        (count, value, index) => count + Number(value !== pixels[1][index]),
        0,
      );
    }, images);
  if (auditSettings || auditPatterns || boardMotion || rowMenus || batchMotion || overwrite) {
    measurements.frames = Object.fromEntries(
      await Promise.all(
        Array.from(menuFrames, async ([key, images]) => [key, await difference(images)]),
      ),
    );
    measurements.differentPixels = Object.values(measurements.frames).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (batchMotion || overwrite) {
      measurements.stablePixels = await difference(captures);
      measurements.differentPixels += measurements.stablePixels;
    }
  } else measurements.differentPixels = await difference(captures);
  await writeFile(join(captureDirectory, "results.json"), JSON.stringify(measurements, null, 2));
  if (inspectRows) {
    for (const [control, original] of Object.entries(measurements.upstream)) {
      const desktop = measurements.desktop[control];
      for (const dimension of ["x", "y", "width", "height"]) {
        assert(
          Math.abs(desktop[dimension] - original[dimension]) < 0.01,
          `${control} ${dimension} 与固定版不符`,
        );
      }
    }
  }
  if (inspectVideo) assert.equal(measurements.differentPixels, 0, "分镜视频格静态样式偏离固定版");
  console.log(measurements);
  if (inspectBatch)
    assert.deepEqual(measurements.desktop.focusTrace, measurements.upstream.focusTrace);
  if (batchMotion) assert.deepEqual(measurements.desktop.motion, measurements.upstream.motion);
  if (auditSettings || auditPatterns || boardMotion || rowMenus)
    assert.deepEqual(measurements.desktop, measurements.upstream);
  if (moreMenu && !moreMotion)
    for (const phase of Object.keys(measurements.upstream))
      assert.deepEqual(
        measurements.menuPlacement[`desktop-${phase}`],
        measurements.menuPlacement[`upstream-${phase}`],
        `${phase} 触发器或弹窗位置不符`,
      );
  if (overwrite) assert.deepEqual(measurements.desktop, measurements.upstream);
  if (process.argv.includes("--strict")) assert.equal(measurements.differentPixels, 0);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
