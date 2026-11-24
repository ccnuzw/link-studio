import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const root = process.cwd(),
  baseline = resolve(process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web");
assert.equal(
  execFileSync("git", ["-C", baseline, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  "ff4070c7b23581b1a79eacbfeddc56f836562377",
);
assert.equal(
  execFileSync("git", ["-C", baseline, "diff", "HEAD", "--", "src/utils/canvas"], {
    encoding: "utf8",
  }),
  "",
);
const temp = await mkdtemp(join(tmpdir(), "link-parity-ui-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const servers = [];
try {
  const samples = [];
  for (const ref of [true, false]) {
    const base = ref ? baseline : root,
      entry = "/src/__canvas_parity.jsx";
    const path = ref ? "/src/utils/canvas/" : "/src/renderer/workspace/";
    const fixture = `import * as F from '${path}${ref ? "outpaint-frame" : "outpaint-geometry"}';import {planCompose} from '${path}outpaint-compose';
      import * as T from '${path}${ref ? "trim" : "trim-range"}';
      window.numeric=()=>{const rows=[];for(const origin of [{w:320,h:180},{w:324,h:576}]) for(const mult of [1,1.25,1.5,2,3]){
        const frame=F.frameByMult(origin,mult);for(const side of ['l','r','t','b','tl','br','bl','tr'])for(const delta of [-1000,0,57,2000]){
        const resized=F.resizeFrame(side,origin,frame,delta,delta/2);const moved=F.moveFrame(origin,resized.frame,23,-8);rows.push([resized,moved,planCompose({natural:{w:1920,h:1080},origin,frame:moved})]);}}
        for(const side of ['start','end'])for(const value of [-2,0.21,0.333,2.88,3,9])rows.push(${ref ? "T.trimRange(0.2,2.9,3,side,value)[side]" : "T.trimBoundary(side,value,0.2,2.9,3)"});return rows;};
      ${
        ref
          ? ""
          : `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ReactFlow} from '@xyflow/react';import '@xyflow/react/dist/style.css';import '/src/renderer/workspace/canvas-workspace.css';
        import {OutpaintFrameLayer} from '${path}outpaint-frame-layer';import {TrimTrack} from '${path}trim-track';import {NodeAudioPlayer} from '${path}node-audio-player';import {AssetPickerDialog} from '${path}asset-picker-dialog';
        import {Interactions} from '/scripts/fixtures/canvas-parity-interactions.jsx';
        const origin={w:160,h:90};window.loads=[];window.desktop={projects:{getAssetPreview:async({assetId,variant})=>{window.loads.push([assetId,variant??'full']);return assetId==='broken'?{ok:false}:{ok:true,value:{url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')+'#'+(variant??'full')}};}}};
        function Demo(){const [extra,setExtra]=useState(false);window.showExtra=()=>setExtra(true);const [frame,setFrame]=useState(F.frameByMult(origin,1.5));const [start,setStart]=useState(0);const [end,setEnd]=useState(4);const [pick,setPick]=useState('');window.openPick=setPick;window.state={frame,start,end};
        return <><div style={{width:800,height:380}}><ReactFlow nodes={[{id:'p',position:{x:90,y:90},data:{label:'source'},style:{width:160,height:90}}]} edges={[]}><OutpaintFrameLayer nodeId='p' origin={origin} frame={frame} onChange={setFrame}/></ReactFlow></div>
        {extra && <Interactions/>}<TrimTrack url='/test.mp4' busy={false} duration={4} start={start} end={end} seek={t=>window.seek=t} change={(side,t)=>(side==='start'?setStart:setEnd)(t)}/>
        <NodeAudioPlayer src='/src/renderer/public/official-voices/fz-asset-20260908172456-9zvzx-audio.wav' assetId='v' waveform={[0.1]}/>
        {pick && <AssetPickerDialog key={pick} assets={[]} jobs={[]} handle='p' projectName='demo' importing={false} capacity={2} lockedKind={pick==='general'?undefined:'audio'} character={pick==='character'?{purpose:'voice',extras:[]}:undefined} attachOfficialVoice={async file=>({assetId:'a',mediaType:'audio',availability:'ready',displayName:file})} confirm={items=>{window.chosen=items;setPick('');}} close={()=>setPick('')} upload={()=>{throw Error()}}/>}</>;}createRoot(document.querySelector('main')).render(<Demo/>);`
      }`;
    const server = await createServer({
      configFile: false,
      root: base,
      cacheDir: join(temp, ref ? "upstream" : "desktop"),
      resolve: { alias: { "@": join(base, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "parity-fixture",
          resolveId: (id) => (id === entry ? join(base, entry) : undefined),
          load: (id) => (id === join(base, entry) ? fixture : undefined),
        },
      ],
    });
    servers.push(server);
    await server.listen();
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(e.message));
    const url = server.resolvedUrls.local[0] + "audit";
    await page.route(url, (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<main></main><script type="module" src="${entry}"></script>`,
      }),
    );
    await page.goto(url);
    await page.waitForFunction(() => !!window.numeric);
    samples.push(await page.evaluate(() => window.numeric()));
    if (!ref) {
      const right = page.getByRole("slider", { name: "右边", exact: true });
      await right.press("Shift+ArrowRight");
      assert.equal(await page.evaluate(() => window.state.frame.x1), 232);
      const box = await right.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 26, box.y + box.height / 2);
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => window.state.frame.x1)).toBe(258);
      const trim = page.getByRole("slider", { name: "拖动入点" });
      await trim.press("Shift+ArrowRight");
      await trim.press("ArrowRight");
      assert.equal(await page.evaluate(() => window.state.start), 1.1);
      const track = await page.locator(".canvas-trim-track").boundingBox();
      await page.mouse.click(track.x + track.width * 0.75, track.y + 10);
      assert.ok(Math.abs((await page.evaluate(() => window.seek)) - 3) < 0.02);
      const audio = page.locator(".node-audio-player audio");
      await audio.dispatchEvent("waiting");
      await expect(page.getByRole("button", { name: "加载中" })).toHaveAttribute(
        "aria-busy",
        "true",
      );
      await audio.dispatchEvent("canplay");
      await expect(page.getByRole("button", { name: "播放", exact: true })).toBeVisible();
      for (const mode of ["general", "audio", "character"]) {
        await page.evaluate((m) => window.openPick(m), mode);
        await page.getByRole("tab", { name: "官方音色库" }).click();
        await page.getByRole("textbox", { name: "搜索音色" }).fill("Zayne");
        await page.getByRole("button", { name: "Young - Male - Zayne 2.0", exact: true }).click();
        await page.locator(".asset-pick-confirm").click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        assert.equal(await page.evaluate(() => window.chosen[0].assetId), "a");
      }
      await page.evaluate(() => window.showExtra());
      await page.getByRole("button", { name: "引用画布里的素材" }).click();
      await page.getByRole("menuitem", { name: "从官方音色库选择" }).click();
      await page.getByRole("textbox", { name: "搜索音色" }).fill("Zayne");
      await page.getByRole("button", { name: "Young - Male - Zayne 2.0", exact: true }).click();
      await page.locator(".asset-pick-confirm").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.locator("form[data-generation-node]").evaluate((form) => form.requestSubmit());
      const submission = await page.evaluate(() => window.videoSubmission);
      assert.equal(submission?.op, "omni");
      assert.deepEqual(submission.referenceAssetIds, ["local-voice"]);
      await page.evaluate(() => window.setExportStage(true));
      assert.ok(await page.getByRole("dialog").evaluate((dialog) => dialog.matches(":modal")));
      await page.getByRole("button", { name: "取消导出" }).click();
      assert.equal(await page.evaluate(() => window.checkExport(true)), "AbortError");
      assert.equal(await page.evaluate(() => window.checkExport(false)), "video-canvas/canvas");
      const show = (zoom, selected = false, id = "image") =>
        page.evaluate((props) => window.setPreviewCase(props), { zoom, selected, id });
      await show(0.45);
      const image = page.locator(".canvas-image-layers");
      await expect(image.locator("img")).toHaveAttribute("src", /#thumb$/);
      await show(0.6);
      assert.deepEqual(await page.evaluate(() => window.loads.filter(([id]) => id === "image")), [
        ["image", "thumb"],
      ]);
      await show(0.6, true);
      await expect(image.locator('img[src$="#full"]')).toHaveCSS("opacity", "1");
      await expect(image.locator("img")).toHaveCount(1);
      await show(0.45);
      await expect(image.locator("img")).toHaveAttribute("src", /#thumb$/);
      await show(0.75);
      await expect(image.locator('img[src$="#full"]')).toHaveCSS("opacity", "1");
      await expect(image.locator("img")).toHaveCount(1);
      await show(0.45, false, "broken");
      await expect(image).toHaveText("图片加载失败");
      await page.evaluate(() => window.openPaint());
      const paint = page.getByRole("dialog", { name: "图片扩图" });
      await paint.getByLabel("画框比例").selectOption("自由");
      await paint.getByLabel("宽度倍数").selectOption("2");
      await paint.getByLabel("高度倍数").selectOption("1");
      await paint.getByRole("textbox", { name: "补画内容（选填）" }).fill("延展街景");
      await paint.getByRole("button", { name: "确认扩图" }).click();
      const result = await page.evaluate(async () => {
        const { pngData, prompt } = window.outpaintDraft;
        const bitmap = new Image();
        bitmap.src = pngData;
        await bitmap.decode();
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, 1).data;
        return [
          bitmap.width,
          bitmap.height,
          Array.from(pixels).filter((_, i) => i % 4 === 3),
          prompt,
        ];
      });
      assert.deepEqual(result, [
        6,
        2,
        [0, 0, 255, 255, 255, 0],
        "保持原图内容不变，自然补全图片中的透明区域。延展街景",
      ]);
    }
    await page.close();
  }
  assert.deepEqual(samples[1], samples[0]);
  console.log(
    `${samples[0].length} pinned numeric cases matched; outpaint, trim, audio waiting, four voice contexts (video omni submission), worker cancellation/export, modal lock and image LOD passed`,
  );
} finally {
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
  await rm(temp, { recursive: true, force: true });
}
