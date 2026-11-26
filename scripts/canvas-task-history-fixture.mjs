const originalTasks = [
  {
    id: "201",
    node_id: "deleted",
    status: "succeeded",
    kind: "image",
    model_id: "image-A",
    created_at: "2026-11-18T12:00:00Z",
    version: 1,
    credits: 8,
    charged_credits: 6,
  },
  {
    id: "202",
    node_id: "video",
    status: "running",
    kind: "video",
    model_id: "video-B",
    created_at: "2026-11-19T12:00:00Z",
    version: 1,
    credits: 20,
  },
];
const nodes = [
  {
    id: "video",
    position: { x: 0, y: 0 },
    data: {
      kind: "video",
      label: "雨夜列车",
      taskId: "202",
      pendingTaskIds: ["202"],
      outputs: [{ id: "201:0", taskId: "201" }],
    },
  },
];
const localJobs = originalTasks.map((task) => ({
  id: task.id,
  nodeId: task.node_id,
  status: task.status,
  kind: task.kind,
  model: task.id === "201" ? task.model_id : "视频展示名",
  ...(task.id === "202" && { modelKey: task.model_id }),
  quotedCredits: task.credits,
  settledCredits: task.charged_credits,
  createdAt: task.created_at,
  updatedAt: task.created_at,
}));

export function historyFixture(upstream, theme) {
  const imports = upstream
    ? `
    import {TasksSheet} from '/src/pages/canvas/chrome/tasks-sheet';
    import {useTasksStore} from '/src/store/tasks';
    import {ReactFlowProvider,useReactFlow} from '@xyflow/react';
    import {applyTheme} from '/src/lib/theme';
    applyTheme(${JSON.stringify(theme)});
  `
    : `
    import {CanvasTaskHistory} from '/src/renderer/workspace/canvas-task-history';
    window.desktop={projects:{listJobs:async()=>({ok:true,value:{jobs:${JSON.stringify(localJobs)}}})}};
  `;
  const setup = upstream
    ? `
    const flow=useReactFlow();
    window.selected=()=>flow.getNodes().filter(node=>node.selected).map(node=>node.id);
    window.advance=()=>useTasksStore.getState().upsert({...${JSON.stringify(originalTasks[1])},status:'finalizing',version:2});
    window.finish=(status,version)=>useTasksStore.getState().upsert({...${JSON.stringify(originalTasks[1])},status,version});
  `
    : `
    const [jobs,setJobs]=React.useState([${JSON.stringify(localJobs[1])}]);
    window.advance=()=>setJobs([{...${JSON.stringify(localJobs[1])},status:'downloading',updatedAt:'2026-11-19T12:01:00Z'}]);
    window.finish=(error,version)=>setJobs([{...${JSON.stringify(localJobs[1])},status:'failed',error,updatedAt:'2026-11-19T12:0'+version+':00Z'}]);
  `;
  return `import React from 'react';import {createRoot} from 'react-dom/client';${imports}
    const nodes=${JSON.stringify(nodes)};
    function Subject(){const [open,setOpen]=React.useState(false);${setup}
      return <><button style={{position:'absolute',left:16,top:16}} onClick={()=>setOpen(true)}>任务历史</button>${upstream ? "<TasksSheet open={open} onOpenChange={setOpen}/>" : '<CanvasTaskHistory open={open} setOpen={setOpen} nodes={nodes} jobs={jobs} inventoryReady projectHandle="fixture" pick={id=>{window.selected=()=>[id];return true;}}/>'}</>;
    }
    createRoot(document.querySelector('main')).render(${upstream ? "<ReactFlowProvider defaultNodes={nodes} defaultEdges={[]}><Subject/></ReactFlowProvider>" : "<Subject/>"});`;
}

export async function replayHistory(page, upstream, expect, checkpoint) {
  if (upstream)
    await page.route("**/generation-tasks?**", (route) =>
      route.fulfill({ json: { code: 0, msg: "ok", data: originalTasks } }),
    );
  await page.getByRole("button", { name: "任务历史", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "任务历史" }),
    rows = dialog.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  const video = rows.first().getByRole("button"),
    deleted = rows.last().getByRole("button");
  await expect(video).toContainText("雨夜列车");
  await expect(video).toContainText("生成中");
  await expect(deleted).toContainText("已删除的节点");
  await expect(deleted).toBeDisabled();
  await expect(video).toContainText("20 积分");
  await expect(video).toContainText("video-B");
  await expect(deleted).toContainText("image-A");
  await expect(deleted).toContainText("6 积分");
  await page.mouse.move(550, 250);
  await checkpoint("rows");
  await page.evaluate(() => window.advance());
  await expect(video).toContainText("即将完成");
  await video.hover();
  await checkpoint("hover");
  await page.mouse.move(550, 250);
  await video.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(video).toBeFocused();
  await checkpoint("focus");
  const geometry = await Promise.all([dialog, video, deleted].map((item) => item.boundingBox()));
  for (const [index, error] of [
    "JOB_QUEUE_TIMEOUT",
    "JOB_TIMEOUT",
    "JOB_PROVIDER_FAILED",
  ].entries()) {
    const expired = error !== "JOB_PROVIDER_FAILED";
    await page.evaluate(
      ([status, version]) => window.finish(status, version),
      [upstream ? (expired ? "expired" : "failed") : error, index + 3],
    );
    await expect(video).toContainText(expired ? "已超时" : "失败");
    if (index === 0) await checkpoint("expired");
  }
  await video.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.selected())).toEqual(["video"]);
  return geometry;
}

