import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const original = resolve(process.env.VIDEO_CANVAS_WEB);
const temp = await mkdtemp(join(tmpdir(), "character-card-"));
const gallery = process.argv.includes("--gallery"),
  dark = process.argv.includes("--dark");
const identity = process.argv.includes("--identity"),
  narrow = process.argv.includes("--narrow");
const composer = process.argv.includes("--voice-panel"),
  voice = composer || process.argv.includes("--voice");
const output = resolve(
  `test-results/character-${composer ? "voice-panel" : voice ? "voice" : identity ? "identity" : gallery ? "gallery" : "card"}${dark ? "-dark" : ""}${narrow ? "-narrow" : ""}-parity`,
);
await mkdir(output, { recursive: true });
const source = await readFile(
  join(original, "src/components/canvas-editor/character-node.tsx"),
  "utf8",
);
const markup = source.match(/<BaseNodeContent>[\s\S]*?<\/BaseNodeContent>/)?.[0];
assert(markup);
const image =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="576" height="324"><rect width="576" height="324" fill="#a9bfcc"/><circle cx="288" cy="145" r="50" fill="#43657a"/></svg>',
  );
const entry = "/src/__character_audit.tsx";
const browser = await chromium.launch({ channel: "chrome" });
const records = {};
const phases = voice
  ? ["unbound", "upload", "history", "focus"]
  : identity
    ? ["initial", "episodes", "all", "editing", "blur"]
    : gallery
      ? ["empty", "ready", "hover", "focus", "tool-pressed", "tool-focus"]
      : ["empty", "ready", "queued", "running", "finalizing", "failed"];
const detail =
  (gallery || identity || voice) &&
  (await readFile(
    join(original, "src/components/canvas-editor/character-detail-dialog.tsx"),
    "utf8",
  ));
