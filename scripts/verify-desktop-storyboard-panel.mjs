import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { build } from "vite";
import { captureSettledPanel } from "./verify-storyboard-panel.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GenerationForm} from 'desktop/workspace/generation';
import {linkedMediaSources} from 'desktop/workspace/media-references';
import 'desktop/styles.css'; import 'desktop/workspace/canvas-workspace.css';
const {graph:initial,assets}=window.fixture;
const settings={plugins:[{key:'agnes-video',hash:'audit',kind:'video',origin:'builtin',auth:'none'}],providers:[{id:'audit-video',enabled:true,revision:1,model:'agnes-video-2.5-flash',pluginHash:'audit',channel:{as:'dataUrl'},config:{name:'视频回放模型',kind:'video',modes:['t2v','i2v'],refs:{image:{max:1,mb:10}},pricing:{unit:'call',input:0},params:{duration:{values:['4','6','8','10','12'],default:'4',range:{min:4,max:12,step:2,open:true}}}}}]};
function Panel(){const [graph,setGraph]=useState(initial);const node=graph.nodes.find(item=>item.id==='video');
return <GenerationForm inline graph={graph} node={node} settings={settings} assets={assets} projectHandle="audit" linkedSources={linkedMediaSources(graph,node.id)} onMentionLink={source=>setGraph({...graph,edges:[...graph.edges,{id:'reference',source,target:node.id}]})} onLocateReference={()=>{}} onPromptChange={()=>{}} onUploadReference={()=>{throw Error('unexpected upload')}} close={()=>{}} submit={async input=>{window.submissions.push(input);return '回放结束，未调用模型'}}/>}
createRoot(document.querySelector('article')).render(<Panel/>);`;

export async function verifyDesktopStoryboardPanel(browser, temp, graph, assets, baseline) {
  const workspace = join(temp, "desktop");
  mkdirSync(workspace);
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
  writeFileSync(join(workspace, "panel.tsx"), entry);
  writeFileSync(
    join(workspace, "index.html"),
    '<!doctype html><html lang="zh-CN" class="dark"><meta charset="utf-8"><main class="canvas-workspace" style="position:fixed;inset:0"><article style="position:absolute;left:240px;top:240px;width:680px"></article></main><script type="module" src="/panel.tsx"></script></html>',
  );
  await build({
    root: workspace,
    configFile: false,
    logLevel: "error",
    resolve: { alias: { desktop: join(root, "src/renderer") } },
    oxc: { jsx: { runtime: "automatic" } },
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    serviceWorkers: "block",
  });
  const errors = [];
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(
      (fixture) => {
        window.fixture = fixture;
        window.submissions = [];
        window.desktop = {
          projects: {
            getAssetPreview: async ({ assetId }) => ({
              ok: assetId === fixture.assets[0].assetId,
              value: { url: "/icon.png" },
            }),
          },
        };
      },
      { graph, assets },
    );
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://localhost") return route.abort();
      if (url.pathname === "/icon.png")
        return route.fulfill({ path: join(root, "resources/icons/icon-32.png") });
      if (url.pathname === "/") return route.fulfill({ path: join(workspace, "dist/index.html") });
      if (url.pathname.startsWith("/assets/"))
        return route.fulfill({ path: join(workspace, "dist/assets", basename(url.pathname)) });
      return route.abort();
    });
    await page.goto("http://localhost/");
    const panel = page.getByRole("region", { name: "生成确认" });
    const submit = panel.getByRole("button", { name: "开始生成", exact: true });
    await expect(panel.getByRole("tab", { name: "图生视频" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(panel.getByRole("button", { name: "生成参数" })).toContainText(/8\s*秒/);
    await expect(panel.locator("[contenteditable=true]")).toHaveText("列车进站");
    await expect(submit).toBeDisabled();
    await expect(panel.locator(".canvas-reference-tile")).toHaveCount(0);
    await expect(panel.getByText("图生方式需要至少 1 张参考图片", { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => window.submissions.length), 0);
    await panel.getByRole("button", { name: "引用画布里的素材", exact: true }).click();
    await page.getByRole("menuitem", { name: /月台分镜图/ }).click();
    await expect(submit).toBeEnabled();
    await expect(panel.locator(".canvas-reference-tile")).toHaveCount(1);
    await expect(
      panel.getByRole("button", { name: "引用：月台分镜图，点击定位到节点" }),
    ).toBeVisible();
    await page.mouse.move(1, 1);
    const path = join(dirname(baseline.capture), "desktop-ready.png");
    const png = await captureSettledPanel(panel, path);
    assert.equal(await page.evaluate(() => window.submissions.length), 0);
    await submit.click();
    await expect(panel.getByText("回放结束，未调用模型", { exact: true })).toBeVisible();
    const calls = await page.evaluate(() => window.submissions);
    assert.equal(calls.length, 1);
    const { op, duration, prompt, images } = baseline.request.input;
    assert.deepEqual(images, [42]);
    assert.deepEqual(calls[0], {
      nodeId: baseline.request.node_id,
      providerId: baseline.request.model_id,
      expectedProviderRevision: 1,
      op,
      duration,
      prompt,
      referenceAssetIds: [assets[0].assetId],
    });
    assert.deepEqual(errors, []);
    const sizes = await page.evaluate(
      async (buffers) => {
        const images = await Promise.all(
          buffers.map(async (buffer) => {
            const img = new Image();
            img.src = `data:image/png;base64,${buffer}`;
            await img.decode();
            return img;
          }),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(...images.map((img) => img.width));
        canvas.height = Math.max(...images.map((img) => img.height));
        const ctx = canvas.getContext("2d");
        const [left, right] = images.map((img) => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        });
        let differences = 0;
        for (let pos = 0; pos < left.length; pos += 4) {
          if (
            left[pos] !== right[pos] ||
            left[pos + 1] !== right[pos + 1] ||
            left[pos + 2] !== right[pos + 2] ||
            left[pos + 3] !== right[pos + 3]
          )
            differences++;
        }
        return {
          sizes: images.map((img) => [img.width, img.height]),
          differences,
          area: canvas.width * canvas.height,
        };
      },
      [readFileSync(baseline.capture).toString("base64"), png.toString("base64")],
    );
    writeFileSync(
      join(dirname(path), "panel-comparison.json"),
      JSON.stringify(
        {
          viewport: [1600, 1000],
          theme: "dark",
          dpr: 1,
          upstream: baseline.request,
          desktop: calls[0],
          ...sizes,
        },
        null,
        2,
      ),
    );
    console.log(
      "桌面表单：缺图禁用，补图后确认前 0 次，确认后 1 次。",
      JSON.stringify(calls[0]),
      JSON.stringify(sizes),
      path,
    );
  } catch (error) {
    console.error({ errors, text: (await page.locator("main").textContent())?.slice(-1200) });
    throw error;
  } finally {
    await page.close();
  }
}
