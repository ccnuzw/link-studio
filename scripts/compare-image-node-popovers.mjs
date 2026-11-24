import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const upstream = resolve(process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web");
assert.equal(
  execFileSync("git", ["-C", upstream, "rev-parse", "--short=8", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  "ff4070c7",
);
const upstreamRequire = createRequire(join(upstream, "package.json"));
const { default: tailwind } = await import(upstreamRequire.resolve("@tailwindcss/vite"));
const output = resolve("test-results/image-node-popovers");
const modelsOnly = process.argv.includes("--models-only");
const openaiRatiosOnly = process.argv.includes("--openai-ratios-only");
const videoResolutionsOnly = process.argv.includes("--video-resolutions-only");
const resultsOnly = process.argv.includes("--results-only");
const pixelRatio = process.argv.includes("--retina") ? 2 : 1;
const clip =
  resultsOnly &&
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=size=96x54:duration=1",
    "-c:v",
    "libvpx",
    "-f",
    "webm",
    "pipe:1",
  ]).toString("base64");
const temp = await mkdtemp(join(tmpdir(), "image-popovers-"));
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--disable-gpu"],
});
await mkdir(output, { recursive: true });
const entry = "/src/__image_picker_fixture.tsx";
const shots = new Map();
try {
  for (const original of openaiRatiosOnly || videoResolutionsOnly ? [false] : [true, false]) {
    const root = original ? upstream : process.cwd();
    const name = original ? "baseline" : "studio";
    const imports = original
      ? `import "/src/index.css"; import {TestNode} from '/src/pages/admin/ai/models/test-node'; import { PresetBody } from '/src/components/canvas/preset-picker';
      import { VideoParamPanel } from '/src/components/canvas/video-param-panel';
      import { Popover, PopoverContent, PopoverTrigger } from '/src/components/ui/popover';`
      : `import '/src/renderer/styles.css'; import '/src/renderer/desktop-shell.css'; import '/src/renderer/settings/channel-workspace.css'; import {TrialInputCard,useTrialInputs} from '/src/renderer/settings/model-trial-input'; import {Sparkles} from 'lucide-react'; import '/src/renderer/workspace/canvas-workspace.css'; import '/src/renderer/workspace/canvas-prompt-editor.css'; import {GenerationForm} from '/src/renderer/workspace/generation';
      import { MediaPopover,MediaParameterPicker,MediaPresetPicker } from '/src/renderer/workspace/media-pickers'; import {modelGenerationOptions} from '@link-studio/core';`;
    const fields = {
      aspectRatio: { label: "画面比例", options: ["1:1", "3:2", "2:3"], default: "1:1" },
      resolution: { label: "清晰度", options: ["1K", "2K"], default: "1K" },
      count: { label: "生成数量", options: [1, 2, 4], default: 1, unit: "张" },
    };
    const fixture = `import {createRoot} from 'react-dom/client'; import {useRef,useState} from 'react'; ${imports}
      const fields=${JSON.stringify(fields)}; const kind=location.hash.slice(1); const parameters=kind==='parameters';
      const props={kind,selected:[],onPick:()=>{}}; const triggerStyle={position:'fixed',left:100,top:580};
      function App(){const anchor=useRef(null);const [open,setOpen]=useState(false);const [value,set]=useState({});const [selected,select]=useState([]);
      return ${original ? `<Popover open={open} onOpenChange={setOpen}><PopoverTrigger style={triggerStyle}>打开</PopoverTrigger><PopoverContent side="top" align="start" sideOffset={10} className={parameters?'nodrag nowheel w-80 rounded-xl p-3':'nodrag nowheel w-[min(620px,calc(100vw-1rem))] gap-0 overflow-hidden rounded-2xl p-0'}>{parameters?<VideoParamPanel caps={{params:Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,{...field,type:'enum',open:true}]))}} params={value} onChange={(key,item)=>set({...value,[key]:item})} section="params"/>:<PresetBody {...props} selected={selected.map(id=>({kind,id}))} onPick={id=>select([id])}/>}</PopoverContent></Popover>` : `<section className="canvas-surface media-generation"><form className="media-generation-form"><button type="button" ref={anchor} style={triggerStyle} onClick={()=>setOpen(true)}>打开</button>{open&&<MediaPopover mediaPanel presetPanel={!parameters} anchor={anchor} label={kind} close={()=>setOpen(false)}>{parameters?<fieldset className="media-parameter-fields"><MediaParameterPicker options={{...modelGenerationOptions('image',undefined,''),sizes:[],largeSizes:[],manualSize:false,qualities:[],counts:fields.count.options,hasConfiguredCount:true,ratios:fields.aspectRatio.options,resolutions:fields.resolution.options,defaultParameters:{aspectRatio:'1:1',resolution:'1K'}}} value={value} size="" duration="" change={v=>set({...value,...v})}/></fieldset>:<MediaPresetPicker {...props} selected={selected} onPick={id=>select([id])}/>}</MediaPopover>}</form></section>`};}
      const mount=createRoot(document.querySelector('article'));
      function Preview(){
        const [params,setParams]=useState({}); const test=kind.endsWith('test'); const video=kind.startsWith('video');
        const modelKind=video?'video':'image'; const ops=video?['t2v','i2v']:['t2i','i2i'];
        const ratios=['Auto','1:1','16:9','9:16','4:3','3:4'];const res=video?['720P','1080P']:['1K','2K','4K'];const unit=video?'个':'张';const name=video?'视频模型':'gpt-image-2.6';
        const definitions={aspectRatio:{...fields.aspectRatio,label:'比例',options:ratios,type:'enum',open:true},resolution:{...fields.resolution,options:res,default:res[0],type:'enum',open:true},...(video?{duration:{type:'number',open:true,label:'视频时长',min:5,max:10,default:5,unit:'秒'},generateAudio:{type:'boolean',open:true,label:'生成音频',default:true}}:{}), count:{...fields.count,unit,type:'enum',open:true}};
        const defaults=Object.fromEntries(Object.entries(definitions).map(([key,field])=>[key,field.default]));
        return ${original ? `<TestNode modelKey={name} vendor="openai" label={name} kind={modelKind} caps={{ops,refs:{image:{on:true,max:1,max_mb:10}},prompt:{max_length:20000},params:definitions}} params={params} assets={{}} errors={{}} onChange={(key,val)=>setParams({...params,[key]:val})} action={test?{label:'开始测试',onClick:()=>{}}:undefined}/>` : `<div className="model-settings"><div className="model-dialog" data-variant={test?'trial':undefined}><aside className={test?'model-trial-input':'model-preview'} style={{padding:0}}><TrialInputCard name={name} seed={name} logo="openai" kind={modelKind} preview={!test} inputs={useTrialInputs()} options={{...modelGenerationOptions(modelKind,undefined,''),modes:ops,references:{image:1},frameLimit:1,referenceLimit:1,ratios,resolutions:res,counts:[1,2,4],countUnit:unit,hasConfiguredCount:true,defaultParameters:defaults,parameterOrder:Object.keys(definitions),parameterLabels:Object.fromEntries(Object.entries(definitions).map(([k,v])=>[k,v.label])),audioLabel:'生成音频', audio:video,audioControl:true,durationRange:video?{min:5,max:10}:undefined,durationControl:video, durations:[],manualDuration:false,autoDuration:false,manualSize:false,sizes:[],largeSizes:[],qualities:[],seed:false,speaker:false,promptLimit:20000}}>{test&&<footer><button className="settings-primary"><Sparkles size={16}/> 开始测试</button></footer>}</TrialInputCard></aside></div></div>`};}
      if (kind.endsWith('-result')) {
        const media = kind.split('-')[0];
        const state = new URLSearchParams(location.search).get('state');
        const taskId = 'fixture-123';
        const rich = new URLSearchParams(location.search).has('details');
        const endpoint = 'https://example.test/render';
        const sample = {model:'fixture'};
        const description = {json:sample,method:'POST',responseType:'json',url:endpoint};
        const video = rich ? 'data:video/webm;base64,${clip}' : null;
        const name = media === 'video' ? '视频模型' : '图片模型';
        const noop = () => {};
        const model = media === 'video' ? 'doubao-seedance-2-5-flash' : 'seedream-4-0';
        const key = media === 'video' ? 'doubao-video' : 'doubao-image';
        const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=';
        ${
          original
            ? `const { ModelTestDialog } = await import('/src/pages/admin/ai/models/model-test-dialog');
        const { defaultCapabilities, defaultPricing } = await import('/src/utils/admin/model-template');
        function ResultFixture() {
          const [tab, setTab] = useState('run');
          const [dryRun, setDryRun] = useState(null);
          const caps = defaultCapabilities(media);
          const view = { status:state, kind:media, model_id:model, progress:0.42, error_message:'供应商拒绝请求',
            outputs: media==='image' || video ? [{ media_type:media, url:media==='image'?image:video }] : [] };
          const run = state === 'idle' ? null : { taskId, view, timedOut:false };
          return <ModelTestDialog open ws={{modelKey:model, body:{label:name,vendor:'doubao',kind:media,pricing:defaultPricing(media)},
            busy:state==='running'?'test-run':null, capabilities:caps, testParams:{}, testInput:{errors:{}}, testAssets:{},
            info:{}, run, dryRun, doDryRun:()=>{setDryRun({time:Date.now(),json:description});setTab('dry-run')},
            trace:run?{taskId,status:'ready',steps:rich?[{kind:'http',name:'submit',duration_ms:24,
              request:{method:'POST',url:endpoint,body:sample},response:{status:200,body:{ok:true}}}]:[]}:null,
            resultTab:tab, setResultTab:setTab}} onClose={noop}/>;
        }`
            : `const { ModelTrial } = await import('/src/renderer/settings/model-trial');
        const { applyKindTemplate } = await import('/src/renderer/settings/model-kind-template');
        const plugin = {kind:media, key, hash:key, version:'1', origin:'builtin', auth:'none', fields:{}};
        const config = applyKindTemplate({name,logo:'doubao',description:'',sort:0},media,false,{adapter:key,model});
        if (new URLSearchParams(location.search).has('legacy')) delete config.modes;
        const profile = {id:model, model, channel:{}, modelKey:model, revision:1, config};
        const result = {status:state, trace:rich?[{kind:'http',phase:'submit',seq:1,id:'step',durationMs:24,
          method:'POST',endpoint,status:200,requestBody:{text:JSON.stringify(sample)},responseBody:{text:'{"ok":true}'}}]:[],
          logs:[], error:state==='failed'?'PROVIDER_TEST_FAILED':undefined, errorMessage:state==='failed'?'供应商拒绝请求':undefined,
          outputs:media==='image'||video?[{id:media,mediaType:media,previewUrl:media==='image'?image:video}]:[]};
        window.desktop = {settings:{modelTrialResult:async()=>({ok:true,value:state==='idle'?null:{runId:taskId,
          expiresAt:Date.now()+60000, result:state==='running'?undefined:result}}),
          modelTrialProgress:async()=>({ok:true,value:{phase:'query',percent:42,trace:[]}}),
          modelTrial:async()=>({ok:true,value:{status:'preview',request:{method:'POST',responseType:'json',endpoint,
            body:JSON.stringify(sample)},trace:[],logs:[]}})}};
        if (media==='image') window.desktop.settings.modelTrial=async(input)=>({ok:true,value:{
          status:'preview',request:{method:'POST',responseType:'json',endpoint,body:JSON.stringify({
            images:input.references.map(ref=>({kind:ref.kind,mime:ref.file?.mime}))})},trace:[],logs:[]}});
        function ResultFixture() {return <div className="model-settings"><ModelTrial model={profile} plugin={plugin} close={noop}/></div>}`
        }
        mount.render(<ResultFixture/>);
      } else if(kind.endsWith('preview')||kind.endsWith('test')) mount.render(<Preview/>); else
      ${
        original
          ? `if(kind.endsWith('-provider')) {
            const {ModelEditorDialogs}=await import('/src/pages/admin/ai/models/model-editor-dialogs');
            const {defaultCapabilities}=await import('/src/utils/admin/model-template');
            const modelKind=kind.split('-')[0];
            const video=modelKind==='video';
            const model=video?'doubao-seedance-2-5-flash':'seedream-4-0';
            const channel={key:'local',name:'本地验证',enabled:true};
            function OriginalForm(){
              const [body,set]=useState(()=>{
                const caps=defaultCapabilities(modelKind);
                if(video){caps.refs.image.max=9;caps.refs.audio.max=4;}
                return {kind:modelKind,label:model,vendor:'doubao',channels:[{channel:'local',upstream_model:model}],deadline:video?'30m':'10m',capabilities:caps};
              });
              const [params,setParams]=useState({});
              return <ModelEditorDialogs catalog={{channels:[channel],plugins:[],pluginsStatus:'ready'}} ws={{
                mode:'form', selection:model, modelKey:model, detail:{enabled:true}, info:{channel,protocol:{}},
                body, capabilities:body.capabilities, editBody:set, checks:[], fieldIssues:[], fieldWarnings:[],
                testParams:params, setTestParam:(key,value)=>setParams({...params,[key]:value}), testAssets:{}, testInput:{errors:{}}}}/>;
            }
            mount.render(<OriginalForm/>);
          }else mount.render(<App/>);`
          : `if(kind.endsWith('-provider')){
        const {ModelEditor}=await import('/src/renderer/settings/model-editor');
        const {applyKindTemplate}=await import('/src/renderer/settings/model-kind-template');
        const modelKind=kind.split('-')[0], video=modelKind==='video';
        const fixed=new URLSearchParams(location.search).has('fixed');
        const key=video?'doubao-video':fixed?'openai-image':'doubao-image';const model=video?'doubao-seedance-2-5-flash':fixed?'gpt-image-2':'seedream-4-0';
        const plugin={kind:modelKind,key,hash:key,name:key,version:'1.0',origin:'builtin',auth:'none',fields:{}};
        const channel={id:'local',name:'本地验证',endpoint:'https://example.invalid',enabled:true,revision:1,hasSecret:true};
        const config=applyKindTemplate({name:model,logo:'doubao',description:'',sort:100},modelKind,false,{adapter:key,model});
        if(video){config.refs.image.max=9;config.refs.audio.max=4;}
        if(fixed && video){config.params.resolution={values:['720p'],default:'720p'};config.pricing={unit:'request',input:2};}
        else if(fixed){delete config.params.aspectRatio;config.params.size={values:['1536x1024'],default:'1536x1024'};config.parameterOrder=['size','count'];}
        const stored=value=>JSON.parse(JSON.stringify(value));
        let profile={id:model,model,modelKey:model,label:model,channelId:channel.id,channel:{},pluginHash:key,enabled:true,config:stored(config),revision:1};
        window.desktop={settings:{modelTrialResult:async()=>({ok:true}),modelSave:async(input)=>{profile=stored({...profile,model:input.upstreamModel,channel:input.settings,config:input.config,revision:profile.revision+1});return {ok:true,value:profile}}}};
        function ProviderFixture(){const [open,setOpen]=useState(true);const [text,change]=useState('');const noop=()=>{};
          const node={id:modelKind,type:'creative',data:{kind:modelKind,label:modelKind,text}};
          return open?<div className="model-settings"><ModelEditor model={profile} providers={[profile]} plugins={[plugin]} pluginsStatus="ready" channel={channel} channels={[channel]} saved={async()=>{}} close={()=>setOpen(false)}/></div>:<><button onClick={()=>setOpen(true)}>重新编辑</button><div style={{position:'fixed',top:450,left:120}}><GenerationForm inline node={node} graph={{nodes:[node],edges:[]}} assets={[]} settings={{providers:[profile],plugins:[plugin]}} onPromptChange={change} onMentionLink={noop} onUploadReference={noop} close={noop} submit={noop}/></div></>}
        mount.render(<ProviderFixture/>);
      }else if(kind==='node'||kind==='video-node'){
        function NodeFixture(){const [text,change]=useState('');const modelKind=kind==='node'?'image':'video';const node={id:modelKind,type:'creative',data:{kind:modelKind,label:modelKind,text}};
        const plugin={hash:'local',kind:modelKind,auth:'none',origin:'builtin',key:modelKind==='video'?'sora':'openai-image'};
        const provider={id:'local',label:modelKind,enabled:true,model:modelKind==='video'?'sora-2':'gpt-image-1',pluginHash:plugin.hash,channel:{}};
        const noop=()=>{};return <div style={{position:'fixed',top:450,left:120}}><GenerationForm inline node={node} graph={{nodes:[node],edges:[]}} assets={[]} settings={{providers:[provider],plugins:[plugin]}} onPromptChange={change} onMentionLink={noop} onUploadReference={noop} close={noop} submit={noop}/></div>}
        mount.render(<NodeFixture/>);
      }else mount.render(<App/>);`
      }`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        ...(original ? [tailwind()] : []),
        {
          name: "image-picker-fixture",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return id;
          },
          load(id) {
            if (id === entry) return fixture;
          },
          transform(code, id) {
            if (original && id.endsWith("/preset-picker.tsx"))
              return code.replace("function PresetBody(", "export function PresetBody(");
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["dark", "light"]) {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 750 },
          colorScheme: theme,
          deviceScaleFactor: pixelRatio,
        });
        page.on("pageerror", (error) => console.error(error));
        await page.route(`${origin}audit*`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html class="${theme}" style="background:#707070"><meta charset="utf-8"><style>article > .model-settings { background:transparent }</style><body style="background:#707070;min-height:100vh"><main class="${original ? "" : "canvas-workspace"}" style="background:transparent"><article></article></main><script type="module" src="${entry}"></script>`,
          }),
        );
        if (videoResolutionsOnly) {
          await page.setViewportSize({ width: 1400, height: 900 });
          await page.goto(`${origin}audit?fixed#video-provider`);
          await page.getByText("能力与参数", { exact: true }).click();
          const card = page.getByLabel("创作端预览");
          const group = (panel) => panel.getByRole("radiogroup", { name: "清晰度", exact: true });
          assert.equal(await group(card).getByRole("radio").count(), 1);
          await page.getByRole("button", { name: "同步视频清晰度" }).click();
          const verify = async (panel) => {
            const choices = group(panel).getByRole("radio");
            assert.deepEqual(await choices.allTextContents(), ["720p", "1080P", "4K", "480P"]);
            const option = group(panel).getByRole("radio", { name: "480P", exact: true });
            await option.click();
            assert.equal(await option.isChecked(), true);
          };
          await verify(card);
          await card.screenshot({ path: join(output, `video-resolution-${theme}.png`) });
          await page.getByRole("button", { name: "保存模型" }).click();
          await page.getByRole("button", { name: "生成参数", exact: true }).click();
          await verify(page.getByRole("region", { name: "生成参数" }));
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "重新编辑" }).click();
          await page.getByText("能力与参数", { exact: true }).click();
          assert.equal(
            await group(card).getByRole("radio", { name: "720p", exact: true }).isChecked(),
            true,
          );
          await page.getByRole("button", { name: "测试模型", exact: true }).click();
          await verify(page.locator('dialog[data-variant="trial"]'));
          console.log(`${theme}: video resolution sync, save, canvas, reopen and trial passed`);
          await page.close();
          continue;
        }
        if (openaiRatiosOnly) {
          await page.setViewportSize({ width: 1400, height: 900 });
          await page.goto(`${origin}audit?fixed#image-provider`);
          await page.getByText("能力与参数", { exact: true }).click();
          const card = page.getByLabel("创作端预览");
          assert.equal(await card.getByRole("radio", { name: "16:9", exact: true }).count(), 0);
          await page.getByRole("button", { name: "同步图片生成参数" }).click();
          await card.getByRole("radio", { name: "16:9", exact: true }).waitFor();
          const sizes = card.getByRole("radiogroup", { name: "尺寸", exact: true });
          const quality = card.getByRole("radiogroup", { name: "质量", exact: true });
          assert.equal(
            await sizes.getByRole("radio", { name: "1536x1024", exact: true }).isChecked(),
            true,
          );
          for (const name of ["自动", "低", "中", "高"]) {
            const choice = quality.getByRole("radio", { name, exact: true });
            await choice.click();
            assert.equal(await choice.isChecked(), true);
          }
          for (const name of ["auto", "1024x1024", "1536x1024", "1024x1536"]) {
            const choice = sizes.getByRole("radio", { name, exact: true });
            await choice.click();
            assert.equal(await choice.isChecked(), true);
          }
          for (const name of ["Auto", "1:1", "16:9", "9:16", "4:3", "3:4"]) {
            const ratio = card
              .getByRole("radiogroup", { name: "比例", exact: true })
              .getByRole("radio", { name, exact: true });
            await ratio.click();
            assert.equal(await ratio.isChecked(), true);
          }
          await card.getByRole("radio", { name: "1:1", exact: true }).click();
          await card.screenshot({ path: join(output, `openai-${theme}-ratios.png`) });
          await page.getByRole("button", { name: "保存模型" }).click();
          await page.getByRole("button", { name: "生成参数", exact: true }).click();
          const canvas = page.getByRole("region", { name: "生成参数" });
          for (const name of ["尺寸", "质量"])
            assert.equal(
              await canvas
                .getByRole("radiogroup", { name, exact: true })
                .getByRole("radio")
                .count(),
              4,
            );
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "重新编辑" }).click();
          await page.getByText("能力与参数", { exact: true }).click();
          assert.equal(await sizes.getByRole("radio").count(), 4);
          assert.equal(await quality.getByRole("radio").count(), 4);
          await page.getByRole("button", { name: "测试模型", exact: true }).click();
          const trial = page.locator('dialog[data-variant="trial"]');
          await trial
            .getByRole("radiogroup", { name: "质量", exact: true })
            .getByRole("radio", { name: "高", exact: true })
            .click();
          await trial.getByRole("radio", { name: "1024x1536", exact: true }).click();
          console.log(`${theme}: OpenAI legacy size → six template ratios`);
          await page.close();
          continue;
        }
        if (resultsOnly) {
          await page.goto(`${origin}audit?state=succeeded&details#video-result`);
          const richDialog = page.getByRole("dialog");
          const richPanel = richDialog.getByRole("tabpanel");
          const player = richPanel.locator("video[controls]");
          await player.waitFor();
          const dimensions = await player.evaluate(async (video) => {
            video.muted = true;
            await video.play();
            video.pause();
            return [video.videoWidth, video.videoHeight];
          });
          assert.deepEqual(dimensions, [96, 54]);
          await richDialog.getByRole("tab", { name: /追踪/ }).click();
          await richPanel.getByRole("button", { name: /POST.*render/ }).click();
          await richPanel.getByText("响应体", { exact: true }).waitFor();
          if (!original) await richDialog.getByLabel("测试提示词").fill("试跑样例");
          await richDialog.getByRole("button", { name: "只看请求（不发送）" }).click();
          await richPanel.locator("pre").waitFor();
          assert.deepEqual(JSON.parse(await richPanel.locator("pre").innerText()).json, {
            model: "fixture",
          });
          if (!original) {
            await richDialog.getByRole("tab", { name: "日志" }).click();
            await richPanel.getByText("modelTrial", { exact: true }).click();
            const bodies = await richPanel.locator("pre").allTextContents();
            assert.deepEqual(
              bodies.map((body) => JSON.parse(body)),
              [
                { dry: true, referenceCount: 0 },
                { status: "preview", outputCount: 0, stepCount: 0 },
              ],
            );
            await richPanel.getByRole("button", { name: "清空" }).click();
            await richPanel.getByText("还没有请求").waitFor();
          }
          for (const variant of original ? [] : ["", "&legacy"]) {
            await page.goto(`${origin}audit?state=idle${variant}#image-result`);
            const trial = page.getByRole("dialog");
            await trial.getByRole("radio", { name: "图生图" }).click();
            assert.equal(
              await trial.getByRole("radio", { name: "图生图" }).getAttribute("aria-checked"),
              "true",
            );
            await trial.getByRole("button", { name: "上传", exact: true }).waitFor();
            const upload = trial.getByLabel("选择本地图片");
            const dryRun = trial.getByRole("button", { name: "只看请求（不发送）" });
            await trial.getByLabel("测试提示词").fill("参考图测试");
            await dryRun.click();
            await trial.getByText("图生方式需要至少 1 张参考图片").waitFor();
            await upload.setInputFiles({
              name: "sample.png",
              mimeType: "image/png",
              buffer: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
                "base64",
              ),
            });
            const request = trial.getByRole("tabpanel", { name: "请求描述" }).locator("pre");
            await dryRun.click();
            assert.deepEqual(JSON.parse(await request.innerText()).json.images, [
              { kind: "image", mime: "image/png" },
            ]);
            await trial.getByRole("radio", { name: "文生图" }).click();
            assert.equal(await upload.count(), 0);
            await dryRun.click();
            await page.waitForFunction(
              () =>
                JSON.parse(document.querySelector('[role="tabpanel"] pre').textContent).json.images
                  .length === 0,
            );
            await trial.getByRole("radio", { name: "图生图" }).click();
            await trial.getByRole("button", { name: "移除素材 sample.png" }).click();
            assert.equal(await upload.isEnabled(), true);
            assert.equal(await trial.getByRole("radio", { name: "图生图" }).isChecked(), true);
          }
          for (const modelKind of ["image", "video"]) {
            for (const state of ["idle", "running", "succeeded", "failed"]) {
              await page.setViewportSize({ width: 1400, height: 900 });
              await page.goto(`${origin}audit?state=${state}#${modelKind}-result`);
              await page.locator("html").evaluate((html, scheme) => {
                html.classList.add("admin-theme");
                html.style.colorScheme = scheme;
              }, theme);
              const dialog = page.getByRole("dialog");
              const panel = dialog.getByRole("tabpanel");
              await panel.waitFor();
              await page.evaluate(() => document.fonts.ready);
              if (state === "idle") await panel.getByText("还没有试跑").waitFor();
              else {
                await panel.getByRole("heading", { name: "试跑任务 #fixture-123" }).waitFor();
                await panel.getByText(state, { exact: true }).waitFor();
              }
              if (state === "running") {
                const bar = panel.getByRole("progressbar");
                assert.equal(await bar.getAttribute(original ? "aria-valuenow" : "value"), "42");
              } else if (state === "failed") {
                await panel.getByText("供应商拒绝请求", { exact: true }).waitFor();
                await panel.getByRole("button", { name: "复制修复信息" }).waitFor();
              } else if (state === "succeeded") {
                if (modelKind === "image")
                  await panel.getByRole("img", { name: "试跑产物" }).waitFor();
                else await panel.getByText("没有产出文件。").waitFor();
              }
              await dialog.screenshot({
                path: join(output, `${name}-${theme}-${modelKind}-result-${state}.png`),
                animations: "disabled",
              });
              const metrics = await Promise.all(
                [dialog, panel, dialog.getByRole("tablist")].map(async (locator) => {
                  const box = await locator.boundingBox();
                  return [box.width, box.height];
                }),
              );
              const key = `${theme}-${modelKind}-${state}`;
              if (original) shots.set(key, metrics);
              else {
                assert.deepEqual(metrics, shots.get(key), key);
                console.log(key, "matched trial dialog, result panel and tabs");
              }
              await dialog.getByRole("tab", { name: "请求描述" }).click();
              await panel.getByText("还没有请求描述").waitFor();
              await dialog.getByRole("tab", { name: "日志" }).click();
              await panel.getByText("还没有请求").waitFor();
            }
          }
          await page.close();
          continue;
        }
        for (const kind of modelsOnly ? [] : ["parameters", "style", "tpl", "motion"]) {
          await page.goto(`${origin}audit?${kind}#${kind}`);
          await page.getByText("打开", { exact: true }).click();
          const panel = page.locator(
            original ? '[data-slot="popover-content"]' : ".image-node-popover",
          );
          await panel.waitFor();
          for (const chosen of [false, true]) {
            if (chosen && kind === "motion") await panel.locator("button:has(img)").first().click();
            else if (chosen)
              await panel
                .getByText(
                  kind === "style" ? "古装偶像" : kind === "tpl" ? "25宫格连贯分镜" : "3:2",
                  { exact: true },
                )
                .click();
            await page.mouse.move(900, 700);
            await panel.evaluate(async (el) => {
              await document.fonts.ready;
              await Promise.all(
                [...el.querySelectorAll("img")]
                  .filter(
                    (img) => img.getBoundingClientRect().top < el.getBoundingClientRect().bottom,
                  )
                  .map((img) => img.decode()),
              );
              await Promise.all(
                document.getAnimations().map((anim) => anim.finished.catch(() => {})),
              );
            });
            const key = `${theme}-${kind}-${chosen ? "selected" : "initial"}`;
            const bounds = await panel.boundingBox();
            const clip = {
              x: bounds.x - 6,
              y: bounds.y - 6,
              width: bounds.width + 12,
              height: bounds.height + 16,
            };
            const file = join(output, `${name}-${key}.png`);
            await page.screenshot({ path: file, clip });
            const rgb = execFileSync(
              "ffmpeg",
              ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
              { maxBuffer: 4 * 1024 * 1024 },
            );
            if (original) shots.set(key, { rgb, bounds });
            else {
              const baseline = shots.get(key);
              assert.deepEqual(bounds, baseline.bounds, key);
              assert.equal(rgb.length, baseline.rgb.length, key);
              let differences = 0;
              for (let offset = 0; offset < rgb.length; offset += 3)
                if (rgb.readUIntBE(offset, 3) !== baseline.rgb.readUIntBE(offset, 3)) differences++;
              console.log(key, differences, "different pixels");
              assert.equal(differences, 0, key);
            }
          }
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "hidden" });
        }
        for (const kind of ["image-preview", "image-test", "video-preview", "video-test"]) {
          await page.goto(`${origin}audit?${kind}#${kind}`);
          await page.evaluate(() => {
            document.documentElement.classList.add("admin-theme");
            document.querySelector("main").className = "";
          });
          await page.addStyleTag({
            content:
              "article {width:302px; margin:20px} article .model-settings,article .model-settings .model-dialog,article .model-dialog > aside {display:block; padding:0; border:0; margin:0; width:302px; height:auto; min-width:0; min-height:0; position:static;}",
          });
          if (!original)
            await page.locator(".model-settings").evaluate((root, scheme) => {
              root.style.colorScheme = scheme;
            }, theme);
          const card = page.locator(original ? '[data-slot="test-node"]' : ".model-media-preview");
          await card.waitFor();
          await page.evaluate(() => document.fonts.ready);
          await card.screenshot({
            path: join(output, `${name}-${theme}-${kind}.png`),
            animations: "disabled",
          });
          const geometry = await card.evaluate((el) =>
            [
              el,
              el.querySelector("textarea"),
              el.querySelector('[role="radiogroup"]'),
              ...Array.from(el.querySelectorAll("button")).filter((b) =>
                ["1:1", "2张", "2个"].includes(b.textContent),
              ),
            ].map((el) => {
              const r = el.getBoundingClientRect();
              return [r.width, r.height, r.y - el.closest("article").getBoundingClientRect().y];
            }),
          );
          const key = `${theme}-${kind}`;
          if (original) shots.set(key, geometry);
          else {
            assert.deepEqual(geometry, shots.get(key), key);
            console.log(key, "matched card and control geometry");
          }
          await card.getByText(kind.startsWith("image") ? "2张" : "2个", { exact: true }).click();
          await card.getByRole("radio").nth(1).click();
          if (kind.startsWith("video"))
            await card.getByText("上传", { exact: true }).first().waitFor();
          else if (original) {
            assert.equal(
              await card.getByRole("radio", { name: "文生图" }).getAttribute("aria-checked"),
              "true",
            );
            assert.equal(await card.getByText("上传", { exact: true }).count(), 0);
          } else {
            assert.equal(await card.getByRole("radio", { name: "图生图" }).isChecked(), true);
            await card.getByRole("button", { name: "上传", exact: true }).waitFor();
          }
        }
        const editorMetrics = async (root, modelKind) => {
          const ratioName = root.getByLabel("aspect_ratio 的展示名");
          const toggle = original
            ? ratioName.locator("..").locator('[data-slot="switch"]').first()
            : root.getByRole("switch", { name: "比例 开放给用户" });
          const controls = [
            root.getByRole("group", { name: "生成方式", exact: true }).getByRole("button").first(),
            root.getByLabel("参考图片最多数量"),
            ratioName,
            toggle,
            root.getByRole("button", { name: "上移", exact: true }).first(),
          ];
          const dimensions = [];
          for (const control of controls) {
            const target = await control.evaluate((element) => {
              const visible = element.matches("input[role=switch]")
                ? element.nextElementSibling
                : element;
              const { width, height } = visible.getBoundingClientRect();
              return [width, height];
            });
            dimensions.push(target);
          }
          const id = `${theme}-${modelKind}-editor`;
          if (original) shots.set(id, dimensions);
          else assert.deepEqual(dimensions, shots.get(id), id);
          const dialog = page.getByRole("dialog", { name: "编辑模型" });
          const preview = dialog.locator(
            original ? '[data-slot="test-node"]' : ".model-media-preview",
          );
          const group = dialog.getByRole("group", { name: "生成方式", exact: true });
          const chipStyle = () =>
            group
              .getByRole("button")
              .first()
              .evaluate((button) => {
                const style = getComputedStyle(button);
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                return [style.color, style.backgroundColor, style.borderTopColor].map((color) => {
                  ctx.clearRect(0, 0, 1, 1);
                  ctx.fillStyle = color;
                  ctx.fillRect(0, 0, 1, 1);
                  return Array.from(ctx.getImageData(0, 0, 1, 1).data);
                });
              });
          if (original) shots.set(id + "-pressed", await chipStyle());
          else
            assert.deepEqual(
              await chipStyle(),
              shots.get(id + "-pressed"),
              `${id} selected mode colors`,
            );
          const layout = await Promise.all(
            [dialog, preview, group].map(async (element) => {
              const { x, y, width, height } = await element.boundingBox();
              return [x, y, width, height];
            }),
          );
          await dialog.screenshot({
            path: join(output, `${name}-${theme}-${modelKind}-editor.png`),
            animations: "disabled",
          });
          if (original) shots.set(id + "-layout", layout);
          else
            assert.deepEqual(
              layout,
              shots.get(id + "-layout"),
              `${id} dialog, preview and generation modes`,
            );
          if (modelKind === "video") {
            const duration = preview.getByRole("slider");
            const scroller = duration.locator(
              'xpath=ancestor::*[contains(@class,"overflow-y-auto") or contains(@class,"trial-media-fields")][1]',
            );
            await scroller.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            const controls = [
              duration,
              preview.getByRole("spinbutton"),
              preview.getByText("开启", { exact: true }),
              preview.getByText("4个", { exact: true }),
            ];
            const bounds = await Promise.all(controls.map((control) => control.boundingBox()));
            await preview.screenshot({
              path: join(output, `${name}-${theme}-video-bottom-${pixelRatio}x.png`),
              animations: "disabled",
            });
            if (original) shots.set(id + "-bottom", bounds);
            else
              assert.deepEqual(
                bounds,
                shots.get(id + "-bottom"),
                `${id} scrolled duration, audio and count`,
              );
            await scroller.evaluate((element) => {
              element.scrollTop = 0;
            });
          }
          if (modelKind === "image") {
            await group.getByRole("button", { name: "文生图" }).click();
          } else {
            await preview.getByRole("radio", { name: "全能参考" }).click();
          }
          const uploads = preview.getByRole("button", { name: "上传", exact: true });
          await uploads.first().waitFor();
          assert.equal(await uploads.count(), modelKind === "image" ? 1 : 3);
          const buttons = await uploads.evaluateAll((items) =>
            items.map((button) => {
              const box = button.getBoundingClientRect();
              const card = button
                .closest('[data-slot="test-node"],.model-media-preview')
                .getBoundingClientRect();
              return [box.x - card.x, box.y - card.y, box.width, box.height];
            }),
          );
          await preview.screenshot({
            path: join(output, `${name}-${theme}-${modelKind}-references.png`),
            animations: "disabled",
          });
          if (original) shots.set(id + "-references", buttons);
          else {
            assert.deepEqual(
              buttons,
              shots.get(id + "-references"),
              `${id} reference upload controls`,
            );
            const localFile = preview.getByLabel(
              modelKind === "image" ? "选择本地图片" : "选择本地视频",
            );
            const file =
              modelKind === "image"
                ? { name: "参考图.png", mimeType: "image/png" }
                : { name: "视频附件.webm", mimeType: "video/webm" };
            await localFile.setInputFiles({ ...file, buffer: Buffer.from("fixture") });
            await preview.getByRole("button", { name: `移除素材 ${file.name}` }).click();
            await preview.getByRole("button", { name: "画布素材", exact: true }).first().click();
            await page.getByRole("menuitem", { name: "使用公开链接" }).click();
            await preview.getByLabel("参考图片链接").fill("https://assets.example.com/photo.png");
            await preview
              .getByText(modelKind === "image" ? "1 / 4" : "1 / 9", { exact: true })
              .waitFor();
            await preview.getByLabel("参考图片链接").fill("");
            if (modelKind === "video") {
              if (theme === "light") {
                const path = join(temp, "100MB.mp4");
                const file = await open(path, "w");
                await file.truncate(100 * 1024 * 1024 + 1);
                await file.close();
                await localFile.setInputFiles(path);
                await preview.getByRole("alert").filter({ hasText: "100 MB" }).waitFor();
                const resized = await open(path, "r+");
                await resized.truncate(100 * 1024 * 1024);
                await resized.close();
                await page.evaluate(() => {
                  let first = true;
                  window.desktop.dialogs = {
                    uploadTrialReference: async () => {
                      if (!first)
                        return { ok: true, url: "https://assets.example.com/uploaded-video.mp4" };
                      first = false;
                      return { ok: false };
                    },
                  };
                });
                await localFile.setInputFiles(path);
                await preview.getByText("素材上传失败，请重新选择上传。").waitFor();
                await localFile.setInputFiles(path);
                await preview.getByRole("button", { name: "移除素材 100MB.mp4" }).click();
                assert.equal(await localFile.isEnabled(), true);
                await page.evaluate(() => {
                  delete window.desktop.dialogs;
                });
              }
              const selected = [];
              for (const [kind, label, count] of [
                ["image", "图片", 9],
                ["audio", "音频", 4],
                ["video", "视频", 1],
              ]) {
                const input = preview.getByLabel(`选择本地${label}`);
                assert.equal(await input.isEnabled(), true);
                const files = Array.from({ length: count }, (_, index) => ({
                  name: `${kind}-${index}`,
                  mimeType: { image: "image/png", audio: "audio/mpeg", video: "video/webm" }[kind],
                  buffer: Buffer.from("fixture"),
                }));
                await input.setInputFiles(files);
                await preview.getByText(`${count} / ${count}`, { exact: true }).waitFor();
                selected.push(...files);
              }
              for (const file of selected)
                await preview
                  .getByRole("button", { name: `移除素材 ${file.name}`, exact: true })
                  .click();
            }
          }
          if (modelKind === "image") await group.getByRole("button", { name: "文生图" }).click();
          else await preview.getByRole("radio", { name: "文生视频" }).click();
        };
        if (original) {
          for (const modelKind of ["image", "video"]) {
            await page.setViewportSize({ width: 1400, height: 900 });
            await page.goto(`${origin}audit?provider=${modelKind}#${modelKind}-provider`);
            await page.locator("html").evaluate((el) => el.classList.add("admin-theme"));
            await page.getByText("能力与参数", { exact: true }).click();
            await page.getByLabel("aspect_ratio 的展示名").waitFor();
            await page.evaluate(() => document.fonts.ready);
            await editorMetrics(page, modelKind);
          }
        } else {
          for (const modelKind of ["image", "video"]) {
            await page.setViewportSize({ width: 1400, height: 900 });
            await page.goto(`${origin}audit?provider=${modelKind}#${modelKind}-provider`);
            const editor = page.getByRole("dialog", { name: "编辑模型" });
            await page.locator("html").evaluate((root, scheme) => {
              root.style.colorScheme = scheme;
            }, theme);
            await editor.getByRole("tab", { name: "能力与参数" }).click();
            const card = editor.locator(".model-media-preview");
            await card.waitFor();
            await editorMetrics(editor, modelKind);
            if (theme === "light" && modelKind === "video") {
              await editor.screenshot({ path: join(output, "video-generation-modes.png") });
              await card.locator(".trial-media-fields").evaluate((el) => {
                el.scrollTop = el.scrollHeight;
              });
              await card.screenshot({ path: join(output, "video-preview-parameters.png") });
              await card.locator(".trial-media-fields").evaluate((el) => {
                el.scrollTop = 0;
              });
            }
            const group = editor.getByRole("group", { name: "生成方式", exact: true });
            const op = modelKind === "video" ? "图生视频" : "图生图";
            const modePicker = card.getByRole("radiogroup", { name: "生成方式" });
            const modes = await modePicker.getByRole("radio").allTextContents();
            await group.getByRole("button", { name: op }).click();
            assert.equal(await card.getByRole("radio", { name: op }).count(), 0);
            await group.getByRole("button", { name: op }).click();
            assert.deepEqual(await modePicker.getByRole("radio").allTextContents(), modes);
            const reference = editor.getByRole("switch", { name: "接收参考图片" });
            const maximum = editor.getByRole("spinbutton", { name: "参考图片最多数量" });
            const previousMax = await maximum.inputValue();
            await reference.click();
            assert.equal(await maximum.count(), 0);
            const refCard = editor.locator('[data-field="refs.image"]');
            await refCard
              .getByText("选了图生方式，需要开启图片参考素材", { exact: true })
              .waitFor();
            await reference.click();
            assert.equal(await maximum.inputValue(), previousMax);
            assert.equal(await refCard.locator(".model-field-note").count(), 0);
            await maximum.fill("0");
            await refCard.getByText(/^允许范围 1 – /).waitFor();
            await maximum.fill(previousMax);
            for (const width of [600, 1400]) {
              await page.setViewportSize({ width, height: 900 });
              const columns = await editor
                .locator(".model-reference-grid")
                .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
              assert.equal(columns, width < 640 ? 1 : 2);
            }
            if (modelKind === "video") {
              const seconds = card.getByRole("spinbutton", { name: "视频时长（数值）" });
              await seconds.fill("8");
              const slider = card.getByRole("slider", { name: "视频时长" });
              assert.equal(await slider.inputValue(), "8");
              await slider.press("ArrowRight");
              assert.equal(await seconds.inputValue(), "9");
              await card.getByRole("radio", { name: "关闭", exact: true }).click();
              assert.equal(
                await card
                  .getByRole("radio", { name: "关闭", exact: true })
                  .getAttribute("aria-checked"),
                "true",
              );
            } else {
              await card.getByRole("radio", { name: "图生图" }).click();
              assert.equal(
                await card.getByRole("radio", { name: "图生图" }).getAttribute("aria-checked"),
                "true",
              );
              const upload = card.getByLabel("选择本地图片");
              await upload.setInputFiles({
                name: "sample.png",
                mimeType: "image/png",
                buffer: Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kqX8AAAAASUVORK5CYII=",
                  "base64",
                ),
              });
              await card.getByRole("button", { name: "移除素材 sample.png" }).click();
              assert.equal(await card.getByText("0 / 4", { exact: true }).count(), 1);
              await card.getByRole("radio", { name: "文生图" }).click();
            }
            assert.equal(await card.getByLabel("随机种子").count(), 0);
            const palette = async (card) =>
              card.evaluate((el) =>
                [el, ...el.querySelectorAll(".trial-media-fields fieldset,textarea,select")].map(
                  (item) => getComputedStyle(item).colorScheme,
                ),
              );
            assert.ok(
              (await palette(card)).every((scheme) => scheme === theme),
              `${modelKind} editor against ${theme} system`,
            );
            assert.equal(
              await card.evaluate((el) => getComputedStyle(el).backgroundColor),
              theme === "dark" ? "oklch(0.205 0 0)" : "oklch(0.985 0.004 85)",
            );
            const unit = modelKind === "image" ? "张" : "个";
            const quantity = editor
              .locator(".model-editor-form fieldset")
              .filter({ has: page.getByLabel("count 的展示名") });
            await quantity.getByRole("button", { name: "设 4 为默认值" }).click();
            await quantity.getByRole("button", { name: "删除可选值 2" }).click();
            assert.equal(
              await card
                .getByRole("radio", { name: `4${unit}`, exact: true })
                .getAttribute("aria-checked"),
              "true",
            );
            assert.equal(
              await card.getByRole("radio", { name: `2${unit}`, exact: true }).count(),
              0,
            );
            await editor.getByRole("switch", { name: "清晰度 开放给用户" }).click();
            assert.equal(await card.getByRole("radiogroup", { name: "清晰度" }).count(), 0);
            if (theme === "light")
              await editor.screenshot({
                path: join(output, `provider-${modelKind}-${theme}-editor.png`),
              });
            await editor.getByRole("button", { name: "保存模型" }).click();
            await page.getByRole("button", { name: "生成参数", exact: true }).click();
            const canvas = page.getByRole("region", { name: "生成参数" });
            await canvas.waitFor();
            assert.equal(
              await canvas
                .getByRole("radio", { name: `4${unit}`, exact: true })
                .getAttribute("aria-checked"),
              "true",
            );
            assert.equal(
              await canvas.getByRole("radio", { name: `2${unit}`, exact: true }).count(),
              0,
            );
            assert.equal(await canvas.getByRole("radiogroup", { name: "清晰度" }).count(), 0);
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: "重新编辑" }).click();
            await editor.getByRole("button", { name: "测试模型", exact: true }).click();
            const trial = page.locator('dialog[data-variant="trial"] .model-media-preview');
            await trial.waitFor();
            assert.equal(
              await trial
                .getByRole("radio", { name: `4${unit}`, exact: true })
                .getAttribute("aria-checked"),
              "true",
            );
            assert.equal(
              await trial.getByRole("radio", { name: `2${unit}`, exact: true }).count(),
              0,
            );
            assert.equal(await trial.getByRole("radiogroup", { name: "清晰度" }).count(), 0);
            assert.ok((await palette(trial)).every((scheme) => scheme === theme));
            assert.equal(
              await trial.evaluate((el) => getComputedStyle(el).backgroundColor),
              theme === "dark" ? "oklch(0.205 0 0)" : "oklch(0.985 0.004 85)",
            );
            console.log(modelKind, theme, "provider edit, save, canvas, trial and theme passed");
          }
          if (modelsOnly) {
            await page.close();
            continue;
          }
          await page.setViewportSize({ width: 1000, height: 750 });
          await page.goto(`${origin}audit?node#node`);
          const openPicker = async (name) => {
            await page.getByRole("button", { name, exact: true }).click();
            return page.getByRole("region", { name, exact: true });
          };
          const trigger = page.getByRole("button", { name: "风格", exact: true });
          const color = async () =>
            trigger.evaluate(async (button) => {
              await Promise.all(button.getAnimations().map((animation) => animation.finished));
              return getComputedStyle(button).backgroundColor;
            });
          assert.deepEqual(
            await trigger.evaluate((button) => [
              button.offsetWidth,
              button.offsetHeight,
              button.textContent,
              button.querySelector("svg").clientWidth,
            ]),
            [32, 32, "", 16],
          );
          await trigger.hover();
          assert.equal(
            await color(),
            theme === "dark" ? "oklch(1 0 0 / 0.07)" : "oklch(0 0 0 / 0.05)",
          );
          const params = await openPicker("生成参数");
          await params.waitFor();
          const countSelect = params.getByRole("combobox", { name: "生成数量" });
          assert.equal(await countSelect.locator("option").count(), 8);
          await countSelect.selectOption("3");
          assert.equal(await countSelect.inputValue(), "3");
          await page.keyboard.press("Escape");
          await params.waitFor({ state: "hidden" });
          const styles = await openPicker("风格");
          await page.mouse.move(950, 700);
          assert.equal(
            await color(),
            theme === "dark" ? "oklch(0.985 0 0 / 0.1)" : "oklch(0.145 0 0 / 0.1)",
          );
          await styles.getByRole("button", { name: "古装偶像", exact: true }).click();
          await styles.waitFor({ state: "hidden" });
          assert.equal(await trigger.getAttribute("title"), "风格：古装偶像");
          assert.equal(
            await color(),
            theme === "dark" ? "oklch(0.985 0 0 / 0.1)" : "oklch(0.145 0 0 / 0.1)",
          );
          await page
            .locator(".media-generation-toolbar")
            .screenshot({ path: join(output, `studio-${theme}-toolbar.png`) });
          await page.getByRole("textbox", { name: "生成提示词" }).getByText("古装偶像").waitFor();
          await page.getByRole("button", { name: "放大编辑提示词" }).click();
          const templates = await openPicker("提示词模板");
          await templates.getByRole("button", { name: "25宫格连贯分镜" }).click();
          await templates.waitFor({ state: "hidden" });
          await page
            .getByRole("dialog", { name: "编辑提示词" })
            .getByRole("textbox")
            .getByText("25宫格连贯分镜")
            .waitFor();
          console.log("image node inline and expanded interaction passed");
          await page.goto(`${origin}audit?video-node#video-node`);
          const motion = await openPicker("运镜");
          await motion.locator("button:has(img)").first().click();
          await motion.waitFor({ state: "hidden" });
          assert.match(
            await page.getByRole("button", { name: "运镜", exact: true }).getAttribute("title"),
            /^运镜：.+/,
          );
          const videoParams = await openPicker("生成参数");
          await videoParams.waitFor();
          await page.keyboard.press("Escape");
          await videoParams.waitFor({ state: "hidden" });
          console.log("video node motion selection and parameter dismissal passed");
        }
        await page.close();
      }
    } finally {
      await server.close();
    }
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
