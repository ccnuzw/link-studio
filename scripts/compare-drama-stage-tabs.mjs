import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build, parseSync, transformWithOxc } from "vite";
import { readRenderedText } from "./read-rendered-text.mjs";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = path.resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const temp = await mkdtemp(path.join(tmpdir(), "stage-tabs-"));
const studioViews = process.argv.includes("--studio-views");
const resolutionChip = process.argv.includes("--studio-resolution");
const videoModel = process.argv.includes("--studio-video-model");
const generateButton = process.argv.includes("--studio-generate");
const library = process.argv.includes("--studio-library");
const staleChoice = process.argv.includes("--studio-stale-choice");
const batchChoice = process.argv.includes("--studio-batch-choice") || staleChoice;
const adaptBar = process.argv.includes("--studio-adapt-bar");
const addClip = process.argv.includes("--studio-add-clip");
const secondsChip =
  generateButton || resolutionChip || videoModel || process.argv.includes("--studio-seconds");
const views = studioViews || process.argv.includes("--asset-views");
const overview = process.argv.includes("--overview-next");
const pill = process.argv.includes("--script-next");
const storyboard = process.argv.includes("--storyboard");
const gate = storyboard || process.argv.includes("--studio-gate");
const output = path.resolve(
  "test-results",
  staleChoice
    ? "drama-studio-stale-choice-parity"
    : batchChoice
      ? "drama-studio-batch-choice-parity"
      : adaptBar
        ? "drama-studio-adapt-bar-parity"
        : addClip
          ? "drama-studio-add-clip-parity"
          : library
            ? "drama-studio-library-parity"
            : secondsChip
              ? generateButton
                ? "drama-studio-generate-parity"
                : videoModel
                  ? "drama-studio-video-model-parity"
                  : resolutionChip
                    ? "drama-studio-resolution-parity"
                    : "drama-studio-seconds-parity"
              : storyboard
                ? "drama-storyboard-parity"
                : gate
                  ? "drama-studio-gate-parity"
                  : pill
                    ? "drama-script-next-parity"
                    : overview
                      ? "drama-overview-next-parity"
                      : views
                        ? studioViews
                          ? "drama-studio-views-parity"
                          : "drama-asset-views-parity"
                        : "drama-stage-tabs-parity",
);
const labels = views
  ? [studioViews ? "片场" : "列表", "画布"]
  : ["总览", "剧本", "资产管理", "片场", "成片"];
const report = {
  revision,
  scope: views
    ? "资产管理视图切换组及外缘 16px，DPR 1"
    : "仅制作工序标签组及外缘 16px；剧本待办、片场运行中，减少动态效果，DPR 1",
  states: {},
};
const images = new Map();
if (batchChoice) report.scope = "批量转写选择，已就绪、未转写、手改过期各一段，双主题双视口。";
if (staleChoice) report.scope = "单段生成遇到手改过期 H3 稿，长描述和第二项键盘焦点，DPR 1。";
if (adaptBar) report.scope = "原稿已修改提示条，宽 320px，DPR 1，明暗主题。";
if (addClip) report.scope = "时间线新增按钮及外缘 8px，空时间线，DPR 1，明暗两种主题。";
if (library)
  report.scope = "片场资产库，默认宽度 224px，明暗主题，本集、全集、空、加载及读取失败。";
if (secondsChip) report.scope = "片场时长按钮、比例和打开的菜单，1024 宽与 390 宽，DPR 1。";
if (resolutionChip) report.scope = "片场分辨率、相邻时长与比例，默认、偏好、过期值、菜单、窄屏。";
if (videoModel) report.scope = "片场视频模型按钮及菜单，含可用、禁用、加载和空清单，双主题双视口。";
if (generateButton) report.scope = "片场顶栏生成按钮，含初次生成、报价、采用、禁用及键盘焦点。";
if (studioViews) report.scope = "片场与画布视图按钮组及外缘 16px，DPR 1";
if (gate)
  report.scope =
    "片场前置引导内容区，不含片场批量工具栏。空、缺稿、可拆、本集拆解、另集拆解、键盘焦点和悬停。";
if (storyboard)
  report.scope =
    "已锁集的片场内容区：待估价、报价、失败重试、同集合成占用、排队、运行、无任务详情。";
if (pill)
  report.scope = "剧本页底部下一步，含整段底部 208px 和投影；报价、超过 200 集、禁用、拆解及隐藏。";
if (overview)
  report.scope =
    "总览「下一步」完整卡片。1024 宽取 340px 侧栏，390 宽取 358px，含长集号截断、运行禁用、悬停和键盘焦点；不含总览外壳。";
