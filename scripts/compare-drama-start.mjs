import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const workspace = process.cwd();
const reference = path.resolve(process.env.AGENT_REFERENCE_WEB ?? "../video-canvas/web");
const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const temp = await mkdtemp(path.join(tmpdir(), "link-start-dialog-"));
const novel = process.argv.includes("--novel");
const series = process.argv.includes("--series");
const count = series ? 1001 : 2;
const output = path.join(
  workspace,
  "test-results",
  series ? "drama-series-start-parity" : novel ? "drama-novel-start-parity" : "drama-start-parity",
);
const script = novel
  ? Array.from(
      { length: 14 },
      (_, index) => `第${index + 1}章 夜雨\n第${index + 1}封信到了。`,
    ).join("\n")
  : series
    ? Array.from({ length: count }, (_, index) => `第${index + 1}集 夜归\n灯火${index + 1}。`).join(
        "\n",
      )
    : "第一集 来客\n门外响起敲门声。\n第二集 纸条\n纸条贴在门口。";
const signals = novel
  ? "找到 0 个分集标记、14 个章节标题、0 个场次头；对白行占 0%"
  : `找到 ${count} 个分集标记、0 个章节标题、0 个场次头；对白行占 0%`;
const pre = {
  sourceToken: "fixture",
  filename: "source.txt",
  chars: [...script].length,
  unitsTotal: novel ? 14 : count,
  units: [],
  kindGuess: novel ? "novel" : "script",
  kindSignals: signals,
  unitKind: novel ? "chapter" : "episode",
  issues: [],
  estimate: {
    episodesMin: novel ? 1 : count,
    episodesMax: novel ? 1 : count,
    episodesExact: !novel,
    credits: 0,
    minutes: novel ? 3 : 0,
  },
};
const model = {
  key: "fixture",
  kind: "agent",
  label: "研读模型",
  pricing: {},
  capabilities: { context: { window: 32768, output: 2048 } },
};
const providerId = "79547ae6-e369-47ad-af04-b6b934e5f984";
const ratios = ["1:1", "16:9", "9:16", "3:2"],
  resolutions = ["1K", "2K", "4K"];
const image = {
  key: providerId,
  kind: "image",
  label: "物品图像",
  pricing: {},
  capabilities: {
    params: {
      aspect_ratio: {
        type: "enum",
        label: "构图比例",
        options: ratios,
        default: "16:9",
        open: true,
      },
      resolution: {
        type: "enum",
        label: "出图精度",
        unit: "档",
        options: resolutions,
        default: "1K",
        open: true,
      },
    },
  },
};
const plugin = {
  hash: "fixture-image",
  key: "doubao-image",
  origin: "builtin",
  kind: "image",
  auth: "none",
};
const provider = {
  id: providerId,
  label: image.label,
  model: "doubao-seedream-4-0",
  pluginHash: plugin.hash,
  enabled: true,
  hasSecret: true,
  channel: {},
  config: {
    name: image.label,
    kind: "image",
    sort: 0,
    description: "",
    params: {
      aspectRatio: { label: "构图比例", values: ratios, default: "16:9", open: true },
      resolution: { label: "出图精度", unit: "档", values: resolutions, default: "1K", open: true },
    },
  },
};
const styles = JSON.parse(
  execFileSync(
    "git",
    ["-C", path.dirname(reference), "show", `${revision}:backend/internal/drama/styles.json`],
    { encoding: "utf8" },
  ),
);
const assetBody = execFileSync(
  "git",
  [
    "-C",
    path.dirname(reference),
    "show",
    `${revision}:backend/internal/drama/prompts/breakdown_draft.md`,
  ],
  { encoding: "utf8" },
)
  .split("## 提示词正文\n")[1]
  .split("\n## ")[0]
  .trim();
