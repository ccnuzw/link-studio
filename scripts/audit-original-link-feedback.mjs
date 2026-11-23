import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const root = resolve(process.env.VIDEO_CANVAS_WEB),
  assets = join(root, "dist/assets");
const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
assert(css);
const scratch = await mkdtemp(join(tmpdir(), "original-links-")),
  out = resolve("test-results/node-port-parity");
const entry = "/src/__original_link_feedback.tsx";
const code = `import {createRoot} from 'react-dom/client';import {ReactFlow,ReactFlowProvider,useReactFlow} from '@xyflow/react';import {useCanvasMenu} from '@/hooks/use-canvas-menu';
import {CanvasNodeView} from '@/components/canvas-editor/canvas-node';import {canLinkNodes} from '@/utils/canvas/link-rule';import {TooltipProvider} from '@/components/ui/tooltip';
import {uploadRunner} from '@/utils/canvas/upload-runner';
const params=new URLSearchParams(location.search),target=params.get('kind'),upload=params.get('upload');if(upload)uploadRunner.hold('source');const nodes=[{id:'source',data:{kind:upload?'video':'image',label:'来源',...(upload?{uploaded:true,uploadProgress:25,status:'running'}:{})},position:{x:0,y:100}},{id:'receiver',data:{kind:target,label:'候选节点',uploaded:target==='image'},position:{x:800,y:100}}].map(node=>({...node,type:'canvas'}));
const reverse=new URLSearchParams(location.search).has('reverse');const types={canvas:CanvasNodeView};function Editor(){const flow=useReactFlow();const menu=useCanvasMenu({setNodes:flow.setNodes,setEdges:flow.setEdges});window.canDrop=()=>canLinkNodes(flow.getNode(reverse?'receiver':'source').data,flow.getNode(reverse?'source':'receiver').data);window.afterDrop=()=>({menu:!!menu.pending,edges:flow.getEdges().map(edge=>[edge.source,edge.target])});return <ReactFlow defaultNodes={nodes} defaultEdges={[]} nodeTypes={types} defaultViewport={{x:60,y:45,zoom:.65}} nodesDraggable={false} onConnect={menu.onConnect} onConnectEnd={menu.onConnectEnd} isValidConnection={edge=>canLinkNodes(flow.getNode(edge.source).data,flow.getNode(edge.target).data)}/>;}
createRoot(document.querySelector('main')).render(<TooltipProvider><ReactFlowProvider><Editor/></ReactFlowProvider></TooltipProvider>);`;
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
      name: "reference-feedback",
      resolveId: (id) => (id === entry ? id : undefined),
      load: (id) => (id === entry ? code : undefined),
    },
  ],
});
const browser = await chromium.launch({ channel: "chrome" }),
  matrix = {};
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  await mkdir(out, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => console.error(error.message));
  await page.route(origin + "assets/**", (route) =>
    route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
  );
  await page.route(origin + "audit*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main style="position:fixed;inset:0"></main><script type="module" src="${entry}"></script>`,
    }),
  );
  const upload = process.argv.includes("--upload");
  for (const reverse of upload ? [false] : [false, true])
    for (const kind of upload
      ? ["video"]
      : ["script", "image", "video", "audio", "storyboard", "director", "character"]) {
      const key = (reverse ? "in-" : "out-") + kind;
      await page.goto(
        origin + "audit?kind=" + kind + (reverse ? "&reverse" : "") + (upload ? "&upload=1" : ""),
      );
      if (upload)
        await expect(page.locator('[data-id="source"]').getByRole("status")).toContainText("25%");
      const port = page.locator(
        '[data-id="source"] .react-flow__handle-' + (reverse ? "left" : "right"),
      );
      await port.waitFor({ timeout: 18000 });
      const card = page.locator('[data-id="receiver"] [aria-label="候选节点"]').first(),
        body = card.locator("..");
      const box = await card.boundingBox(),
        start = await port.boundingBox();
      await page.mouse.move(
        start.x + start.width / 2 + (reverse ? -4 : 4),
        start.y + start.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.4, { steps: 12 });
      const eligible = await page.evaluate(() => window.canDrop()),
        tilts = !["image", "video", "audio"].includes(kind) || eligible;
      await expect(body, key).toHaveCSS("opacity", tilts ? "1" : "0.35");
      await expect(body, key).toHaveCSS("transform", tilts ? /^matrix3d\(/ : "none");
      await page.waitForTimeout(650);
      matrix[key] = {
        eligible,
        tilts,
        opacity: await body.evaluate((node) => getComputedStyle(node).opacity),
      };
      if (upload) assert.equal(eligible, false);
      await page.mouse.up();
      await expect(body).toHaveCSS("transform", "none");
      await expect(body).toHaveCSS("opacity", "1");
      const expected = {
        menu: !eligible,
        edges: eligible ? [reverse ? ["receiver", "source"] : ["source", "receiver"]] : [],
      };
      await expect
        .poll(() => page.evaluate(() => window.afterDrop()), { message: key })
        .toEqual(expected);
      matrix[key].drop = expected;
    }
  await writeFile(
    join(out, upload ? "original-upload-feedback.json" : "original-node-feedback.json"),
    JSON.stringify(matrix, null, 2),
  );
  console.table(matrix);
} finally {
  await browser.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
