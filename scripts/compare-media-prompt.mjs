import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const temp = await mkdtemp(join(tmpdir(), "media-prompt-"));
const theme = process.env.PARITY_THEME ?? "light";
assert(["light", "dark"].includes(theme));
const output = resolve("test-results/media-prompt-parity", theme === "light" ? "." : theme);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const results = {};
const entry = "/src/__media_prompt_audit.tsx";
try {
  for (const name of ["upstream", "desktop"]) {
    const upstream = name === "upstream";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
    assert(css);
    const setup = upstream
      ? `import {NodePromptInput} from '/src/components/canvas/node-prompt-input';
      import {RefStrip} from '/src/components/canvas/ref-strip'; import {ReactFlowProvider} from '@xyflow/react';`
      : `import {GenerationForm} from '/src/renderer/workspace/generation';`;
    const component = upstream
      ? `<ReactFlowProvider><NodePromptInput width={680} value={value} onValueChange={change} models={models} modelLabel={models.length ? undefined : '暂无可用模型'} modelId={modelId} onModelChange={setModelId} canSubmit={false} mention={{linkedIds:new Set(),list:()=>({linked:[],canvas:[]}),link:noop}}><RefStrip items={[]} manual={[]} errors={[]} candidates={()=>[]} onLink={noop} onUnlink={noop} uploadKinds={[]} onUpload={noop} onRemoveManual={noop}/></NodePromptInput></ReactFlowProvider>`
      : `<GenerationForm inline node={node} graph={{nodes:[node],edges:[]}} settings={{providers:models.map(model=>({...model,model:model.label,enabled:true,pluginHash:'local',channel:{}})),plugins:[{hash:'local',kind:'audio',auth:'none'}]}} assets={[]} onPromptChange={change} onMentionLink={noop} onUploadReference={noop} close={noop} submit={noop}/>`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, name),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "media-prompt-audit",
          resolveId(id) {
            if (id === entry) return id;
          },
          load(id) {
            if (id === entry)
              return `import {createRoot} from 'react-dom/client'; import {useState} from 'react'; ${setup}
        const noop=()=>{};const offline=location.search==='?offline'; const models=location.search ? ['甲模型','乙模型'].map(label=>({id:label,label,credits:0})) : []; function Audit(){const [value,change]=useState('低沉男声');const [modelId,setModelId]=useState(offline?'missing':models[0]?.id??'');const node={id:'audio',type:'creative',data:{kind:'audio',label:'音频',text:value,...(offline&&{generation:{modelKey:'missing'}})}};return ${upstream ? component.replace("modelLabel={models.length", 'modelInvalid={offline} notice={offline ? {tone:"error",text:"这个模型已经下线，请换一个模型后再生成"} : null} modelLabel={offline ? "模型已下线" : models.length') : component};}createRoot(document.querySelector('article')).render(<Audit/>);`;
          },
        },
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: "reduce",
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
          body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "" : "canvas-workspace"}" style="position:fixed;inset:0;background:${theme === "light" ? "#fafafa" : "#171717"}"><article style="position:absolute;left:260px;top:240px;width:680px"></article></main><script type="module" src="${entry}"></script></html>`,
        }),
      );
      await page.goto(`${origin}audit`);
      for (const state of ["inline", "expanded"]) {
        if (state === "expanded")
          await page.getByRole("button", { name: "放大编辑提示词" }).click();
        const surface =
          state === "expanded"
            ? page.getByRole("dialog", { name: "编辑提示词" })
            : upstream
              ? page.locator("article > div").first()
              : page.getByRole("region", { name: "生成确认" });
        const editor = surface.getByRole("textbox");
        await expect(editor).toHaveText("低沉男声");
        await page.mouse.move(10, 10);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        const rects = {
          surface: await surface.boundingBox(),
          editor: await editor.boundingBox(),
          count: await surface.getByText("4/16000", { exact: true }).boundingBox(),
          add: await surface.getByRole("button", { name: "引用画布里的素材" }).boundingBox(),
          send: await surface.getByRole("button", { name: "开始生成", exact: true }).boundingBox(),
        };
        if (state === "inline")
          rects.expand = await surface
            .getByRole("button", { name: "放大编辑提示词" })
            .boundingBox();
        results[`${name}-${state}`] = rects;
        await surface.screenshot({ path: join(output, `${name}-${state}.png`), caret: "hide" });
        console.log(name, state, rects);
        const modelTrigger = surface.getByRole("button", { name: "选择模型" });
        await modelTrigger.press("Enter");
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
        await expect(menu.getByText("选择模型", { exact: true })).toBeVisible();
        await menu.screenshot({
          path: join(output, `${name}-${state}-menu.png`),
          animations: "disabled",
        });
        results[`${name}-${state}-menu`] = await menu.boundingBox();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(modelTrigger).toBeFocused();
        if (state === "expanded") {
          await editor.press("End");
          await editor.press("Enter");
          await page.keyboard.insertText("第二句");
          await expect(surface.getByText("8/16000", { exact: true })).toBeVisible();
          await editor.press("Escape");
          await expect(surface).toBeHidden();
          await expect(page.getByRole("textbox")).toContainText("第二句");
        }
      }
      await page.goto(`${origin}audit?models`);
      const trigger = page.getByRole("button", { name: "选择模型" });
      await expect(trigger).toContainText("甲模型");
      await trigger.press("Enter");
      const secondModel = page.getByRole("menuitemradio", { name: /乙模型/ });
      await secondModel.click();
      await expect(secondModel).toBeChecked();
      await expect(trigger).toContainText("乙模型");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await page.getByRole("button", { name: "放大编辑提示词" }).click();
      await expect(
        page.getByRole("dialog").getByRole("button", { name: "选择模型" }),
      ).toContainText("乙模型");
      await page.goto(`${origin}audit?offline`);
      await expect(trigger).toHaveText("模型已下线");
      const alert = page.getByRole("alert");
      await expect(alert).toHaveText("这个模型已经下线，请换一个模型后再生成");
      await page.evaluate(() => document.fonts.ready);
      results[`${name}-offline-notice`] = await alert.boundingBox();
      await alert.screenshot({ path: join(output, `${name}-offline-notice.png`) });
    } finally {
      await page.close();
      await server.close();
    }
  }
  const ffmpeg = resolve(
    "out/media",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  const states = ["inline", "expanded", "inline-menu", "expanded-menu", "offline-notice"];
  for (const state of states) {
    assert.deepEqual(results[`upstream-${state}`], results[`desktop-${state}`]);
    const [first, second] = ["upstream", "desktop"].map((name) =>
      execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          join(output, `${name}-${state}.png`),
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      ),
    );
    assert.equal(first.length, second.length);
    let differences = 0;
    for (let offset = 0; offset < first.length; offset += 3)
      if (first.readUIntBE(offset, 3) !== second.readUIntBE(offset, 3)) differences++;
    results[`${state}-different-pixels`] = differences;
    console.log(state, differences, "different pixels of", first.length / 3);
  }
  const evidence = await browser.newPage({
    viewport: { width: 728, height: 548 },
    deviceScaleFactor: 1,
  });
  try {
    const html = await Promise.all(
      ["upstream", "desktop"].map(
        async (name, index) =>
          `<section><strong>${index ? "Link Studio · 桌面" : "video-canvas · 原版"}</strong><img src="data:image/png;base64,${(await readFile(join(output, `${name}-inline.png`))).toString("base64")}"></section>`,
      ),
    );
    await evidence.setContent(
      `<style>body{background:#eceef0;margin:12px 24px;font:14px system-ui;color:#232326}img{display:block;margin:4px 0 12px}</style>${html.join("")}`,
    );
    await evidence.screenshot({ path: join(output, "comparison.png") });
  } finally {
    await evidence.close();
  }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  if (process.env.PARITY_EXACT === "1")
    assert(
      states.every((state) => results[`${state}-different-pixels`] === 0),
      `${theme} surfaces differ`,
    );
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