const sampleData = { script, pre, model, styles, assetBody };
const paperSkill = { name: "paper-grain", title: "纸张质感", description: "资产图的纸面纹理" };
const mocks = {
  "@/hooks/use-drama-styles": `export const useDramaStyles=()=>({ready:true,...window.fixture.styles});`,
  "@/components/drama/prompts/use-prompt-library": `const steps=Object.fromEntries(['plan','scripts','assets','asset_prompts','video','board'].map(step=>[step,[]]));export const usePromptLibrary=()=>({ready:true,templates:[{step:'assets',pages:[{key:'breakdown',label:'资产拆解',body:window.fixture.assetBody}]}],mine:steps,skills:{...steps,asset_prompts:window.fixture.skills}});`,
  "@/hooks/use-models": `export const toModelOption=model=>({label:model.label,value:model.key});export const useRemoteModels=kind=>({status:'ready',models:kind==='agent'?[window.fixture.model]:kind==='image'?window.fixture.images:[],options:[]});`,
};
if (novel)
  mocks["@/api/drama"] =
    `export const estimateSource=(_,input)=>window.estimateRange(input.rangeEnd);`;
const captures = new Map();
const report = {
  revision,
  scope: `${novel ? "同稿十四章" : `同稿 ${count} 集`}、默认画幅、相同视口及固定背景；开拍弹窗（非整个应用）`,
  states: {},
};
const browser = await chromium.launch({ channel: "chrome" });
async function settledImage(page, file) {
  let prior;
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const image = await page.screenshot({ animations: "disabled", caret: "hide" });
    if (prior?.equals(image)) {
      await writeFile(file, image);
      return image;
    }
    prior = image;
  }
  throw Error(`画面未稳定：${file}`);
}
try {
  await mkdir(output, { recursive: true });
  const archive = path.join(temp, "reference.tar");
  execFileSync("git", ["-C", path.dirname(reference), "archive", "-o", archive, revision, "web"]);
  execFileSync("tar", ["-xf", archive, "-C", temp]);
  const pinned = path.join(temp, "web");
  await symlink(path.join(reference, "node_modules"), path.join(pinned, "node_modules"), "dir");
  execFileSync(path.join(pinned, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: pinned,
  });
  for (const upstream of [true, false]) {
    const side = upstream ? "reference" : "desktop",
      root = upstream ? pinned : workspace;
    const inline = upstream
      ? `import {useState} from 'react';import {StartDialog} from './src/pages/drama/start-dialog';function ReferenceStart(){const [open,setOpen]=useState(false);return <><button hidden={open} onClick={()=>setOpen(true)}>开始</button><StartDialog open={open} pre={pre} onOpenChange={setOpen} onSubmit={async()=>{}}/></>}const component=<ReferenceStart/>;`
      : `import {DramaStudio} from './src/renderer/workspace/drama-studio';
      window.desktop={skills:{list:async()=>({ok:true,value:window.fixture.skills??[]})},settings:{dramaPromptLibrary:async()=>({ok:true,value:{entries:[]}})},projects:{drama:async()=>({ok:true,value:null}),previewDramaSource:async()=>({ok:true,value:{sourceToken:pre.sourceToken,kindGuess:pre.kindGuess,kindSignals:pre.kindSignals,issues:[],chars:pre.chars,kind:pre.unitKind,units:pre.unitsTotal,credits:0,...(pre.kindGuess==='novel'?{planning:{rangeEnd:14,episodeMin:1,episodeMax:1,batches:2,minutes:pre.estimate.minutes}}:{exactEpisodes:pre.estimate.episodesMin})}})}};
      const component=<DramaStudio projectHandle="fixture" projectId="fixture" withAssistant={false} close={()=>{}} providers={[{id:'fixture',label:model.label,enabled:true,hasSecret:true,agentEnabled:true},...window.fixture.providers]} plugins={window.fixture.plugins}/>;`;
    const entry = path.join(root, "start-dialog-fixture.jsx"),
      bundle = path.join(temp, side);
    const aliases = upstream
      ? Object.keys(mocks).map((key) => ({
          find: new RegExp("^" + key + "$"),
          replacement: `\0fixture:${key}`,
        }))
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
          name: "start-dialog-fixture",
          resolveId(id) {
            if (id === entry || id.startsWith("\0fixture:")) return id;
          },
          load(id) {
            if (id.startsWith("\0fixture:")) return mocks[id.slice(9)];
            if (id === entry)
              return `import {createRoot} from 'react-dom/client';const {pre,model}=window.fixture;${inline}createRoot(document.querySelector('#root')).render(component);`;
          },
        },
      ],
      build: { outDir: bundle, lib: { entry, formats: ["es"], fileName: () => "fixture.js" } },
    });
    const assets = upstream
      ? path.join(root, "dist/assets")
      : path.resolve(process.env.DRAMA_DESKTOP_ASSETS ?? path.join(root, "out/renderer/assets"));
    const css = (await readdir(assets)).filter((file) => /^index-.*\.css$/.test(file));
    if (css.length !== 1) throw Error(`找不到 ${side} 的生产样式`);
    for (const theme of ["light", "dark"])
      for (const width of [1024, 390])
        for (const media of novel || series ? [false] : [false, true]) {
          const height = width === 390 ? 844 : 768,
            key = `${theme}-${width}`;
          const page = await browser.newPage({
            viewport: { width, height },
            colorScheme: theme,
            reducedMotion: "reduce",
            deviceScaleFactor: 1,
          });
          try {
            page.on("pageerror", (error) => console.error(side, error));
            if (novel)
              await page.addInitScript(() => {
                window.requests = [];
                window.estimateRange = (end) => {
                  window.requests.push(end);
                  return new Promise((resolve) => {
                    window.finishQuote = (credits) =>
                      resolve({ episodesMin: 1, episodesMax: 1, minutes: 2, credits });
                  });
                };
              });
            await page.route("http://start.test/**", (route) => {
              const name = new URL(route.request().url()).pathname.slice(1);
              if (name === "fixture.js")
                return route.fulfill({
                  path: path.join(bundle, name),
                  contentType: "text/javascript",
                });
              if (name === "index.css")
                return route.fulfill({ path: path.join(assets, css[0]), contentType: "text/css" });
              if (name.endsWith(".woff2"))
                return route.fulfill({
                  path: path.join(assets, path.basename(name)),
                  contentType: "font/woff2",
                });
              if (upstream && /^drama-styles\/\w+\.webp$/.test(name))
                return route.fulfill({
                  path: path.join(root, "public", name),
                  contentType: "image/webp",
                });
              if (name) return route.abort();
              const skills = media
                ? [
                    {
                      ...paperSkill,
                      origin: "local",
                      enabled: false,
                      activeVersion: 1,
                      scopes: ["asset_prompts"],
                      versions: [{ version: 1, description: paperSkill.description }],
                    },
                  ]
                : [];
              const fixture = {
                ...sampleData,
                skills,
                images: media ? [image] : [],
                providers: media ? [provider] : [],
                plugins: media ? [plugin] : [],
              };
              return route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html class="${theme}"><meta charset=utf-8><link rel=stylesheet href=/index.css><style>body{margin:0;background:${theme === "dark" ? "#242424" : "#fafafa"}}body.measuring :is(.drama-studio,.drama-source){background:transparent}body.measuring :is(.drama-studio>header,.drama-source>fieldset){visibility:hidden}</style><div id=root></div><script>window.fixture=${JSON.stringify(fixture)}</script><script type=module src=/fixture.js></script></html>`,
              });
            });
            await page.goto("http://start.test/");
            if (!upstream) {
              await page.getByRole("button", { name: "粘贴正文" }).click();
              await page.getByLabel("粘贴正文").fill(script);
            }
            await page.getByRole("button", { name: "开始", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "开拍设置" });
            const countText = `剧本一次切完 · ${count.toLocaleString("en-US")} 集`;
            await dialog
              .getByText(novel ? /预计约 1 集/ : countText)
              .first()
              .waitFor({ timeout: 8000 });
            if (novel && !upstream)
              await page.evaluate(() => {
                const projects = window.desktop.projects,
                  preview = projects.previewDramaSource;
                projects.previewDramaSource = async (input) => {
                  const estimate = await window.estimateRange(input.rangeEnd);
                  const result = await preview(input);
                  result.value.credits = estimate.credits;
                  result.value.planning.minutes = estimate.minutes;
                  return result;
                };
              });
            await page.evaluate(async () => {
              document.body.classList.add("measuring");
              await document.fonts.ready;
              await Promise.all(
                document
                  .getAnimations()
                  .filter((anim) => anim.effect.getTiming().iterations !== Infinity)
                  .map((anim) => anim.finished.catch(() => {})),
              );
            });
            const keyButton = dialog.getByRole("button", { name: "9:16" });
            if ((await keyButton.getAttribute("aria-pressed")) !== "true")
              throw Error("默认画幅不一致");
            const scroll = upstream
              ? dialog.locator('[class*="overflow-y-auto"]').first()
              : dialog.locator("form");
            const styleTrigger = dialog.getByRole("button", {
              name: upstream ? "真人都市电影" : "画风",
              exact: true,
            });
            const gallery = page.locator(
              upstream ? '[data-slot="popover-content"]' : '.drama-field-menu[data-kind="style"]',
            );
            for (const position of series
              ? ["top"]
              : novel
                ? [
                    "top",
                    "source-menu",
                    "range-menu",
                    "quote-loading",
                    "quote-ready",
                    "quote-reset",
                  ]
                : media
                  ? [
                      "params-default",
                      "params",
                      "params-reopened",
                      "params-keyboard",
                      "prompt-menu",
                      "prompt-editor",
                      "skill-menu",
                      "skill-selected",
                    ]
                  : ["top", "bottom", "gallery", "custom"]) {
              const name = position === "top" ? key : `${key}-${position}`;
              if (position === "source-menu")
                await dialog
                  .getByRole("button", { name: upstream ? "小说" : "原文类型", exact: true })
                  .click();
              if (position === "range-menu") {
                await page.keyboard.press("Escape");
                await dialog
                  .getByRole("button", { name: upstream ? "全部" : "规划范围", exact: true })
                  .click();
                await page.getByRole("spinbutton", { name: "规划到第几章" }).waitFor();
              }
              if (position === "quote-loading") {
                const input = page.getByRole("spinbutton", { name: "规划到第几章" });
                await input.fill("8");
                await input.press("Enter");
                await page.waitForFunction(() => window.requests.length > 0);
                assert.deepEqual(await page.evaluate(() => window.requests), [8]);
                await dialog.getByText("研读与规划约 0 积分").waitFor();
                assert.ok(
                  await dialog.getByRole("button", { name: "开始", exact: true }).isEnabled(),
                );
              }
              if (position === "quote-ready") {
                await page.evaluate(() => window.finishQuote(7));
                await dialog.getByText("研读与规划约 7 积分").waitFor();
              }
              if (position === "quote-reset") {
                await dialog
                  .getByRole("button", {
                    name: upstream ? "规划到第 8 章" : "规划范围",
                    exact: true,
                  })
                  .click();
                await page.getByRole("button", { name: "全部（14 章）" }).click();
                await dialog.getByText("研读与规划约 0 积分").waitFor();
                await page.waitForTimeout(350);
                assert.deepEqual(await page.evaluate(() => window.requests), [8]);
              }
              if (position === "top" || position === "bottom")
                await scroll.evaluate((element, end) => {
                  element.scrollTop = end ? element.scrollHeight : 0;
                }, position === "bottom");
              if (position === "gallery") {
                await scroll.evaluate((element) => {
                  element.scrollTop = 0;
                });
                await styleTrigger.click();
                await gallery.waitFor();
                await gallery.locator("img").evaluateAll(async (images) => {
                  if (images.length !== 11) throw Error("预览图数量错误");
                  await Promise.all(images.map((image) => image.decode()));
                });
              }
              if (position === "custom") {
                await gallery.getByRole("button", { name: "自定义", exact: true }).click();
                await gallery.getByRole("textbox").fill("潮湿街巷，暖色窗光");
              }
              const parameterPanel = page.locator(
                upstream
                  ? '[data-slot="popover-content"]'
                  : '.drama-field-menu[data-kind="params"]',
              );
              if (series) {
                await dialog.getByText(/字 · 1,001 集$/).waitFor();
                assert.ok(
                  await dialog
                    .getByRole("button")
                    .filter({ hasText: "按原分集 · 1001 集" })
                    .isDisabled(),
                );
              }
              if (position.startsWith("params")) {
                const trigger = upstream
                  ? dialog.getByRole("button", { name: "图片参数", exact: true }).nth(2)
                  : dialog.getByRole("button", { name: "物品图片参数" });
                if (position === "params-default") {
                  await trigger.evaluate((element) => element.scrollIntoView({ block: "center" }));
                  await trigger.click();
                }
                if (position === "params")
                  for (const value of ["1:1", "4K档"])
                    await parameterPanel.getByRole("radio", { name: value, exact: true }).click();
                if (position === "params-reopened" || position === "params-keyboard") {
                  await page.keyboard.press("Escape");
                  await parameterPanel.waitFor({ state: "hidden" });
                  await page.waitForFunction(
                    (element) => document.activeElement === element,
                    await trigger.elementHandle(),
                  );
                  if (position === "params-reopened") await trigger.click();
                  else {
                    await trigger.press("Enter");
                    const first = parameterPanel.getByRole("radio", { name: "1:1", exact: true });
                    await page.waitForFunction(
                      (element) => document.activeElement === element,
                      await first.elementHandle(),
                    );
                    await page.keyboard.press("Tab");
                    await page.keyboard.press("Space");
                  }
                }
                const [ratio, resolution] =
                  position === "params-default"
                    ? ["16:9", "1K"]
                    : position === "params-keyboard"
                      ? ["16:9", "4K"]
                      : ["1:1", "4K"];
                assert.equal(await trigger.innerText(), `${ratio} · ${resolution}`);
                for (const [label, value] of [
                  ["构图比例", ratio],
                  ["出图精度", `${resolution}档`],
                ])
                  assert.equal(
                    await parameterPanel
                      .getByRole("radiogroup", { name: label })
                      .getByRole("radio", { checked: true })
                      .innerText(),
                    value,
                  );
              }
              if (position === "prompt-menu") {
                await page.keyboard.press("Escape");
                await scroll.evaluate((element) => {
                  element.scrollTop = element.scrollHeight;
                });
                const trigger = upstream
                  ? dialog
                      .locator('[data-slot="prompt-rows"] > div')
                      .filter({ hasText: "资产拆解" })
                      .getByRole("button")
                  : dialog.getByRole("button", { name: "资产拆解", exact: true });
                await trigger.click();
                await page.getByRole("button", { name: "新建", exact: true }).waitFor();
              }
              if (position === "prompt-editor") {
                await page.getByRole("button", { name: "新建", exact: true }).click();
                await dialog.getByRole("textbox", { name: "名称", exact: true }).fill("蜡印拆解");
                const body = dialog.getByRole("textbox", { name: "提示词正文" });
                if ((await body.inputValue()).trim() !== assetBody.trim())
                  throw Error(`内置正文不一致：${side}`);
                await body.fill("只拆解原文中出现的蜡印与信封。");
                await body.evaluate((el) => el.blur());
              }
              if (position === "skill-menu" || position === "skill-selected") {
                const trigger = upstream
                  ? dialog
                      .locator('[data-slot="prompt-rows"] > div')
                      .filter({ hasText: "资产图提示词" })
                      .getByRole("button")
                  : dialog.getByRole("button", { name: "资产图提示词", exact: true });
                if (position === "skill-menu") {
                  await dialog.getByRole("button", { name: "返回", exact: true }).click();
                  await scroll.evaluate((element) => {
                    element.scrollTop = element.scrollHeight;
                  });
                  await trigger.click();
                  await page.getByRole("button", { name: /纸张质感.*资产图的纸面纹理/ }).waitFor();
                } else {
                  await page.getByRole("button", { name: /纸张质感.*资产图的纸面纹理/ }).click();
                  if ((await trigger.innerText()).trim() !== "技能 · 纸张质感")
                    throw Error(`技能选值不一致：${side}`);
                }
              }
              await page.evaluate(() =>
                Promise.all(
                  document
                    .getAnimations()
                    .filter((anim) => anim.effect.getTiming().iterations !== Infinity)
                    .map((anim) => anim.finished.catch(() => {})),
                ),
              );
              const scrollTop = await scroll.evaluate((element) => element.scrollTop);
              const image = await settledImage(page, path.join(output, `${side}-${name}.png`));
              const state = (report.states[name] ??= {});
              state[side] = {
                box: await dialog.boundingBox(),
                ratio: position === "prompt-editor" ? null : await keyButton.boundingBox(),
                scrollTop,
                ...(position === "params"
                  ? { parameterPanel: await parameterPanel.boundingBox() }
                  : position === "prompt-menu"
                    ? {
                        promptMenu: await page
                          .getByRole("button", { name: "新建", exact: true })
                          .boundingBox(),
                      }
                    : position === "gallery" || position === "custom"
                      ? {
                          gallery: await gallery.boundingBox(),
                          firstPoster: await gallery.locator("img").first().boundingBox(),
                        }
                      : {}),
              };
              if (position.startsWith("params")) {
                state[side].parameterPanel = await parameterPanel.boundingBox();
                state[side].controls = await parameterPanel
                  .getByRole("radio")
                  .evaluateAll((buttons) =>
                    buttons.map((button) => {
                      const css = getComputedStyle(button);
                      return {
                        value: button.textContent,
                        checked: button.getAttribute("aria-checked"),
                        rect: button.getBoundingClientRect().toJSON(),
                        font: css.font,
                        color: css.color,
                        border: css.border,
                        background: css.backgroundColor,
                        shadow: css.boxShadow,
                        outline: css.outline,
                        focusVisible: button.matches(":focus-visible"),
                      };
                    }),
                  );
              }
              if (novel) {
                state[side].scroller = await scroll.evaluate((element) => ({
                  left: element.scrollLeft,
                  width: element.clientWidth,
                  contentWidth: element.scrollWidth,
                  rows: [...element.children].map((child) => ({
                    label: child.textContent.slice(0, 12),
                    x: child.getBoundingClientRect().x,
                    y: child.getBoundingClientRect().y,
                    width: child.getBoundingClientRect().width,
                    height: child.getBoundingClientRect().height,
                  })),
                }));
                state[side].sourceTrigger = await dialog
                  .getByRole("button", { name: upstream ? "小说" : "原文类型", exact: true })
                  .boundingBox();
              }
              if (position === "prompt-editor")
                state[side].editor = await dialog.getByRole("textbox").evaluateAll((elements) =>
                  elements.map((element) => {
                    const css = getComputedStyle(element);
                    return {
                      field: element.getAttribute("aria-label"),
                      rect: element.getBoundingClientRect().toJSON(),
                      background: css.backgroundColor,
                      font: css.font,
                    };
                  }),
                );
              if (series)
                state[side].episodeCount = await dialog
                  .getByText(countText, { exact: true })
                  .boundingBox();
              if (["prompt-menu", "skill-menu", "source-menu", "range-menu"].includes(position)) {
                const kind =
                  position === "source-menu"
                    ? "source"
                    : position === "range-menu"
                      ? "range"
                      : "prompt";
                const menu = page.locator(
                  upstream
                    ? '[data-slot="popover-content"]'
                    : `.drama-field-menu[data-kind="${kind}"]`,
                );
                state[side].popup = await menu.boundingBox();
                state[side].focus = await menu.evaluate((element) => ({
                  row: [...element.querySelectorAll("button")].indexOf(document.activeElement),
                  visible: document.activeElement?.matches(":focus-visible"),
                  target: document.activeElement?.tagName,
                }));
                state[side].choices = await menu.getByRole("button").evaluateAll((buttons) =>
                  buttons.map((button) => ({
                    label: button.textContent,
                    rect: button.getBoundingClientRect().toJSON(),
                    font: getComputedStyle(button).font,
                  })),
                );
              }
              if (state[side].gallery)
                state[side].paint = await gallery.evaluate((element) => {
                  const style = getComputedStyle(element),
                    anchor = getComputedStyle(element.parentElement);
                  return {
                    transform: style.transform,
                    position: anchor.position,
                    anchorTransform: anchor.transform,
                    opacity: style.opacity,
                    overflow: style.overflow,
                    background: style.backgroundColor,
                    radius: style.borderRadius,
                    focus: document.activeElement?.tagName,
                  };
                });
              if (upstream) captures.set(name, image);
              else
                Object.assign(
                  state,
                  await page.evaluate(
                    async ({ pair, region, poster, popup }) => {
                      const pixels = await Promise.all(
                        pair.map(async (data) => {
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
                      const within = (box, x, y) =>
                        box &&
                        x >= Math.ceil(box.x) &&
                        y >= Math.ceil(box.y) &&
                        x < Math.floor(box.x + box.width) &&
                        y < Math.floor(box.y + box.height);
                      let differentPixels = 0,
                        galleryPixels = 0,
                        posterPixels = 0,
                        popupPixels = 0;
                      for (let index = 0; index < pixels[0].length; index++)
                        if (pixels[0][index] !== pixels[1][index]) {
                          differentPixels++;
                          const x = index % innerWidth,
                            y = Math.floor(index / innerWidth);
                          if (within(region, x, y)) galleryPixels++;
                          if (within(poster, x, y)) posterPixels++;
                          if (within(popup, x, y)) popupPixels++;
                        }
                      return {
                        differentPixels,
                        ...(region
                          ? {
                              visibleGalleryDifferences: galleryPixels,
                              firstPosterDifferences: posterPixels,
                            }
                          : {}),
                        ...(popup && { visiblePopupDifferences: popupPixels }),
                      };
                    },
                    {
                      pair: [captures.get(name), image].map((buffer) => buffer.toString("base64")),
                      region: state.reference.gallery,
                      poster: state.reference.firstPoster,
                      popup:
                        state.reference.popup ??
                        state.reference.parameterPanel ??
                        state.reference.episodeCount,
                    },
                  ),
                );
              if (
                !upstream &&
                [
                  "light-1024",
                  "light-1024-gallery",
                  "light-1024-prompt-editor",
                  "light-1024-bottom",
                  "light-1024-skill-menu",
                  "light-390-range-menu",
                  "dark-390-params",
                ].includes(name)
              ) {
                const narrow = width === 390;
                const comparison = await browser.newPage({
                  viewport: narrow ? { width: 780, height: 876 } : { width: 1024, height: 416 },
                });
                try {
                  await comparison.setContent(
                    "<style>*{box-sizing:border-box}body{margin:0;display:flex;font:14px/32px sans-serif;background:#fff}figure{margin:0;width:50%;text-align:center}img{display:block;width:100%}</style>" +
                      [captures.get(name), image]
                        .map(
                          (buffer, index) =>
                            `<figure><figcaption>${index ? "小灵 · link-studio" : "小镜 · 4277d16f"}</figcaption><img src="data:image/png;base64,${buffer.toString("base64")}"></figure>`,
                        )
                        .join(""),
                  );
                  await comparison.evaluate(() =>
                    Promise.all(Array.from(document.images, (image) => image.decode())),
                  );
                  await comparison.screenshot({
                    path: path.join(
                      output,
                      position === "top"
                        ? "comparison.png"
                        : `comparison-${narrow ? "narrow-" : ""}${position}.png`,
                    ),
                  });
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
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  if (series)
    for (const [name, state] of Object.entries(report.states))
      assert.deepEqual(
        state.desktop.episodeCount,
        state.reference.episodeCount,
        `${name}: 集数标签位置`,
      );
  console.table(
    Object.entries(report.states).map(([state, { differentPixels, visiblePopupDifferences }]) => ({
      state,
      differentPixels,
      visiblePopupDifferences,
    })),
  );
  for (const [name, { reference, desktop }] of Object.entries(report.states).filter(
    ([, state]) => state.reference.parameterPanel,
  )) {
    assert.deepEqual(desktop.parameterPanel, reference.parameterPanel, `${name}: 图片参数面板`);
    const selection = (side) =>
      side.controls.map(({ value, checked, rect, focusVisible }) => ({
        value,
        checked,
        rect,
        focusVisible,
      }));
    assert.deepEqual(selection(desktop), selection(reference), `${name}: 选项、位置与焦点`);
  }
  if (novel)
    for (const [name, { reference, desktop }] of Object.entries(report.states)) {
      for (const key of ["box", "ratio", "sourceTrigger", "popup", "scrollTop"])
        assert.deepEqual(desktop[key], reference[key], `${name}: ${key}`);
      for (const key of ["left", "width", "contentWidth"])
        assert.equal(desktop.scroller[key], reference.scroller[key], `${name}: scroller.${key}`);
    }
  if (Object.values(report.states).some((state) => state.differentPixels)) process.exitCode = 1;
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
