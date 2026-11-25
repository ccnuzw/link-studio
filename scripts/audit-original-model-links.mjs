import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const root = resolve(process.env.VIDEO_CANVAS_WEB);
const scratch = await mkdtemp(join(tmpdir(), "original-model-links-"));
const output = resolve("test-results/model-link-parity");
const entry = "/src/__model_link_audit.tsx";
const code = `import {createRoot} from 'react-dom/client';
import {ReactFlow,ReactFlowProvider,useReactFlow} from '@xyflow/react';import '@xyflow/react/dist/style.css';
import {useCanvasMenu} from '@/hooks/use-canvas-menu';import {canLinkNodes} from '@/utils/canvas/link-rule';import {useModelsStore} from '@/store/models';
const params=new URLSearchParams(location.search);const ops=params.get('ops').split(',');
useModelsStore.setState({byKind:{video:{status:'ready',models:[{key:'test',capabilities:{ops,refs:{image:{on:true},audio:{on:true},video:{on:true}}}}]}}});
const sourceKind=params.get('source')||'image';const nodes=params.has('fan')?['image','audio'].map((kind,index)=>({id:kind,position:{x:30,y:80+index*200},data:{kind,label:'来源-'+kind}})):[{id:'material',position:{x:50,y:50},data:{kind:sourceKind,label:'来源'}},{id:'video',position:{x:450,y:150},data:{kind:'video',model:'test',label:'视频',params:{op:params.get('op')||'t2v'}}}];
function Editor(){const flow=useReactFlow();const menu=useCanvasMenu({setNodes:flow.setNodes,setEdges:flow.setEdges,defaultModels:{video:'test'}});
window.fan=()=>menu.openGroupMenu({x:600,y:370},{nodeIds:['image','audio'],froms:[]});window.sampleFanReady=()=>!!menu.pendingGroup;window.createVideo=()=>menu.addNode('video');
window.fanResult=()=>{const target=flow.getNodes().find(node=>node.data.kind==='video');return target && {model:target.data.model,mode:target.data.params?.op,position:target.position,sources:flow.getEdges().filter(edge=>edge.target===target.id).map(edge=>edge.source).sort()}};
window.sample=()=>({pending:!!menu.pending,op:flow.getNode('video').data.params.op,edges:flow.getEdges().map(e=>[e.source,e.target]),uploads:flow.getNodes().filter(n=>n.data.uploaded).map(n=>({name:n.data.fileName,status:n.data.status,position:n.position}))});
window.upload=async count=>{menu.beginUpload();const canvas=document.createElement('canvas');canvas.width=canvas.height=8;const blob=await new Promise(r=>canvas.toBlob(r));return menu.addUploadedNodes(Array.from({length:count},(_,i)=>new File([blob],'样本'+i+'.png',{type:'image/png'})));};
return <ReactFlow defaultNodes={nodes} defaultEdges={params.has('duplicate')?[{id:'old',source:'material',target:'video'}]:[]} nodesDraggable={false} onConnect={menu.onConnect} onConnectEnd={menu.onConnectEnd} isValidConnection={e=>e.source!==e.target&&canLinkNodes(flow.getNode(e.source).data,flow.getNode(e.target).data)}/>;}
createRoot(document.querySelector('main')).render(<ReactFlowProvider><Editor/></ReactFlowProvider>);`;
const server = await createServer({
  root,
  configFile: false,
  cacheDir: scratch,
  resolve: { alias: { "@": join(root, "src") } },
  assetsInclude: ["**/*.glb"],
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "model-link-audit",
      resolveId: (id) => (id === entry ? id : undefined),
      load: (id) => (id === entry ? code : undefined),
    },
  ],
});
const browser = await chromium.launch({ channel: "chrome" });
try {
  await server.listen();
  await mkdir(output, { recursive: true });
  const origin = server.resolvedUrls.local[0];
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
  const results = {};
  let uploads = 0;
  await page.route("**/assets/upload-intents", (route) =>
    route.fulfill({ json: { code: 0, msg: "ok", data: { mode: "proxy" } } }),
  );
  await page.route("**/assets", (route) =>
    route.fulfill({
      json: { code: 0, msg: "ok", data: { id: ++uploads, url: "/fixture.png", kind: "image" } },
    }),
  );
  await page.route(`${origin}audit*`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><main style="position:fixed;inset:0"></main><script type="module" src="${entry}"></script>`,
    }),
  );
  async function open(ops, op, source = "image", duplicate = false) {
    await page.goto(
      origin +
        "audit?" +
        new URLSearchParams({ ops, op, source, ...(duplicate && { duplicate: "1" }) }),
    );
    await page.locator('[data-id="video"] .target').waitFor();
  }
  async function drag(selector, point) {
    const box = await page.locator(selector).boundingBox();
    assert(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 12 });
    await page.mouse.up();
  }
  for (const [source, ops, op, next] of [
    ["image", "t2v,i2v,omni", "t2v", "omni"],
    ["image", "t2v,i2v", "t2v", "i2v"],
    ["character", "t2v,i2v,omni", "i2v", "i2v"],
    ["audio", "t2v,i2v", "t2v", false],
    ["storyboard", "t2v", "t2v", "t2v"],
  ]) {
    await open(ops, op, source);
    await drag('[data-id="material"] .source', { x: 500, y: 165 });
    const expected = {
      pending: !next,
      op: next || op,
      edges: next ? [["material", "video"]] : [],
      uploads: [],
    };
    await expect.poll(() => page.evaluate(() => window.sample())).toEqual(expected);
    results[[source, ops, op].join(":")] = expected;
  }
  await open("t2v,i2v,omni", "t2v", "image", true);
  await drag('[data-id="material"] .source', { x: 500, y: 165 });
  const duplicate = { pending: false, op: "omni", edges: [["material", "video"]], uploads: [] };
  await expect.poll(() => page.evaluate(() => window.sample())).toEqual(duplicate);
  results.duplicate = duplicate;
  for (const [ops, mode, sources] of [
    ["t2v,i2v", "i2v", ["image"]],
    ["t2v,i2v,omni", "omni", ["audio", "image"]],
  ]) {
    await page.goto(`${origin}audit?${new URLSearchParams({ ops, fan: "1" })}`);
    await page.locator('[data-id="audio"]').waitFor();
    await page.evaluate(() => window.fan());
    await expect.poll(() => page.evaluate(() => window.sampleFanReady())).toBe(true);
    await page.evaluate(() => window.createVideo());
    const expected = { model: "test", mode, sources, position: { x: 600, y: 208 } };
    await expect.poll(() => page.evaluate(() => window.fanResult())).toEqual(expected);
    results[`fan-${mode}`] = expected;
  }
  for (const count of [1, 4]) {
    await open("t2v,i2v,omni", "t2v");
    await drag('[data-id="video"] .target', { x: 305, y: 352 });
    await expect.poll(() => page.evaluate(() => window.sample().pending)).toBe(true);
    const notice = await page.evaluate((count) => window.upload(count), count);
    assert.deepEqual(notice, {
      tone: "info",
      text:
        count === 1
          ? "图片接不到刚才那根线上，已单独放下"
          : `${count} 个节点接不到刚才那根线上，已单独放下`,
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.sample().uploads.filter((n) => n.status === "done").length),
      )
      .toBe(count);
    const final = await page.evaluate(() => window.sample());
    assert.deepEqual(final.edges, []);
    assert.equal(final.op, "t2v");
    assert.deepEqual(
      final.uploads.sort((a, b) => a.name.localeCompare(b.name)).map((n) => n.position),
      Array.from({ length: count }, (_, i) => ({
        x: 305 - 576 + (i % 3) * 440,
        y: 352 - 162 + Math.floor(i / 3) * 380,
      })),
    );
    results[`upload-${count}`] = { notice, ...final };
  }
  assert.equal(uploads, 5);
  await writeFile(join(output, "original.json"), JSON.stringify(results, null, 2));
  console.log(
    "6 model link drops, 2 default-model fan outs and 2 pending uploads matched; 5 files registered.",
  );
} finally {
  await browser.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
