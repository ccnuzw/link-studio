import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const workspace = process.cwd(),
  reference = path.resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const continuation = process.argv.includes("--continue");
const quotations = process.argv.includes("--breakdown-quotes"),
  breakdown = quotations || process.argv.includes("--breakdown");
const series = process.argv.includes("--series");
const rings = process.argv.includes("--rings"),
  deletion = process.argv.includes("--delete"),
  rail = deletion || rings || process.argv.includes("--rail");
const output = path.join(
  workspace,
  "test-results",
  quotations
    ? "drama-breakdown-quote-parity"
    : breakdown
      ? "drama-breakdown-parity"
      : rings
        ? "drama-episode-progress-parity"
        : deletion
          ? "drama-episode-delete-parity"
          : rail
            ? "drama-episode-rail-parity"
            : series
              ? "drama-series-scripts-parity"
              : continuation
                ? "drama-continue-parity"
                : "drama-scripts-parity",
);
const temp = await mkdtemp(path.join(tmpdir(), "link-script-dialog-"));
const browser = await chromium.launch({ channel: "chrome" });
const episodes =
  series || rail
    ? Array.from({ length: 204 }, (_, index) => ({
        title: `长路${index + 1}`,
        no: index + 1,
        locked: rail && index === 1,
        scriptStatus: rail && index < 3 ? "ready" : "empty",
      }))
    : ["风雨来客", "信中约定", "第二封信", "天明"].map((title, index) => ({
        title,
        no: index + 1,
        locked: index === 3,
        scriptStatus: index >= 2 ? "ready" : "empty",
      }));
if (breakdown) episodes[0].scriptStatus = "ready";
const hooks = {
  "./context": `export const useWorkspace=()=>({drama:{id:'fixture',episodes:window.fixture,unitKind:'chapter',unitsTotal:35,rangeEnd:13,sourceChars:7000},jobs:[],refresh:()=>{}});`,
  "@/api/drama": `export async function estimateJobDetail(id,{episodes}) {return {credits:episodes.length*7,gapEpisodes:episodes.filter(no=>no>1&&!episodes.includes(no-1)&&window.fixture[no-2].scriptStatus!=='ready')};}export function submitJob(){throw Error('visual fixture');}`,
  "@/store/drama": `export const useDramaJobsStore={};`,
};
if (continuation)
  hooks["@/api/drama"] =
    `export async function estimatePlanning(id,end){return {credits:end===18?4:14,episodesMin:1,episodesMax:end===18?1:3,minutes:end===18?1:4};}export function setPlanningRange(){throw Error('visual fixture');}`;
if (quotations)
  hooks["@/api/drama"] =
    `export async function estimateJobDetail(){if(location.search==='?phase=error')throw Error();return new Promise(()=>{});}export function submitJob(){throw Error('visual fixture');}`;
const referenceEntry = breakdown
  ? `import {BreakdownDialog} from './src/pages/drama/workspace/breakdown-dialog';const dialog=<BreakdownDialog open onOpenChange={()=>{}} onStarted={()=>{}}/>;`
  : continuation
    ? `import {ContinuePlanDialog} from './src/pages/drama/workspace/continue-plan-dialog';const dialog=<ContinuePlanDialog open onOpenChange={()=>{}}/>;`
    : `import {ScriptsDialog} from './src/pages/drama/workspace/scripts-dialog';const dialog=<ScriptsDialog open onOpenChange={()=>{}}/>;`;
