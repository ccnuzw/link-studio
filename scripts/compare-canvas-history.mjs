import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned checkout");
const temp = await mkdtemp(join(tmpdir(), "canvas-history-"));
const browser = await chromium.launch({ channel: "chrome" });
const results = {};
try {
  for (const reference of [true, false]) {
    const name = reference ? "upstream" : "desktop";
    const root = reference ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const entry = "/src/__history_audit.jsx";
    const hook = reference
      ? "/src/hooks/use-canvas-history"
      : "/src/renderer/workspace/use-canvas-history";
    const fixture = `import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
      import {useCanvasHistory} from '${hook}';
      const initial={id:'node',type:'creative',position:{x:0,y:0},data:{kind:'image',label:'原名',${reference ? "prompt" : "text"}:''}};
      const viewport={x:0,y:0,zoom:1};
      function History(){
        const [nodes,setNodes]=useState([initial,{...initial,id:'source'}]);const [edges,setEdges]=useState([]);
        const [dragging,setDragging]=useState(false);
        const [voiceJobs,setVoiceJobs]=useState([]);
        const canvas=React.useMemo(()=>({nodes,edges,viewport}),[nodes,edges]);
        const history=${reference ? "useCanvasHistory({nodes,edges,setNodes,setEdges})" : "useCanvasHistory(canvas,next=>{setNodes(next.nodes);setEdges(next.edges)},dragging,voiceJobs)"};
        window.audit={
          edit:(field,value)=>flushSync(()=>setNodes(([node,source])=>[{...node,data:{...node.data,[field==='prompt'?'${reference ? "prompt" : "text"}':field]:value}},source])),
          move:(x,drag=false)=>flushSync(()=>{setDragging(drag);setNodes(([node,source])=>[{...node,dragging:drag,position:{x,y:0}},source])}),
          pick:()=>flushSync(()=>{history.absorbTyping('mention');setEdges([{id:'mention',source:'source',target:'node'}]);setNodes(([node,source])=>[{...node,data:{...node.data,${reference ? "prompt" : "text"}:'引用素材'}},source])}),
          scene:duration=>flushSync(()=>setNodes(([node,source])=>[{...node,data:{...node.data,kind:'${reference ? "director" : "script"}',${reference ? "scene" : "director"}:{version:1,duration,activeCameraId:'',characters:[],props:[],cameras:[]}}},source])),
          seconds:()=>nodes[0].data.${reference ? "scene" : "director"}?.duration,
          finishImage:(jobId,split=false)=>flushSync(()=>{
            const node=nodes[1]; const output={id:jobId+':0',kind:'image',assetId:jobId,src:jobId,mediaType:'image',createdAt:'today'};
            const next={...node,data:{...node.data,outputs:[...(node.data.outputs??[]),output],activeOutputId:output.id,assetId:jobId${reference ? ",src:jobId" : ""}}};
            const prior=[nodes[0],next];
            const rows=[{id:'new-shot',scene:'列车进站',action:'',dialogue:'',shot:'中景',camera:'固定',duration:3}];
            const updated=split?[{...nodes[0],data:{...nodes[0].data,storyboard:${reference ? "{shots:rows}" : "rows"}}},next]:prior;
            const jobs=[{id:jobId,nodeId:'source',status:'succeeded',outputs:[{kind:'image',assetId:jobId}]}];
            ${reference ? "" : "if(split)history.recordSynced({...canvas,nodes:prior},{...canvas,nodes:updated},jobs);else history.syncGenerated({...canvas,nodes:updated},jobs);"}
            setNodes(updated);
          }),
          image:()=>[nodes[0].position.x,nodes[1].data.assetId,nodes[1].data.activeOutputId,nodes[1].data.outputs.map(output=>output.id)],
          shots:()=>nodes[0].data.storyboard${reference ? "?.shots" : ""}?.length??0,
          external:()=>flushSync(()=>{
            const updated=nodes.map(node=>({...node,data:{...node.data,label:'外部改名'}}));
            ${reference ? "history.reset()" : "history.syncGenerated({...canvas,nodes:updated},[])"};
            setNodes(updated);
          }),
          startVoice:()=>flushSync(()=>{setVoiceJobs([{id:'voice-job',nodeId:'node',purpose:'character-voice',status:'running'}]);setNodes(([node,source])=>[{...node,data:{...node.data,character:{name:'林舟',look:'夜班',description:'',extraAssetIds:[]},${reference ? "voiceTaskId:'voice-job'" : ""}}},source])}),
          finishVoice:()=>flushSync(()=>{
            const [node,source]=nodes;
            const voice={assetId:'voice-asset',${reference ? "origin:'generated'" : ""}};
            setVoiceJobs([]);
            const updated=[{...node,data:{...node.data,character:{...node.data.character,voice},${reference ? "voiceTaskId:undefined" : ""}}},source];
            ${reference ? "" : "history.syncGenerated({...canvas,nodes:updated},[{id:'voice-job',nodeId:node.id,status:'succeeded',bound:true,purpose:'character-voice',outputs:[{kind:'audio',assetId:'voice-asset'}]}]);"}
            setNodes(updated);
          }),
          voice:()=>[nodes[0].position.x,nodes[0].data.character?.voice?.assetId??null],
          useManualVoice:()=>flushSync(()=>setNodes(([node,source])=>[
            {...node,data:{...node.data,character:{...node.data.character,voice:{assetId:'manual-asset',${reference ? "origin:'uploaded'" : ""}}}}},source
          ])),
          travel:dir=>flushSync(()=>${reference ? "history[dir]()" : "history.restore(dir)"}),
          read:()=>[nodes[0].data.label,nodes[0].data.${reference ? "prompt" : "text"},nodes[0].position.x,history.canUndo,history.canRedo,edges.length]
        };return null;
      }createRoot(document.querySelector('main')).render(<History/>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "history-audit",
          resolveId: (id) => (id === entry ? join(root, entry) : undefined),
          load: (id) => (id === join(root, entry) ? fixture : undefined),
        },
      ],
    });
    const page = await browser.newPage();
    try {
      await server.listen();
      const url = `${server.resolvedUrls.local[0]}audit`;
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<main></main><script type="module" src="${entry}"></script>`,
        }),
      );
      await page.goto(url);
      await page.waitForFunction(() => !!window.audit);
      results[name] = await page.evaluate(async () => {
        const states = {};
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
        const record = (label) => {
          states[label] = window.audit.read();
        };
        window.audit.edit("label", "新名");
        await tick();
        window.audit.edit("prompt", "清晨");
        await tick();
        window.audit.travel("undo");
        await tick();
        record("连续编辑撤销");
        window.audit.travel("redo");
        await tick();
        record("连续编辑重做");
        window.audit.edit("prompt", "中午");
        await new Promise((resolve) => setTimeout(resolve, 850));
        window.audit.edit("prompt", "傍晚");
        await tick();
        window.audit.move(15, true);
        window.audit.move(30, true);
        window.audit.move(45);
        await tick();
        window.audit.travel("undo");
        await tick();
        record("拖动撤销");
        window.audit.travel("undo");
        await tick();
        record("停手后撤销");
        window.audit.travel("undo");
        await tick();
        record("停手前撤销");
        for (let index = 1; index <= 105; index++) {
          window.audit.move(index);
          await tick();
        }
        let count = 0;
        while (window.audit.read()[3] && count < 106) {
          window.audit.travel("undo");
          await tick();
          count++;
        }
        states.capacity = [count, window.audit.read()[2]];
        for (const delay of [0, 850]) {
          window.audit.edit("prompt", "@镜头");
          await new Promise((resolve) => setTimeout(resolve, delay));
          window.audit.pick();
          await tick();
          window.audit.travel("undo");
          await tick();
          record(`选材前等待${delay}毫秒`);
        }
        window.audit.scene(5);
        await tick();
        window.audit.move(120);
        await tick();
        window.audit.scene(8);
        await tick();
        window.audit.travel("undo");
        await tick();
        states.sceneUndo = [window.audit.read()[2], window.audit.seconds()];
        window.audit.travel("redo");
        await tick();
        states.sceneRedo = [window.audit.read()[2], window.audit.seconds()];
        window.audit.move(130);
        await tick();
        window.audit.finishImage("first");
        await tick();
        window.audit.finishImage("variant");
        await tick();
        window.audit.travel("undo");
        await tick();
        states.firstImageUndo = window.audit.image();
        window.audit.travel("redo");
        await tick();
        states.firstImageRedo = window.audit.image();
        window.audit.move(140);
        await tick();
        window.audit.finishImage("second");
        await tick();
        window.audit.travel("undo");
        await tick();
        states.secondImageUndo = window.audit.image();
        window.audit.travel("undo");
        await tick();
        states.beforeBothImages = window.audit.image();
        window.audit.travel("redo");
        await tick();
        window.audit.travel("redo");
        await tick();
        states.secondImageRedo = window.audit.image();
        window.audit.move(150);
        await tick();
        window.audit.finishImage("parallel", true);
        await tick();
        states.parallelResult = [window.audit.shots(), ...window.audit.image()];
        window.audit.travel("undo");
        await tick();
        states.parallelSplitUndo = [window.audit.shots(), ...window.audit.image()];
        window.audit.travel("undo");
        await tick();
        states.parallelMoveUndo = [window.audit.shots(), ...window.audit.image()];
        window.audit.external();
        await tick();
        window.audit.travel("undo");
        await tick();
        record("外部改名后撤销");
        window.audit.startVoice();
        await tick();
        window.audit.move(160);
        await tick();
        window.audit.finishVoice();
        await tick();
        window.audit.travel("undo");
        await tick();
        states.voiceUndo = window.audit.voice();
        window.audit.travel("undo");
        await tick();
        states.voiceMoveUndo = window.audit.voice();
        window.audit.travel("redo");
        await tick();
        states.voiceMoveRedo = window.audit.voice();
        window.audit.useManualVoice();
        await tick();
        window.audit.travel("undo");
        await tick();
        states.manualVoiceUndo = window.audit.voice();
        window.audit.travel("redo");
        await tick();
        states.manualVoiceRedo = window.audit.voice();
        return states;
      });
    } finally {
      await page.close();
      await server.close();
    }
  }
  console.log(results);
  assert.deepEqual(results.upstream.capacity, [100, 5]);
  assert.deepEqual(results.upstream.sceneUndo, [5, 8]);
  assert.deepEqual(results.upstream.sceneRedo, [120, 8]);
  assert.deepEqual(results.upstream.manualVoiceUndo, [160, "voice-asset"]);
  assert.deepEqual(results.upstream.manualVoiceRedo, [160, "manual-asset"]);
  assert.deepEqual(results.desktop, results.upstream);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
