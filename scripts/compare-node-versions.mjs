import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const temp = await mkdtemp(join(tmpdir(), "canvas-versions-"));
const retina = process.argv.includes("--retina");
const tasks = process.argv.includes("--tasks");
const transitions = process.argv.includes("--transitions");
const narrow = process.argv.includes("--narrow"),
  faults = process.argv.includes("--faults");
const posters = process.argv.includes("--posters"),
  bulk = process.argv.includes("--bulk") || narrow || faults || posters;
const viewport = narrow ? { width: 560, height: 640 } : { width: 1200, height: 800 };
const count = bulk ? 9 : 2;
const badgeCount = count + (tasks ? 3 : 0);
const pendingTitles = ["排队中", "生成中", "即将完成"];
assert(!tasks || !bulk, "--tasks uses a two-version audio fixture");
const images = bulk
  ? await Promise.all(
      [32, 64].map(
        async (size) =>
          "data:image/png;base64," +
          (await readFile(`resources/icons/icon-${size}.png`)).toString("base64"),
      ),
    )
  : [];
const poster = posters
  ? execFileSync(resolve("out/media", `${process.platform}-${process.arch}`, "ffmpeg"), [
      "-v",
      "error",
      "-i",
      "resources/icons/icon-64.png",
      "-vf",
      "pad=112:64:24:0:blue",
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-update",
      "1",
      "-f",
      "image2",
      "pipe:1",
    ])
  : undefined;