const desktopEntry = continuation
  ? `import {DramaContinueDialog} from './src/renderer/workspace/drama-continue-dialog';window.desktop={projects:{estimateDramaContinuation:async({rangeEnd})=>({ok:true,value:{credits:rangeEnd===18?4:14,episodeMin:1,episodeMax:rangeEnd===18?1:3,minutes:rangeEnd===18?1:4}})}};const dialog=<main className="drama-studio"><DramaContinueDialog projectHandle="fixture" doc={{source:{total:35,chars:7000,kind:'chapter'},planning:{end:13}}} close={()=>{}} saved={()=>{}}/></main>;`
  : `import {DramaScriptsDialog} from './src/renderer/workspace/drama-scripts-dialog';window.desktop={projects:{${breakdown ? "estimateDramaBreakdown" : "estimateDramaScripts"}:async({episodes})=>${quotations ? "location.search==='?phase=error'?{ok:false,error:{message:'估算失败'}}:new Promise(()=>{})" : "({ok:true,value:episodes.length*7})"}}};
const doc={episodes:window.fixture.map(episode=>({...episode,episode_no:episode.no,script_status:episode.scriptStatus,script_md:episode.scriptStatus==='ready'?'在门廊相遇。':''}))};const dialog=<main className="drama-studio"><DramaScriptsDialog projectHandle="fixture" doc={doc} mode="${breakdown ? "breakdown" : "scripts"}" initial={[]} close={()=>{}} saved={()=>{}}/></main>;`;
const report = {
  revision,
  scope: continuation
    ? "继续规划弹窗，同35章、已完成13章、7000字、同估价、固定背景、DPR 1，不含工作室外壳"
    : `分集剧本选集弹窗，同 ${episodes.length} 集、同估价、固定背景、DPR 1，不含工作室外壳`,
  states: {},
};
if (breakdown)
  report.scope =
    "资产拆解选集弹窗；四集，两集可拆、缺稿一集、已锁一集；默认、全选、清空，两主题两视口，含背景";
if (quotations)
  report.scope =
    "资产拆解等待估价、估价失败；同一可用选集，同错误消息，断言开始按钮仍可操作；整视口，DPR 1";
const captures = new Map();
if (rail) {
  report.scope = "204 集，剧本工序分集栏；固定背景，高 768/620 px，DPR 1，不含工作室外壳";
  Object.assign(hooks, {
    "./continue-plan-dialog": "export const ContinuePlanDialog=()=>null",
    "./job-bar": "export const ProgressRing=()=>null",
    "@/api/drama": "export async function addEpisode(){};export async function deleteEpisode(){};",
    "@/components/admin-ui/confirm-dialog": "export async function confirm(){}",
    "@/store/drama-segments": "export const useDramaSegmentsStore={};",
  });
}
if (deletion) {
  delete hooks["@/components/admin-ui/confirm-dialog"];
  episodes[1].segmentCount = 1;
  report.scope =
    "204集；选中第1集，右键有1个片段的第2集；真实菜单和确认框，同背景，DPR 1，不含工作室外壳";
}
if (rings) {
  delete hooks["./job-bar"];
  hooks["@/api/drama"] += [
    "cancelJob",
    "resumePlanning",
    "pausePlanning",
    "retryBuiltin",
    "submitJob",
  ]
    .map((name) => `export function ${name}(){throw Error('visual fixture');}`)
    .join("");
  hooks["./context"] = hooks["./context"].replace("jobs:[]", "jobs:window.jobs");
  report.scope = "204 集项目中第 2 集的完整分集按钮；任务排队、运行 0/20/80%、结束回到锁；DPR 1";
}
const railEntry = (upstream) =>
  `import {useState} from 'react';import {EpisodeRail} from '${upstream ? "./src/pages/drama/workspace/episode-rail" : "./src/renderer/workspace/drama-episode-rail"}';${deletion && upstream ? "import {MemoryRouter} from 'react-router';import {DialogHost} from './src/components/dialog-host';" : ""}function Fixture(){const [page,pick]=useState(1);return <main className="${upstream ? "drama-theme" : "drama-columns"}" style={{display:'flex',height:'100vh',background:'${deletion ? "var(--fixture-bg)" : "var(--background)"}'}}>${upstream ? "<EpisodeRail stage=\"script\" ep={typeof page==='number'?page:0} doc={typeof page==='string'?page:null} onPick={pick} onDoc={pick}/>" : "<EpisodeRail doc={{jobs:window.jobs,segments:[{episode_no:2}],episodes:window.fixture.map(item=>({...item,episode_no:item.no,script_status:item.scriptStatus,script_md:''}))}} page={page} pick={pick} remove={async()=>{}} add={()=>{}} extend={()=>{}}/>"}</main>}const dialog=${deletion && upstream ? "<MemoryRouter><Fixture/><DialogHost/></MemoryRouter>" : "<Fixture/>"};`;