export function historyLifecycleFixture(upstream, theme) {
  const imports = upstream
    ? `import {TasksSheet} from '/src/pages/canvas/chrome/tasks-sheet';
    import {useTasksStore} from '/src/store/tasks';import {ReactFlowProvider,useReactFlow} from '@xyflow/react';
    import {applyTheme} from '/src/lib/theme';applyTheme(${JSON.stringify(theme)});`
    : `import {CanvasTaskHistory} from '/src/renderer/workspace/canvas-task-history';
    window.requests=0;window.desktop={projects:{listJobs:()=>new Promise(resolve=>{window.requests++;window.reply=resolve;})}};`;
  const setup = upstream
    ? `const flow=useReactFlow();window.record=()=>flow.setNodes(nodes=>nodes.map(node=>({...node,data:{...node.data,taskId:'202'}})));
    window.advance=()=>useTasksStore.getState().upsert(${JSON.stringify(originalTasks[1])});`
    : `const [nodes,setNodes]=React.useState([base]),[jobs,setJobs]=React.useState([]);
    window.record=()=>setNodes([{...base,data:{...base.data,outputs:[{id:'202:0'}]}}]);
    window.advance=()=>setJobs([${JSON.stringify(localJobs[1])}]);`;
  return `import React from 'react';import {createRoot} from 'react-dom/client';${imports}
    const base={id:'video',position:{x:0,y:0},data:{kind:'video',label:'雨夜列车'}};
    function Subject(){const [open,setOpen]=React.useState(false);${setup}return <><button style={{position:'absolute',left:16,top:16}} onClick={()=>setOpen(true)}>任务历史</button>${upstream ? "<TasksSheet open={open} onOpenChange={setOpen}/>" : '<CanvasTaskHistory open={open} setOpen={setOpen} nodes={nodes} jobs={jobs} inventoryReady projectHandle="fixture" pick={()=>true}/>'}</>;}
    createRoot(document.querySelector('main')).render(${upstream ? "<ReactFlowProvider defaultNodes={[base]} defaultEdges={[]}><Subject/></ReactFlowProvider>" : "<Subject/>"});`;
}

export async function replayHistoryLifecycle(page, upstream, expect, checkpoint) {
  const requests = [];
  if (upstream)
    await page.route("**/generation-tasks?**", (route) => {
      requests.push(route);
    });
  const count = () => (upstream ? requests.length : page.evaluate(() => window.requests));
  const open = page.getByRole("button", { name: "任务历史", exact: true }),
    dialog = page.getByRole("dialog", { name: "任务历史" });
  await open.click();
  await expect(dialog).toContainText("这张画布还没有生成过内容。");
  await checkpoint("empty");
  expect(await count()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.record());
  await open.click();
  await expect(dialog).toContainText("正在加载任务");
  await expect.poll(count).toBe(1);
  const spinner = await dialog.locator("svg.lucide-loader-circle").evaluate((element) => {
    const animation = element.getAnimations()[0];
    if (!animation) throw new Error("没有加载动画");
    animation.pause();
    animation.currentTime = 250;
    const timing = animation.effect.getTiming();
    return {
      duration: timing.duration,
      infinite: timing.iterations === Infinity,
      transform: getComputedStyle(element).transform,
    };
  });
  expect(spinner).toEqual({
    duration: 1000,
    infinite: true,
    transform: "matrix(0, 1, -1, 0, 0, 0)",
  });
  await checkpoint("loading");
  await page.evaluate(() => window.advance());
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  if (upstream) await requests[0].fulfill({ json: { code: 0, msg: "ok", data: [] } });
  else await page.evaluate(() => window.reply({ ok: true, value: { jobs: [] } }));
  await expect(dialog).toContainText("生成中");
  await page.mouse.click(510, 300);
  await expect(dialog).toHaveCount(0);
  await open.click();
  await expect(dialog).toContainText("生成中");
  await expect.poll(count).toBe(2);
  if (upstream) await requests[1].abort();
  else await page.evaluate(() => window.reply({ ok: false }));
  await expect(dialog).toContainText("生成中");
  await dialog.getByRole("button", { name: upstream ? "Close" : "关闭任务历史" }).click();
  await expect(dialog).toHaveCount(0);
  return { requests: await count(), spinner };
}