const browser = await chromium.launch({ channel: "chrome", headless: true });
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
      entry = path.join(root, "stage-fixture.jsx"),
      outDir = path.join(temp, side);
    const module = upstream
      ? "./src/pages/drama/workspace/stage-tabs"
      : "./src/renderer/workspace/drama-stage-tabs";
    let fixture = `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {MotionConfig} from 'motion/react';import {${upstream ? "StageTabs" : "DramaStageTabs"} as Tabs} from '${module}';function Fixture(){const [stage,go]=useState('overview');return <Tabs stage={stage} hints={{script:'todo',studio:'run'}} ${upstream ? "onChange" : "go"}={go}/>;}createRoot(document.querySelector('header')).render(<MotionConfig reducedMotion="user"><Fixture/></MotionConfig>);`;
    if (library) {
      const source = await readFile(
        path.join(pinned, "src/pages/drama/studio/library.tsx"),
        "utf8",
      );
      const component = upstream
        ? source.replace(
            'import { useStudio } from "./use-studio";',
            "const useStudio = () => fixtureState;",
          )
        : `import {StudioLibrary} from './src/renderer/workspace/drama-studio-library';`;
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${component}
      const root=createRoot(document.querySelector('#library'));let fixtureState;
      const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=';
      window.desktop={projects:{getAssetPreview:async()=>({ok:true,value:{url:image}})}};
      window.show=phase=>{
        const portrait=['portrait','rendering'].includes(phase), generating=phase==='rendering';
        const assets=['character','scene','prop','audio'].map((type,index)=>({id:type,label:['陈舟','街口','来客的信封','雨声'][index],type,kind:type==='prop'||type==='scene'?'image':type,episodes:index%2===0?[1]:[2],generating:generating && index===0,src:portrait && index===0?image:null,
          character: index===0 && portrait?{name:'陈舟',look:'',extraAssetIds:[],voice:{mode:'audio',assetId:'voice',name:'少年时期的陈舟录音.wav'}}:undefined}));
        const items=portrait||['here','all'].includes(phase)?assets:[];
        fixtureState={assets:items,assetsStatus:phase==='loading'?'loading':phase==='error'?'error':'ready',no:1};
        const editor={ready:phase!=='loading',graph:{nodes:items.map(asset=>({type:'creative',id:asset.id,data:{kind:asset.character?'image':asset.kind,label:asset.label,character:asset.character,assetId:asset.src?'portrait':undefined,drama:asset.type==='audio'?{episodes:asset.episodes}:{type:asset.type,episodes:asset.episodes}}}))},jobs:new Map(generating?[['character',[{status:'running'}]]]:[])};
        flushSync(()=>root.render(${upstream ? "<Library key={phase}/>" : "<StudioLibrary key={phase} projectHandle=\"fixture\" episodeNo={1} editor={editor} error={phase==='error'?'error':''} hidden={false}/>"}));};`;
      fixture = (
        await transformWithOxc(fixture, "library-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (views) {
      const source = path.join(
        root,
        upstream
          ? "src/pages/drama/workspace/assets-area.tsx"
          : "src/renderer/workspace/drama-asset-browser.tsx",
      );
      const text = await readFile(source, "utf8"),
        name = upstream ? "ViewToggle" : "DramaAssetViewToggle";
      const toggle = parseSync(source, text).program.body.find(
        (statement) =>
          statement.type === "ExportNamedDeclaration" && statement.declaration?.id?.name === name,
      );
      assert.ok(toggle);
      fixture = `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {Frame,LayoutGrid,Clapperboard} from 'lucide-react';${upstream ? "import {cn} from '@/lib/utils';" : ""}${text.slice(toggle.start, toggle.end)}function Fixture(){const [view,change]=useState('list');return <${name} view={view} ${studioViews ? 'listLabel="片场" listIcon={Clapperboard}' : ""} ${upstream ? "onChange" : "change"}={change}/>;}createRoot(document.querySelector('header')).render(<Fixture/>);`;
      fixture = (
        await transformWithOxc(fixture, "view-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (overview) {
      const file = path.join(pinned, "src/pages/drama/workspace/overview-area.tsx"),
        text = await readFile(file, "utf8");
      const item = parseSync(file, text).program.body.find(
        (node) => node.type === "FunctionDeclaration" && node.id.name === "NextItem",
      );
      assert.ok(item);
      const section = text.match(
        /<section className="bg-card border-border rounded-2xl border pb-2">[\s\S]*?<\/section>/,
      )?.[0];
      assert.ok(section);
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${upstream ? `import {Button} from '@/components/ui/button';import {ArrowRight,ScanSearch,Clapperboard,ScrollText} from 'lucide-react';import {nextStep} from '@/utils/drama/episodes';import {cn} from '@/lib/utils';${text.slice(item.start, item.end)}` : `import {DramaOverviewNext} from './src/renderer/workspace/drama-overview-next';`}
      const root=createRoot(document.querySelector('#next'));window.show=phase=>{const onGo=()=>{},onBreakdownOpen=()=>{},count=phase==='missing'?32:3,episodes=Array.from({length:count},(_,index)=>({no:index+1,episode_no:index+1,title:'来信',locked:(phase==='empty'||phase==='finished'||index===count-1),scriptStatus:phase==='missing'&&index<count-1?'empty':'ready',script_md:phase==='missing'&&index<count-1?'':'一封信。',segmentCount:phase==='empty'?1:0,doneSegmentCount:phase==='empty'?1:0}));
      const jobs=['blocked','missing'].includes(phase)?[{id:'1',step:phase==='missing'?'scripts':'breakdown',episodes:[1],status:'running'}]:[],drama={episodes,jobs,segments:phase==='empty'?episodes.map(ep=>({episode_no:ep.no,chosen_task_id:'done'})):[]};${upstream ? `const next=nextStep(drama,jobs),toShoot=episodes.filter(ep=>ep.locked&&!(ep.segmentCount>0&&ep.doneSegmentCount>=ep.segmentCount));` : ""}flushSync(()=>root.render(${upstream ? section : `<DramaOverviewNext doc={drama} go={onGo} openBreakdown={onBreakdownOpen}/>`}));};`;
      fixture = (
        await transformWithOxc(fixture, "next-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (gate) {
      const file = path.join(pinned, "src/pages/drama/workspace/studio-area.tsx"),
        text = await readFile(file, "utf8");
      const nodes = parseSync(file, text).program.body.map((node) => node.declaration ?? node);
      const source = (name) => {
        const node = nodes.find(
          (node) => node.type === "FunctionDeclaration" && node.id.name === name,
        );
        assert.ok(node);
        return text.slice(node.start, node.end);
      };
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${upstream ? `import {Button} from '@/components/ui/button';import {Clapperboard,Lock,Users,ScrollText} from 'lucide-react';import {episodeCardView} from '@/utils/drama/episode-cards';import {jobConflictReason,isActiveJob} from '@/utils/drama/jobs';const useWorkspace=()=>data,useDramaVideoModel=()=>({maxSeconds:10}),useStoryboardStart=()=>({}),GateFrame=({children})=>children;${source("Gate")};${source("StudioArea")}` : `import {DramaStudioGate,studioPrerequisite} from './src/renderer/workspace/drama-studio-gate';`}
      const root=createRoot(document.querySelector('#gate'));let data;window.show=phase=>{const status=phase==='missing'?'empty':'ready',episode={no:3,episode_no:3,scriptStatus:status,script_status:status,storyboardStatus:'empty',storyboard_status:'empty',locked:false},jobs=['breaking','other','hover','focus'].includes(phase)?[{step:'breakdown',status:'running',episodes:[phase==='other'?2:3]}]:[];data={drama:{episodes:phase==='empty'?[]:[episode],jobs},jobs};flushSync(()=>root.render(${upstream ? "<StudioArea key={phase} ep={3} onGo={()=>{}} onBreakdownOpen={()=>{}}/>" : "<DramaStudioGate key={phase} kind={studioPrerequisite(data.drama,data.drama.episodes[0])} no={3} go={()=>{}} openBreakdown={()=>{}}/>"}));};`;
      if (storyboard) {
        const extract = async (module, name) => {
          const file = path.join(pinned, "src/pages/drama/workspace", `${module}.tsx`),
            text = await readFile(file, "utf8"),
            node = parseSync(file, text)
              .program.body.map((entry) => entry.declaration ?? entry)
              .find((entry) => entry.type === "FunctionDeclaration" && entry.id.name === name);
          assert.ok(node);
          return text.slice(node.start, node.end);
        };
        const referenceParts = upstream
          ? `import {Button} from '@/components/ui/button';import {Loader2,Clapperboard} from 'lucide-react';import {motion} from 'motion/react';import {SPRING} from '@/lib/motion';import {cn} from '@/lib/utils';import {episodeCardView} from '@/utils/drama/episode-cards';import {activeStoryboardJob,jobConflictReason} from '@/utils/drama/jobs';const useWorkspace=()=>data,useDramaVideoModel=()=>({maxSeconds:15}),useStoryboardStart=()=>({}),useEstimate=()=>({status:phase==='waiting'?'loading':'ready',credits:37}),useCancelJob=()=>({}),GateFrame=({children})=>children;${source("Gate")};${source("InlineProgress")};${source("StudioArea")};${await extract("storyboard-start", "StoryboardButton")};${await extract("job-bar", "JobProgressBar")}`
          : `import {DramaStoryboardGate} from './src/renderer/workspace/drama-storyboard-gate';window.desktop={projects:{estimateDramaStoryboard:async()=>phase==='waiting'?new Promise(()=>{}):{ok:true,value:{credits:37}}}};`;
        fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${referenceParts};let data,phase;const root=createRoot(document.querySelector('#gate'));window.show=value=>{phase=value;const generating=['queued','running','unknown'].includes(phase),status=generating?'generating':phase==='failed'?'failed':'empty',episode={no:3,episode_no:3,locked:true,storyboardStatus:status,storyboard_status:status},jobs=(generating&&phase!=='unknown'||phase==='blocked')?[{id:'job',step:phase==='blocked'?'compose':'storyboard',episodes:[3],progress:phase==='running'?40:0,status:phase==='queued'?'queued':'running'}]:[];data={drama:{episodes:[episode],jobs},jobs};flushSync(()=>root.render(${upstream ? "<StudioArea key={phase} ep={3} onGo={()=>{}} onBreakdownOpen={()=>{}}/>" : '<DramaStoryboardGate key={phase} doc={data.drama} episode={episode} projectHandle="fixture" maxSeconds={15} saved={()=>{}}/>'}));};`;
      }
      fixture = (
        await transformWithOxc(fixture, "gate-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (pill) {
      const file = path.join(pinned, "src/pages/drama/workspace/script-area.tsx"),
        text = await readFile(file, "utf8");
      const node = parseSync(file, text).program.body.find(
        (node) => node.type === "FunctionDeclaration" && node.id.name === "NextStepPill",
      );
      assert.ok(node);
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {AnimatePresence,motion} from 'motion/react';${upstream ? `import {Button} from '@/components/ui/button';import {DURATION,EASE_OUT} from '@/lib/motion';import {nextStep,MAX_JOB_EPISODES} from '@/utils/drama/episodes';const useWorkspace=()=>data,useEstimate=()=>({status:phase==='waiting'?'loading':'ready',credits:17});${text.slice(node.start, node.end)}` : `import {DramaScriptNext,scriptNextStep} from './src/renderer/workspace/drama-script-next';window.desktop={projects:{estimateDramaScripts:async()=>phase==='waiting'?new Promise(()=>{}):{ok:true,value:17}}};`}
      let phase,data;const root=createRoot(document.querySelector('#pill'));window.show=value=>{phase=value;const missing=['waiting','quoted','many'].includes(phase),episodes=Array.from({length:phase==='many'?204:3},(_,index)=>({episode_no:index+1,no:index+1,script_md:missing?'':'来信',scriptStatus:missing?'empty':'ready',locked:phase==='none'})),jobs=phase==='blocked'?[{step:'breakdown',episodes:[1],status:'running'}]:[];data={drama:{episodes,jobs},jobs};flushSync(()=>root.render(${upstream ? "<NextStepPill key={phase} onScripts={()=>{}} onBreakdown={()=>{}}/>" : '<DramaScriptNext key={phase} step={scriptNextStep(data.drama)} projectHandle="fixture" order={1} open={()=>{}}/>'}));};`;
      fixture = (
        await transformWithOxc(fixture, "pill-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (batchChoice) {
      const source = await readFile(
        path.join(pinned, "src/components/drama/choice-dialog.tsx"),
        "utf8",
      );
      const component = upstream
        ? source.slice(0, source.indexOf("export function choose"))
        : "import {DramaBatchVideo} from './src/renderer/workspace/drama-batch-video';";
      fixture = `import {createRoot} from 'react-dom/client';import {useState} from 'react';${component}
        const items=[{id:'a',prompt:'信',adaptations:{h3:{prompt:'最新',source_hash:'信'}}},{id:'b',prompt:'门'},{id:'c',prompt:'雨',adaptations:{h3:{prompt:'手改',source_hash:'旧',edited:true}}}];
        function Fixture(){const [open,setOpen]=useState(false);return ${upstream ? '<><button onClick={()=>setOpen(true)}>批量生成分镜视频</button>{open && <ChoiceDialog open resolve={()=>{}} onClose={()=>setOpen(false)} title="2 个片段还没转写为 H3" stats={[{label:"已就绪",value:1},{label:"未转写",value:1},{label:"已过期",value:1}]} note="1 个转写稿被手改过，重新转写会覆盖" options={[{value:"adapt",label:"转写后生成",count:3,primary:true},{value:"source",label:"原稿生成",count:3},{value:"ready",label:"只生成已转写的",count:1}]}/>}</>' : '<DramaBatchVideo format="h3" adapted targets={async()=>items} hash={async text=>text} report={()=>{}}/>'};}
        createRoot(document.querySelector('#choice')).render(<Fixture/>);`;
      if (staleChoice && upstream) {
        const studio = await readFile(
          path.join(pinned, "src/pages/drama/studio/use-studio.ts"),
          "utf8",
        );
        const config = studio.match(
          /const picked = await chooseOption\((\{\s+title: "原稿在转写后改过",[\s\S]*?\n\s*\})\);/,
        );
        assert.ok(config, "固定提交的单段过期生成选项");
        fixture = `import {createRoot} from 'react-dom/client';import {useState} from 'react';${component}
          import {formatLabel} from '@/utils/drama/adaptation';
          const format='h3', adaptation={edited:true};
          function Fixture(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>立即生成</button>{open && <ChoiceDialog {...${config[1]}} open resolve={()=>{}} onClose={()=>setOpen(false)}/>}</>}
          createRoot(document.querySelector('#choice')).render(<Fixture/>);`;
      } else if (staleChoice) {
        fixture = `import {createRoot} from 'react-dom/client';
          import {DramaSegmentVideo,useStudioAdaptations} from './src/renderer/workspace/drama-segment-video';
          const segment={id:'clip',episode_no:1,seq:0,prompt:'放下信封。',seconds:5,revision:3,adaptations:{h3:{prompt:'手改的转写稿。',source_hash:'旧稿',edited:true}}};
          const ok=value=>({ok:true,value}), reload=async()=>{};
          const latest={...segment,revision:4,adaptations:{h3:{...segment.adaptations.h3,edited:true}}};
          segment.adaptations.h3.edited=false;
          window.desktop={projects:{drama:async()=>ok({segments:[latest]}),getCanvas:async()=>ok({canvas:{nodes:[],edges:[]},canvasRevision:1}),listJobs:async()=>ok({jobs:[]}),listAssets:async()=>ok({assets:[]})}};
          function Fixture(){return <DramaSegmentVideo locked adaptations={useStudioAdaptations()} toolbar={document.querySelector('#choice')} projectHandle="fixture" model={{id:'video',revision:1,config:{kind:'video',promptFormat:'h3'}}} options={{modes:['t2v'],references:{},referenceLimit:0,hiddenParameters:[],durations:[5],resolutions:[],ratios:['9:16']}} segment={segment} episodeSegments={[segment]} episodeOrder={0} ratio="9:16" plugins={[]} imageModels={[]} reload={reload}/>;}
          createRoot(document.body.appendChild(document.createElement('div'))).render(<Fixture/>);`;
      }
      fixture = (
        await transformWithOxc(fixture, "choice-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (adaptBar) {
      const source = await readFile(
        path.join(
          root,
          upstream
            ? "src/pages/drama/studio/prompt-pane.tsx"
            : "src/renderer/workspace/drama-segment-video.tsx",
        ),
        "utf8",
      );
      const markup = upstream
        ? source.match(/<Bar\s+tone="warning"[\s\S]*?<\/Bar>/)?.[0]
        : source.match(/<div className="studio-adapt-bar" role="status">[\s\S]*?<\/div>/)?.[0];
      assert.ok(markup);
      const bar = upstream
        ? source.slice(
            source.indexOf("function Bar("),
            source.indexOf("/**", source.indexOf("function Bar(")),
          )
        : "";
      fixture = `import {createRoot} from 'react-dom/client';import {TriangleAlert} from 'lucide-react';${upstream ? "import {Button} from '@/components/ui/button';import {cn} from '@/lib/utils';" : ""}${bar}const busy=false, adapt=()=>{}, run=()=>{};createRoot(document.querySelector('#bar')).render(${markup});`;
      fixture = (
        await transformWithOxc(fixture, "bar-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    }
    if (addClip) {
      const source =
        upstream &&
        (await readFile(path.join(pinned, "src/pages/drama/studio/clip-bar.tsx"), "utf8"));
      const button =
        upstream &&
        source.slice(
          source.lastIndexOf("<Button"),
          source.lastIndexOf("</Button>") + "</Button>".length,
        );
      if (upstream) assert.ok(button.includes('aria-label="新增片段"'));
      fixture = `import {createRoot} from 'react-dom/client';
        ${upstream ? `import {Button} from '@/components/ui/button';import {Plus} from 'lucide-react';const actions={add(){}};` : `import {DramaClipRow} from './src/renderer/workspace/drama-clip-row';`}
        createRoot(document.querySelector('#clip')).render(${upstream ? button : `<DramaClipRow segments={[]} select={()=>{}} save={async()=>{}} add={()=>{}} editor={{graph:{nodes:[]},jobs:new Map(),assets:[]}} handle="fixture" previewHost={null}/>`});`;
    }
    if (generateButton) {
      const file = path.join(pinned, "src/pages/drama/studio/generate-controls.tsx");
      const text = await readFile(file, "utf8");
      const nodes = parseSync(file, text).program.body.map((node) => node.declaration ?? node);
      const parts = ["useBlockedReason", "GenerateControls"].map((name) => {
        const node = nodes.find((entry) => entry.id?.name === name);
        assert.ok(node);
        return text.slice(node.start, node.end);
      });
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
        ${upstream ? `import {Loader2} from 'lucide-react';import {Button} from '@/components/ui/button';import {cn} from '@/lib/utils';import {hasVideo} from '@/utils/drama/segments';import {formatLabel} from '@/utils/drama/adaptation';const VideoModelMenu=()=>null,useStudio=()=>data;${parts.join("\n")}` : "import {DramaGenerateButton} from './src/renderer/workspace/drama-generate-button';"}
        const root=createRoot(document.querySelector('#seconds'));let data;window.show=phase=>{const again=phase==='again',credits=phase==='normal'?undefined:24,reason=phase==='missing'?'没有可用的视频模型（需要支持参考图）':phase==='invalid'?'请填写提示词':undefined;data={selected:{id:'seg',chosenTaskId:again?'take':'',takes:[{taskId:'take',status:'succeeded',asset:{}}]},video:{model:phase==='missing'?undefined:{},status:'ready'},plan:{errors:phase==='invalid'?{prompt:reason}:{}},credits,availableCredits:null,submitting:new Set(),actions:{}};flushSync(()=>root.render(<div key={phase} className="drama-studio-generate-controls">${upstream ? "<GenerateControls/>" : "<DramaGenerateButton again={again} credits={credits} reason={reason}/>"}</div>))};`;
      fixture = (
        await transformWithOxc(fixture, "generate-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    } else if (videoModel) {
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
        ${upstream ? "import {VideoModelMenu} from '@/components/drama/video-model-menu';" : "import {StudioVideoModel} from './src/renderer/workspace/drama-studio-video-model';import {dramaVideoModelIssue} from '@link-studio/core';"}
        const root=createRoot(document.querySelector('#seconds'));
        const plugins=[{hash:'video',key:'doubao-video',origin:'builtin'}];
        const fixtures=['开拍视频','新视频','只支持文字'].map((label,index)=>({key:label,id:label,label,model:'doubao-seedance-2-0',pluginHash:'video',channel:{},config:{modes:index===2?['t2v']:['omni']},capabilities:{ops:index===2?['t2v']:['omni'],refs:{image:{on:index!==2,max:index===2?0:8},audio:{on:true,max:3}},params:{duration:{type:'number',max:15}}}}));
        window.show=phase=>{const loading=phase.startsWith('loading'),models=loading||phase.startsWith('empty')?[]:fixtures,model=models[0];flushSync(()=>root.render(<div key={phase} style={{display:'flex',alignItems:'center'}}>${upstream ? "<VideoModelMenu models={models} loading={loading} model={model} onPick={()=>{}}/>" : "<StudioVideoModel models={models} loading={loading} model={model} pick={()=>{}} plugins={plugins} issues={new Map(models.map(entry=>[entry.id,dramaVideoModelIssue(entry,plugins)]))}/>"}</div>));};`;
      fixture = (
        await transformWithOxc(fixture, "model-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
    } else if (secondsChip) {
      const file = path.join(pinned, "src/pages/drama/studio/studio-bar.tsx");
      const text = await readFile(file, "utf8");
      const part = parseSync(file, text).program.body.find(
        (node) => node.type === "FunctionDeclaration" && node.id.name === "SecondsChip",
      );
      const choices = text.match(/const SECOND_CHOICES = .*?;/)?.[0];
      const controls = text.match(
        /<div className="flex items-center gap-0.5 max-md:hidden">[\s\S]*?<\/div>/,
      )?.[0];
      const quality = parseSync(file, text).program.body.find(
        (node) => node.type === "FunctionDeclaration" && node.id.name === "ResolutionChip",
      );
      assert.ok(part && choices && controls && quality);
      const group = resolutionChip ? controls : controls.replace("<ResolutionChip />", "");
      fixture = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${upstream ? `import {Timer,MonitorPlay} from 'lucide-react';import {ChipPopover,MenuLabel} from '@/components/drama/pickers';import {cn} from '@/lib/utils';import {paramEntries,matchOption} from '@/utils/tasks/capabilities';import {modelMaxSeconds} from '@/utils/drama/video-models';${choices}const useStudio=()=>({selected:{seconds},video:{model:{capabilities:{params:{duration:{type:'number',max:15},resolution:field}}}},overrides:{resolution:chosen},setOverride:()=>{},actions:{setSeconds:()=>{}}});${text.slice(part.start, part.end)};${text.slice(quality.start, quality.end)}` : `import {StudioSegmentSeconds} from './src/renderer/workspace/drama-studio-seconds';`}
      const root=createRoot(document.querySelector('#seconds')),drama={ratio:'9:16'},field={type:'enum',open:true,label:'视频清晰度',default:'720p',options:['480p','720p','1080p']};let seconds,chosen;window.show=phase=>{seconds=${resolutionChip ? "5" : "phase==='menu'||phase==='legacy'?20:5"};chosen=phase==='stale'?'4k':phase==='picked'||phase==='menu'?'1080p':undefined;flushSync(()=>root.render(<section key={phase}>${upstream ? group : `<StudioSegmentSeconds seconds={seconds} ratio={drama.ratio} max={15} change={()=>{}} ${resolutionChip ? "resolutionField={{label:field.label,defaultValue:field.default,choices:field.options}} resolution={chosen} pickResolution={()=>{}}" : ""}/>`}</section>))};`;
      fixture = (
        await transformWithOxc(fixture, "seconds-fixture.tsx", { jsx: { runtime: "automatic" } })
      ).code;
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
          name: "stage-fixture",
          resolveId: (id) => (id === entry ? entry : null),
          load: (id) => (id === entry ? fixture : null),
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
      for (const width of library || addClip || adaptBar ? [1440] : [1024, 390]) {
        const page = await browser.newPage({
          viewport: { width, height: width === 390 ? 844 : 768 },
          colorScheme: theme,
          reducedMotion: "reduce",
          deviceScaleFactor: 1,
        });
        try {
          await page.route("http://localhost/**", (route) => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (name === "fixture.js")
              return route.fulfill({
                path: path.join(outDir, name),
                contentType: "text/javascript",
              });
            if (batchChoice && !upstream && name === "index.css")
              return Promise.all(
                [
                  "styles.css",
                  "workspace/canvas-workspace.css",
                  "workspace/drama-clip-row.css",
                  "workspace/drama-studio.css",
                ].map((file) => readFile(path.resolve("src/renderer", file), "utf8")),
              ).then((parts) => route.fulfill({ body: parts.join("\n"), contentType: "text/css" }));
            if ((addClip || adaptBar) && !upstream && name === "index.css")
              return Promise.all(
                [
                  "styles.css",
                  "workspace/drama-studio.css",
                  adaptBar ? "workspace/drama-studio-panels.css" : "workspace/drama-clip-row.css",
                ].map((file) => readFile(path.resolve("src/renderer", file), "utf8")),
              ).then((parts) => route.fulfill({ body: parts.join("\n"), contentType: "text/css" }));
            if (name === "index.css")
              return route.fulfill({ path: path.join(assets, css), contentType: "text/css" });
            if (name.endsWith(".woff2"))
              return route.fulfill({
                path:
                  batchChoice && !upstream && name === "fonts/geist-latin-wght-normal.woff2"
                    ? path.resolve("src/renderer/workspace", name)
                    : path.join(assets, path.basename(name)),
                contentType: "font/woff2",
              });
            if (name) return route.abort();
            const bg = theme === "dark" ? "oklch(.145 .002 286)" : "oklch(.95 .007 85)";
            const scope = upstream
              ? "drama-theme bg-background text-foreground"
              : overview || pill || gate || secondsChip || library || addClip || adaptBar
                ? "drama-columns"
                : "drama-studio";
            const mount = batchChoice
              ? `<div style="position:absolute;inset:0;background:${bg}"><div id="choice"></div></div>`
              : adaptBar
                ? `<div style="position:absolute;inset:0;background:${bg};padding:40px"><div id="bar" style="width:320px"></div></div>`
                : addClip
                  ? `<div style="position:absolute;inset:0;background:${bg};padding:40px"><div id="clip"></div></div>`
                  : library
                    ? `<div style="position:absolute;inset:0;background:${bg}"><div id="library" style="position:absolute;left:0;top:${upstream ? 48 : 0}px;width:${upstream ? 224 : 900}px;height:440px"></div></div>`
                    : secondsChip
                      ? `<div style="position:absolute;inset:0;background:${bg}"><div id="seconds" style="position:absolute;left:40px;top:32px"></div></div>`
                      : gate
                        ? `<div id="gate" style="position:absolute;inset:0 0 auto auto;width:${width === 390 ? 390 : 946}px;height:360px;display:${upstream ? "block" : "flex"};background:${bg}"></div>`
                        : pill
                          ? `<div id="pill" style="position:absolute;inset:0 0 auto auto;width:${width === 390 ? 390 : 946}px;height:240px;background:${bg}"></div>`
                          : overview
                            ? `<article style="display:block;padding:16px"><div id="next" style="width:${width === 390 ? 358 : 340}px"></div></article>`
                            : `<header style="display:flex;align-items:center;height:100px;padding:0;width:100%;background:${bg}"></header>`;
            return route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset=utf-8><link rel=stylesheet href=/index.css><main class="${scope}">${mount}</main><script type=module src=/fixture.js></script>`,
            });
          });
          await page.goto("http://localhost/");
          if (views)
            await page.locator("header").evaluate((el) => {
              el.style.justifyContent = "center";
              el.style.position = "relative";
            });
          const tabs = views
            ? page.getByRole("group", { name: "视图" })
            : page.getByRole("tablist", { name: "制作工序" });
          if (
            !overview &&
            !pill &&
            !gate &&
            !secondsChip &&
            !library &&
            !addClip &&
            !adaptBar &&
            !batchChoice
          ) {
            await tabs.waitFor();
            await page.evaluate(() => document.fonts.ready);
          }
          for (const label of batchChoice
            ? ["idle", "focus"]
            : adaptBar
              ? ["idle", "hover"]
              : addClip
                ? ["idle", "focus", "hover", "pressed"]
                : library
                  ? [
                      "here",
                      "all",
                      "empty",
                      "empty-all",
                      "loading",
                      "error",
                      "portrait",
                      "rendering",
                    ]
                  : secondsChip
                    ? generateButton
                      ? ["normal", "quoted", "again", "invalid", "missing", "focus"]
                      : videoModel
                        ? [
                            "normal",
                            "focus",
                            "menu",
                            "loading",
                            "loading-menu",
                            "empty",
                            "empty-menu",
                          ]
                        : width === 390
                          ? ["hidden"]
                          : resolutionChip
                            ? ["normal", "picked", "stale", "menu"]
                            : ["normal", "focus", "legacy", "menu"]
                    : storyboard
                      ? ["waiting", "quoted", "failed", "blocked", "queued", "running", "unknown"]
                      : gate
                        ? ["empty", "missing", "ready", "breaking", "other", "hover", "focus"]
                        : pill
                          ? ["waiting", "quoted", "many", "ready", "blocked", "none"]
                          : overview
                            ? ["missing", "ready", "blocked", "finished", "empty", "hover", "focus"]
                            : labels) {
            let clip;
            const key = `${theme}-${width}-${label}`;
            report.states[key] ??= {};
            const row = report.states[key];
            if (batchChoice) {
              const dialog = page.getByRole("alertdialog");
              if (label === "idle")
                await page
                  .getByRole("button", { name: staleChoice ? "立即生成" : "批量生成分镜视频" })
                  .click();
              await dialog.waitFor();
              if (label === "focus") {
                const target = dialog.getByRole("button", {
                  name: staleChoice ? "仍用当前转写稿生成" : /原稿生成/,
                });
                for (
                  let index = 0;
                  index < 4 && !(await target.evaluate((el) => el === document.activeElement));
                  index++
                )
                  await page.keyboard.press("Tab");
                assert.ok(
                  await target.evaluate((el) => el === document.activeElement),
                  "Tab 到达第二个选项",
                );
              }
              await page.evaluate(() => document.fonts.ready);
              await dialog.evaluate(async (el) => {
                await Promise.all(el.getAnimations().map((anim) => anim.finished));
              });
              row[side] = await dialog.evaluate((el) =>
                [el, ...el.querySelectorAll("button")].map((node) => {
                  const { x, y, width, height } = node.getBoundingClientRect();
                  return { x, y, width, height, focused: node === document.activeElement };
                }),
              );
              if (process.env.DRAMA_CHOICE_STYLES && width === 1024 && label === "idle") {
                const styles = await dialog.evaluate((popup) =>
                  [
                    document.querySelector(
                      '[data-slot="alert-dialog-overlay"],.shot-confirm-backdrop',
                    ),
                    popup.parentElement,
                    popup,
                    ...popup.querySelectorAll("button,button > *"),
                  ]
                    .filter(Boolean)
                    .map((node) => {
                      const style = getComputedStyle(node);
                      const { x, y, width, height } = node.getBoundingClientRect();
                      return {
                        tag: node.tagName,
                        x,
                        y,
                        width,
                        height,
                        radius: style.borderRadius,
                        shadow: style.boxShadow,
                        background: style.backgroundColor,
                        color: style.color,
                        font: style.font,
                        opacity: style.opacity,
                        transform: style.transform,
                        filter: style.filter,
                        backdrop: style.backdropFilter,
                        scale: style.scale,
                        animation: style.animation,
                        isolation: style.isolation,
                        translate: style.translate,
                      };
                    }),
                );
                await writeFile(
                  path.join(output, `${side}-${theme}-styles.json`),
                  JSON.stringify(styles, null, 2),
                );
              }
              clip = {
                x: Math.floor((width - Math.min(448, width)) / 2),
                y: Math.floor((page.viewportSize().height - 440) / 2),
                width: Math.min(448, width),
                height: 440,
              };
            } else if (adaptBar) {
              const bar = page.getByRole("status");
              await bar.waitFor();
              await page.evaluate(() => document.fonts.ready);
              if (label === "hover") await bar.getByRole("button").hover();
              await bar.getByRole("button").evaluate(async (el) => {
                getComputedStyle(el).backgroundColor;
                await Promise.all(el.getAnimations().map((anim) => anim.finished));
              });
              clip = await bar.boundingBox();
              row[side] = await bar.evaluate((el) =>
                [el, el.querySelector("span"), el.querySelector("button")].map((node) => {
                  const style = getComputedStyle(node),
                    box = node.getBoundingClientRect();
                  return {
                    width: box.width,
                    height: box.height,
                    font: style.fontFamily,
                    lineHeight: style.lineHeight,
                    radius: style.borderRadius,
                    color: style.color,
                    background: style.backgroundColor,
                  };
                }),
              );
            } else if (addClip) {
              const button = page.getByRole("button", { name: "新增片段" });
              await button.waitFor();
              if (label === "idle") {
                const bounds = await button.boundingBox();
                await page.locator("#clip").evaluate((mount, point) => {
                  mount.style.position = "relative";
                  mount.style.left = `${80 - point.x}px`;
                  mount.style.top = `${100 - point.y}px`;
                }, bounds);
              }
              const initial = await button.boundingBox();
              if (label === "focus") await page.keyboard.press("Tab");
              if (label === "hover") {
                await button.evaluate((el) => el.blur());
                await button.hover();
              }
              if (label === "pressed") await page.mouse.down();
              await button.evaluate(async (el) => {
                getComputedStyle(el).backgroundColor;
                await Promise.all(el.getAnimations().map((anim) => anim.finished));
              });
              const box = await button.boundingBox();
              row[side] = {
                width: box.width,
                height: box.height,
                offsetY: box.y - initial.y,
                focus: await button.evaluate((el) => el.matches(":focus-visible")),
              };
              assert.equal(row[side].focus, label === "focus");
              clip = { x: initial.x - 8, y: initial.y - 8, width: 64, height: 92 };
            } else if (library) {
              await page.evaluate((phase) => window.show(phase), label);
              const panel = page.getByRole("complementary", { name: "资产库" });
              if (["portrait", "rendering"].includes(label)) {
                await panel
                  .locator("img")
                  .first()
                  .evaluate((image) => image.decode());
                assert.ok(
                  await panel.getByText("少年时期的陈舟录音.wav", { exact: true }).isVisible(),
                );
              }
              if (label.endsWith("all")) await panel.getByRole("button", { name: "全集" }).click();
              await page.mouse.move(240, 0);
              await page.evaluate(() => document.fonts.ready);
              await page.waitForTimeout(450);
              row[side] = await panel.locator("button, [draggable=true], p").evaluateAll((parts) =>
                parts.map((el) => {
                  const rect = el.getBoundingClientRect();
                  return {
                    text: el.textContent,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                  };
                }),
              );
              clip = { x: 0, y: 48, width: 224, height: 380 };
            } else if (secondsChip) {
              await page.mouse.move(0, 0);
              await page.evaluate((phase) => window.show(phase), label);
              const button = generateButton
                ? page.locator("#seconds button")
                : videoModel
                  ? page.getByTitle("生成片段视频用的模型")
                  : resolutionChip
                    ? page.locator("#seconds button").nth(1)
                    : page.getByTitle("片段时长 · 模型上限 15s");
              if (label === "focus") await page.keyboard.press("Tab");
              if (label.endsWith("menu")) {
                await button.click();
                await page.mouse.move(0, 0);
                await page.getByRole("dialog").waitFor();
                if (videoModel && label === "menu")
                  assert.ok(await page.getByRole("button", { name: /只支持文字/ }).isDisabled());
              }
              assert.equal(await button.isVisible(), label !== "hidden");
              if (generateButton)
                assert.equal(await button.isDisabled(), ["missing", "invalid"].includes(label));
              await page.evaluate(() => document.fonts.ready);
              await page.evaluate(() =>
                Promise.all(
                  document.getAnimations().map((animation) => animation.finished.catch(() => {})),
                ),
              );
              row[side] = await page.locator("button:visible").evaluateAll((elements) =>
                elements.map((el) => {
                  const { x, y, width, height } = el.getBoundingClientRect();
                  return { text: el.textContent, x, y, width, height };
                }),
              );
              if (label === "menu" || label === "focus") {
                const target = label === "menu" ? page.getByRole("dialog") : button;
                row[`${side}Paint`] = await target.evaluate((element) => {
                  const style = getComputedStyle(element);
                  return {
                    shadow: style.boxShadow,
                    outline: style.outline,
                    offset: style.outlineOffset,
                    radius: style.borderRadius,
                    background: style.backgroundColor,
                  };
                });
              }
              clip = {
                x: 20,
                y: 12,
                width: resolutionChip || videoModel ? 370 : 220,
                height: label.endsWith("menu") ? (resolutionChip || videoModel ? 236 : 422) : 80,
              };
            } else if (gate) {
              await page.mouse.move(0, 500);
              await page.evaluate((phase) => window.show(phase), label);
              const host = page.locator("#gate"),
                button = host.getByRole("button");
              await host.getByRole("heading").waitFor();
              if (storyboard && ["quoted", "failed", "blocked"].includes(label))
                await host.getByText("37", { exact: true }).waitFor();
              await page.evaluate(() => document.fonts.ready);
              if (label === "hover") await button.hover();
              if (label === "focus") {
                await page.keyboard.press("Tab");
                assert.ok(await button.evaluate((el) => el.matches(":focus-visible")));
              }
              await page.evaluate(() =>
                Promise.all(
                  document.getAnimations().map((animation) => animation.finished.catch(() => {})),
                ),
              );
              clip = await host.boundingBox();
              const text = await readRenderedText(host);
              row[side] = {
                text,
                ...(await host.evaluate((el) => ({
                  parts: [...el.firstElementChild.children].map((part) => {
                    const rect = part.getBoundingClientRect();
                    return [rect.x, rect.y, rect.width, rect.height];
                  }),
                }))),
              };
            } else if (pill) {
              await page.evaluate((phase) => window.show(phase), label);
              const host = page.locator("#pill");
              if (["quoted", "many"].includes(label))
                await host.getByText("17", { exact: true }).waitFor();
              await page.waitForTimeout(380);
              await page.evaluate(() => document.fonts.ready);
              const box = await host.boundingBox();
              clip = { x: box.x, y: 32, width: box.width, height: 208 };
              const text = await readRenderedText(host);
              row[side] = {
                text,
                ...(await host.evaluate((region) => ({
                  buttons: [...region.querySelectorAll("button")].map((button) => [
                    button.textContent,
                    button.disabled,
                    button.title,
                  ]),
                  parts: [...(region.firstElementChild?.children ?? [])].map((el) => ({
                    x: el.getBoundingClientRect().x,
                    width: el.getBoundingClientRect().width,
                    font: getComputedStyle(el).fontVariantNumeric,
                  })),
                  height: region.firstElementChild?.getBoundingClientRect().height ?? 0,
                }))),
              };
            } else if (overview) {
              await page.mouse.move(0, 300);
              await page.evaluate((phase) => window.show(phase), label);
              const card = page.locator("#next>section");
              await card.waitFor();
              await page.evaluate(() => document.fonts.ready);
              const target = card.getByRole("button", { name: "拆解", exact: true });
              if (label === "hover") await target.hover();
              if (label === "focus") {
                await page.keyboard.press("Tab");
                assert.ok(await target.evaluate((el) => el.matches(":focus-visible")));
              }
              if (label === "blocked")
                assert.equal(
                  await target.getAttribute("title"),
                  "有进行中的任务：资产拆解 · 第 1 集",
                );
              if (label === "missing")
                assert.equal(
                  await card
                    .locator("small")
                    .first()
                    .evaluate((el) => el.scrollWidth > el.clientWidth),
                  true,
                );
              await page.evaluate(() =>
                Promise.all(
                  document.getAnimations().map((animation) => animation.finished.catch(() => {})),
                ),
              );
              const box = await card.boundingBox();
              clip = { x: box.x, y: box.y, width: box.width, height: Math.ceil(box.height) };
              const text = await readRenderedText(card);
              row[side] = {
                text,
                ...(await card.evaluate((region) => ({
                  height: region.getBoundingClientRect().height,
                  buttons: [...region.querySelectorAll("button")].map((button) => [
                    button.textContent,
                    button.disabled,
                  ]),
                }))),
              };
            } else {
              const role = views ? "button" : "tab",
                button = tabs.getByRole(role, { name: label, exact: true });
              await button.click();
              await page.mouse.move(0, 0);
              assert.equal(
                await button.getAttribute(views ? "aria-pressed" : "aria-selected"),
                "true",
              );
              await page.waitForFunction(
                () =>
                  document
                    .querySelector(
                      "[aria-selected=true] > :first-child,[aria-pressed=true] > :first-child",
                    )
                    ?.getBoundingClientRect().width > 0,
              );
              await page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              const box = await tabs.boundingBox();
              clip = {
                x: Math.floor(box.x) - 16,
                y: Math.floor(box.y) - 16,
                width: Math.ceil(box.width) + 32,
                height: Math.ceil(box.height) + 32,
              };
              row[side] = await tabs.getByRole(role).evaluateAll((elements) =>
                elements.map((el) => ({
                  name: el.ariaLabel ?? el.textContent,
                  x: el.offsetLeft - elements[0].offsetLeft,
                  y: el.offsetTop - elements[0].offsetTop,
                  width: el.offsetWidth,
                  height: el.offsetHeight,
                  selected: el.ariaSelected ?? el.ariaPressed,
                })),
              );
            }
            const png = await page.screenshot({
              clip,
              animations: "disabled",
              path: path.join(output, `${side}-${key}.png`),
            });
            if (upstream) images.set(key, png);
            else {
              row.differentPixels = await page.evaluate(
                async (pair) => {
                  const parts = await Promise.all(
                    pair.map(async (data) => {
                      const image = new Image();
                      image.src = `data:image/png;base64,${data}`;
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
                  if (parts[0].width !== parts[1].width || parts[0].height !== parts[1].height)
                    return -1;
                  return parts[0].pixels.reduce(
                    (count, color, index) => count + Number(color !== parts[1].pixels[index]),
                    0,
                  );
                },
                [images.get(key), png].map((buffer) => buffer.toString("base64")),
              );
            }
          }
        } finally {
          await page.close();
        }
      }
  }
  const comparison = await browser.newPage({
    viewport: {
      width: 730,
      height:
        batchChoice || library
          ? 840
          : secondsChip
            ? 920
            : gate
              ? 760
              : pill
                ? 476
                : overview
                  ? 436
                  : 224,
    },
  });
  try {
    const panels = [];
    for (const theme of ["light", "dark"])
      for (const side of ["reference", "desktop"]) {
        const image = await readFile(
          path.join(
            output,
            `${side}-${theme}-${batchChoice ? "1024-idle" : adaptBar ? "1440-idle" : addClip ? "1440-focus" : library ? "1440-all" : generateButton ? "1024-again" : secondsChip ? "1024-menu" : storyboard ? "390-running" : gate ? "390-breaking" : pill ? "390-many" : `1024-${overview ? "ready" : views ? "画布" : "资产管理"}`}.png`,
          ),
        );
        panels.push(
          `<figure>${side === "reference" ? "小镜 · 4277d16f" : "小灵 · link-studio"}<img style="max-width:100%" src="data:image/png;base64,${image.toString("base64")}"></figure>`,
        );
      }
    await comparison.setContent(
      "<style>body{margin:0;background:#ecebea;display:grid;grid-template-columns:1fr 1fr}figure{margin:6px 0;text-align:center;font:14px/28px sans-serif}img{display:block;margin:auto}</style>" +
        panels.join(""),
    );
    await comparison.screenshot({ path: path.join(output, "comparison.png") });
  } finally {
    await comparison.close();
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  for (const [key, row] of Object.entries(report.states)) {
    console.log(key, row.differentPixels);
    if (row.differentPixels !== 0 || JSON.stringify(row.reference) !== JSON.stringify(row.desktop))
      process.exitCode = 1;
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