const output = resolve(
  "test-results/canvas-version-history" +
    (tasks ? "-tasks" : "") +
    (transitions ? "-transitions" : "") +
    (bulk ? "-bulk" : "") +
    (narrow ? "-narrow" : "") +
    (faults ? "-faults" : "") +
    (posters ? "-posters" : "") +
    (retina ? "-retina" : ""),
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", args: ["--disable-gpu"] });
const results = {};
try {
  for (const side of ["original", "desktop"]) {
    const upstream = side === "original",
      root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets"),
      css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const fixture = "/src/__version_check.tsx";
    const common = `import {createRoot} from 'react-dom/client';import {useState} from 'react';const kind='${posters ? "video" : bulk ? "image" : "audio"}',images=${JSON.stringify(images)};const outputs=Array.from({length:${count}},(_,index)=>({id:String(index+1),kind,assetId:String(index+1),mediaType:kind,src:kind==='video'?'/files/'+(index+1)+'.mp4':images[index%2]??'/unused.wav',createdAt:0}));const last=outputs.at(-1),data={kind,text:'',label:'版本样片',status:'done',src:last.src,assetId:last.id,outputs,activeOutputId:last.id};`;
    const taskSetup = !tasks
      ? "const jobs=[];"
      : `const jobs=['queued','running','downloading','failed','failed','cancelled'].map((status,index)=>({id:String(index+11),status,kind,batchId:'batch',nodeId:'sample',createdAt:'2026-01-01T00:00:'+(index===4?'00':'31')+'Z',errorMessage:index===4?'旧批错误':'本地渲染失败',canCancelRemote:true}));data.pendingTaskIds=jobs.slice(0,3).map(job=>job.id);` +
        (upstream
          ? `import {useTasksStore} from '@/store/tasks';useTasksStore.setState({tasks:Object.fromEntries(jobs.map(job=>[job.id,{id:job.id,node_id:'sample',created_at:job.createdAt,status:({queued:'pending',downloading:'finalizing',cancelled:'canceled'})[job.status]??job.status,error_message:job.errorMessage}]))});`
          : "");
    const code =
      common +
      taskSetup +
      (faults && !posters
        ? `last.src='/hold.png';outputs[7].src='/corrupt.png';outputs[6].src='/denied.png';data.src=last.src;`
        : "") +
      (upstream
        ? `import {ReactFlowProvider} from '@xyflow/react';import {VersionBadge} from '@/components/canvas/version-badge';import {NodeHistoryDialog} from '@/components/canvas/history-dialog';function Audit(){return <ReactFlowProvider defaultNodes={[{id:'sample',type:'canvas',position:{x:0,y:0},data}]}><VersionBadge nodeId="sample" badge={{count:${badgeCount},generating:${tasks}}}/><NodeHistoryDialog/></ReactFlowProvider>}`
        : `import {VersionBadge,NodeVersionDialog} from '/src/renderer/workspace/node-version-dialog';window.desktop={projects:{getAssetPreview:async({assetId,variant})=>${faults ? "assetId==='7'?{ok:false}:" : ""}({ok:true,value:{url:outputs.find(item=>item.id===assetId).src+(variant==='poster'?'?v=poster':'')}})}};function Audit(){const [open,set]=useState(false),[current,choose]=useState(data);return <><VersionBadge count={${badgeCount}} generating={${tasks}} open={()=>set(true)}/>{open && <NodeVersionDialog data={current} handle="local" jobs={jobs} assets={[]} close={()=>set(false)} choose={out=>choose({...data,activeOutputId:out.id,assetId:out.assetId})} add={()=>0} download={()=>{}} cancel={()=>{}}/>}</>}`) +
      `createRoot(document.getElementById('badge')).render(<Audit/>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, side),
      assetsInclude: ["**/*.glb"],
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "versions-replay",
          enforce: "pre",
          resolveId: (id) =>
            id === fixture ? id : id.endsWith(".css") ? "\0built-styles" : undefined,
          load: (id) =>
            id === fixture ? code : id === "\0built-styles" ? "export {};" : undefined,
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport,
          deviceScaleFactor: retina ? 2 : 1,
          colorScheme: theme,
          reducedMotion: transitions ? "no-preference" : "reduce",
        });
        try {
          page.on("pageerror", (err) => console.error(side, err.message));
          let release;
          const held = new Promise((resolve) => {
            release = resolve;
          });
          const mediaRequests = [];
          if (posters)
            await page.route("**/files/**", async (route) => {
              const url = new URL(route.request().url());
              mediaRequests.push(url);
              if (url.search !== "?v=poster") return route.abort();
              if (faults) {
                if (url.pathname === "/files/7.mp4")
                  return route.fulfill({ status: 403, body: "" });
                if (url.pathname === "/files/8.mp4")
                  return route.fulfill({ contentType: "image/png", body: "corrupt" });
                if (url.pathname === "/files/9.mp4") await held;
              }
              return route.fulfill({ contentType: "image/png", body: poster });
            });
          if (faults) {
            await page.route("**/corrupt.png", (route) =>
              route.fulfill({ contentType: "image/png", body: "corrupt" }),
            );
            await page.route("**/denied.png", (route) => route.fulfill({ status: 403, body: "" }));
            await page.route("**/hold.png", async (route) => {
              await held;
              await route.fulfill({ path: resolve("resources/icons/icon-32.png") });
            });
          }
          await page.route(origin + "assets/**", (route) =>
            route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
          );
          await page.route(origin + "audit", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><style>#back{position:fixed;inset:0;background:${theme === "light" ? "#fafafa" : "#171717"}}#badge{position:absolute;left:50px;top:50px;width:576px;height:288px;box-shadow:none;border:0;background:transparent}</style><main id="back" class="${upstream ? "" : "canvas-workspace"}"><div id="badge" class="${upstream ? "" : "creative-card"}"></div></main><script type="module" src="${fixture}"></script>`,
            }),
          );
          await page.goto(origin + "audit");
          const badge = page.getByRole("button", { name: `历史记录，共 ${badgeCount} 版` });
          await expect(badge).toBeVisible({ timeout: 30000 });
          if (transitions) {
            const samples = {};
            const frame = { x: 200, y: 220, width: 800, height: 360 };
            const sample = async (name, label, opening, action) => {
              await page.evaluate((label) => {
                window.historyFrames = [];
                const listener = (event) => {
                  if (
                    event.target.getAttribute("role") !== "dialog" ||
                    event.target.getAttribute("aria-label") !== label
                  )
                    return;
                  document.removeEventListener("transitionrun", listener, true);
                  window.historyFrames = document
                    .getAnimations()
                    .filter(
                      (animation) =>
                        animation instanceof CSSTransition &&
                        [200, 240].includes(animation.effect.getTiming().duration),
                    );
                  for (const animation of window.historyFrames) {
                    animation.pause();
                    animation.currentTime = 0;
                  }
                };
                document.addEventListener("transitionrun", listener, true);
              }, label);
              await action();
              await expect
                .poll(() => page.evaluate(() => window.historyFrames.length))
                .toBeGreaterThan(0);
              const dialog = page.locator(`[role=dialog][aria-label="${label}"]`);
              for (const ms of [60, 120, 180]) {
                const measured = await page.evaluate(
                  async ({ label, ms }) => {
                    for (const animation of window.historyFrames) animation.currentTime = ms;
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    const element = document.querySelector(`[role=dialog][aria-label="${label}"]`),
                      style = getComputedStyle(element);
                    return {
                      opacity: style.opacity,
                      scale: style.scale,
                      properties: window.historyFrames
                        .map((animation) => [
                          animation.transitionProperty,
                          animation.effect.getTiming().duration,
                        ])
                        .sort(),
                    };
                  },
                  { label, ms },
                );
                const key = `${name}-${ms}`;
                samples[key] = measured;
                if (process.env.STYLES && ms === 120)
                  console.log(
                    side,
                    theme,
                    name,
                    await dialog.evaluate((el) => [
                      el.getBoundingClientRect().toJSON(),
                      el.innerText.slice(0, 100),
                      getComputedStyle(el).boxShadow,
                      getComputedStyle(el).transform,
                    ]),
                  );
                const bytes = await page.screenshot({
                  clip: frame,
                  path: join(output, `${side}-${theme}-${key}.png`),
                });
                assert(bytes.equals(await page.screenshot({ clip: frame })), key + " unstable");
              }
              await page.evaluate(() => {
                for (const animation of window.historyFrames) animation.finish();
              });
              if (opening) await expect(dialog).toBeVisible();
              else await expect(dialog).toHaveCount(0);
            };
            const normal = page.getByRole("dialog", { name: /^历史记录/ }),
              full = page.getByRole("dialog", { name: "全屏查看", exact: true });
            await page.mouse.move(1, 1);
            await sample("normal-in", "历史记录", true, () => badge.click());
            await sample("full-in", "全屏查看", true, () =>
              normal.getByRole("button", { name: "全屏查看" }).click(),
            );
            await sample("full-out", "全屏查看", false, () =>
              full.getByRole("button", { name: "关闭" }).click(),
            );
            await sample("normal-out", "历史记录", false, () =>
              normal.getByRole("button", { name: "关闭" }).click(),
            );
            results[`${side}-${theme}`] = samples;
            if (!upstream) assert.deepEqual(samples, results[`original-${theme}`]);
            continue;
          }
          const snap = async (state, clip, hover) => {
            if (hover) await hover.hover();
            else await page.mouse.move(1, 1);
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all(
                document
                  .getAnimations()
                  .filter((item) => item.effect?.getTiming().iterations !== Infinity)
                  .map((a) => a.finished.catch(() => {})),
              );
            });
            const bytes = await page.screenshot({
              clip,
              path: join(output, `${side}-${theme}-${state}.png`),
            });
            assert(bytes.equals(await page.screenshot({ clip })), `${side}-${state} unstable`);
          };
          if (narrow)
            await page.locator("#badge").evaluate((element) => {
              element.style.width = "350px";
            });
          const layout = { badge: await badge.boundingBox() };
          if (!bulk && !tasks) await snap("badge", { x: 545, y: 50, width: 85, height: 55 });
          if (process.env.STYLES)
            console.log(
              side,
              theme,
              "badge",
              await badge.evaluate((e) => getComputedStyle(e).boxShadow),
            );
          await badge.click();
          const dialog = page.getByRole("dialog", { name: /^历史记录/ });
          const tile = dialog.getByRole("button", {
            name: `第 ${count} 版（当前主图）`,
            exact: true,
          });
          await expect(tile).toBeVisible();
          if (tasks) {
            const freezeSpins = () =>
              page.evaluate(async () => {
                await Promise.all(
                  document.getAnimations().map((animation) => {
                    if (animation.effect?.getTiming().iterations !== Infinity)
                      return animation.finished.catch(() => {});
                    animation.pause();
                    animation.currentTime = 250;
                    return animation.ready;
                  }),
                );
              });
            for (const title of pendingTitles)
              await expect(dialog.getByLabel(title, { exact: true })).toBeVisible();
            const failed = dialog.getByLabel("生成失败：本地渲染失败", { exact: true });
            await expect(failed).toBeVisible();
            await expect(dialog.getByText("旧批错误")).toHaveCount(0);
            await freezeSpins();
            const clip = async (locator) => {
              const box = await locator.boundingBox();
              return {
                x: Math.floor(box.x) - 2,
                y: Math.floor(box.y) - 2,
                width: Math.ceil(box.width) + 4,
                height: Math.ceil(box.height) + 4,
              };
            };
            for (const [index, title] of pendingTitles.entries())
              await snap(`task-${index}`, await clip(dialog.getByLabel(title, { exact: true })));
            await snap("task-failed", await clip(failed));
            await dialog.getByRole("button", { name: "更多" }).click();
            await expect(page.getByRole("menuitem", { name: "取消剩余（2 个）" })).toBeEnabled();
            await page.keyboard.press("Escape");
            await dialog.getByRole("button", { name: "全屏查看" }).click();
            const full = page.getByRole("dialog", { name: "全屏查看" });
            await expect(full.getByText("本地渲染失败")).toHaveCount(0);
            await freezeSpins();
            await snap("task-full", { x: 0, y: 0, width: 1200, height: 295 });
            continue;
          }
          if (bulk) {
            const nineClip = narrow
              ? { x: 0, y: 0, ...viewport }
              : { x: 220, y: 95, width: 760, height: 610 };
            if (faults) {
              try {
                if (posters) {
                  for (const index of [7, 8]) {
                    const cell = dialog.getByRole("button", {
                      name: `第 ${index} 版`,
                      exact: true,
                    });
                    await expect(cell.locator("img,[data-slot=media-skeleton]")).toHaveCount(0);
                    await expect(cell.locator(":scope >span>svg")).toHaveCSS("width", "24px");
                  }
                } else
                  await expect(dialog.getByRole("img", { name: "图片加载失败" })).toHaveCount(2);
                const skeleton = tile.locator("[data-slot=media-skeleton]");
                await expect(skeleton).toHaveCSS("opacity", "1");
                await expect(skeleton.locator("div")).toHaveCount(0);
                await snap("pending", nineClip);
              } finally {
                release();
              }
            }
            await expect(dialog.locator("img")).toHaveCount(count - (faults ? 2 : 0));
            await dialog
              .locator("img")
              .evaluateAll((elements) => Promise.all(elements.map((element) => element.decode())));
            await expect(dialog.locator("[data-slot=media-skeleton]")).toHaveCount(0);
            await snap("nine", nineClip);
            if (posters) {
              assert(mediaRequests.length >= count - (faults && !upstream ? 1 : 0));
              assert(mediaRequests.every((url) => url.search === "?v=poster"));
              await expect(dialog.locator("video")).toHaveCount(0);
            }
            if (narrow) {
              const tiles = dialog.locator("[data-history-tile]"),
                grid = tiles.first().locator("..");
              await tile.focus();
              await page.keyboard.press("ArrowDown");
              await expect(tiles.nth(2)).toBeFocused();
              for (let row = 0; row < 3; row++) await page.keyboard.press("ArrowDown");
              await expect(tiles.last()).toBeFocused();
              await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
              await page.keyboard.press("Enter");
              await expect(tiles.last()).toHaveAttribute("aria-pressed", "true");
              layout.scroll = await grid.evaluate((el) => el.scrollTop);
              await snap("scroll", nineClip);
            }
            const confirmClip = {
              x: viewport.width / 2 - 225,
              y: viewport.height / 2 - 102,
              width: 450,
              height: 224,
            };
            await dialog.getByRole("button", { name: "更多" }).click();
            await page.getByRole("menuitem", { name: "全部添加到画布" }).click();
            const question = page.getByRole("dialog", {
              name: "将在画布上新建 9 个节点，确定吗？",
            });
            await expect(question.getByRole("button", { name: "取消" })).toBeFocused();
            await snap("normal-confirm", confirmClip);
            await page.keyboard.press("Escape");
            await expect(question).toHaveCount(0);
            await dialog.getByRole("button", { name: "全屏查看" }).click();
            const full = page.getByRole("dialog", { name: "全屏查看" });
            await full.getByRole("button", { name: "全部添加到画布" }).click();
            const confirm = page
              .getByRole("button", { name: "确定", exact: true })
              .locator('xpath=ancestor::*[@role="dialog"][1]');
            await expect(confirm.getByText("将在画布上新建 9 个节点，确定吗？")).toBeVisible();
            await expect(confirm.getByRole("button", { name: "取消" })).toBeFocused();
            await snap("confirm", confirmClip);
            layout.confirm = await confirm.boundingBox();
            if (process.env.STYLES)
              console.log(
                side,
                theme,
                await confirm.evaluate((el) =>
                  [el, ...el.querySelectorAll("button")].map((item) => [
                    item.tagName,
                    item.getBoundingClientRect().toJSON(),
                    ...[
                      "font",
                      "borderRadius",
                      "backgroundColor",
                      "boxShadow",
                      "border",
                      "outline",
                      "position",
                      "zIndex",
                      "appearance",
                      "display",
                      "color",
                      "translate",
                      "transform",
                    ].map((key) => [key, getComputedStyle(item)[key]]),
                  ]),
                ),
              );
            await confirm.getByRole("button", { name: "取消" }).click();
            await expect(full).toBeVisible();
            results[`${side}-${theme}`] = layout;
            continue;
          }
          await snap("normal", { x: 200, y: 220, width: 800, height: 360 });
          layout.dialog = await dialog.boundingBox();
          layout.tile = await tile.boundingBox();
          await snap("tools", { x: 245, y: 328, width: 365, height: 186 }, tile);
          await dialog.getByRole("button", { name: "更多" }).click();
          const menu = page.getByRole("menu");
          await expect(menu.getByRole("menuitem", { name: "取消剩余" })).toBeDisabled();
          await snap("menu", { x: 675, y: 290, width: 257, height: 196 });
          layout.menu = await menu.boundingBox();
          if (process.env.STYLES)
            console.log(
              "menu",
              side,
              await menu.evaluate((el) =>
                [
                  el,
                  el.parentElement,
                  document.querySelector('[aria-label="更多"]'),
                  ...el.children,
                ].map((item) => [
                  item.className,
                  item.getBoundingClientRect().toJSON(),
                  getComputedStyle(item).position,
                  getComputedStyle(item).transform,
                ]),
              ),
            );
          await page.keyboard.press("Escape");
          await expect(menu).toHaveCount(0);
          if (process.env.STYLES)
            console.log(
              side,
              theme,
              JSON.stringify(
                await dialog.evaluate((el) =>
                  [
                    el,
                    ...el.querySelectorAll("button,h2,[data-history-tile],[data-history-tile]>div"),
                  ].map((e) => {
                    const s = getComputedStyle(e);
                    return [
                      e.tagName,
                      e.getAttribute("aria-label"),
                      s.color,
                      s.backgroundColor,
                      s.font,
                      s.borderRadius,
                      s.boxShadow,
                      s.backgroundImage,
                      e.getBoundingClientRect().toJSON(),
                    ];
                  }),
                ),
              ),
            );
          await dialog.getByRole("button", { name: "全屏查看" }).click();
          const full = page.getByRole("dialog", { name: "全屏查看", exact: true });
          await expect(full).toBeVisible();
          await snap("full", { x: 0, y: 0, width: 1200, height: 300 });
          layout.fullTile = await full
            .getByRole("button", { name: "第 2 版（当前主图）", exact: true })
            .boundingBox();
          if (process.env.STYLES)
            console.log(
              "full",
              side,
              JSON.stringify(
                await full
                  .getByRole("button", { name: "下载全部" })
                  .evaluate((button) => [
                    document.activeElement?.outerHTML.slice(0, 130),
                    ...[
                      "backgroundColor",
                      "boxShadow",
                      "borderRadius",
                      "outline",
                      "display",
                      "appearance",
                      "border",
                      "transitionProperty",
                      "opacity",
                    ].map((key) => [key, getComputedStyle(button)[key]]),
                  ]),
              ),
            );
          results[`${side}-${theme}`] = layout;
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  for (const theme of ["light", "dark"])
    for (const state of transitions
      ? ["normal-in", "full-in", "full-out", "normal-out"].flatMap((name) =>
          [60, 120, 180].map((ms) => `${name}-${ms}`),
        )
      : tasks
        ? ["task-0", "task-1", "task-2", "task-failed", "task-full"]
        : bulk
          ? [
              "nine",
              "normal-confirm",
              "confirm",
              ...(narrow ? ["scroll"] : []),
              ...(faults ? ["pending"] : []),
            ]
          : ["badge", "normal", "tools", "menu", "full"]) {
      const [original, desktop] = ["original", "desktop"].map((side) =>
        execFileSync(
          resolve("out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
          [
            "-v",
            "error",
            "-i",
            join(output, `${side}-${theme}-${state}.png`),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { maxBuffer: 8000000 },
        ),
      );
      assert.equal(original.length, desktop.length);
      let different = 0;
      for (let index = 0; index < original.length; index += 3)
        if (original.readUIntBE(index, 3) !== desktop.readUIntBE(index, 3)) different++;
      results[`${theme}-${state}`] = { different, total: original.length / 3 };
    }
  console.log(results);
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  if (process.argv.includes("--strict"))
    assert(Object.values(results).every((item) => !item.different));
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
