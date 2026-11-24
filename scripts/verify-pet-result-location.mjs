import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const outDir = await mkdtemp(path.join(tmpdir(), "pet-location-"));
const output = path.resolve("test-results/pet-result-location");
const entry = path.resolve("pet-location-fixture.jsx");
const source = `
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {ReactFlow, ReactFlowProvider, useReactFlow} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {usePetNotices, NoticeBubble} from './src/renderer/workspace/pet/notices';
import {locatePetResults} from './src/renderer/workspace/pet/locate-results';
import {canvasPetJobs} from './src/renderer/workspace/pet/result-observer';
import './src/renderer/styles.css';
import './src/renderer/workspace/canvas-workspace.css';
import './src/renderer/workspace/pet/pet.css';
const nodes = [-600,1100].map((x,index)=>({id:'image-'+index,position:{x,y:index*120},data:{label:'图片 '+(index+1)}}));
const getJobs=()=>nodes.map(node=>({id:'job-'+node.id,nodeId:node.id,kind:'image',status:'succeeded',updatedAt:new Date().toISOString()}));
function Scene(){
  const flow=useReactFlow();
  const [jobs,setJobs]=useState([]);
  const {bubble,dismiss}=usePetNotices({mode:'quiet',assistantBusy:false,assistantPending:false,panelOpen:false,dragging:false,pageVisible:true},true,undefined,undefined,undefined,jobs);
  window.complete=()=>{
    const completed = getJobs();
    const deleted = {...completed[0], id:'deleted', nodeId:'removed-node'};
    const studio = {...completed[0], id:'studio', purpose:'drama-segment'};
    setJobs(canvasPetJobs([...completed, deleted, studio], nodes));
  };
  return <><ReactFlow nodes={nodes} edges={[]} minZoom={0.1} proOptions={{hideAttribution:true}}/>
    {bubble && <NoticeBubble bubble={bubble} rect={{x:680,y:364,width:80,height:88}} area={{width:800,height:480}}
      pageVisible dismiss={dismiss} open={()=>{window.located=locatePetResults(flow,bubble.nodeIds)}}/>}</>;
}
createRoot(document.querySelector('main')).render(<ReactFlowProvider><Scene/></ReactFlowProvider>);`;
let browser;
try {
  await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "pet-location",
        resolveId: (id) => (id === entry ? entry : null),
        load: (id) => (id === entry ? source : null),
      },
    ],
    build: {
      outDir,
      lib: { entry, formats: ["es"], fileName: () => "fixture.js", cssFileName: "fixture" },
    },
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const viewport = { width: 800, height: 480 };
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await page.route("http://localhost/**", (route) => {
    const file = path.basename(new URL(route.request().url()).pathname);
    if (file === "fixture.js" || file === "fixture.css")
      return route.fulfill({ path: path.join(outDir, file) });
    if (file) return route.abort();
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="zh-CN"><meta charset=utf-8><link rel="stylesheet" href="/fixture.css"><main class="canvas-workspace" style="position:relative;display:block"></main><script type="module" src="/fixture.js"></script></html>',
    });
  });
  await page.goto("http://localhost/");
  const nodes = page.locator(".react-flow__node");
  await nodes.last().waitFor();
  const bounds = () =>
    nodes.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
  const before = await bounds();
  assert.ok(before[0].right < 0 && before[1].left > viewport.width);
  await page.evaluate(() => window.complete());
  await page.getByRole("button", { name: "2 张图好了", exact: true }).click();
  assert.equal(await page.evaluate(() => window.located), true);
  const after = await bounds();
  for (const rect of after)
    assert.ok(
      rect.left >= 0 &&
        rect.right <= viewport.width &&
        rect.top >= 0 &&
        rect.bottom <= viewport.height,
    );
  assert.equal(await page.getByRole("status").count(), 0);
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ viewport, before, after }, null, 2),
  );
  console.log("两个画外节点经合并结果气泡定位后均完整可见");
} finally {
  await browser?.close();
  await rm(outDir, { recursive: true, force: true });
}