try {
  await mkdir(output, { recursive: true });
  const archive = path.join(temp, "reference.tar");
  execFileSync("git", ["-C", reference, "archive", "-o", archive, revision, "web"]);
  execFileSync("tar", ["-xf", archive, "-C", temp]);
  const pinned = path.join(temp, "web");
  await symlink(path.join(reference, "web/node_modules"), path.join(pinned, "node_modules"), "dir");
  execFileSync(path.join(pinned, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: pinned,
  });
  for (const upstream of [true, false]) {
    const side = upstream ? "reference" : "desktop",
      root = upstream ? pinned : workspace,
      entry = path.join(root, "scripts-fixture.jsx"),
      outDir = path.join(temp, side);
    const aliases = upstream
      ? Object.keys(hooks)
          .filter((id) => id.startsWith("@"))
          .map((id) => ({ find: new RegExp("^" + id + "$"), replacement: "\0mock:" + id }))
      : [];
    await build({
      root,
      publicDir: false,
      configFile: false,
      logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"' },
      resolve: { alias: [...aliases, { find: "@", replacement: path.join(root, "src") }] },
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "scripts-fixture",
          enforce: "pre",
          resolveId(id, importer) {
            if (id === entry || id.startsWith("\0mock:")) return id;
            if (
              upstream &&
              id in hooks &&
              (id !== "./context" ||
                (rings && importer?.endsWith("/job-bar.tsx")) ||
                importer?.endsWith(
                  rail
                    ? "/episode-rail.tsx"
                    : continuation
                      ? "/continue-plan-dialog.tsx"
                      : breakdown
                        ? "/breakdown-dialog.tsx"
                        : "/scripts-dialog.tsx",
                ))
            )
              return "\0mock:" + id;
          },
          load(id) {
            if (id.startsWith("\0mock:")) return hooks[id.slice(6)];
            if (id === entry)
              return `import {createRoot} from 'react-dom/client';${rail && upstream ? "import {MotionConfig} from 'motion/react';" : ""}${rail ? railEntry(upstream) : upstream ? referenceEntry : desktopEntry}createRoot(document.querySelector('#root')).render(${rail && upstream ? '<MotionConfig reducedMotion="user">{dialog}</MotionConfig>' : "dialog"});`;
          },
        },
      ],
      build: { outDir, lib: { entry, formats: ["es"], fileName: () => "fixture.js" } },
    });
    const assets = upstream
      ? path.join(root, "dist/assets")
      : path.resolve(process.env.DRAMA_DESKTOP_ASSETS ?? "out/renderer/assets");
    const html = await readFile(path.join(assets, "../index.html"), "utf8");
    const css = [...html.matchAll(/href="[^"\n]*\/assets\/(index-[^"/]+\.css)"/g)].map(
      (match) => match[1],
    );
    assert.equal(css.length, 1);
    for (const theme of ["light", "dark"])
      for (const width of rail ? [1024, 768] : [1024, 390]) {
        const height = width === 390 ? 844 : width === 768 ? 620 : 768,
          page = await browser.newPage({
            viewport: { width, height },
            colorScheme: theme,
            reducedMotion: "reduce",
            deviceScaleFactor: 1,
          });
        try {
          page.on("pageerror", (error) => console.error(side, error));
          await page.route("http://localhost/**", (route) => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (name === "fixture.js")
              return route.fulfill({
                path: path.join(outDir, name),
                contentType: "text/javascript",
              });
            if (name === "index.css")
              return route.fulfill({ path: path.join(assets, css[0]), contentType: "text/css" });
            if (name.endsWith(".woff2"))
              return route.fulfill({
                path: path.join(assets, path.basename(name)),
                contentType: "font/woff2",
              });
            if (name) return route.abort();
            const phase = new URL(route.request().url()).searchParams.get("phase");
            const jobs = phase
              ? [
                  {
                    id: "fixture",
                    step: "compose",
                    lane: "user",
                    episodes: [2],
                    status:
                      phase === "queued" ? "queued" : phase === "done" ? "succeeded" : "running",
                    progress: Number(phase) || 0,
                  },
                ]
              : [];
            return route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset=utf-8><link rel=stylesheet href=/index.css><style>html,body{margin:0;min-height:100%;background:${theme === "dark" ? "#242424" : "#fafafa"}}.drama-studio{background:transparent}</style><div id=root></div><script>window.fixture=${JSON.stringify(episodes)};window.jobs=${JSON.stringify(jobs)}</script><script type=module src=/fixture.js></script>`,
            });
          });
          await page.goto("http://localhost/");
          const dialog = rail
            ? page.getByRole("navigation", { name: "分集" })
            : page.getByRole("dialog", {
                name: continuation ? "继续规划" : breakdown ? "资产拆解" : "生成分集剧本",
              });
          if (deletion)
            await page.evaluate(
              (color) => document.documentElement.style.setProperty("--fixture-bg", color),
              theme === "dark" ? "oklch(.145 .002 286)" : "oklch(.95 .007 85)",
            );
          const states = breakdown
            ? [
                ["default", [1]],
                ["all", [1, 3]],
                ["empty", []],
              ]
            : deletion
              ? [
                  ["menu", []],
                  ["confirm", []],
                ]
              : rail
                ? [
                    ["first", []],
                    ["outline", []],
                    ["last", []],
                  ]
                : series
                  ? [
                      ["first", episodes.slice(0, 200)],
                      ["all", episodes],
                      ["limit", episodes.slice(4)],
                      ["last", episodes.slice(200)],
                    ]
                  : continuation
                    ? [
                        ["default", []],
                        ["range", []],
                      ]
                    : [
                        ["default", [1, 2]],
                        ["gap", [2]],
                        ["overwrite", [1, 2, 3]],
                        ["empty", []],
                      ];
          for (const [state, chosen] of quotations
            ? [
                ["loading", [1]],
                ["error", [1]],
              ]
            : rings
              ? ["queued", "0", "20", "80", "done"].map((key) => [key, []])
              : states) {
            const popup = page.getByRole(state === "menu" ? "menu" : "alertdialog");
            const ringButton = dialog.getByRole("button", { name: "第 2 集 · 长路2", exact: true });
            if (rings) {
              await page.goto("http://localhost/?phase=" + state);
              await ringButton.waitFor();
              assert.equal(
                await ringButton.locator("circle[stroke-dasharray]").count(),
                state === "done" ? 0 : 1,
              );
            } else if (deletion) {
              if (state === "menu")
                await dialog
                  .getByRole("button", { name: "第 2 集 · 长路2", exact: true })
                  .click({ button: "right" });
              else {
                await page.getByRole("menuitem", { name: "删除" }).click();
                await popup.getByText("删除第 2 集「长路2」？").waitFor();
                assert.ok((await popup.innerText()).includes("它的 1 个片段也会删除"));
              }
              await popup.waitFor();
            } else if (rail) {
              if (state === "last")
                await dialog.evaluate((element) => {
                  const rows = [...element.querySelectorAll("div")].find(
                    (item) =>
                      item.clientHeight > 0 &&
                      item.scrollHeight > item.clientHeight &&
                      getComputedStyle(item).overflowY === "auto",
                  );
                  rows.scrollTop = rows.scrollHeight;
                });
              const active = dialog.getByRole("button", {
                name:
                  state === "first"
                    ? "第 1 集 · 长路1"
                    : state === "outline"
                      ? "故事大纲"
                      : "第 204 集 · 长路204",
                exact: true,
              });
              if (state !== "first") await active.click();
              assert.equal(await active.getAttribute("aria-current"), "true");
              assert.ok((await dialog.getByRole("button").count()) < 40);
            } else if (series) {
              if (state !== "first") {
                await dialog.getByLabel("起始集").fill(String(chosen[0].no));
                await dialog.getByLabel("结束集").fill("204");
                await dialog.getByRole("button", { name: "选中", exact: true }).click();
              }
              if (state !== "all") await dialog.getByText(`约 ${chosen.length * 7} 积分`).waitFor();
              const grid = dialog.locator('[data-slot="episode-grid"]');
              if (state === "last")
                await grid.evaluate((element) => {
                  element.scrollTop = element.scrollHeight;
                });
              if (state === "last")
                await grid.getByRole("button", { name: /204\.\s*长路204/ }).waitFor();
              assert.equal(
                await dialog
                  .getByRole("button", {
                    name: state === "all" ? "一次最多 200 集" : `生成 ${chosen.length} 集剧本`,
                    exact: true,
                  })
                  .isDisabled(),
                state === "all",
              );
              await dialog.getByText(`已选 ${chosen.length} 集`, { exact: true }).waitFor();
              assert.ok((await grid.getByRole("button").count()) < 60);
            } else if (quotations) {
              await page.goto("http://localhost/?phase=" + state);
              await dialog
                .getByText(state === "loading" ? "估算中…" : "估算失败", { exact: true })
                .waitFor();
              assert.ok(await dialog.getByRole("button", { name: "开始拆解" }).isEnabled());
            } else if (breakdown) {
              if (state !== "default")
                await dialog
                  .getByRole("button", { name: state === "all" ? "全选可用" : "清空" })
                  .click();
              await dialog.getByText(`已选 ${chosen.length} 集`, { exact: true }).waitFor();
              if (chosen.length) await dialog.getByText(`约 ${7 * chosen.length} 积分`).waitFor();
              assert.equal(await dialog.locator("[aria-pressed=true]").count(), chosen.length);
              assert.equal(
                await dialog.getByRole("button", { name: /2\.\s*信中约定/ }).isDisabled(),
                true,
              );
              assert.equal(
                await dialog.getByRole("button", { name: /4\.\s*天明/ }).isDisabled(),
                true,
              );
            } else if (continuation) {
              if (state === "range") {
                await dialog.getByRole("tab", { name: "规划到第 N 章" }).click();
                await dialog.getByLabel("规划到第几章").fill("18");
              }
              await dialog.getByText(state === "range" ? "约 4 积分" : "约 14 积分").waitFor();
              await dialog
                .getByText(
                  state === "range"
                    ? "第 14–18 章 · 约 1,000 字 · 预计约 1 集 · 约 1 分钟"
                    : "第 14–35 章 · 约 4,400 字 · 预计约 1–3 集 · 约 4 分钟",
                )
                .waitFor();
            } else {
              if (state === "gap")
                await dialog.getByRole("button", { name: /1\.\s*风雨来客/ }).click();
              if (state === "overwrite") await dialog.getByRole("button", { name: "全选" }).click();
              if (state === "empty") await dialog.getByRole("button", { name: "清空" }).click();
              await dialog.getByText(`已选 ${chosen.length} 集`).waitFor();
              if (chosen.length) await dialog.getByText(`约 ${chosen.length * 7} 积分`).waitFor();
              assert.equal(await dialog.locator("[aria-pressed=true]").count(), chosen.length);
              assert.equal(await dialog.getByRole("note").count(), state === "gap" ? 1 : 0);
              if (state === "overwrite")
                await dialog.getByText("其中 1 集会覆盖现有剧本").waitFor();
            }
            await page.mouse.move(0, 0);
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all(
                document.getAnimations().map((animation) => animation.finished.catch(() => {})),
              );
            });
            const key = `${theme}-${width}-${state}`,
              row = (report.states[key] ??= {});
            row[side] = await (deletion ? popup : rings ? ringButton : dialog).boundingBox();
            if (rings && state !== "done") {
              const arc = ringButton.locator("circle[stroke-dasharray]");
              row[side].offset = await arc.evaluate((item) =>
                parseFloat(getComputedStyle(item).strokeDashoffset),
              );
              const fraction = state === "queued" ? 0.25 : Math.max(0.04, Number(state) / 100);
              assert.ok(Math.abs(row[side].offset - 10 * Math.PI * (1 - fraction)) < 0.001);
            }
            if (deletion)
              row[side].styles = await popup.evaluate((root) =>
                [root, ...root.querySelectorAll("button,p,h2,h3,[role=menuitem]")].map((item) => {
                  const style = getComputedStyle(item);
                  return {
                    text: item.textContent,
                    css: [
                      style.backgroundColor,
                      style.border,
                      style.borderRadius,
                      style.color,
                      style.boxShadow,
                      style.font,
                      style.gap,
                      style.backdropFilter,
                    ],
                    bounds: item.getBoundingClientRect().toJSON(),
                  };
                }),
              );
            if (deletion && state === "menu")
              row[side].add = await page.locator('button[title="新增一集"]').evaluate((item) => {
                const css = getComputedStyle(item);
                return {
                  color: css.color,
                  opacity: css.opacity,
                  background: css.backgroundColor,
                  font: css.font,
                  antialias: css.webkitFontSmoothing,
                  rect: item.getBoundingClientRect().toJSON(),
                };
              });
            if (rail && !deletion && !rings)
              row[side].buttons = await dialog.getByRole("button").evaluateAll((items) =>
                items.map((item) => ({
                  name: item.getAttribute("aria-label") ?? item.textContent,
                  box: item.getBoundingClientRect().toJSON(),
                })),
              );
            if (rail && !deletion && !upstream) assert.deepEqual(row.desktop, row.reference, key);
            if (series) {
              row[side].grid = await dialog
                .locator('[data-slot="episode-grid"]')
                .evaluate((element) => {
                  const box = element.getBoundingClientRect();
                  return {
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                    scrollTop: element.scrollTop,
                    scrollHeight: element.scrollHeight,
                    visible: [...element.querySelectorAll("button")]
                      .filter((button) => {
                        const rect = button.getBoundingClientRect();
                        return rect.bottom > box.top && rect.top < box.bottom;
                      })
                      .map((button) => [
                        button.textContent,
                        button.getAttribute("aria-pressed"),
                        button.getBoundingClientRect().toJSON(),
                      ]),
                  };
                });
              if (!upstream) assert.deepEqual(row.desktop.grid, row.reference.grid, key);
            }
            if (continuation)
              row[side].styles = await dialog
                .locator(
                  'button,input,footer,[data-slot="dialog-footer"],span.min-w-0,.continue-estimate>span',
                )
                .evaluateAll((elements) =>
                  elements.map((element) => {
                    const css = getComputedStyle(element);
                    return {
                      label: element.textContent,
                      clip: css.backgroundClip,
                      shadow: css.boxShadow,
                      border: css.border,
                      focus: element.matches(":focus-visible"),
                      numeric: css.fontVariantNumeric,
                      rect: element.getBoundingClientRect().toJSON(),
                    };
                  }),
                );
            if (state === "default")
              row[side].controls = await dialog
                .locator("h2,button,input,small,[aria-pressed]>span")
                .evaluateAll((elements) =>
                  elements.map((element) => {
                    const css = getComputedStyle(element);
                    return {
                      label: element.textContent || element.getAttribute("aria-label"),
                      bounds: element.getBoundingClientRect().toJSON(),
                      font: css.font,
                      color: css.color,
                      radius: css.borderRadius,
                      padding: css.padding,
                      background: css.backgroundColor,
                    };
                  }),
                );
            if (breakdown && state === "default")
              row[side].warning = await dialog.locator("b").evaluateAll((elements) =>
                elements.map((el) => ({
                  text: el.parentElement.textContent,
                  rect: el.getBoundingClientRect().toJSON(),
                  font: getComputedStyle(el).font,
                  parent: getComputedStyle(el.parentElement).font,
                })),
              );
            const image = await page.screenshot({
              ...(rail &&
                !deletion && {
                  clip: rings ? await ringButton.boundingBox() : { x: 0, y: 0, width: 78, height },
                }),
              animations: "disabled",
              caret: "hide",
              path: path.join(output, `${side}-${key}.png`),
            });
            if (upstream) captures.set(key, image);
            else
              Object.assign(
                row,
                await page.evaluate(
                  async ({ pair, grid }) => {
                    const pixels = await Promise.all(
                      pair.map(async (data) => {
                        const image = new Image();
                        image.src = "data:image/png;base64," + data;
                        await image.decode();
                        const canvas = document.createElement("canvas");
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const context = canvas.getContext("2d");
                        context.drawImage(image, 0, 0);
                        return new Uint32Array(
                          context.getImageData(0, 0, image.width, image.height).data.buffer,
                        );
                      }),
                    );
                    const differentPixels = pixels[0].reduce(
                      (total, color, index) => total + Number(color !== pixels[1][index]),
                      0,
                    );
                    if (!grid) return { differentPixels };
                    let gridDifferentPixels = 0;
                    for (let top = Math.ceil(grid.y); top < Math.floor(grid.y + grid.height); top++)
                      for (
                        let left = Math.ceil(grid.x);
                        left < Math.floor(grid.x + grid.width);
                        left++
                      ) {
                        const offset = top * innerWidth + left;
                        if (pixels[0][offset] !== pixels[1][offset]) gridDifferentPixels++;
                      }
                    return { differentPixels, gridDifferentPixels };
                  },
                  {
                    pair: [captures.get(key), image].map((buffer) => buffer.toString("base64")),
                    grid: deletion ? row.reference : row.reference.grid,
                  },
                ),
              );
            if (
              !upstream &&
              key ===
                `light-1024-${quotations ? "loading" : deletion ? "confirm" : series ? "last" : "default"}`
            ) {
              const cropHeight = series ? 640 : 386,
                comparison = await browser.newPage({
                  viewport: { width: 1248, height: cropHeight + 32 },
                });
              try {
                const figures = [captures.get(key), image].map(
                  (capture, index) =>
                    `<figure><figcaption>${index ? "小灵 · link-studio" : "小镜 · 4277d16f"}</figcaption><div style="background-image:url(data:image/png;base64,${capture.toString("base64")})"></div></figure>`,
                );
                await comparison.setContent(
                  `<style>body{margin:0;display:flex;background:#fff}figure{margin:0;width:624px;text-align:center;font:16px/32px sans-serif}figure div{height:${cropHeight}px;background-position:center;background-repeat:no-repeat}</style>` +
                    figures.join(""),
                );
                await comparison.screenshot({ path: path.join(output, "comparison.png") });
              } finally {
                await comparison.close();
              }
            }
            if (rail && !upstream && key === "light-1024-first") {
              const comparison = await browser.newPage({ viewport: { width: 392, height: 802 } });
              try {
                await comparison.setContent(
                  `<style>body{margin:0;display:flex;background:#f3f3f3}figure{margin:0;flex:1;text-align:center;font:14px/32px sans-serif}img{display:block;margin:auto}</style>` +
                    [captures.get(key), image]
                      .map(
                        (capture, index) =>
                          `<figure><figcaption>${index ? "小灵 · link-studio" : "小镜 · 4277d16f"}</figcaption><img src="data:image/png;base64,${capture.toString("base64")}"></figure>`,
                      )
                      .join(""),
                );
                await comparison.screenshot({ path: path.join(output, "comparison.png") });
              } finally {
                await comparison.close();
              }
            }
          }
        } finally {
          await page.close();
        }
      }
  }
  if (rings) {
    const comparison = await browser.newPage({ viewport: { width: 530, height: 204 } });
    try {
      const phases = ["queued", "0", "20", "80", "done"],
        keys = phases.map((state) => "light-1024-" + state);
      const lines = await Promise.all(
        ["reference", "desktop"].map(
          async (side) =>
            `<span>${side === "reference" ? "小镜" : "小灵"}</span>` +
            (
              await Promise.all(
                keys.map(
                  async (key) =>
                    `<div><img src="data:image/png;base64,${(await readFile(path.join(output, `${side}-${key}.png`))).toString("base64")}"></div>`,
                ),
              )
            ).join(""),
        ),
      );
      await comparison.setContent(
        `<style>*{box-sizing:border-box}body{margin:0;padding:12px;font:14px sans-serif;background:#f4f3ef;color:#28241f;display:grid;grid-template-columns:48px repeat(5,1fr);align-items:center;text-align:center;gap:4px}img{display:block;margin:auto}h3{grid-column:1/-1;margin:0}</style><h3>分集侧栏 · 同状态对照</h3><i></i>` +
          ["排队", "运行 0%", "运行 20%", "运行 80%", "结束"]
            .map((label) => `<b>${label}</b>`)
            .join("") +
          lines.join(""),
      );
      await comparison.screenshot({ path: path.join(output, "comparison.png") });
    } finally {
      await comparison.close();
    }
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(report.states);
  if (Object.values(report.states).some((row) => row.differentPixels)) process.exitCode = 1;
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
