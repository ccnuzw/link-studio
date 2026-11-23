import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const theme = process.argv.includes("--dark") ? "dark" : "light",
  dpr = process.argv.includes("--retina") ? 2 : 1;
const empty = process.argv.includes("--empty");
const generation = process.argv.includes("--generation");
const selected = generation && process.argv.includes("--selected");
const phases = ["queued", "running", "failed", "image", "video", "audio"];
const output = resolve(
    `test-results/canvas-${generation ? "generation" : empty ? "empty-media" : "upload"}-parity${selected ? "-selected" : ""}${theme === "dark" ? "-dark" : ""}${dpr === 2 ? "-retina" : ""}`,
  ),
  scratch = await mkdtemp(join(tmpdir(), "upload-parity-"));
const browser = await chromium.launch({ channel: "chrome", args: ["--disable-gpu"] }),
  images = {},
  states = {};
await mkdir(output, { recursive: true });
try {
  for (const side of ["original", "desktop"]) {
    const original = side === "original",
      root = original ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, original ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    const entry = "/src/__canvas_upload_compare.tsx";
    const code = generation
      ? `import {createRoot} from 'react-dom/client';
      ${original ? `import {NodeVideoBody} from '@/components/canvas/node-video-body';import {BaseNode} from '@/components/canvas/base-node';` : `import {MediaGenerationTask} from '/src/renderer/workspace/character-image-task';`}
      const phase=location.search.slice(1),kind=['image','video','audio'].includes(phase)?phase:'image',status=phase===kind?'downloading':phase;
      const id='df190699-40ae-429a-a70c-05dc50cfe269',message='服务暂时不可用',action=()=>{window.acted=true;};
      Date.now=()=>89000;
      createRoot(document.querySelector('#sample')).render(${original ? `<BaseNode style={{width:576}}><NodeVideoBody mediaType={kind} aspect={2} view={status==='failed'?{phase:'failed',message,taskRef:id,refunded:false}:status==='running'?{phase:'running',elapsedMs:89000,progress:37}:{phase:status==='downloading'?'finalizing':'queued'}} onRetry={action} onCancel={action}/></BaseNode>` : `<article className="creative-card" data-card-kind={kind} data-visual="true" data-image-frame="true" style={{width:576,height:288}}><div className="node-media canvas-upload-body" data-kind={kind}><MediaGenerationTask job={{id,status,kind,createdAt:new Date(0).toISOString(),progress:37,error:message,canCancelRemote:true}} action={action} disabled={false}/></div></article>`});`
      : empty
        ? `import {createRoot} from 'react-dom/client';
      ${original ? `import {NodeVideoBody} from '@/components/canvas/node-video-body';import {NodeFillActions} from '@/components/canvas-editor/node-fill-actions';import * as icons from '@/components/canvas/placeholder-icons';` : `import {MediaNodePlaceholder,MediaFillActions} from '/src/renderer/workspace/media-node-placeholder';`}
      const kind=location.search.slice(1).split('-')[0],label='选中后输入提示词生成'+({image:'图片',video:'视频',audio:'音频'})[kind];
      const upload=()=>window.clicked='upload',library=()=>window.clicked='library';
      ${original ? `const Icon=icons[{image:'ImagePlaceholderIcon',video:'VideoPlaceholderIcon',audio:'AudioPlaceholderIcon'}[kind]];` : ""}
      createRoot(document.querySelector('#sample')).render(${original ? `<NodeVideoBody mediaType={kind} aspect={2} view={{phase:'idle'}} placeholder={label} placeholderIcon={<Icon className="size-10"/>} placeholderActions={<NodeFillActions id="node" actions={{pickFile:upload,pickAsset:library}}/>}/>` : `<div className="node-media" data-kind={kind}><MediaNodePlaceholder kind={kind}/><MediaFillActions disabled={false} upload={upload} library={library}/></div>`});`
        : `import {createRoot} from 'react-dom/client';
      ${original ? `import {NodeVideoBody} from '@/components/canvas/node-video-body';` : `import {CanvasUploadContext,CanvasUploadBody} from '/src/renderer/workspace/canvas-upload';`}
      const state=location.search.slice(1),progress=Number(state),failure=isNaN(progress),retry=state==='retry'?()=>window.retried=true:undefined;
      createRoot(document.querySelector('#sample')).render(${original ? `<NodeVideoBody mediaType="image" aspect={2} view={failure?{phase:'failed',message:state==='interrupted'?'上传已中断，请删除后重新上传':'上传失败，请重试',refunded:false,taskRef:null}:{phase:'uploading',progress}} onRetry={retry}/>` : `<CanvasUploadContext.Provider value={()=>retry}><CanvasUploadBody id="test" progress={failure?undefined:progress} interrupted={state==='interrupted'}/></CanvasUploadContext.Provider>`});`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(scratch, side),
      resolve: { alias: { "@": join(root, "src") } },
      assetsInclude: ["**/*.glb"],
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "upload-audit",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? code : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0],
        page = await browser.newPage({
          viewport: { width: 700, height: 400 },
          deviceScaleFactor: dpr,
          colorScheme: theme,
        });
      await page.route(origin + "assets/**", (route) =>
        route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
      );
      const wrapper = generation
        ? `class="react-flow__node react-flow__node-creative${selected ? " selected" : ""}"`
        : original
          ? ""
          : 'class="creative-card" data-visual="true" data-image-frame="true"';
      await page.route(origin + "check*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><style>#sample{position:fixed;left:40px;top:30px;width:576px;height:288px;border-radius:8px;background:${theme === "dark" ? "oklch(.205 0 0)" : "white"}}*,*::before{animation-play-state:paused!important}</style><main class="${original ? "" : "canvas-workspace"}"><div id="sample" ${wrapper}></div></main><script type="module" src="${entry}"></script></html>`,
        }),
      );
      for (const phase of generation
        ? phases
        : empty
          ? ["image", "video", "audio"].flatMap((kind) =>
              ["idle", "hover", "focus"].map((state) => `${kind}-${state}`),
            )
          : ["0", "37", "100", "retry", "reopened", "interrupted"]) {
        await page.goto(origin + "check?" + phase);
        const panel = empty
          ? page.locator("#sample")
          : page.getByRole(
              (generation ? phase === "failed" : isNaN(Number(phase))) ? "alert" : "status",
            );
        await expect(empty ? panel.getByRole("img") : panel).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        if (empty) {
          await page.mouse.move(5, 5);
          if (phase.endsWith("hover")) await panel.getByRole("button").first().hover();
          if (phase.endsWith("focus")) await page.keyboard.press("Tab");
          await page.waitForTimeout(200);
        }
        const actual = await panel.innerText();
        states[phase] ??= [];
        states[phase].push(actual);
        await writeFile(
          join(output, `${side}-${phase}-layout.json`),
          JSON.stringify(
            await panel.evaluate((el) =>
              [el, ...el.querySelectorAll("svg,p,button,span")].map((item) => {
                const style = getComputedStyle(item);
                return {
                  tag: item.tagName,
                  rect: item.getBoundingClientRect().toJSON(),
                  font: style.font,
                  color: style.color,
                  shadow: style.boxShadow,
                  padding: style.padding,
                  gap: style.gap,
                  radius: style.borderRadius,
                  svg: item instanceof SVGElement ? item.innerHTML : undefined,
                };
              }),
            ),
            null,
            2,
          ),
        );
        const clip = generation
          ? { x: 48, y: 38, width: 560, height: 272 }
          : { x: 148, y: 100, width: 360, height: 148 };
        const image = await page.screenshot({ clip, path: join(output, `${side}-${phase}.png`) });
        assert(image.equals(await page.screenshot({ clip })), `${side}-${phase} unstable`);
        images[phase] ??= [];
        images[phase].push(image.toString("base64"));
        if (generation) {
          if (["failed", "queued", "running"].includes(phase)) {
            await panel.getByRole("button", { name: phase === "failed" ? "重试" : "取消" }).click();
            assert(await page.evaluate(() => window.acted));
          } else await expect(panel.getByRole("button")).toHaveCount(0);
        } else if (empty) {
          for (const [index, action] of ["upload", "library"].entries()) {
            await panel.getByRole("button").nth(index).click();
            assert.equal(await page.evaluate(() => window.clicked), action);
          }
        } else if (phase === "retry") {
          await panel.getByRole("button", { name: "重试" }).click();
          assert(await page.evaluate(() => window.retried));
        } else await expect(panel.getByRole("button")).toHaveCount(0);
      }
      await page.close();
    } finally {
      await server.close();
    }
  }
  const page = await browser.newPage(),
    differences = {};
  for (const [key, pair] of Object.entries(images)) {
    assert.deepEqual(states[key][0], states[key][1]);
    differences[key] = await page.evaluate(async (pair) => {
      const [left, right] = await Promise.all(
        pair.map(async (source) => {
          const image = new Image();
          image.src = "data:image/png;base64," + source;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          return new Uint32Array(ctx.getImageData(0, 0, image.width, image.height).data.buffer);
        }),
      );
      return left.reduce((sum, pixel, index) => sum + Number(pixel !== right[index]), 0);
    }, pair);
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ states, differences }, null, 2));
  console.table(differences);
  if (process.argv.includes("--strict"))
    assert(Object.values(differences).every((count) => count === 0));
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
