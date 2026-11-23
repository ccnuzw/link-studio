import { execFileSync } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const workspace = process.cwd();
const reference = path.resolve(process.env.AGENT_REFERENCE_WEB ?? "../video-canvas/web");
const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const temp = await mkdtemp(path.join(tmpdir(), "link-card-"));
const compaction = process.argv.includes("--compaction");
const watch = process.argv.includes("--watch");
const opening = process.argv.includes("--history-opening");
const paging = opening || process.argv.includes("--paging");
const settled = process.argv.includes("--settled");
const decisions = process.argv.includes("--generation-decisions");
const approvalCard = process.argv.includes("--generation-approval");
const component = compaction || paging || watch || settled || decisions || approvalCard;
const output = path.join(
  workspace,
  approvalCard
    ? "test-results/agent-generation-approval-parity"
    : decisions
      ? "test-results/agent-generation-decision-parity"
      : settled
        ? "test-results/agent-settled-parity"
        : watch
          ? "test-results/agent-watch-parity"
          : opening
            ? "test-results/agent-history-opening-parity"
            : paging
              ? "test-results/agent-history-paging-parity"
              : compaction
                ? "test-results/agent-compaction-parity"
                : "test-results/agent-card-parity",
);
const viewport = { width: 400, height: 460 };
const scenarios = ["light", "dark"].flatMap((theme) =>
  [400, 320].map((width) => ({ theme, width, height: viewport.height })),
);
const fixture = {
  kind: "table",
  title: "悬念镜头对照",
  columns: ["镜头", "声音"],
  rows: Array.from({ length: 7 }, (_, index) => ({
    cells: [`镜头 ${index + 1}`, { text: "门外回声", tone: "warn" }],
  })),
  notes: [{ text: "先核对原剧本", tone: "info" }],
  sources: [{ title: "分镜参考", url: "https://example.com/storyboard" }],
};
const summary = {
  kind: "summary",
  title: "第一集改写摘要",
  tone: "ok",
  rows: [
    {
      label: "场景",
      value: "夜晚的楼道，门外传来两次敲门声。",
      sub: "第 1 集 · Scene 01",
      badge: "待改写",
    },
    { label: "人物", value: "父女隔门重逢", badge: "已确认", tone: "ok" },
    { label: "对白", value: "我一直在等你。", sub: "版本 02", badge: "需核对", tone: "warn" },
  ],
  notes: [{ text: "先核对原剧本", tone: "info" }],
};
const browser = await chromium.launch({
  channel: "chrome",
  args: approvalCard ? ["--disable-partial-raster", "--run-all-compositor-stages-before-draw"] : [],
});
try {
  await mkdir(output, { recursive: true });
  execFileSync("git", [
    "-C",
    path.dirname(reference),
    "archive",
    "-o",
    path.join(temp, "web.tar"),
    revision,
    "web",
  ]);
  execFileSync("tar", ["-xf", path.join(temp, "web.tar"), "-C", temp]);
  const pinned = path.join(temp, "web");
  await symlink(path.join(reference, "node_modules"), path.join(pinned, "node_modules"), "dir");
  execFileSync(path.join(pinned, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: pinned,
    stdio: "inherit",
  });
  if (compaction)
    await appendFile(
      path.join(pinned, "src/pages/canvas/agent/message-list.tsx"),
      "\nexport {CompactionDivider};\n",
    );
  if (settled)
    await appendFile(
      path.join(pinned, "src/pages/canvas/agent/message-list.tsx"),
      "\nexport {SettledDivider};\n",
    );
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, colorScheme: "light" });
  const report = {
    revision,
    scenarios,
    browser: browser.version(),
    sizes: {},
    styles: {},
    differences: {},
  };
  const captures = {};
  for (const [name, root] of [
    ["upstream", pinned],
    ["desktop", workspace],
  ]) {
    const upstream = name === "upstream";
    const dir = upstream ? "dist/assets" : "out/renderer/assets";
    const styles = (await readdir(path.join(root, dir))).filter((file) =>
      /^index-.*\.css$/.test(file),
    );
    if (styles.length !== 1) throw new Error(`Expected one production stylesheet in ${dir}`);
    const assets = path.join(temp, `${name}-assets`);
    if (approvalCard && !upstream) {
      await mkdir(assets);
      for (const filename of [
        styles[0],
        ...(await readdir(path.join(root, dir))).filter((file) => file.endsWith(".woff2")),
      ])
        await copyFile(path.join(root, dir, filename), path.join(assets, filename));
    }
    const entry = paging
      ? `const phase=new URLSearchParams(location.search).get('state'), failed=phase==='failed';` +
        (upstream
          ? `import {MessageList} from '/src/pages/canvas/agent/message-list.tsx'; import {AgentLoading} from '/src/pages/canvas/agent/agent-loading.tsx'; const content=phase.startsWith('open')?createElement(AgentLoading,{failed:phase==='open-error',onRetry:()=>{}}):createElement(MessageList,{ctl:{timeline:[],olderFailed:failed,loadingOlder:phase==='loading'},nodes:[],refNodes:[],onScrolled:()=>{}});`
          : `import {AssistantTranscript} from '/src/renderer/assistant/assistant-panel.tsx';const content=createElement(AssistantTranscript,{sessionId:'fixture',label:'聊天记录',history:{phase:({'open':'latest','open-error':'latest-error','jump':'ready','failed':'older-error','loading':'older'})[phase],hasMoreOlder:false}});`)
      : compaction
        ? `import {CompactionDivider} from '${upstream ? "/src/pages/canvas/agent/message-list.tsx" : "/src/renderer/assistant/compaction-divider.tsx"}';
      import {${upstream ? "StatusLine" : "AssistantCompactionStatus"} as Progress} from '${upstream ? "/src/pages/canvas/agent/status-line.tsx" : "/src/renderer/assistant/assistant-panel.tsx"}';
      import {Tooltip} from '@base-ui/react/tooltip'; const state=new URLSearchParams(location.search).get('state');
      const limit=state==='tokens'?0:3000,item={before:2800,after:state==='pending'?null:600,failed:state==='failed'};
      const since=Date.now()-3500;const content=state==='running'?createElement(Progress,${upstream ? "{line:{runId:'r',text:'正在整理较早的对话…',waiting:false,since}}" : "{events:[{runId:'r',type:'run.status',createdAt:since,payload:{status:'running'}}],state:{activeRun:'r',activeStatus:'running',compacting:true}}"}):createElement(Tooltip.Provider,{delay:0},createElement(CompactionDivider,{item,limit,window:limit}));`
        : upstream
          ? `import {InfoCard} from '/src/pages/canvas/agent/info-card.tsx';
      import {ReactFlowProvider} from '@xyflow/react'; import {parseCard} from '/src/utils/agent/card.ts';
      const content = createElement(ReactFlowProvider,null,createElement(InfoCard,{card:parseCard(fixture),scope:'canvas'}));`
          : `import {InfoCard} from '/src/renderer/assistant/info-card.tsx';
      const content = createElement(InfoCard,{raw:fixture});`;
    const file = path.join(root, "card-fixture-" + path.basename(temp) + ".jsx");
    const watchEntry = `import {useState} from 'react';import {${upstream ? "WatchStripView" : "AssistantWatchStrip"} as Strip} from '${upstream ? "/src/pages/canvas/agent/watch-strip.tsx" : "/src/renderer/workspace/assistant-watch.tsx"}';import {summarizeWatches} from '${upstream ? "/src/utils/agent/watch.ts" : "/src/renderer/workspace/assistant-watch-state.ts"}';
      const scenario=new URLSearchParams(location.search).get('state'), queued=scenario==='queued',partial=scenario==='partial',settled=queued?3:partial?2:0;
      const labels=['片头画面','夜景全景 · '+ '雨后的街道和远处亮着灯的房间'.repeat(3),'街道特写'];if(scenario==='overflow')labels.push(...Array.from({length:12},(_,index)=>'补充镜头 '+(index+1)));
      const summary=summarizeWatches([{batch_id:'b1',state:queued?'deliverable':'waiting',total:labels.length,settled,tasks:labels.map((label,index)=>({label,node_id:'n'+index,task_id:'t'+index,status:index<settled?'settled':'pending',task_status:index<settled?(index===0?'succeeded':'failed'):undefined}))}]);
      function View(){const [open,setOpen]=useState(false);return createElement(Strip,{summary,open,onToggle:()=>setOpen(!open),onLocate:()=>{},onCancel:()=>{},locate:()=>{},cancel:()=>{}});} const content=createElement(View);`;
    const settledEntry =
      `import {SettledDivider} from '${upstream ? "/src/pages/canvas/agent/message-list.tsx" : "/src/renderer/workspace/settled-divider.tsx"}';const steer=new URLSearchParams(location.search).get('state')==='steer';` +
      (upstream
        ? `import {buildTimeline} from '/src/utils/agent/timeline.ts';import {emptySession} from '/src/utils/agent/session-state.ts';const [item]=buildTimeline({...emptySession(),events:[{seq:1,type:'tasks.settled',run_id:'r',data:{steer}}]});const content=createElement(SettledDivider,{text:item.text});`
        : `const content=createElement(SettledDivider,{steer},'任务结果');`);
    const decisionEntry =
      `const scenario=new URLSearchParams(location.search).get('state'),status=scenario==='priced'?'executed':scenario,count=4,credits=scenario==='priced'?30:0,answer='先改来信镜头，再补人物的声音。'.repeat(3);` +
      (upstream
        ? `import {ApprovalRow} from '/src/pages/canvas/agent/approval-row.tsx';const approval={id:'a',kind:'generate',status,payload:{items:Array.from({length:count},(_,index)=>({node_id:String(index+1)}))},decision:{answer},quote_credits:credits};const content=createElement(ApprovalRow,{approvalId:'a',ctl:{state:{approvals:{a:approval}}}});`
        : `import {GenerationDecisionRow} from '/src/renderer/workspace/generation-decision-row.tsx';const content=createElement(GenerationDecisionRow,{status,count,answer,credits});`);
    const approvalEntry =
      `const reason='为这一幕准备四个候选镜头。',items=['街口','门铃','信封','来信'].map((label,index)=>({label,node_id:'n'+index,model_name:'角色镜头',price:index===3?30:12,count:1}));` +
      (upstream
        ? `import {ApprovalCard} from '/src/pages/canvas/agent/approval-card.tsx';const content=createElement(ApprovalCard,{approval:{id:'a',kind:'generate',status:'pending',payload:{items,reason}},ctl:{}});`
        : `import {GenerationApprovalCard} from '/src/renderer/workspace/generation-approval-card.tsx';const content=createElement(GenerationApprovalCard,{items,reason,busy:false,decide:()=>{}});`);
    const script = `import {createElement} from 'react';import {createRoot} from 'react-dom/client';const fixture=new URLSearchParams(location.search).get('kind') === 'summary' ? ${JSON.stringify(summary)} : ${JSON.stringify(fixture)};${approvalCard ? approvalEntry : decisions ? decisionEntry : settled ? settledEntry : watch ? watchEntry : entry}\ncreateRoot(document.querySelector('main')).render(content);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: path.join(temp, `${name}-cache`),
      resolve: { alias: { "@": path.join(root, "src") } },
      server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "card-fixture",
          resolveId(id) {
            if (id === `/${path.basename(file)}`) return file;
          },
          load(id) {
            if (id === file) return script;
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      if (approvalCard && !upstream)
        for (const filename of await readdir(assets))
          await page.route(`${origin}/${dir}/${filename}`, (route) =>
            route.fulfill({
              path: path.join(assets, filename),
              contentType: filename.endsWith(".css") ? "text/css" : "font/woff2",
            }),
          );
      if (upstream)
        await page.route(`${origin}/assets/*.woff2`, (route) =>
          route.fulfill({
            path: path.join(root, dir, path.basename(new URL(route.request().url()).pathname)),
            contentType: "font/woff2",
          }),
        );
      const surface = upstream ? "" : 'class="assistant-surface drama-assistant"';
      await page.route(`${origin}/compare?*`, (route) => {
        const theme = new URL(route.request().url()).searchParams.get("theme");
        if (component) {
          const scope = new URL(route.request().url()).searchParams.get("scope");
          const section = upstream
            ? `<main class="${scope === "drama" ? "drama-theme" : ""}"></main>`
            : `<div data-open="true" class="${scope === "settings" ? "settings-drawer" : scope === "drama" ? "drama-studio" : "canvas-workspace"}"><section class="assistant-surface ${scope}-assistant"><main></main></section></div>`;
          return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html class="${upstream && theme === "dark" ? "dark" : ""} ${upstream && scope === "settings" ? "admin-theme" : ""}"><meta charset=utf-8><link rel=stylesheet href="/${dir}/${styles[0]}"><style>main{position:fixed;left:12px;right:12px;top:32px;padding-bottom:4px;transform:translateZ(0);background:${theme === "dark" ? "#171717" : "white"}}${paging ? "main{display:flex;flex-direction:column;height:300px}.assistant-surface main .assistant-transcript{border:0;background:transparent}" : ""}</style>${section}<script type=module src="/${path.basename(file)}"></script>`,
          });
        }
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${upstream && theme === "dark" ? "dark" : ""}"><meta charset=utf-8><link rel=stylesheet href="/${dir}/${styles[0]}"><style>html,body{min-height:100%;margin:0}main{padding:12px}main.assistant-surface{display:block;padding:12px;height:100vh;border:0;border-radius:0}</style><main ${surface}></main><script type=module src="/${path.basename(file)}"></script>`,
        });
      });
      if (component) {
        for (const { theme, width, height } of scenarios)
          for (const scope of watch || settled || decisions || approvalCard
            ? ["canvas"]
            : ["canvas", "settings", "drama"])
            for (const state of approvalCard
              ? ["folded", "expanded", "partial", "none"]
              : decisions
                ? ["executed", "priced", "partially_approved", "rejected", "failed", "expired"]
                : settled
                  ? ["auto", "steer"]
                  : watch
                    ? ["waiting", "expanded", "partial", "queued", "overflow"]
                    : opening
                      ? ["open", "open-error", "jump"]
                      : paging
                        ? ["loading", "failed"]
                        : ["running", "pending", "complete", "tokens", "failed"]) {
              const key = `${scope}-${theme}-${width}-${state}`;
              await page.setViewportSize({ width, height });
              await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
              await page.goto(`${origin}/compare?theme=${theme}&scope=${scope}&state=${state}`);
              if (state === "jump") {
                const scroller = page.locator(upstream ? ".agent-fade-y" : ".assistant-events");
                await scroller.evaluate((el) => {
                  const spacer = document.createElement("div");
                  spacer.style.height = "900px";
                  el.firstElementChild.append(spacer);
                });
                await page.waitForFunction(
                  (selector) => document.querySelector(selector)?.scrollTop > 300,
                  upstream ? ".agent-fade-y" : ".assistant-events",
                );
                await scroller.evaluate((el) => {
                  el.scrollTop = 0;
                  return new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  );
                });
                if (await page.getByRole("button", { name: "回到底部" }).count())
                  throw Error("Jump appeared before content growth");
                await scroller.evaluate((el) => {
                  el.firstElementChild.lastElementChild.style.height = "1100px";
                });
              }
              if (watch && state !== "waiting") {
                await page.locator('[aria-expanded="false"]').click({ position: { x: 36, y: 16 } });
                await page.getByRole("list").waitFor();
                await page.mouse.move(0, 0);
              }
              if (watch && state === "overflow")
                await page.getByRole("list").evaluate((el) => {
                  el.scrollTop = el.scrollHeight;
                  if (!el.scrollTop) throw Error("Task list did not scroll");
                });
              if (approvalCard) {
                const card = page.getByRole("group", { name: "申请生成 4 个节点" });
                await card.waitFor();
                if (state !== "folded")
                  await card.getByRole("button", { name: "还有 1 项" }).click();
                if (state === "partial" || state === "none")
                  for (const box of (await card.getByRole("checkbox").all()).slice(
                    0,
                    state === "none" ? 4 : 3,
                  ))
                    await box.uncheck();
                await page.mouse.move(0, 0);
                const approve = card.getByRole("option", { name: /批准生成/ });
                if (
                  !(await approve.innerText()).includes(
                    `✦ ${state === "none" ? 0 : state === "partial" ? 30 : 66}`,
                  ) ||
                  (await approve.isDisabled()) !== (state === "none")
                )
                  throw Error("Incorrect quote or enabled state");
                await page.waitForFunction(() => {
                  const highlight = document.querySelector(
                    "[role=option][aria-selected=true] > span[aria-hidden]",
                  );
                  return !highlight || getComputedStyle(highlight).transform === "none";
                });
              }
              const divider =
                watch || decisions || approvalCard
                  ? page.locator("main > :first-child")
                  : state === "jump"
                    ? page.getByRole("button", { name: "回到底部" })
                    : state.startsWith("open")
                      ? page.getByRole("status")
                      : paging
                        ? page.locator(upstream ? ".agent-raised" : ".assistant-page-pill")
                        : page.getByRole(state === "running" ? "status" : "separator");
              await divider.waitFor();
              await page.evaluate(() => document.fonts.ready);
              if (decisions && !(await divider.innerText()).includes("申请生成 4 个节点"))
                throw Error("Missing generation decision");
              if (
                decisions &&
                state === "priced" &&
                !(await divider.innerText()).includes("· ✦ 30")
              )
                throw Error("Missing approved quote");
              if (approvalCard)
                await divider.evaluate(async () => {
                  if (!(await document.fonts.load('400 13px "Geist Variable"', "Agent")).length)
                    throw Error("审批卡字体没有加载");
                  await document.fonts.ready;
                });
              if (settled)
                await divider.evaluate(async (el) => {
                  const loaded = await document.fonts.load('400 11.5px "Geist Variable"', "Agent");
                  if (!loaded.length) throw Error("Missing Geist font");
                  await document.fonts.ready;
                  await new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  );
                  if (!el.getBoundingClientRect().height) throw Error("Missing settlement divider");
                });
              if (paging)
                await divider.evaluate(async (el) => {
                  while (getComputedStyle(el).opacity !== "1")
                    await new Promise(requestAnimationFrame);
                });
              await page.waitForFunction(() =>
                [...document.querySelectorAll("[role=separator] *,[role=status]")].every(
                  (child) => getComputedStyle(child).opacity === "1",
                ),
              );
              await page.evaluate(() =>
                Promise.all(
                  document
                    .getAnimations()
                    .filter((animation) => animation.effect.getTiming().iterations !== Infinity)
                    .map((animation) => animation.finished.catch(() => {})),
                ),
              );
              report.sizes[`${name}-${key}`] = await divider.boundingBox();
              report.styles[`${name}-${key}`] = await divider.evaluate((element) =>
                [element, element.firstElementChild, ...element.querySelectorAll("svg")]
                  .filter(Boolean)
                  .map((child) => [
                    child.tagName,
                    getComputedStyle(child).font,
                    getComputedStyle(child).color,
                    child.getBoundingClientRect().toJSON(),
                  ]),
              );
              if (approvalCard)
                report.styles[`${name}-${key}-detail`] = await divider.evaluate((el) =>
                  [...el.querySelectorAll("span,p,ul,li,button")].map((child) => [
                    child.textContent.slice(0, 32),
                    child.getBoundingClientRect().toJSON(),
                    getComputedStyle(child).font,
                    getComputedStyle(child).color,
                  ]),
                );
              if (approvalCard)
                report.styles[`${name}-${key}-checkbox`] = await divider
                  .getByRole("checkbox")
                  .first()
                  .evaluate((el) =>
                    Object.fromEntries(
                      [
                        "backgroundColor",
                        "backgroundClip",
                        "border",
                        "colorScheme",
                        "borderRadius",
                        "appearance",
                        "outline",
                        "boxShadow",
                        "filter",
                        "opacity",
                        "transition",
                        "transform",
                        "contain",
                        "overflow",
                      ].map((prop) => [prop, getComputedStyle(el)[prop]]),
                    ),
                  );
              if (paging)
                report.styles[`${name}-${key}-surface`] = await divider.evaluate((el) =>
                  Object.fromEntries(
                    [
                      "boxShadow",
                      "backgroundColor",
                      "borderRadius",
                      "transform",
                      "textRendering",
                      "opacity",
                      "colorScheme",
                      "fontFamily",
                      "filter",
                      "isolation",
                      "willChange",
                      "backdropFilter",
                    ].map((prop) => [prop, getComputedStyle(el)[prop]]),
                  ),
                );
              if (opening)
                report.styles[`${name}-${key}-children`] = await divider.evaluate((el) =>
                  [...el.children].map((child) => {
                    const style = getComputedStyle(child);
                    return [
                      child.tagName,
                      child.getBoundingClientRect().toJSON(),
                      style.font,
                      style.color,
                      style.backgroundColor,
                      style.borderColor,
                      style.borderRadius,
                    ];
                  }),
                );
              if (watch)
                report.styles[`${name}-${key}-tasks`] = await divider.evaluate((el) =>
                  [...el.querySelectorAll("li span,li button")].map((child) => {
                    const style = getComputedStyle(child);
                    return [
                      child.textContent,
                      style.font,
                      style.color,
                      child.getBoundingClientRect().toJSON(),
                    ];
                  }),
                );
              let image = await divider.screenshot(),
                stable = false;
              for (let attempt = 0; attempt < 4 && !stable; attempt++) {
                await page.evaluate(
                  () =>
                    new Promise((resolve) =>
                      requestAnimationFrame(() => requestAnimationFrame(resolve)),
                    ),
                );
                const next = await divider.screenshot();
                stable = image.equals(next);
                image = next;
              }
              if (!stable) throw Error(`Unstable ${name}-${key}`);
              await writeFile(path.join(output, `${name}-${key}.png`), image);
              (captures[key] ??= []).push(image.toString("base64"));
            }
        continue;
      }
      for (const { theme, width, height } of scenarios)
        for (const sample of [fixture, summary]) {
          await page.setViewportSize({ width, height });
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(`${origin}/compare?theme=${theme}&kind=${sample.kind}`);
          const card = page.getByRole("region", { name: sample.title });
          await card.waitFor();
          for (const state of sample.kind === "summary" ? ["summary"] : ["folded", "expanded"]) {
            if (state === "expanded") await card.getByRole("button", { name: "还有 1 项" }).click();
            await page.mouse.move(0, 0);
            await page.evaluate(() => document.fonts.ready);
            if (
              !(await page.evaluate(() =>
                [...document.fonts].some(
                  (font) => font.family.includes("Geist") && font.status === "loaded",
                ),
              ))
            )
              throw new Error(`Missing Geist font for ${name}`);
            const count = await card.locator(state === "summary" ? "dt" : "tbody tr").count();
            if (count !== { folded: 6, expanded: 7, summary: 3 }[state])
              throw new Error("Unexpected card state");
            const key = `${theme}-${width}-${state}`;
            report.sizes[`${name}-${key}`] = await card.boundingBox();
            if (state === "summary")
              report.styles[`${name}-${key}`] = await card.evaluate((element) =>
                Object.fromEntries(
                  [
                    "dl",
                    "dl > div",
                    "dt",
                    "dd",
                    "dd > :last-child",
                    "dd:last-child span",
                    "ul",
                    "li",
                  ].map((selector) => {
                    const child = element.querySelector(selector);
                    const style = getComputedStyle(child);
                    return [
                      selector,
                      {
                        font: style.font,
                        color: style.color,
                        display: style.display,
                        columns: style.gridTemplateColumns,
                        box: child.getBoundingClientRect().toJSON(),
                      },
                    ];
                  }),
                ),
              );
            if (state === "folded")
              report.styles[`${name}-${theme}-${width}`] = await card.evaluate((element) =>
                Object.fromEntries(
                  ["h3", "th", "td", "td span", "button", "ul", "a"].map((selector) => {
                    const child = element.querySelector(selector);
                    const style = getComputedStyle(child);
                    return [
                      selector,
                      {
                        font: style.font,
                        color: style.color,
                        box: child.getBoundingClientRect().toJSON(),
                      },
                    ];
                  }),
                ),
              );
            const image = await page.screenshot({ path: path.join(output, `${name}-${key}.png`) });
            if (!image.equals(await page.screenshot()))
              throw new Error(`Unstable ${name}-${state}`);
            (captures[key] ??= []).push(image.toString("base64"));
          }
        }
    } finally {
      await server.close();
    }
  }
  for (const [state, images] of Object.entries(captures)) {
    if (
      component &&
      JSON.stringify(report.sizes["upstream-" + state]) !==
        JSON.stringify(report.sizes["desktop-" + state])
    ) {
      report.differences[state] = "geometry";
      continue;
    }
    report.differences[state] = await page.evaluate(async (images) => {
      const pixels = await Promise.all(
        images.map(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return new Uint32Array(
            context.getImageData(0, 0, canvas.width, canvas.height).data.buffer,
          );
        }),
      );
      return pixels[0].reduce(
        (count, color, index) => count + Number(color !== pixels[1][index]),
        0,
      );
    }, images);
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  if (decisions || approvalCard) {
    const states = approvalCard
      ? ["partial"]
      : ["executed", "partially_approved", "rejected", "failed", "expired"];
    const columns = ["小镜 · 4277d16f", "小灵 · Link Studio"].map(
      (title, index) =>
        `<section><h2>${title}</h2>${states.map((state) => `<img alt="${state}" src="data:image/png;base64,${captures["canvas-light-400-" + state][index]}">`).join("")}</section>`,
    );
    await page.setViewportSize({ width: 820, height: 240 });
    await page.setContent(
      `<style>body{margin:0;background:#eee;font:14px system-ui}article{display:flex;gap:12px;padding:12px}section{background:white;padding:8px}h2{font-size:15px;margin:0 0 12px}img{display:block;margin:8px 0}</style><article>${columns.join("")}</article>`,
    );
    await page
      .locator("img")
      .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
    await page.locator("article").screenshot({ path: path.join(output, "comparison.png") });
  }
  console.log(JSON.stringify(report));
  if (Object.values(report.differences).some((count) => count !== 0))
    throw new Error("组件与固定基线存在像素差异，详见 report.json");
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
