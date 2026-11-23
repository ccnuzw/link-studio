import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const root = resolve(process.env.VIDEO_CANVAS_WEB);
const temp = await mkdtemp(join(tmpdir(), "video-mode-tabs-"));
const output = resolve("test-results/video-mode-parity");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const entry = "/src/__op_audit.tsx";
const results = {};
const servers = [];
const states = ["empty", "linked", "switched", "hover", "focus", "busy"];
try {
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream";
    const project = upstream ? root : process.cwd();
    const assets = join(project, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    const setup = upstream
      ? `import {OpTabs} from '@/components/canvas/op-tabs';import {opDisabledHint,OP_LABEL} from '@/utils/tasks/capabilities';`
      : `import {VideoModeTabs} from '/src/renderer/workspace/video-mode-tabs';`;
    const view = upstream
      ? `<OpTabs id="video" value={value} onValueChange={set} disabled={location.hash==='#busy'} options={ops.map(op=>({value:op,label:OP_LABEL[op],disabledHint:opDisabledHint({ops,refs:{image:{on:true},audio:{on:true}}},op,hasRefs)}))}/>`
      : `<VideoModeTabs id="video" value={value} choose={set} options={{modes:ops,references:{image:1,audio:1}}} hasRefs={hasRefs} disabled={location.hash==='#busy'}/>`;
    const server = await createServer({
      root: project,
      configFile: false,
      cacheDir: join(temp, side),
      resolve: { alias: { "@": join(project, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { port: 0, host: "127.0.0.1", hmr: false },
      plugins: [
        {
          name: "mode-audit",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) =>
            id === entry
              ? `${setup} import {useState} from 'react';import {createRoot} from 'react-dom/client';function Audit(){const ops=['t2v','i2v','omni'];const hasRefs=location.search==='?refs';const [value,set]=useState(hasRefs?'i2v':'t2v');return ${view};}createRoot(document.querySelector('article')).render(<Audit/>);`
              : undefined,
        },
      ],
    });
    servers.push(server);
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
        deviceScaleFactor: 1,
        colorScheme: theme,
      });
      try {
        await page.route(`${origin}assets/**`, (route) =>
          route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
        );
        await page.route(`${origin}audit*`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main class="${upstream ? "" : "canvas-workspace"}"><article class="${upstream ? "bg-panel" : "canvas-surface media-generation"}" style="position:absolute;left:200px;top:100px;padding:16px;width:600px;display:flex"></article></main><script type="module" src="${entry}"></script></html>`,
          }),
        );
        for (const state of states) {
          if (state !== "switched")
            await page.goto(
              `${origin}audit-${state}${state === "empty" ? "" : "?refs"}${state === "busy" ? "#busy" : ""}`,
            );
          const list = page.getByRole("tablist", { name: "生成方式" });
          const active = list.getByRole("tab", {
            name: state === "empty" ? "文生视频" : state === "switched" ? "全能参考" : "图生视频",
          });
          const disabled = list.getByRole("tab", {
            name: state === "empty" ? "全能参考" : "文生视频",
          });
          if (state === "switched") await active.click();
          if (state === "busy") await expect(list.locator("button:disabled")).toHaveCount(3);
          else await disabled.press("Enter");
          await expect(disabled).toHaveAttribute(
            "title",
            state === "empty" ? "需要连接图片/音频节点" : "已有参考素材，文生视频不可用",
          );
          await expect(active).toHaveAttribute("aria-selected", "true");
          await disabled.blur();
          await page.mouse.move(0, 0);
          if (state === "hover") await list.getByRole("tab", { name: "全能参考" }).hover();
          if (state === "focus") {
            await page.keyboard.press("Tab");
            await expect(active).toBeFocused();
          }
          await list.evaluate(async (el) => {
            await Promise.all(
              el
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished.catch(() => {})),
            );
          });
          await page.evaluate(() => document.fonts.ready);
          if (state === "switched")
            await expect
              .poll(() =>
                active
                  .locator("span")
                  .first()
                  .evaluate((el) => getComputedStyle(el).transform),
              )
              .toMatch(/^(?:none|matrix\(1, 0, 0, 1, 0, 0\))$/);
          const boxes = await Promise.all(
            [list, ...(await list.getByRole("tab").all())].map((el) => el.boundingBox()),
          );
          if (state === "empty" && process.env.PARITY_STYLES)
            console.log(
              side,
              theme,
              await list.evaluate((el) =>
                [
                  el.parentElement,
                  el,
                  el.firstChild,
                  el.firstChild.firstChild,
                  el.firstChild.lastChild,
                ].map((node) => {
                  const css = getComputedStyle(node);
                  return [
                    css.color,
                    css.backgroundColor,
                    css.font,
                    css.lineHeight,
                    css.boxShadow,
                    css.position,
                    css.display,
                    css.transform,
                  ];
                }),
              ),
            );
          results[`${side}-${theme}-${state}`] = boxes;
          await list.screenshot({ path: join(output, `${side}-${theme}-${state}.png`) });
        }
      } finally {
        await page.close();
      }
    }
  }
  const [upstream, desktop] = servers;
  const {
    opToAcceptSource,
    opDisabledHint,
    acceptsSourceKind,
    currentOp,
    PORTS_OF_KIND,
    refKindsOf,
  } = await upstream.ssrLoadModule("/src/utils/tasks/capabilities.ts");
  const { modeForSource, modeHint, mediaModeForSource, referenceUsed } =
    await desktop.ssrLoadModule("/src/renderer/workspace/video-modes.ts");
  let referenceChecks = 0;
  for (const mode of [undefined, "t2i", "i2i", "t2v", "i2v", "omni"])
    for (const mask of [undefined, 0, 1, 2, 3, 4, 5, 6, 7]) {
      const references = Object.fromEntries(
        ["image", "video", "audio"].map((kind, index) => [kind, Number(!!(mask & (1 << index)))]),
      );
      const caps =
        mask === undefined
          ? undefined
          : {
              refs: Object.fromEntries(
                Object.entries(references).map(([kind, count]) => [kind, { on: !!count }]),
              ),
            };
      for (const [kind, ports] of Object.entries(PORTS_OF_KIND)) {
        assert.equal(
          referenceUsed(kind, caps && { references }, mode),
          !caps ||
            ports.includes("text") ||
            ports.some((port) => refKindsOf(caps, mode).includes(port)),
        );
        referenceChecks++;
      }
    }
  console.log(`${referenceChecks} matching reference strip port decisions`);
  let checks = 0;
  for (const modes of [["t2v", "i2v", "omni"], ["omni", "i2v"], ["t2v"], ["i2v"], ["omni"]])
    for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const references = Object.fromEntries(
        ["image", "video", "audio"].map((kind, index) => [kind, Number(!!(mask & (1 << index)))]),
      );
      const caps = {
        ops: modes,
        refs: Object.fromEntries(
          Object.entries(references).map(([kind, count]) => [kind, { on: !!count }]),
        ),
      };
      for (const op of modes) {
        for (const kind of ["script", "image", "video", "audio", "character", "storyboard"]) {
          const expected =
            kind === "storyboard" || acceptsSourceKind(caps, op, kind)
              ? undefined
              : (opToAcceptSource(caps, op, kind) ?? false);
          assert.equal(modeForSource(kind, { modes, references }, op), expected);
          checks++;
        }
        for (const hasRefs of [true, false]) {
          assert.equal(
            modeHint(op, { modes, references }, hasRefs),
            opDisabledHint(caps, op, hasRefs),
          );
          checks++;
        }
      }
    }
  console.log(`${checks} matching operation/link decisions`);
  let mediaChecks = 0;
  for (const [target, modes] of [
    ["image", ["t2i"]],
    ["image", ["i2i"]],
    ["image", ["t2i", "i2i"]],
    ["image", ["i2i", "t2i"]],
    ["audio", []],
  ]) {
    for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const references = Object.fromEntries(
        ["image", "video", "audio"].map((kind, index) => [kind, Number(!!(mask & (1 << index)))]),
      );
      const caps = {
        ops: modes,
        refs: Object.fromEntries(
          Object.entries(references).map(([kind, count]) => [kind, { on: !!count }]),
        ),
      };
      const current = currentOp(caps, {});
      for (const source of [
        "script",
        "image",
        "video",
        "audio",
        "character",
        "director",
        "storyboard",
      ]) {
        const accepted =
          source === "storyboard" ||
          acceptsSourceKind(caps, current, source) ||
          !!opToAcceptSource(caps, current, source);
        assert.equal(mediaModeForSource(source, target, { modes, references }) !== false, accepted);
        mediaChecks++;
      }
    }
  }
  console.log(`${mediaChecks} matching image/audio target decisions`);
  const ffmpeg = resolve(
    "out/media",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  for (const theme of ["light", "dark"])
    for (const state of states) {
      const key = `${theme}-${state}`;
      assert.deepEqual(results[`desktop-${key}`], results[`upstream-${key}`]);
      const [before, after] = ["upstream", "desktop"].map((side) =>
        execFileSync(ffmpeg, [
          "-v",
          "error",
          "-i",
          join(output, `${side}-${key}.png`),
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ]),
      );
      let different = 0;
      for (let offset = 0; offset < before.length; offset += 3)
        if (before.readUIntBE(offset, 3) !== after.readUIntBE(offset, 3)) different++;
      results[key] = different;
      console.log(key, different, "different pixels of", before.length / 3);
    }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  if (process.env.PARITY_EXACT === "1")
    assert(Object.values(results).every((value) => typeof value !== "number" || value === 0));
} finally {
  await Promise.all(servers.map((server) => server.close()));
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
