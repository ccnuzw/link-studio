import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { readRenderedText } from "./read-rendered-text.mjs";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = path.resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const pinned = (file) =>
  execFileSync("git", ["-C", reference, "show", `${revision}:web/src/${file}`], {
    encoding: "utf8",
  });
const view = pinned("pages/drama/studio/view.tsx");
const bindings = view.slice(
  view.indexOf("  const lg ="),
  view.indexOf("  return (", view.indexOf("  const lg =")),
);
const start = view.indexOf("<ResizablePanelGroup");
const groups = view.slice(start, view.indexOf("</Face>", start));
const temp = await mkdtemp(path.join(tmpdir(), "studio-panels-"));
const output = path.resolve("test-results/drama-studio-panels-parity");
const playbackOnly = process.argv.includes("--playback");
const adaptationOnly = process.argv.includes("--adaptation");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  await mkdir(output, { recursive: true });
  const report = { revision, states: {} };
  for (const side of playbackOnly || adaptationOnly ? ["desktop"] : ["reference", "desktop"]) {
    const upstream = side === "reference";
    const root = upstream ? path.join(reference, "web") : process.cwd();
    const entry = path.join(root, "studio-panel-fixture.tsx");
    const fixture = adaptationOnly
      ? `
      import { useCallback, useState } from 'react';
      import { DramaSegmentVideo, boardSourceHash, useStudioAdaptations } from './src/renderer/workspace/drama-segment-video';
      import { DramaClipRow } from './src/renderer/workspace/drama-clip-row';
      import './src/renderer/workspace/drama-studio-panels.css';
      let segment={id:'clip',episode_no:1,seq:0,prompt:'敲门。',seconds:5,revision:1};
      const second={...segment,id:'second',seq:1,prompt:'门开了。'};
      const ok=value=>({ok:true,value}); window.submissions=[]; window.receipts=[];
      window.desktop={projects:{
        getCanvas:async()=>ok({canvas:{nodes:[],edges:[]},canvasRevision:1}),listJobs:async()=>ok({jobs:[]}),listAssets:async()=>ok({assets:[]}),
        drama:async({setSegmentPrompt:save,adaptSegment:adapt})=>{
          const target=(save??adapt)?.segmentId==='second'?second:segment;
          if ((save??adapt)?.revision!==undefined && (save??adapt).revision!==target.revision) return {ok:false,error:{code:'AGENT_APPROVAL_STALE',message:'修订号过期'}};
          if(save?.format) segment={...segment,revision:segment.revision+1,adaptations:{h3:{...segment.adaptations.h3,prompt:save.prompt,edited:true}}};
          else if(save) segment={...segment,revision:segment.revision+1,prompt:save.prompt};
          if(adapt) {
            const source=target.prompt;
            if(window.holdAdapt) await new Promise(resolve=>{window.releaseAdapt=resolve;});
            if(window.failAdapt) return {ok:false,error:{message:'文本模型超时'}};
            const adaptations={h3:{prompt:'改写：'+source,source_hash:await boardSourceHash(source),edited:false}};
            if(target===second) Object.assign(second,{revision:second.revision+1,adaptations});
            else segment={...segment,revision:segment.revision+1,adaptations};
          }
          return ok({segments:[segment,second]});
        },submitJob:async({generation})=>{window.submissions.push(generation.prompt);window.receipts.push([generation.nodeId,generation.prompt]);return ok({});}
      }};
      function Fixture(){const [current,setCurrent]=useState(segment),[toolbar,setToolbar]=useState(null),[editor,setEditor]=useState(null);
        const reload=useCallback(async()=>setCurrent(segment),[]);
        const adaptations=useStudioAdaptations();
        const [selected,select]=useState('clip'),[format,setFormat]=useState('h3');
        const [batchHost,setBatchHost]=useState(null);
        return <><DramaClipRow batchHost={setBatchHost} segments={[current,second]} selected={selected} select={select} save={async()=>{}} add={()=>{}} handle="fixture" previewHost={null} editor={{graph:{nodes:[]},jobs:new Map(),assets:[]}}/>
        <select aria-label="模型格式" value={format} onChange={event=>setFormat(event.target.value)}><option value="h3">H3</option><option value="generic">通用</option></select>
        <div ref={setToolbar}/><div ref={setEditor}/><DramaSegmentVideo batchHost={batchHost} key={selected} adaptations={adaptations} expanded locked toolbar={toolbar} editorHost={editor} previewHost={null} projectHandle="fixture" model={{id:'video',revision:1,config:{kind:'video',promptFormat:format}}} options={{modes:['t2v'],references:{},referenceLimit:0,hiddenParameters:[],durations:[5],resolutions:[],ratios:['9:16']}} segment={selected==='clip'?current:second} episodeSegments={[current,second]} episodeOrder={0} ratio="9:16" plugins={[]} imageModels={[]} reload={reload}/></>;}`
      : upstream
        ? `import {Group as ResizablePanelGroup, Panel as ResizablePanel, Separator as ResizableHandle, useDefaultLayout} from 'react-resizable-panels';
      ${pinned("hooks/use-media-query.ts")} ${pinned("utils/drama/studio-layout.ts")}
      const Phased=({children})=>children, Library=()=>null, Preview=()=>null, Editor=()=>null, ClipBar=()=>null, HANDLE='reference-handle',phase=2;
      function Fixture(){${bindings}return <div style={{position:'absolute',inset:'48px 0 0'}}>${groups}</div>;}`
        : `import {StudioPanels} from './src/renderer/workspace/drama-studio-panels';
        import {useState} from 'react';import {createPortal} from 'react-dom';
        import {SegmentPromptEditor,useSegmentPrompt} from './src/renderer/workspace/drama-segment-prompt';
        const segment={id:'fixture',episode_no:1,prompt:'旧稿',revision:1,adaptations:{h3:{prompt:'转写前一版'}}};
        window.desktop={projects:{drama:async ({setSegmentPrompt,addSegment,deleteSegment})=>{
          if(deleteSegment){(window.removals??=[]).push(deleteSegment);return window.removals.length===1?{ok:false,error:{message:'写入失败'}}:{ok:true,value:{segments:[]}};}
          if(addSegment){(window.newSegments??=[]).push(addSegment);return {ok:true,value:{segments:[{id:'blank-'+window.newSegments.length,...addSegment}]}};}
          window.savedDraft=setSegmentPrompt.prompt;window.lastSave=setSegmentPrompt;return {ok:true,value:{segments:[{...segment,revision:2}]}};}}};
        function Draft({host,format}){const prompt=useSegmentPrompt('fixture',segment,0,async()=>{},format);return host&&createPortal(<SegmentPromptEditor episodeNo={1} projectHandle="fixture" prompt={prompt} generate={()=>{}} report={()=>{}}/>,host);}
        function Controller({host}){const [format,select]=useState();window.editFormat=select;return <Draft key={format??'source'} host={host} format={format}/>;}
        import {appendStudioClip,DramaClipRow} from './src/renderer/workspace/drama-clip-row';
        import {DramaSegmentHeading} from './src/renderer/workspace/drama-segment-heading';
        import {editorAttempt} from './src/renderer/workspace/drama-segment-status';
        function Heading({saved}){const [phase,change]=useState('failed');window.changeAttempt=change;
          const current={...segment,seq:1,chosen_task_id:'adopted',take_ids:['adopted','retry']};
          const adopted={id:'adopted',createdAt:'1',status:'succeeded',outputs:[{kind:'video',assetId:'clip'}]};
          const attempt=editorAttempt(current,[adopted,{id:'retry',createdAt:'1',status:phase,errorMessage:'不支持此画幅'}],[{assetId:'clip',mediaType:'video',availability:'ready'}]);
          return <DramaSegmentHeading segment={current} handle="fixture" order={0} attempt={attempt} saved={saved}/>;}
        const videos=${playbackOnly} ? ['first','last'] : [];
        const jobs=new Map(videos.map(id=>['seg:'+id,[{id,status:'succeeded',outputs:[{kind:'video',assetId:id}]}]]));
        const assets=videos.map(assetId=>({assetId,mediaType:'video',availability:'ready',metadata:{durationMs:2000}}));
        window.desktop.projects.getAssetPreview=async ({assetId,variant})=>variant ? {ok:false} : {ok:true,value:{url:window.media[assetId]}};
        function Clips({preview}){const [ids,setIds]=useState(videos.length?['first','empty','last']:['first','second']),[selected,select]=useState('first');
          const add=async()=>{const {value}=await appendStudioClip('fixture',2,ids.length,ids.length===2?8:15);const id=value.segments[0].id;setIds([...ids,id]);select(id);};
          return <DramaClipRow add={add} previewHost={preview} segments={ids.map((id,seq)=>({id,seq,chosen_task_id:id,seconds:id==='first'?5:8,prompt:id}))} selected={selected} select={select} editor={{graph:{nodes:[]},jobs,assets}} handle="fixture" save={async(previous,next)=>{(window.orders??=[]).push([previous,next]);setIds(next)}}/>;}
        function Fixture(){const [host,setHost]=useState(null),[preview,setPreview]=useState(null),[removed,setRemoved]=useState(false);return <StudioPanels hidden={false} library={null} preview={<div className="studio-panel-scroll" ref={setPreview}/>} editor={<>{!removed&&<Heading saved={()=>setRemoved(true)}/>}<div ref={setHost}/></> }><Controller host={host}/><Clips preview={preview}/></StudioPanels>}`;
    const outDir = path.join(temp, side);
    await build({
      root,
      configFile: false,
      publicDir: false,
      logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"' },
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "fixture",
          resolveId: (id) => (id === entry ? id : null),
          load: (id) =>
            id === entry
              ? `${fixture}\nimport {createRoot} from 'react-dom/client';createRoot(document.querySelector('main')).render(<Fixture/>);`
              : null,
        },
      ],
      build: {
        outDir,
        lib: { entry, formats: ["es"], fileName: () => "fixture.js", cssFileName: "fixture" },
      },
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    try {
      const css = upstream
        ? "[data-group]{height:100%;width:100%}.reference-handle[aria-orientation=vertical]{width:1px}.reference-handle[aria-orientation=horizontal]{height:1px}"
        : (
            await Promise.all(
              [
                path.join(outDir, "fixture.css"),
                "src/renderer/workspace/canvas-workspace.css",
                "src/renderer/workspace/drama-studio.css",
              ].map((file) => readFile(file, "utf8")),
            )
          ).join("\n");
      await page.route("http://studio.test/**", (route) =>
        route.request().url().endsWith("fixture.js")
          ? route.fulfill({
              path: path.join(outDir, "fixture.js"),
              contentType: "application/javascript",
            })
          : route.fulfill({
              contentType: "text/html",
              body: `<style>${css}</style><main></main><script type=module src=/fixture.js></script>`,
            }),
      );
      if (playbackOnly) {
        const media = {};
        for (const [id, color] of [
          ["first", "black"],
          ["last", "white"],
        ]) {
          const file = path.join(temp, `${id}.mp4`);
          execFileSync(path.resolve(`out/media/${process.platform}-${process.arch}/ffmpeg`), [
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            `color=c=${color}:s=64x48:r=12:d=2`,
            "-an",
            "-c:v",
            process.platform === "darwin" ? "h264_videotoolbox" : "mpeg4",
            ...(process.platform === "darwin" ? ["-allow_sw", "1"] : []),
            file,
          ]);
          media[id] = `data:video/mp4;base64,${(await readFile(file)).toString("base64")}`;
        }
        await page.addInitScript((value) => {
          window.media = value;
        }, media);
      }
      if (adaptationOnly)
        await page.route("http://localhost/**", (route) =>
          route.fulfill(
            route.request().url().endsWith("fixture.js")
              ? { path: path.join(outDir, "fixture.js"), contentType: "text/javascript" }
              : {
                  contentType: "text/html",
                  body: `<!doctype html><style>${css}</style><main></main><script type=module src=/fixture.js></script>`,
                },
          ),
        );
      await page.goto(adaptationOnly ? "http://localhost/" : "http://studio.test/");
      if (adaptationOnly) {
        page.setDefaultTimeout(7000);
        const submit = page.getByRole("button", { name: "立即生成" }),
          original = page.getByRole("textbox", { name: "片段原稿" }),
          adapted = page.getByRole("textbox", { name: "片段转写稿" });
        await original.fill("打开信封。");
        await submit.click();
        await page.waitForFunction(() => window.submissions.length === 1);
        await page.getByRole("button", { name: "转写为 H3" }).click();
        await adapted.fill("雨中的信封。");
        await submit.click();
        await page.waitForFunction(() => window.submissions.length === 2);
        await page.getByRole("tab", { name: /原稿/ }).click();
        await original.fill("放下信封。");
        const tab = page.getByRole("tab", { name: /转写/ });
        const warning = page.getByRole("status").filter({ hasText: "原稿已修改" });
        await tab.getByText("已过期").waitFor();
        assert.equal(await warning.count(), 0);
        await original.fill("打开信封。");
        await tab.getByLabel("最新").waitFor();
        await original.fill("放下信封。");
        await page.getByRole("tab", { name: /转写/ }).click();
        await warning.getByRole("button", { name: "重新转写" }).click();
        const overwrite = page.getByRole("alertdialog", { name: "覆盖手改的转写稿？" });
        await overwrite.waitFor();
        assert.equal(await page.locator('[title="正在转写"]').count(), 0);
        await overwrite.getByRole("button", { name: "取消" }).click();
        await warning.waitFor();
        assert.equal(await readRenderedText(adapted), "雨中的信封。");
        const dialog = page.getByRole("alertdialog", { name: "原稿在转写后改过" });
        await submit.click();
        await dialog.getByRole("button", { name: "取消" }).click();
        assert.equal(await page.evaluate(() => window.submissions.length), 2);
        await submit.click();
        await dialog.getByRole("button", { name: "仍用当前转写稿生成" }).click();
        await page.waitForFunction(() => window.submissions.length === 3);
        await submit.click();
        await dialog.getByRole("button", { name: "重新转写并生成" }).click();
        await page.waitForFunction(() => window.submissions.length === 4);
        await tab.getByLabel("最新").waitFor();
        assert.equal(await warning.count(), 0);
        assert.deepEqual(await page.evaluate(() => window.submissions), [
          "打开信封。",
          "雨中的信封。",
          "雨中的信封。",
          "改写：放下信封。",
        ]);
        await page.evaluate(() => {
          window.holdAdapt = true;
        });
        await page.getByRole("button", { name: "重新转写", exact: true }).click();
        await page.waitForFunction(() => !!window.releaseAdapt);
        assert.ok(await submit.isDisabled());
        assert.equal(await adapted.getAttribute("contenteditable"), "false");
        await page.getByRole("tab", { name: /原稿/ }).click();
        await original.fill("等待时修改并生成。");
        await submit.click();
        await page.waitForFunction(() => window.submissions.length === 5);
        assert.equal(await page.evaluate(() => window.submissions.at(-1)), "等待时修改并生成。");
        await original.fill("回写前的最后修改。");
        await page.evaluate(() => window.releaseAdapt());
        await tab.getByText("已过期").waitFor();
        assert.equal(await readRenderedText(original), "回写前的最后修改。");
        await tab.click();
        await warning.waitFor();
        assert.equal(await readRenderedText(adapted), "改写：放下信封。");
        const stored = await page.evaluate(
          async () => (await window.desktop.projects.drama({})).value.segments[0],
        );
        assert.equal(stored.prompt, "回写前的最后修改。");
        await page.evaluate(() => {
          window.releaseAdapt = null;
          window.failAdapt = true;
        });
        await submit.click();
        await dialog.getByRole("button", { name: "重新转写并生成" }).click();
        await page.waitForFunction(() => !!window.releaseAdapt);
        const firstClip = page.getByLabel("片段 1，5 秒"),
          secondClip = page.getByLabel("片段 2，5 秒");
        await secondClip.click();
        assert.equal(await readRenderedText(original), "门开了。");
        assert.ok(await page.getByRole("button", { name: "转写为 H3" }).isEnabled());
        await firstClip.click();
        assert.ok(await page.getByTitle("正在转写", { exact: true }).first().isDisabled());
        await page.getByLabel("模型格式").selectOption("generic");
        assert.ok(await page.getByRole("button", { name: "转写为 通用" }).isDisabled());
        await secondClip.click();
        await page.evaluate(() => window.releaseAdapt());
        await firstClip.click();
        await tab.click();
        assert.equal(await page.getByText("文本模型超时").count(), 0);
        await page.getByLabel("模型格式").selectOption("h3");
        const failure = page.getByRole("alert").filter({ hasText: "文本模型超时" });
        await failure.waitFor();
        assert.equal(await page.evaluate(() => window.submissions.length), 5);
        assert.equal(await readRenderedText(adapted), "改写：放下信封。");
        await page.evaluate(() => {
          window.holdAdapt = false;
          window.failAdapt = false;
        });
        await failure.getByRole("button", { name: "重试" }).click();
        await tab.getByLabel("最新").waitFor();
        assert.equal(await readRenderedText(adapted), "改写：回写前的最后修改。");
        assert.equal(await failure.count(), 0);
        const batch = page.getByRole("button", { name: "批量生成分镜视频" });
        const options = page.getByRole("alertdialog", { name: "1 个片段还没转写为 H3" });
        const fresh = ["seg:clip", "改写：回写前的最后修改。"];
        await batch.click();
        await options.getByRole("button", { name: "取消" }).click();
        assert.equal(await page.evaluate(() => window.receipts.length), 5);
        await batch.click();
        await options.getByRole("button", { name: /只生成已转写的/ }).click();
        await page.waitForFunction(() => window.receipts.length === 6);
        assert.deepEqual(await page.evaluate(() => window.receipts.at(-1)), fresh);
        await batch.click();
        await options.getByRole("button", { name: /原稿生成/ }).click();
        await page.waitForFunction(() => window.receipts.length === 8);
        assert.deepEqual(await page.evaluate(() => window.receipts.slice(-2)), [
          fresh,
          ["seg:second", "门开了。"],
        ]);
        await batch.click();
        await options.getByRole("button", { name: /转写后生成/ }).click();
        await page.waitForFunction(() => window.receipts.length === 10);
        assert.deepEqual(await page.evaluate(() => window.receipts.slice(-2)), [
          fresh,
          ["seg:second", "改写：门开了。"],
        ]);
        await page.getByRole("tab", { name: /原稿/ }).click();
        await original.fill("@[信使](gone)敲门。");
        const dead = page.getByRole("alertdialog", { name: "有引用已失效" });
        await batch.click();
        await dead.getByRole("button", { name: "取消" }).click();
        assert.equal(await page.evaluate(() => window.receipts.length), 10);
        await submit.click();
        await dead.getByRole("button", { name: "取消" }).click();
        assert.equal(await page.evaluate(() => window.receipts.length), 10);
        await batch.click();
        await dead.getByRole("button", { name: "继续生成" }).click();
        await page.waitForFunction(() => window.receipts.length === 12);
        assert.deepEqual(await page.evaluate(() => window.receipts.slice(-2)), [
          ["seg:clip", "信使敲门。"],
          ["seg:second", "门开了。"],
        ]);
        await original.fill("关上信箱。");
        await tab.click();
        await warning.waitFor();
        await page.evaluate(() => {
          window.failAdapt = true;
        });
        await batch.click();
        await options.getByRole("button", { name: /转写后生成/ }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "1 个片段转写失败，已跳过：片段 01" })
          .waitFor();
        const partial = await page.evaluate(() => window.receipts.slice(12));
        assert.deepEqual(partial, [["seg:second", "改写：门开了。"]]);
        assert.equal(await readRenderedText(adapted), "改写：回写前的最后修改。");
        console.log("片场原稿、手改转写稿、取消、保留过期稿、重新转写后提交通过");
        continue;
      }
      if (playbackOnly) {
        const start = page.getByRole("button", { name: "连播", exact: true });
        const pause = page.getByRole("button", { name: "暂停连播" });
        const active = page.locator('.drama-playback-stage video[aria-hidden="false"]');
        await page.getByText("00:00 / 00:04").waitFor();
        await start.click();
        await page.waitForFunction(() => {
          const slots = [...document.querySelectorAll(".drama-playback-stage video")];
          return (
            slots.length === 2 &&
            slots.every((slot) => slot.readyState >= 2) &&
            slots[0].currentTime > 0.1 &&
            !slots[0].paused &&
            slots[1].paused
          );
        });
        await pause.click();
        const stopped = await active.evaluate((video) => video.currentTime);
        await page.waitForTimeout(150);
        assert.equal(await active.evaluate((video) => video.currentTime), stopped);
        await start.click();
        await page.waitForFunction(
          (time) => document.querySelector('video[aria-hidden="false"]').currentTime > time + 0.1,
          stopped,
        );
        await pause.click();
        await page.getByTitle("empty", { exact: true }).click();
        await page.getByText("00:02 / 00:04").waitFor();
        assert.equal(
          await page.getByTitle("last", { exact: true }).getAttribute("aria-current"),
          "true",
        );
        assert.equal(
          await active.evaluate((video) => video.paused && video.currentTime === 0),
          true,
        );
        assert.equal(
          await page.locator(".drama-clip-playhead").evaluate((el) => el.style.transform),
          "translateX(168px)",
        );
        await page.getByTitle("first", { exact: true }).click();
        const preloaded = await page.locator('video[aria-hidden="true"]').elementHandle();
        await start.click();
        await page.waitForFunction(
          (slot) =>
            slot.getAttribute("aria-hidden") === "false" && !slot.paused && slot.currentTime > 0,
          preloaded,
        );
        await page.getByRole("status").filter({ hasText: "连播结束" }).waitFor();
        await page.getByText("00:00 / 00:04").waitFor();
        assert.equal(await active.count(), 0);
        await start.click();
        const beforeResize = await active.elementHandle();
        await page.setViewportSize({ width: 1023, height: 900 });
        await page.waitForFunction((slot) => slot.paused && !slot.isConnected, beforeResize);
        assert.equal(await start.isDisabled(), true);
        console.log(
          "playback: pause, resume, jump over empty, 168px playhead, preloaded handoff, finish and leave passed",
        );
        continue;
      }
      async function measure(state, count) {
        await page.waitForFunction(
          (expected) => document.querySelectorAll("[data-panel]").length === expected,
          count,
        );
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const sizes = await page.locator("[data-panel]").evaluateAll((elements) =>
          Object.fromEntries(
            elements.map((el) => {
              const { x, y, width, height } = el.getBoundingClientRect();
              return [el.id, { x, y, width, height }];
            }),
          ),
        );
        report.states[state] ??= {};
        report.states[state][side] = sizes;
        return sizes;
      }
      const wide = await measure("wide", 5);
      assert.equal(wide.library.width, 224);
      const vertical = page.locator('[data-separator][aria-orientation="vertical"]').first();
      const handle = await vertical.boundingBox();
      await page.mouse.move(handle.x + 0.5, handle.y + 20);
      await page.mouse.down();
      await page.mouse.move(handle.x + 65, handle.y + 20, { steps: 5 });
      await page.mouse.up();
      const drag = await measure("dragged", 5);
      assert.ok(drag.library.width > wide.library.width + 50);
      const horizontal = page.locator('[data-separator][aria-orientation="horizontal"]');
      await horizontal.press("ArrowUp");
      const resized = await measure("keyboard", 5);
      assert.ok(resized.clips.height > wide.clips.height);
      await page.reload();
      assert.deepEqual(await measure("reopened", 5), resized);
      const editor = page.getByRole("textbox", { name: "片段原稿" });
      if (!upstream) await editor.fill("窗沿的新稿");
      await page.setViewportSize({ width: 1279, height: 900 });
      await measure("two", 4);
      if (!upstream) assert.equal(await readRenderedText(editor), "窗沿的新稿");
      await page.setViewportSize({ width: 1023, height: 900 });
      await measure("one", 3);
      await page.setViewportSize({ width: 1440, height: 900 });
      await measure("wide-again", 5);
      if (!upstream) {
        assert.equal(await readRenderedText(editor), "窗沿的新稿");
        await page.waitForFunction(() => window.savedDraft === "窗沿的新稿");
        await page.evaluate(() => window.editFormat("h3"));
        await page.getByText("转写前一版", { exact: true }).waitFor();
        await editor.fill("手改镜头");
        await page.waitForFunction(() => window.lastSave?.prompt === "手改镜头");
        assert.deepEqual(await page.evaluate(() => window.lastSave), {
          segmentId: "fixture",
          episodeNo: 1,
          episodeOrder: 0,
          revision: 1,
          prompt: "手改镜头",
          format: "h3",
        });
        const first = page.getByTitle("first", { exact: true }),
          second = page.getByTitle("second", { exact: true });
        await second.press("Enter");
        const source = await first.boundingBox(),
          target = await second.boundingBox();
        assert.equal(
          await page.evaluate(
            ({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=button]")?.title,
            { x: source.x + source.width / 2, y: source.y + 20 },
          ),
          "first",
          JSON.stringify({ source, target }),
        );
        await page.mouse.move(source.x + source.width / 2, source.y + 20);
        await page.mouse.down();
        await page.mouse.move(target.x + target.width - 2, target.y + 20, { steps: 12 });
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="分镜时间线"]')?.firstElementChild?.title ===
            "second",
        );
        assert.deepEqual(await page.evaluate(() => window.orders ?? []), []);
        await page.mouse.up();
        await page.waitForFunction(() => window.orders?.length === 1);
        assert.deepEqual(await page.evaluate(() => window.orders), [
          [
            ["first", "second"],
            ["second", "first"],
          ],
        ]);
        assert.equal(await second.getAttribute("aria-current"), "true");
        const add = page.getByRole("button", { name: "新增片段", exact: true });
        await page.waitForFunction(() => {
          const tile = document.querySelector('[title="first"]');
          return tile && getComputedStyle(tile).transform === "none";
        });
        const button = await add.boundingBox(),
          tail = await first.boundingBox();
        assert.deepEqual(
          [button.width, button.height, button.x - tail.x - tail.width],
          [48, 76, 6],
        );
        await add.press("Enter");
        await page.locator('[title="blank-1"][aria-current="true"]').waitFor();
        await add.click();
        await page.locator('[title="blank-2"][aria-current="true"]').waitFor();
        assert.deepEqual(await page.evaluate(() => window.newSegments), [
          { episode_no: 2, revision: 2, seconds: 8 },
          { episode_no: 2, revision: 3, seconds: 10 },
        ]);
        const remove = page.getByRole("button", { name: "删除这个片段" });
        const headingStatus = page.locator('.studio-segment-heading [role="status"]');
        assert.equal(await readRenderedText(headingStatus), "生成失败");
        for (const [phase, label] of [
          ["running", "生成中"],
          ["succeeded", "已出视频"],
        ]) {
          await page.evaluate((value) => window.changeAttempt(value), phase);
          await headingStatus.filter({ hasText: label }).waitFor();
        }
        const dialog = page.getByRole("alertdialog", { name: "删除片段 02？" });
        await remove.click();
        assert.equal(await dialog.evaluate((el) => getComputedStyle(el).position), "fixed");
        await dialog.getByRole("button", { name: "取消" }).click();
        assert.deepEqual(await page.evaluate(() => window.removals ?? []), []);
        await remove.click();
        await dialog.getByRole("button", { name: "删除", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "写入失败" }).waitFor();
        await dialog.getByRole("button", { name: "删除", exact: true }).click();
        await remove.waitFor({ state: "detached" });
        assert.deepEqual(
          await page.evaluate(() => window.removals),
          Array(2).fill({ segmentId: "fixture", episodeNo: 1, episodeOrder: 0 }),
        );
      }
    } finally {
      await page.close();
    }
  }
  if (!playbackOnly && !adaptationOnly)
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  for (const [state, row] of Object.entries(report.states))
    assert.deepEqual(row.desktop, row.reference, state);
  if (!playbackOnly && !adaptationOnly)
    console.log(`${Object.keys(report.states).length} paired panel layouts match`);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