const voicePanel =
  detail && detail.match(/(<section className="bg-chrome-hover[\s\S]*?)\{\/\* 生成新声音/)?.[1];
const upstreamComposer =
  composer && detail.match(/\{\/\* 生成新声音[^\n]*\n\s*(<div[\s\S]*?)\s*<\/section>/)?.[1];
const desktopComposer =
  composer &&
  (await readFile("src/renderer/workspace/character-dialog.tsx", "utf8")).match(
    /(<div className="voice-composer">[\s\S]*?)\s*<\/CharacterVoiceSection>/,
  )?.[1];
const chip =
  composer &&
  (await readFile(join(original, "src/components/canvas/node-prompt-input.tsx"), "utf8")).match(
    /const PANEL_CHIP_CLASS = cn\([\s\S]*?\);/,
  )?.[0];
const player =
  detail && detail.match(/const ORIGIN_LABEL[\s\S]*?function VoicePlayer[\s\S]*?\n}/)?.[0];
const fields =
  detail &&
  detail.match(/(<div className="flex flex-col gap-3 pr-8">[\s\S]*?<\/div>)\s*<section/)?.[1];
const tokens = detail && detail.match(/const LABEL =[\s\S]*?const FIELD_CLASS =[\s\S]*?;/)?.[0];
if (identity) assert(fields && tokens);
const panel =
  detail && detail.match(/\{\/\* 左：[^\n]*\n\s*(<div[\s\S]*?<\/div>)\s*\{\/\* 右：/)?.[1];
const pill = detail && detail.match(/const SEGMENT_CLASS[\s\S]*?\n}\n/)?.[0];
if (gallery) assert(panel && pill);
try {
  for (const upstream of [true, false]) {
    const name = upstream ? "upstream" : "desktop";
    const root = upstream ? original : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const stylesheet = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    const identityFixture = `const [data,setData]=React.useState({label:'林舟',character:{name:'林舟',look:'基础形象'}});const character=data.character,episodes=phase==='episodes'?[5,1,3,2]:phase==='all'?[]:null;`;
    const module = identity
      ? upstream
        ? `import {Input} from '/src/components/ui/input';import {renameCharacter,MAX_NAME} from '/src/utils/characters/node-character';import {episodesLabel} from '/src/utils/drama/assets';${tokens} function Fixture(){${identityFixture}const id='actor',[name,setName]=React.useState(character.name),updateNodeData=(_,patch)=>setData({...data,...patch});return (${fields});}`
        : `import {CharacterIdentityFields} from '/src/renderer/workspace/character-identity-fields';function Fixture(){${identityFixture}return <CharacterIdentityFields {...character} episodes={episodes} change={patch=>setData({...data,character:{...character,...patch}})}/ >}`
      : gallery
        ? upstream
          ? `import {Fragment} from 'react';import {ChromeButton} from '/src/components/canvas/chrome/chrome';import {cn} from '/src/lib/utils';import {FolderOpen,Loader2,Plus,Upload,UserRound,UsersRound,X} from 'lucide-react';${pill}
      function Fixture(){const data={src:ready?image:null},character={name:'林舟',extras:ready?[{assetId:'extra',src:image}]:[]},media={},extrasFull=false,MAX_EXTRAS=4,MAIN_ZOOM_ID='main',LABEL='text-muted-foreground text-xs font-medium';return (${panel});}`
          : `import {CharacterImageGallery} from '/src/renderer/workspace/character-image-gallery';window.desktop={projects:{getAssetPreview:async()=>({ok:true,value:{url:image}})}};function Fixture(){return <CharacterImageGallery name="林舟" handle="test" primary={ready?'main':''} extras={ready?['extra']:[]} assets={[]}/>}`
        : upstream
          ? `
      import {BaseNodeContent} from '/src/components/canvas/base-node';import {Button} from '/src/components/ui/button';
      import {cn} from '/src/lib/utils'; import {AudioLines,Plus,Ellipsis,FolderOpen,Upload,Loader2} from 'lucide-react';
      import {NodeVideoBody} from '/src/components/canvas/node-video-body';
      const aspect=16/9,mainUploading=false,MAX_EXTRAS=4,extraFull=false,media={},cell={kind:'none',title:'还没有声音，点开详情设置'};
      function Fixture(){const showTask=!['empty','ready'].includes(phase);const vm={view:{phase,elapsedMs:12000,progress:42,message:'生成失败，请重试',taskRef:'test-123'},cancel:()=>{},submit:()=>{}};const data={src:ready?image:undefined};const view={phase:showTask && phase!=='failed'?'generating':phase,tag:showTask ? phase==='failed'?'生成失败':'生成中' : ready?null:'待补充'};const character={name:'林舟',look:'基础形象',extras:ready?[{assetId:'extra',src:image}]:[]};return (${markup});}`
          : `
      import {CharacterCardBody} from '/src/renderer/workspace/character-card-body';
      window.desktop={projects:{getAssetPreview:async()=>({ok:true,value:{url:image}})}};
      function Fixture(){const job={status:phase==='finalizing'?'downloading':phase,progress:42,createdAt:new Date(Date.now()-12000).toISOString(),id:'test-123',error:'生成失败，请重试',canCancelRemote:true};return <CharacterCardBody character={{name:'林舟',look:'基础形象',extraAssetIds:ready?['extra']:[]}} projectHandle="test" mainId={ready?'main':undefined} aspect={16/9} imageJob={job} taskAction={async()=>{}}/>}`;
    let fixture = module;
    if (voice) {
      assert(voicePanel && player && pill);
      const data = `const current=phase==='unbound'?undefined:{assetId:'first',origin:phase==='upload'?'upload':'generated'}, statuses=phase==='history'||phase==='focus'?['succeeded','failed','running','cancelled','succeeded']:[], prompt='一段声音样本',model='Audio One',date=new Date(2026,10,22,12,30);`;
      fixture = upstream
        ? `import {Fragment} from 'react';import {ChromeButton} from '/src/components/canvas/chrome/chrome';import {cn} from '/src/lib/utils';import {VoiceHistoryList} from '/src/components/canvas-editor/voice-history-list';import {useVoicePlaying,toggleVoice} from '/src/components/characters/voice-player';import {AudioLines,Upload,FolderOpen,Loader2,Pause,Play} from 'lucide-react';${pill} ${player} function Fixture(){${data} const media={},character={voice:current},applyHistoryVoice=()=>{},history=statuses.map((status,index)=>({taskId:String(index),current:!index,model,createdAt:'11-22 12:30',prompt,state:status==='succeeded'?{phase:'done',asset:{id:index?'other':'first'}}:status==='failed'?{phase:'failed',reason:'生成失败'}:status==='running'?{phase:'generating',progress:42}:{phase:'canceled'}}));return (${voicePanel}</section>);}`
        : `import {CharacterVoiceSection} from '/src/renderer/workspace/character-voice-section';function Fixture(){${data}const jobs=statuses.map((status,index)=>({id:String(index),status,model,voicePrompt:prompt,createdAt:date.toISOString(),progress:42,outputs:status==='succeeded'?[{kind:'audio',assetId:index?'other':'first'}]:[]}));return <CharacterVoiceSection handle="test" voice={current} jobs={jobs} assets={['first','other'].map(assetId=>({assetId,availability:'ready'}))} providers={[]}/>;}`;
    }
    if (composer) {
      assert(upstreamComposer && desktopComposer && chip);
      const failed = "phase==='history'",
        text = "phase==='unbound'?'':'轻柔的低音。'";
      fixture = upstream
        ? `import {Textarea} from '/src/components/ui/textarea';import {Button} from '/src/components/ui/button';import {ModelMenu} from '/src/components/canvas/model-menu';${tokens}${chip} ${fixture}`
            .replace(
              "character={voice:current}",
              `character={voice:current,voicePrompt:${text}},voiceGen={options:[],modelsStatus:'ready',task:${failed}?{phase:'failed',reason:'生成失败'}:{phase:'idle'}},id='actor',generating=false,data={},MAX_TEXT=500`,
            )
            .replace("</section>);}", `${upstreamComposer}</section>);}`)
        : `import {GenerationModelMenu} from '/src/renderer/workspace/generation-model-menu';import {Loader2} from 'lucide-react';${fixture}`
            .replace(
              "const jobs=",
              `const voiceModel=undefined,voiceModels=[],voicePrompt=${text},voiceBusy=false,settings={plugins:[]},dialog=React.useRef(null),submitting=false,character={voice:current},runningVoice=undefined,generationError='',latestJob=${failed}?{status:'failed',errorMessage:'生成失败'}:null;const jobs=`,
            )
            .replace(
              "providers={[]}/>;",
              `providers={[]}>${desktopComposer}</CharacterVoiceSection>;`,
            );
    }
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "character-body-fixture",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return join(root, entry);
            if ((gallery || voice) && id.endsWith(".css")) return "\0built-css";
          },
          load(id) {
            if (id === "\0built-css") return "export {};";
            if (id === join(root, entry))
              return `import React from 'react';import {createRoot} from 'react-dom/client';${fixture}const phase=location.search.slice(1),ready=${gallery}?phase!=='empty':phase==='ready',image=${JSON.stringify(image)};createRoot(document.querySelector('article')).render(<Fixture/>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: { width: narrow ? 390 : 1000, height: 680 },
      deviceScaleFactor: 1,
      colorScheme: dark ? "dark" : "light",
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      await page.route(`${origin}assets/**`, (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      await page.route(`${origin}audit*`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${dark ? "dark" : ""}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${stylesheet}"><main class="${upstream || gallery ? "" : "canvas-workspace"}"><article class="${gallery || identity || voice ? "" : upstream ? "bg-card rounded-md" : "creative-card"}" data-visual="true" data-character="true" style="position:fixed;left:${narrow ? 20 : 100}px;top:100px;width:${identity || voice ? (narrow ? 318 : 483) : gallery ? 304 : 576}px;${gallery || identity || voice ? `background:${dark ? "#303030" : "white"}` : ""}"></article></main><script type="module" src="${entry}"></script>`,
        }),
      );
      await page.clock.setFixedTime(new Date("2026-11-22T09:00:00Z"));
      for (const phase of phases) {
        await page.goto(`${origin}audit?${phase}`);
        if (voice) {
          await page.getByRole("heading", { name: "声音" }).waitFor();
          if (phase === "focus") {
            await page.keyboard.press("Tab");
            await page.getByRole("button", { name: "试听", exact: true }).first().focus();
          }
        } else if (identity) {
          const field = page.getByLabel("角色名称");
          await field.waitFor();
          if (phase === "editing" || phase === "blur") {
            await field.fill("  Lin 林舟  ");
            await field.fill("   ");
            if (phase === "blur") {
              await field.press("Tab");
              assert.equal(await field.inputValue(), "Lin 林舟");
              await page.getByLabel("形象名称").fill("");
            }
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            await page.waitForFunction(() =>
              document.getAnimations().every((effect) => effect.playState !== "running"),
            );
          }
        } else
          await page
            .getByRole("button", { name: gallery ? "从真人库引入" : "编辑角色卡" })
            .waitFor();
        if (gallery && phase !== "empty")
          await page.waitForFunction(
            () =>
              document.images.length === 2 &&
              [...document.images].every((image) => image.naturalWidth),
          );
        if (gallery && phase === "hover")
          await page.getByRole("button", { name: "放大预览补充图 1" }).hover();
        if (gallery && phase === "focus") {
          await page.mouse.move(1, 1);
          await page.keyboard.press("Tab");
          await page.getByRole("button", { name: "放大预览形象图" }).focus();
        }
        const human = page.getByRole("button", { name: "从真人库引入" });
        if (gallery && phase === "tool-focus") {
          await page.mouse.move(1, 1);
          await page.keyboard.press("Tab");
          await human.focus();
        }
        if (gallery && phase === "tool-pressed") {
          await human.hover();
          await page.mouse.down();
          await page.waitForFunction(
            () =>
              getComputedStyle(document.querySelector('button[aria-label="从真人库引入"]'))
                .transform === "matrix(0.96, 0, 0, 0.96, 0, 0)",
          );
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((image) => image.decode()));
        });
        if (phase === "ready")
          await page.waitForFunction(
            () =>
              document.images.length === 2 &&
              [...document.images].every((image) => image.naturalWidth),
          );
        const body = page.locator(voice ? "article > section" : "article > div").first();
        const bounds = await body.boundingBox();
        if (process.env.CHARACTER_GEOMETRY && composer && phase === "unbound")
          console.log(
            name,
            await body.locator("textarea").evaluate((element) => {
              const style = getComputedStyle(element);
              return [
                element.clientWidth,
                element.scrollHeight,
                style.font,
                style.letterSpacing,
                style.lineBreak,
                style.overflowWrap,
                style.scrollbarGutter,
                style.padding,
                style.borderWidth,
                style.textWrap,
                style.wordBreak,
                style.textAlign,
                style.tabSize,
                style.textIndent,
                style.textSpacingTrim,
                style.textSizeAdjust,
                style.boxSizing,
                style.display,
                element.placeholder,
              ];
            }),
          );
        if (process.env.CHARACTER_GEOMETRY && identity && phase === "episodes")
          console.log(
            name,
            await body.locator("span").evaluateAll((spans) =>
              spans.map((span) => {
                const style = getComputedStyle(span);
                return [
                  span.getBoundingClientRect().toJSON(),
                  style.font,
                  style.borderRadius,
                  style.backgroundColor,
                  style.boxShadow,
                  style.colorScheme,
                  style.cornerShape,
                ];
              }),
            ),
          );
        if (process.env.CHARACTER_GEOMETRY && phase === "empty")
          console.log(
            name,
            await body.evaluate((element) =>
              Array.from(element.querySelectorAll("button,span,b,svg")).map((item) => {
                const style = getComputedStyle(item),
                  rect = item.getBoundingClientRect();
                return [
                  item.tagName,
                  rect.x,
                  rect.y,
                  rect.width,
                  rect.height,
                  style.font,
                  style.color,
                  style.webkitFontSmoothing,
                  style.borderRadius,
                  style.letterSpacing,
                ];
              }),
            ),
          );
        records[`${name}-${phase}`] = {
          bounds,
          controls: await body.locator(identity ? "input" : "button").evaluateAll((buttons) =>
            buttons.map((button) => {
              const { x, y, width, height } = button.getBoundingClientRect();
              return { x, y, width, height };
            }),
          ),
        };
        await page.screenshot({
          clip: bounds,
          animations: "disabled",
          path: join(output, `${name}-${phase}.png`),
        });
        if (gallery && phase === "tool-pressed") {
          await page.mouse.move(1, 1);
          await page.mouse.up();
        }
      }
    } finally {
      await page.close();
      await server.close();
    }
  }
  const page = await browser.newPage();
  for (const phase of phases) {
    assert.deepEqual(records[`upstream-${phase}`].bounds, records[`desktop-${phase}`].bounds);
    assert.deepEqual(records[`upstream-${phase}`].controls, records[`desktop-${phase}`].controls);
    const pictures = await Promise.all(
      ["upstream", "desktop"].map((name) =>
        readFile(join(output, `${name}-${phase}.png`), "base64"),
      ),
    );
    records[phase] = await page.evaluate(async (pictures) => {
      const pixels = await Promise.all(
        pictures.map(async (picture) => {
          const image = new Image();
          image.src = "data:image/png;base64," + picture;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return new Uint32Array(context.getImageData(0, 0, image.width, image.height).data.buffer);
        }),
      );
      return pixels[0].reduce(
        (count, pixel, index) => count + Number(pixel !== pixels[1][index]),
        0,
      );
    }, pictures);
  }
  console.log(Object.fromEntries(phases.map((phase) => [phase, records[phase]])));
  await writeFile(join(output, "results.json"), JSON.stringify(records, null, 2));
  if (process.argv.includes("--strict")) assert(phases.every((phase) => records[phase] === 0));
} finally {
  await browser.close();
  await rm(temp, { force: true, recursive: true });
}
