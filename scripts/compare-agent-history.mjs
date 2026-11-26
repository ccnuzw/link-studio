import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const workspace = process.cwd();
const reference = path.resolve(process.env.AGENT_REFERENCE_WEB ?? "../video-canvas/web");
const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const preferences = process.argv.includes("--preferences");
const contextRing = process.argv.includes("--context-ring");
const output = path.join(
  workspace,
  `test-results/agent-${contextRing ? "context-ring" : preferences ? "preferences" : "history"}-parity`,
);
const temp = await mkdtemp(path.join(tmpdir(), "link-history-"));
const sessions = [
  { id: "one", title: "保留分镜方案" },
  { id: "two", title: "Storyboard 02 · 重逢之后的楼道对白与人物调度细节逐镜确认" },
];
const browser = await chromium.launch({ channel: "chrome" });
const captures = new Map();
const report = {
  revision,
  browser: browser.version(),
  scope: contextRing
    ? "展开态按钮及用量弹层各自的矩形内部，固定背景，不含悬停提示"
    : "菜单矩形内部",
  samples: {},
  differences: {},
};

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
  await appendFile(
    path.join(pinned, "src/pages/canvas/agent/agent-header.tsx"),
    "\nexport { TitleHistory, SettingsPopover };\n",
  );
  await writeFile(
    path.join(pinned, "src/pages/admin/assistant/admin-assistant-panel.tsx"),
    "export function AdminAssistantPanel(){return <header/>}",
  );

  for (const upstream of [true, false]) {
    const name = upstream ? "upstream" : "desktop";
    const root = upstream ? pinned : workspace;
    const assets = path.join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const styles = (await readdir(assets)).filter((file) => /^index-.*\.css$/.test(file));
    if (styles.length !== 1) throw new Error(`Expected one built stylesheet in ${assets}`);
    const css = await readFile(path.join(assets, styles[0]));
    const fonts = new Map(
      await Promise.all(
        (await readdir(assets))
          .filter((file) => file.endsWith(".woff2"))
          .map(async (file) => [file, await readFile(path.join(assets, file))]),
      ),
    );
    const entry = path.join(root, "history-fixture.jsx");
    const component = upstream
      ? `import {TitleHistory,SettingsPopover} from './src/pages/canvas/agent/agent-header';
      import {ContextRing} from './src/pages/canvas/agent/context-ring';
      import {TooltipProvider} from './src/components/ui/tooltip';
      import {AssistantDrawer} from './src/pages/admin/assistant/assistant-drawer';
      import {useAdminStore} from './src/store/admin'; import {createPortal} from 'react-dom';
      const history = <TooltipProvider>${contextRing ? "<ContextRing tokens={tokens} window={limit}/>" : preferences ? "<SettingsPopover/>" : "<TitleHistory ctl={{sessions,session:sessions[0],busy}} title={title}/>"}</TooltipProvider>;
      useAdminStore.setState({assistantOpen:true});
      function ReferenceDrawer(){const [header,setHeader]=useState(null); useLayoutEffect(()=>setHeader(document.querySelector('aside header')),[]);return <><AssistantDrawer/>{header && createPortal(history,header)}</>}
      const content = scope === 'settings' ? <ReferenceDrawer/> : <header>{history}</header>;`
      : contextRing
        ? `import {AssistantContextRing} from './src/renderer/assistant/assistant-context-ring';const content=<AssistantContextRing model={limit ? {config:{contextWindow:limit}} : undefined} events={[{type:'run.status',runId:'r'}, {type:'run.usage',runId:'r',payload:{context_tokens:tokens}}]}/>;`
        : preferences
          ? `import {AssistantPreferences} from './src/renderer/assistant/assistant-preferences';const content=<AssistantPreferences/>;`
          : `import {AssistantHistory} from './src/renderer/workspace/assistant-history';
      const content = <AssistantHistory sessions={sessions} current={sessions[0]?.id ?? ''} locked={busy} title={title}/>;`;
    const script = `import {createRoot} from 'react-dom/client';import {useLayoutEffect,useState} from 'react';
      const scope = new URLSearchParams(location.search).get('scope');
      const state = new URLSearchParams(location.search).get('state');
      const tokens = ({zero:0,warn:24576,danger:38000,unknown:1031})[state], limit = state === 'unknown' ? 0 : 32768;
      const sessions = state === 'empty' ? [] : ${JSON.stringify(sessions)};
      const title = sessions[0]?.title ?? '新对话', busy = state === 'busy';
      ${upstream ? "" : `import {SettingsDrawer} from './src/renderer/settings/settings-drawer';`}
      ${component}\ncreateRoot(document.querySelector(${upstream ? "'main'" : "scope==='settings'?'main':'header'"})).render(${upstream ? "content" : `scope==='settings'?<SettingsDrawer open><section className="assistant-surface settings-assistant"><header className="assistant-heading">{content}</header></section></SettingsDrawer>:content`});`;
    const bundle = path.join(temp, `${name}-bundle`);
    await build({
      root,
      configFile: false,
      logLevel: "error",
      publicDir: false,
      define: { "process.env.NODE_ENV": '"production"' },
      resolve: { alias: { "@": path.join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "history-fixture",
          resolveId(id) {
            if (id === entry) return entry;
          },
          load(id) {
            if (id === entry) return script;
          },
        },
      ],
      build: { outDir: bundle, lib: { entry, formats: ["es"], fileName: () => "fixture.js" } },
    });

    const page = await browser.newPage({ deviceScaleFactor: 1 });
    if (preferences && !upstream)
      await page.addInitScript(() => {
        let enabled = false;
        window.desktop = {
          settings: {
            agentPreferences: async ({ showThinking }) => {
              enabled = showThinking ?? enabled;
              return { ok: true, value: { showThinking: enabled } };
            },
          },
        };
      });
    page.on("pageerror", (error) => console.error(name, error));
    try {
      await page.route("http://history.test/**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/fixture.js")
          return route.fulfill({ path: path.join(bundle, "fixture.js") });
        if (url.pathname === `/assets/${styles[0]}`)
          return route.fulfill({ contentType: "text/css", body: css });
        if (fonts.has(path.basename(url.pathname)))
          return route.fulfill({
            contentType: "font/woff2",
            body: fonts.get(path.basename(url.pathname)),
          });
        if (url.pathname !== "/")
          return route.fulfill({ path: path.join(assets, path.basename(url.pathname)) });
        const dark = url.searchParams.get("theme") === "dark";
        const scope = url.searchParams.get("scope");
        const host = {
          canvas: "canvas-workspace",
          settings: "channel-settings-body",
          drama: "drama-studio",
        }[scope];
        const section = `<section class="assistant-surface ${scope}-assistant"><header class="assistant-heading"></header></section>`;
        const surface = upstream
          ? `<main class="${contextRing && scope === "drama" ? "drama-theme" : ""}"></main>`
          : scope === "settings"
            ? '<main class="model-settings"></main>'
            : `<main class="${host}">${section}</main>`;
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${dark && upstream ? "dark" : ""} ${scope === "settings" && upstream ? "admin-theme" : ""}"><meta charset=utf-8>
          <link rel=stylesheet href="/assets/${styles[0]}"><style>body,main${scope !== "settings" ? ",main > section" : ""}{background:${dark ? "#171717" : "white"}!important;min-height:100vh}header{position:fixed;${preferences || contextRing ? "right" : "left"}:36px;${contextRing ? "bottom" : "top"}:16px}</style>
          ${contextRing ? `<style>header{background:${dark ? "#171717" : "white"}!important}</style>` : ""}${surface}<script type=module src="/fixture.js"></script>`,
        });
      });
      for (const scope of upstream && !contextRing
        ? ["canvas", "settings"]
        : ["canvas", "settings", "drama"])
        for (const theme of ["light", "dark"])
          for (const width of [320, 400])
            for (const state of contextRing
              ? ["zero", "warn", "danger", "unknown"]
              : preferences
                ? ["off", "on"]
                : ["normal", "confirm", "busy", "empty"]) {
              const sample = `${theme}-${width}-${state}`;
              const key = scope === "canvas" ? sample : `${scope}-${sample}`;
              await page.emulateMedia({ colorScheme: theme });
              await page.setViewportSize({ width, height: 420 });
              await page.goto(`http://history.test/?theme=${theme}&state=${state}&scope=${scope}`);
              const trigger = page.getByRole("button", {
                name: contextRing
                  ? /^上下文用量/
                  : preferences
                    ? upstream
                      ? "Agent 设置"
                      : "小灵设置"
                    : /^历史会话，当前/,
              });
              await trigger.click();
              const menu = page.locator(
                upstream
                  ? "[data-slot=popover-content]"
                  : contextRing
                    ? ".agent-context-popup:popover-open"
                    : preferences
                      ? ".agent-settings-menu:popover-open"
                      : ".assistant-history:popover-open",
              );
              await menu.waitFor();
              if (preferences) {
                const toggle = menu.getByRole("switch", { name: "显示思考过程" });
                if ((await toggle.isChecked()) !== (state === "on")) await toggle.click();
                if ((await toggle.isChecked()) !== (state === "on"))
                  throw new Error(`Unexpected switch: ${name}-${key}`);
              }
              if (state === "confirm") {
                await menu.getByRole("button", { name: "删除「保留分镜方案」" }).click();
                await menu.getByRole("button", { name: "确认删除「保留分镜方案」" }).waitFor();
              }
              if ((await menu.locator("button:disabled").count()) !== (state === "busy" ? 3 : 0))
                throw new Error(`Unexpected disabled buttons: ${key}`);
              await page.mouse.move(0, 400);
              await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.all(
                  document
                    .getAnimations()
                    .filter((animation) => animation.effect.getTiming().iterations !== Infinity)
                    .map((animation) => animation.finished.catch(() => {})),
                );
              });
              const box = await menu.boundingBox();
              const triggerBox = await trigger.boundingBox();
              const expectedX =
                preferences || contextRing
                  ? Math.max(5, triggerBox.x + triggerBox.width - box.width)
                  : Math.min(triggerBox.x, width - box.width - 5);
              if (
                Math.abs(
                  box.y -
                    (contextRing
                      ? triggerBox.y - box.height - 8
                      : triggerBox.y + triggerBox.height + 4),
                ) > (contextRing ? 0.5 : 0) ||
                box.x !== expectedX
              )
                throw new Error(
                  `Unexpected menu anchor: ${name}-${key}: ${JSON.stringify({ box, triggerBox, expectedX })}`,
                );
              report.samples[`${name}-${key}`] = {
                box,
                offset: [box.x - triggerBox.x, box.y - triggerBox.y - triggerBox.height],
                styles: await menu.evaluate((element) =>
                  [element, ...element.querySelectorAll("p,button")].map((child) => {
                    const style = getComputedStyle(child);
                    return [
                      child.tagName,
                      style.font,
                      style.color,
                      style.backgroundColor,
                      style.borderRadius,
                      style.opacity,
                      child.offsetHeight,
                    ];
                  }),
                ),
              };
              const regions = contextRing
                ? [
                    ["", menu],
                    ["-trigger", trigger],
                  ]
                : [["", menu]];
              for (const [suffix, region] of regions) {
                let image = await region.screenshot();
                let stable = false;
                for (let attempt = 0; attempt < 4 && !stable; attempt++) {
                  await page.evaluate(
                    () =>
                      new Promise((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve)),
                      ),
                  );
                  const next = await region.screenshot();
                  stable = image.equals(next);
                  image = next;
                }
                if (!stable) throw new Error(`Unstable ${name}-${key}`);
                await writeFile(path.join(output, `${name}-${key}${suffix}.png`), image);
                if (upstream) captures.set(key + suffix, image.toString("base64"));
                else
                  report.differences[key + suffix] = await page.evaluate(
                    async (images) => {
                      const decoded = await Promise.all(
                        images.map(async (data) => {
                          const image = new Image();
                          image.src = `data:image/png;base64,${data}`;
                          await image.decode();
                          const canvas = document.createElement("canvas");
                          canvas.width = image.width;
                          canvas.height = image.height;
                          const context = canvas.getContext("2d");
                          context.drawImage(image, 0, 0);
                          return context.getImageData(0, 0, image.width, image.height);
                        }),
                      );
                      const [baseline, current] = decoded;
                      if (baseline.width !== current.width || baseline.height !== current.height)
                        return "size mismatch";
                      const pixels = new Uint32Array(current.data.buffer);
                      return new Uint32Array(baseline.data.buffer).reduce(
                        (count, color, index) => count + Number(color !== pixels[index]),
                        0,
                      );
                    },
                    [
                      captures.get((scope === "settings" || contextRing ? key : sample) + suffix),
                      image.toString("base64"),
                    ],
                  );
              }
            }
    } finally {
      await page.close();
    }
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(report.differences);
  if (Object.values(report.differences).some((value) => value !== 0))
    throw new Error("菜单存在像素差异，详见 report.json");
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
