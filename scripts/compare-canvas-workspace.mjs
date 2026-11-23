import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";
import { replayArrangeMenu } from "./canvas-arrange-replay.mjs";
import { replayAcrossCanvases, replayCanvasClipboard } from "./canvas-clipboard-replay.mjs";
import {
  pendingImageProvider,
  startDesktopImage,
  taskSetup,
} from "./canvas-edge-backfill-fixture.mjs";
import { replayGroupTools } from "./canvas-group-replay.mjs";
import { replayLooseLink } from "./canvas-loose-link-replay.mjs";
import { overlapGroupsFixture, replayOverlapGroups } from "./canvas-overlap-groups-replay.mjs";
import { replaySingleGroup } from "./canvas-single-group-replay.mjs";

assert(process.env.VIDEO_CANVAS_WEB, "Set VIDEO_CANVAS_WEB to the pinned checkout");
const root = resolve(process.env.VIDEO_CANVAS_WEB),
  theme = process.argv.includes("--dark") ? "dark" : "light";
const markdown = process.argv.includes("--markdown");
const arrange = process.argv.includes("--arrange");
const singleGroup = process.argv.includes("--single-group");
const overlapGroups = process.argv.includes("--overlap-groups");
const looseLink = process.argv.includes("--loose-link");
const groupTools = overlapGroups || singleGroup || process.argv.includes("--group-tools");
const emptyText = process.argv.includes("--empty-text");
const crossClipboard = process.argv.includes("--cross-clipboard");
const clipboard = crossClipboard || process.argv.includes("--clipboard");
assert(
  !(clipboard && !crossClipboard && process.argv.includes("--strict")),
  "同画布剪贴板回放验证交互与几何，不采集像素帧",
);
const failedText = process.argv.includes("--failed-text");
const failedBackfill = process.argv.includes("--failed-backfill");
const backfillEdge = failedBackfill || process.argv.includes("--backfill-edge");
const cutEdge = backfillEdge || process.argv.includes("--cut-edge");
const sameEngine = process.argv.includes("--same-engine");
const electronSrgb = process.argv.includes("--electron-srgb");
const directory = resolve(
    `test-results/canvas-workspace-${theme}${looseLink ? "-loose-link" : overlapGroups ? "-overlap-groups" : singleGroup ? "-single-group" : groupTools ? "-group-tools" : arrange ? "-arrange" : markdown ? "-markdown" : emptyText ? "-empty-text" : failedText ? "-failed-text" : failedBackfill ? "-failed-backfill" : backfillEdge ? "-backfill-edge" : cutEdge ? "-cut-edge" : crossClipboard ? "-cross-clipboard" : clipboard ? "-clipboard" : ""}${sameEngine ? "-same-engine" : ""}${electronSrgb ? "-srgb" : ""}`,
  ),
  temp = await mkdtemp(join(tmpdir(), "canvas-workspace-audit-"));
const title = "镜头对照",
  graph = {
    nodes: [
      {
        id: "script",
        type: "canvas",
        position: { x: 120, y: 200 },
        data: { kind: "script", label: "对白", text: "列车驶入站台。" },
      },
      {
        id: "video",
        type: "canvas",
        position: { x: 690, y: 220 },
        data: { kind: "video", label: "站台", status: "idle" },
      },
    ],
    edges: [{ id: "script-video", source: "script", target: "video" }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
const entry = "/src/__workspace_audit.jsx",
  assets = join(root, "dist/assets");
if (looseLink) {
  graph.nodes[0].position = { x: 96, y: 272 };
  graph.nodes[1].position = { x: 890, y: 150 };
}
if (overlapGroups) overlapGroupsFixture(graph);
if (arrange)
  graph.nodes.push({
    id: "note",
    type: "canvas",
    position: { x: 330, y: 550 },
    data: { kind: "script", label: "场记", text: "傍晚" },
  });
if (singleGroup) {
  Object.assign(graph.nodes[0], { parentId: "group", position: { x: 28, y: 50 } });
  graph.nodes[1].position = { x: 826, y: 256 };
  graph.nodes.unshift({
    id: "group",
    type: "group",
    position: { x: 130, y: 256 },
    width: 632,
    height: 420,
    zIndex: -2000,
    data: { label: "单成员组" },
  });
}
if (emptyText) graph.nodes[0].data.text = "";
if (cutEdge) graph.nodes[1].position = { x: 1030, y: 380 };
if (backfillEdge) {
  graph.nodes[0].position = { x: 30, y: 110 };
  graph.nodes[1].position = { x: 820, y: 150 };
  graph.nodes[1].data = { kind: "image", label: "站台", params: { prompt: "站台特写" } };
}
if (failedText)
  Object.assign(graph.nodes[0].data, { status: "error", error: "服务暂时不可用，请稍后再试。" });
if (markdown)
  graph.nodes[0].data.text = [
    "## 夜班列车",
    "",
    "汽笛响起。",
    "列车驶入 **三号站台**。",
    "",
    "- [x] 确认镜位",
    "- 检查 [拍摄计划](https://example.invalid/plan)",
    "",
    "> 冷色调，保留环境音。",
    "",
    "1. 广角",
    "2. 特写",
    "",
    "### 镜头清单",
    "",
    "| 景别 | 秒数 |",
    "| --- | ---: |",
    "| 全景 | 8 |",
    "| 中景 | 5 |",
    "",
    "使用 `cut`，保留 ~~旧版~~。",
    "",
    "```text",
    "TAKE 02",
    "ROLL 03",
    "```",
    "",
    "---",
    "",
    "结束。",
  ].join("\n");
const sheet = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
assert(sheet);
const report = { theme, graph, original: {}, desktop: {}, frames: {} },
  images = new Map();
let app, browser, server, referenceWindowId, provider;
try {
  await mkdir(directory, { recursive: true });
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: temp,
    LINK_STUDIO_TEST_PROJECT_PARENT: temp,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: electronSrgb ? ["--force-color-profile=srgb", "."] : ["."],
    env,
  });
  const desktop = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true),
  );
  if (singleGroup)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1024, 700),
    );
  await desktop.emulateMedia({ colorScheme: null });
  if (backfillEdge)
    provider = await pendingImageProvider(
      desktop,
      await readFile("resources/icons/icon-32.png", "base64"),
    );
  await desktop.getByRole("textbox", { name: "新项目名称" }).fill(title);
  await desktop.getByRole("button", { name: "新建项目" }).click();
  await desktop.getByRole("button", { name: "更多", exact: true }).click();
  await desktop.getByRole("menuitem", { name: "主题", exact: true }).press("ArrowRight");
  await desktop
    .getByRole("menuitemradio", { name: theme === "dark" ? "深色" : "浅色", exact: true })
    .click();
  await expect
    .poll(() => desktop.evaluate(() => matchMedia("(prefers-color-scheme:dark)").matches))
    .toBe(theme === "dark");
  await desktop.getByRole("button", { name: "画布菜单" }).click();
  await desktop.getByRole("menuitem", { name: "桌面项目操作" }).press("ArrowRight");
  const chosen = desktop.waitForEvent("filechooser");
  await desktop.getByRole("menuitem", { name: "导入画布" }).click();
  await (await chosen).setFiles({
    name: "workspace.canvas.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "video-canvas/canvas",
        version: 1,
        exportedAt: "2026-11-20T12:00:00Z",
        appVersion: "ccffac4e",
        canvas: { title, nodes: graph.nodes, edges: graph.edges },
        assets: {},
      }),
    ),
  });
  await expect(desktop.locator(".react-flow__edge")).toHaveCount(1);
  const display = await desktop.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  report.display = display;
  const dto = {
    id: "1001",
    version: 1,
    title,
    description: null,
    graph: structuredClone(graph),
    createdAt: "2026-11-20T12:00:00Z",
    updatedAt: "2026-11-20T12:00:00Z",
  };
  if (backfillEdge) Object.assign(dto.graph.nodes[1].data, { status: "running", taskId: "123" });
  const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {ReactFlowProvider} from '@xyflow/react';import {TooltipProvider} from '/src/components/ui/tooltip';import {Flow} from '/src/pages/canvas/flow';import {useSettingsStore} from '/src/store/settings';useSettingsStore.getState().updateSettings('theme',${JSON.stringify(theme)});const root=createRoot(document.querySelector('main')),dto=${JSON.stringify(dto)};const render=canvas=>root.render(<MemoryRouter key={canvas.id} initialEntries={['/canvas/'+canvas.id]}><TooltipProvider><ReactFlowProvider><Flow canvas={canvas} recovery={null} onConflict={()=>{}}/></ReactFlowProvider></TooltipProvider></MemoryRouter>);render(dto);${crossClipboard ? "window.openAuditTarget=()=>render({...dto,id:'1002',title:'未命名画布',graph:{...dto.graph,nodes:[],edges:[]}});" : ""}`;
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(temp, "vite"),
    define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/api/v1") },
    resolve: { alias: { "@": join(root, "src") } },
    oxc: { jsx: { runtime: "automatic" } },
    server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [
      {
        name: "real-workspace-audit",
        resolveId(id) {
          if (id === entry) return join(root, id);
        },
        load(id) {
          if (id === join(root, entry)) return (backfillEdge ? taskSetup : "") + fixture;
        },
      },
    ],
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  let original;
  if (sameEngine) {
    const opened = app.waitForEvent("window");
    referenceWindowId = await app.evaluate(({ BrowserWindow }, size) => {
      const auditWindow = new BrowserWindow({
        width: size.width,
        height: size.height,
        useContentSize: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      auditWindow.setIgnoreMouseEvents(true);
      void auditWindow.loadURL("about:blank");
      return auditWindow.id;
    }, display);
    original = await opened;
    await original.emulateMedia({ colorScheme: null });
  } else {
    browser = await chromium.launch({
      channel: "chrome",
      ...((arrange || singleGroup || overlapGroups || looseLink) && {
        ignoreDefaultArgs: ["--hide-scrollbars"],
      }),
    });
    original = await browser.newPage({
      viewport: { width: display.width, height: display.height },
      deviceScaleFactor: display.dpr,
      colorScheme: theme,
    });
  }
  report.engines = {
    original: await original.evaluate(() => navigator.userAgent),
    desktop: await desktop.evaluate(() => navigator.userAgent),
  };
  const errors = [];
  original.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await original.route(`${origin}assets/**`, (route) =>
    route.fulfill({ path: join(assets, basename(new URL(route.request().url()).pathname)) }),
  );
  if (backfillEdge)
    await original.route("**/audit-output.png", (route) =>
      route.fulfill({ path: resolve("resources/icons/icon-32.png") }),
    );
  await original.route(`${origin}api/**`, (route) =>
    route.fulfill({ json: { code: 0, msg: "ok", data: [] } }),
  );
  if (crossClipboard)
    await original.route("**/api/v1/canvas/1002", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            json: {
              code: 0,
              msg: "ok",
              data: {
                revision: route.request().postDataJSON().revision + 1,
                updated_at: "2026-11-23T10:00:00Z",
              },
            },
          })
        : route.fallback(),
    );
  await original.route(`${origin}audit`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${sheet}"><main></main><script type="module" src="${entry}"></script>`,
    }),
  );
  await original.goto(`${origin}audit`);
  await expect(original.locator(".react-flow__edge")).toHaveCount(1, { timeout: 45000 });
  for (const [name, page] of [
    ["original", original],
    ["desktop", desktop],
  ]) {
    await page.bringToFront();
    const palette = await page.evaluate(() => ({
      html: document.documentElement.className,
      systemDark: matchMedia("(prefers-color-scheme:dark)").matches,
      background: getComputedStyle(document.querySelector(".react-flow")).backgroundColor,
      canvas: getComputedStyle(document.querySelector(".react-flow"))
        .getPropertyValue("--canvas-bg")
        .trim(),
    }));
    (report.palette ??= {})[name] = palette;
    assert.equal(palette.systemDark, theme === "dark");
    if (name === "original")
      assert.equal(palette.html.split(" ").includes("dark"), theme === "dark");
    await page.evaluate(() => document.fonts.ready);
    const node = page.locator(".react-flow__node").filter({ hasText: "对白" });
    await expect(node).toHaveCount(1);
    await page.getByRole("radio", { name: "选择", exact: true }).waitFor();
    const capture = async (state, clip) => {
      const details = await page.evaluate(() => ({
        viewport: getComputedStyle(document.querySelector(".react-flow__viewport")).transform,
        tool: [...document.querySelectorAll("[role=radio][aria-checked=true]")].map((el) =>
          el.getAttribute("aria-label"),
        ),
        nodes: [...document.querySelectorAll(".react-flow__node")].map((el) => ({
          selected: el.classList.contains("selected"),
          rect: el.getBoundingClientRect().toJSON(),
        })),
        edge: document.querySelector(".react-flow__edge-path")?.getAttribute("d"),
      }));
      const tooltipState = state === "selectionCopyTip";
      const shot = async () => {
        if (!tooltipState && !overlapGroups && !looseLink)
          return page.screenshot({ animations: "disabled", caret: "hide", clip });
        if (tooltipState) {
          const button = page.getByRole("button", { name: "复制选中节点", exact: true });
          await button.hover();
          await expect(
            page.locator('[data-slot="tooltip-content"],.canvas-control-tip'),
          ).toBeVisible();
          await button.evaluate(async () => {
            await Promise.all(
              document
                .getAnimations()
                .filter((anim) => anim.effect?.getComputedTiming().endTime < 1000)
                .map((anim) => anim.finished.catch(() => {})),
            );
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
          });
        }
        const full = await page.screenshot({ caret: "hide" });
        return Buffer.from(
          await page.evaluate(
            async ({ src, clip }) => {
              const image = new Image();
              image.src = "data:image/png;base64," + src;
              await image.decode();
              const canvas = document.createElement("canvas"),
                dpr = devicePixelRatio;
              if (image.width !== innerWidth * dpr || image.height !== innerHeight * dpr)
                throw Error("整窗截图尺寸不等于视口乘 DPR");
              canvas.width = clip.width * dpr;
              canvas.height = clip.height * dpr;
              canvas.getContext("2d").drawImage(image, -clip.x * dpr, -clip.y * dpr);
              return canvas.toDataURL().split(",")[1];
            },
            { src: full.toString("base64"), clip },
          ),
          "base64",
        );
      };
      let frame = await shot(),
        consecutive = 1;
      for (let attempt = 0; attempt < 8 && consecutive < 3; attempt++) {
        const next = await shot();
        consecutive = next.equals(frame) ? consecutive + 1 : 1;
        frame = next;
      }
      if (tooltipState) {
        const button = page.getByRole("button", { name: "复制选中节点", exact: true });
        assert(
          await button.evaluate((element) => element.matches(":hover")),
          `${name}: 截图时复制按钮已失去悬停`,
        );
        const tip = page.locator('[data-slot="tooltip-content"],.canvas-control-tip');
        await expect(tip).toBeVisible();
        details.tipPaint = await tip.evaluate((element) =>
          [element, element.lastElementChild].map((part) => {
            const style = getComputedStyle(part);
            return {
              background: style.backgroundColor,
              color: style.color,
              radius: style.borderRadius,
              rect: part.getBoundingClientRect().toJSON(),
            };
          }),
        );
        assert.equal(consecutive, 3, `${name}: 复制提示局部未稳定`);
      }
      if (cutEdge)
        details.cut = await page.evaluate(() => {
          const edge = document.querySelector(".react-flow__edge"),
            buttons = [...document.querySelectorAll('button[aria-label="断开连接"]')];
          return {
            selected: edge.classList.contains("selected"),
            buttons: buttons.map((button) => ({
              title: button.title,
              rect: button.getBoundingClientRect().toJSON(),
              distance: getComputedStyle(button.parentElement).offsetDistance,
              focused: button === document.activeElement,
            })),
          };
        });
      if (cutEdge)
        details.paint = await page
          .locator('button[aria-label="断开连接"]')
          .evaluateAll((buttons) =>
            buttons.map((button) =>
              Object.fromEntries(
                [
                  "boxShadow",
                  "backgroundColor",
                  "border",
                  "backdropFilter",
                  "color",
                  "outline",
                  "scale",
                ].map((key) => [key, getComputedStyle(button)[key]]),
              ),
            ),
          );
      report[name][state] = { ...details, consecutive };
      await writeFile(join(directory, `${name}-${state}.png`), frame);
      if (!images.has(state)) images.set(state, []);
      images.get(state).push(frame.toString("base64"));
    };
    await page.locator(".react-flow__pane").click({ position: { x: 110, y: 100 } });
    await page.mouse.move(95, 97);
    await expect(
      page.locator(name === "original" ? "[role=status] span" : ".canvas-save-indicator span"),
    ).toHaveCount(0);
    if (arrange) {
      report[name].arrange = await replayArrangeMenu(page, capture);
      continue;
    }
    if (looseLink) {
      report[name].looseLink = await replayLooseLink(page, capture);
      continue;
    }
    if (groupTools) {
      report[name].group = await (overlapGroups
        ? replayOverlapGroups
        : singleGroup
          ? replaySingleGroup
          : replayGroupTools)(page, capture);
      continue;
    }
    if (crossClipboard) {
      report[name].cross = await replayAcrossCanvases(
        page,
        async () => {
          if (name === "original") await page.evaluate(() => window.openAuditTarget());
          else {
            await page.getByRole("button", { name: "画布菜单" }).click();
            await page.getByRole("menuitem", { name: "新建画布" }).click();
            const title = page.getByRole("textbox", { name: "画布名称" });
            await expect(title).toHaveValue("未命名画布");
            await expect(title).toBeEnabled();
          }
        },
        capture,
      );
      continue;
    }
    if (clipboard) {
      report[name].clipboard = await replayCanvasClipboard(page, node);
      continue;
    }
    if (cutEdge) {
      const edge = page.locator(".react-flow__edge"),
        cut = page.getByRole("button", { name: "断开连接", exact: true });
      if (backfillEdge) {
        if (name === "desktop") await startDesktopImage(page);
        await expect(edge.locator("animateTransform")).toHaveAttribute("dur", "1.1s");
      }
      const point = await edge.locator(".react-flow__edge-path").evaluate((path) => {
        const point = path
          .getPointAtLength(path.getTotalLength() * 0.37)
          .matrixTransform(path.getScreenCTM());
        return { x: point.x, y: point.y };
      });
      const clip = {
        x: Math.floor(point.x) - 80,
        y: Math.floor(point.y) - 65,
        width: 160,
        height: 130,
      };
      const freeze = () =>
        edge.evaluate((element) => {
          const svg = element.ownerSVGElement;
          svg.pauseAnimations();
          svg.setCurrentTime(element.querySelector("animateTransform").getStartTime() + 0.65);
        });
      if (backfillEdge) {
        await page.mouse.click(point.x, point.y);
        await expect(cut).toBeVisible();
        await cut.focus();
        await page.mouse.move(95, 97);
        await freeze();
        await capture("generating", clip);
        if (name === "desktop") await provider.finish(failedBackfill);
        else await page.evaluate((failed) => window.finishFixtureTask(failed), failedBackfill);
        const target = page
          .locator(".react-flow__node")
          .filter({ has: page.getByText("站台", { exact: true }) });
        const result = failedBackfill
          ? target.getByRole("button", { name: "重试", exact: true })
          : target.locator("img").first();
        await expect(result).toBeVisible();
        await expect(edge).toHaveClass(/selected/);
        await expect(cut).toBeFocused();
        if (!failedBackfill)
          await expect
            .poll(() => result.evaluate((image) => image.complete && image.naturalWidth > 0))
            .toBe(true);
        await expect(edge.locator("animateTransform")).toHaveAttribute("dur", "2.6s");
        await freeze();
        await capture("completed", clip);
        await cut.press("Enter");
        await expect(edge).toHaveCount(0);
        await page.keyboard.press("ControlOrMeta+z");
        await expect(edge).toHaveClass(/selected/);
        await expect(result).toBeVisible();
        continue;
      }
      await page.mouse.move(point.x, point.y);
      await expect(cut).toHaveCount(0);
      await capture("idleEdge", clip);
      await page.mouse.click(point.x, point.y);
      await expect(cut).toBeVisible();
      await freeze();
      await page.mouse.move(95, 97);
      await capture("cutReady", clip);
      await cut.hover();
      await expect
        .poll(() =>
          cut.evaluate((el) => el.matches(":hover") && el.getBoundingClientRect().width > 38.87),
        )
        .toBe(true);
      await capture("cutHover", clip);
      await page.mouse.move(95, 97);
      await page.keyboard.press("Tab");
      await cut.focus();
      await capture("cutFocus", clip);
      await cut.press("Enter");
      await expect(edge).toHaveCount(0);
      await expect(cut).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(edge).toHaveCount(1);
      await expect(edge).toHaveClass(/selected/);
      await expect(cut).toBeVisible();
      await page.mouse.click(point.x, point.y);
      await expect(cut).toBeVisible();
      await page.keyboard.press("Backspace");
      await expect(edge).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(edge).toHaveCount(1);
      await expect(edge).toHaveClass(/selected/);
      await expect(cut).toBeVisible();
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect(edge).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(edge).toHaveClass(/selected/);
      await expect(cut).toBeVisible();
      await freeze();
      await page.mouse.move(95, 97);
      await capture("restoredEdge", clip);
      await node.click();
      await expect(node).toHaveClass(/selected/);
      await page.keyboard.press("Backspace");
      await expect(node).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(node).toHaveClass(/selected/);
      await expect(edge).not.toHaveClass(/selected/);
      await expect(cut).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect(node).toHaveCount(0);
      await expect(edge).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(node).toHaveClass(/selected/);
      const target = page
        .locator(".react-flow__node")
        .filter({ has: page.getByText("站台", { exact: true }) });
      await target.click({ position: { x: 25, y: 25 }, modifiers: ["ControlOrMeta"] });
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
      await page.keyboard.press("Backspace");
      await expect(page.locator(".react-flow__node")).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
      await expect(edge).not.toHaveClass(/selected/);
      const forwardDelete = async () => {
        await page.keyboard.press("Delete");
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      };
      await forwardDelete();
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
      await page.locator(".react-flow__pane").click({ position: { x: 110, y: 100 } });
      await page.mouse.click(point.x, point.y);
      await expect(cut).toBeVisible();
      await forwardDelete();
      await expect(edge).toHaveClass(/selected/);
      await expect(cut).toBeVisible();
      const start = await node.boundingBox();
      assert(start);
      await page.mouse.click(start.x + 60, start.y + 55);
      await page.mouse.move(start.x + 60, start.y + 55);
      await page.mouse.down();
      await page.mouse.move(start.x + 112, start.y + 87, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(() => node.evaluate((el) => el.getBoundingClientRect().x))
        .toBeGreaterThan(start.x + 40);
      const movedX = await node.evaluate((el) => el.getBoundingClientRect().x);
      const moved = await edge.locator(".react-flow__edge-path").evaluate((path) => {
        const { x, y } = path
          .getPointAtLength(path.getTotalLength() * 0.31)
          .matrixTransform(path.getScreenCTM());
        return { x, y };
      });
      await page.mouse.click(moved.x, moved.y);
      await expect(cut).toBeVisible();
      const distance = () =>
        cut.evaluate((el) => getComputedStyle(el.parentElement).offsetDistance);
      const clicked = await distance();
      assert(Math.abs(parseFloat(clicked) - 31) < 1);
      const path = await edge.locator(".react-flow__edge-path").elementHandle();
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => node.evaluate((el) => el.getBoundingClientRect().x)).toBe(start.x);
      await expect(node).toHaveClass(/selected/);
      await expect(cut).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(() => node.evaluate((el) => el.getBoundingClientRect().x)).toBe(movedX);
      await expect(edge).toHaveClass(/selected/);
      await expect(cut).toBeVisible();
      await freeze();
      await page.mouse.move(95, 97);
      await capture("redoMove", {
        ...clip,
        x: Math.floor(moved.x) - 80,
        y: Math.floor(moved.y) - 65,
      });
      assert.equal(await distance(), clicked, `${name}: 重做拖动不应把剪刀移回中点`);
      assert(await path.evaluate((el) => el.isConnected), `${name}: 未删除的连线保持挂载`);
      await path.dispose();
      continue;
    }
    if (failedText) {
      const alert = node.getByRole("alert");
      await expect(alert).toHaveText(graph.nodes[0].data.error);
      const label = node.getByText("生成失败", { exact: true });
      await expect(label).toBeVisible();
      await expect(page.getByRole("button", { name: "失败节点 1 个" })).toBeVisible();
      const clip = await node.boundingBox();
      assert(clip);
      await capture("failed", { ...clip, y: clip.y - 32, height: clip.height + 32 });
      report[name].failed.parts = await Promise.all(
        [
          label,
          alert.locator("svg"),
          alert.getByText(graph.nodes[0].data.error, { exact: true }),
        ].map((part) => part.boundingBox()),
      );
      const editor = page.getByRole("textbox", { name: "文本内容" });
      await alert.dblclick();
      await expect(editor).toHaveText(graph.nodes[0].data.text);
      await editor.press("Escape");
      await expect(alert).toBeVisible();
      await alert.dblclick();
      await editor.click();
      await editor.press("ControlOrMeta+a");
      await page.keyboard.insertText("列车准备出站。");
      await expect(editor).toHaveText("列车准备出站。");
      await editor.press("Escape");
      await expect(alert).toHaveCount(0);
      await expect(label).toHaveCount(0);
      await expect(node.getByText("列车准备出站。", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "失败节点 0 个" })).toBeVisible();
      continue;
    }
    if (emptyText) {
      const image = node.getByRole("img", { name: "双击输入文字" });
      const clip = await node.boundingBox();
      assert(clip);
      await expect(image.locator("svg")).toBeVisible();
      await capture("empty", clip);
      report[name].empty.content = await Promise.all(
        [image, image.locator("svg"), image.locator("span")].map((element) =>
          element.boundingBox(),
        ),
      );
      const viewport = page.locator(".react-flow__viewport");
      const transform = () => viewport.evaluate((element) => getComputedStyle(element).transform);
      const initial = await transform();
      const wheelEvent = page.evaluate(
        () =>
          new Promise((resolve) =>
            window.addEventListener(
              "wheel",
              (event) =>
                resolve({
                  x: event.deltaX,
                  y: event.deltaY,
                  mode: event.deltaMode,
                  trusted: event.isTrusted,
                }),
              { once: true, capture: true },
            ),
          ),
      );
      await image.hover();
      await page.mouse.wheel(0, 60 * (page === original && !sameEngine ? display.dpr : 1));
      report[name].empty.wheel = await wheelEvent;
      assert.deepEqual(report[name].empty.wheel, { x: 0, y: 60, mode: 0, trusted: true });
      await expect.poll(transform).not.toBe(initial);
      await image.dblclick();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      report[name].empty.wheelViewport = await transform();
      continue;
    }
    if (markdown) {
      const body = node.locator(".nowheel").filter({ has: page.locator("table") });
      await expect(body).toHaveCount(1);
      await expect(body.locator("p br")).toHaveCount(1);
      await expect(body.locator("h3")).toHaveText("夜班列车");
      await expect(body.getByRole("checkbox")).toBeChecked();
      await expect(body.getByRole("link")).toHaveAttribute("href", "https://example.invalid/plan");
      const clip = await body.boundingBox();
      assert(clip);
      (report.typography ??= {})[name] = await body.evaluate((element) =>
        [...element.querySelectorAll("h3,p,ul,li,input,pre,code")].map((block) => {
          const style = getComputedStyle(block);
          return {
            tag: block.tagName,
            cls: block.className,
            font: style.font,
            fontFamily: style.fontFamily,
            lineHeight: style.lineHeight,
            margin: style.margin,
            padding: style.padding,
            align: style.verticalAlign,
            list: style.listStyleType,
          };
        }),
      );
      for (const state of ["top", "bottom"]) {
        if (state === "bottom") {
          await body.hover();
          await page.mouse.wheel(0, 960);
          await page.mouse.move(95, 97);
          await expect
            .poll(() =>
              body.evaluate(
                (element) =>
                  element.scrollTop > 0 &&
                  element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
              ),
            )
            .toBe(true);
        }
        await capture(state, clip);
        report[name][state].body = await body.evaluate((element) => ({
          top: element.scrollTop,
          height: element.scrollHeight,
          width: element.clientWidth,
          blocks: [...element.querySelectorAll("h3,h4,p,ul,ol,blockquote,table,pre,hr")].map(
            (block) => ({
              tag: block.tagName,
              y: block.getBoundingClientRect().y,
              height: block.getBoundingClientRect().height,
            }),
          ),
        }));
      }
      continue;
    }
    await capture("idle");
    const box = await node.boundingBox();
    await page.mouse.click(box.x + 60, box.y + 55);
    await expect(node).toHaveClass(/selected/);
    await page.mouse.move(95, 97);
    await capture("selected");
    await page.mouse.move(box.x + 60, box.y + 55);
    await page.mouse.down();
    await page.mouse.move(box.x + 112, box.y + 87, { steps: 8 });
    await page.mouse.up();
    await page.mouse.move(95, 97);
    await capture("dragged");
    await page.getByRole("button", { name: "任务历史" }).click();
    await expect(page.getByRole("dialog", { name: "任务历史" })).toBeVisible();
    await page.mouse.move(500, 250);
    await capture("history");
  }
  assert.deepEqual(errors, []);
  if (crossClipboard) {
    const { selectionTools: originalTips, ...originalCross } = report.original.cross,
      { selectionTools: desktopTips, ...desktopCross } = report.desktop.cross;
    assert.deepEqual(desktopCross, originalCross);
    assert.equal(desktopTips.length, originalTips.length);
    report.selectionTooltipGeometry = desktopTips.map((rect, index) =>
      rect.map((value, axis) => value - originalTips[index][axis]),
    );
    assert.deepEqual(
      desktopTips.slice(0, 3),
      originalTips.slice(0, 3),
      "打组、复制、下载的提示矩形",
    );
    for (const axis of [0, 1, 3])
      assert.equal(desktopTips[3][axis], originalTips[3][axis], "删除提示的位置和高度");
    assert.deepEqual(
      report.desktop.selectionCopyTip.tipPaint,
      report.original.selectionCopyTip.tipPaint,
      "复制提示和箭头的颜色、圆角与矩形",
    );
    console.log("四个提示的矩形差（CSS px）", report.selectionTooltipGeometry);
  } else if (clipboard) {
    const points = report.original.clipboard.states.map(({ x, y }) => [x, y]);
    assert.deepEqual(points.slice(0, 2), [
      [168, 248],
      [216, 296],
    ]);
    assert.deepEqual(points.at(-1), [106, 628]);
    const { x, y } = report.original.clipboard.zoomed,
      dpr = report.display.dpr;
    assert.deepEqual([Math.round(x * dpr), Math.round(y * dpr)], [320 * dpr, 530 * dpr]);
    assert.deepEqual(report.desktop.clipboard, report.original.clipboard);
    console.log(report.original.clipboard);
  }
  for (const [state, pair] of images) {
    report.frames[state] = await original.evaluate(async (pair) => {
      const buffers = await Promise.all(
        pair.map(async (src) => {
          const bitmap = new Image();
          bitmap.src = "data:image/png;base64," + src;
          await bitmap.decode();
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          return new Uint32Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
        }),
      );
      if (buffers[0].length !== buffers[1].length) throw Error("画面尺寸不一致");
      return buffers[0].reduce((sum, pixel, index) => sum + Number(pixel !== buffers[1][index]), 0);
    }, pair);
  }
  console.log(report.frames);
  if (singleGroup || overlapGroups || looseLink) {
    const png = await original.evaluate(
      async ({ rows, reference }) => {
        const decoded = await Promise.all(
          rows.map((pair) =>
            Promise.all(
              pair.map(async (bytes) => {
                const image = new Image();
                image.src = "data:image/png;base64," + bytes;
                await image.decode();
                return image;
              }),
            ),
          ),
        );
        const canvas = document.createElement("canvas"),
          gap = 8,
          header = 32,
          width = Math.max(...decoded.flat().map((image) => image.width));
        canvas.width = width * 2 + gap;
        canvas.height = header + decoded.reduce((sum, row) => sum + row[0].height, 0) + gap;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#202124";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "white";
        ctx.font = "18px sans-serif";
        ctx.fillText(reference, 8, 23);
        ctx.fillText("桌面 Electron", width + gap + 8, 23);
        let top = header;
        for (const row of decoded) {
          for (const [column, image] of row.entries())
            ctx.drawImage(image, column * (width + gap), top);
          top += row[0].height + gap;
        }
        return canvas.toDataURL().split(",")[1];
      },
      {
        rows: (looseLink
          ? ["forwardMenu", "reverseMenu"]
          : singleGroup
            ? ["disabledHover", "cornerPalette"]
            : ["frontTarget", "selectedFront"]
        ).map((state) => images.get(state)),
        reference: sameEngine ? "原版 Electron" : "原版 Chrome",
      },
    );
    await writeFile(join(directory, "comparison.png"), Buffer.from(png, "base64"));
  }
  if (arrange) {
    const png = await original.evaluate(
      async ({ pair, reference }) => {
        const canvas = document.createElement("canvas");
        canvas.width = 704;
        canvas.height = 276;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#202124";
        ctx.fillRect(0, 0, 704, 276);
        ctx.fillStyle = "white";
        ctx.font = "15px sans-serif";
        for (const [column, bytes] of pair.entries()) {
          const image = new Image();
          image.src = "data:image/png;base64," + bytes;
          await image.decode();
          ctx.fillText(column ? "桌面 Electron" : reference, column * 352 + 8, 20);
          ctx.drawImage(image, column * 352, 28);
        }
        return canvas.toDataURL().split(",")[1];
      },
      {
        pair: images.get("arrangeBottom"),
        reference: sameEngine ? "原版 Electron" : "原版 Chrome",
      },
    );
    await writeFile(join(directory, "arrange-bottom-comparison.png"), Buffer.from(png, "base64"));
  }
  if (crossClipboard) {
    const preview = await original.evaluate(async (pair) => {
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 168;
      const context = canvas.getContext("2d");
      context.fillStyle = "#202124";
      context.fillRect(0, 0, 960, 168);
      context.font = "16px sans-serif";
      for (const [column, bytes] of pair.entries()) {
        const image = new Image();
        image.src = "data:image/png;base64," + bytes;
        await image.decode();
        const dpr = devicePixelRatio;
        context.fillStyle = "white";
        context.fillText(column ? "桌面 Electron" : "原版 Chrome", column * 480 + 8, 22);
        context.drawImage(
          image,
          500 * dpr,
          118 * dpr,
          480 * dpr,
          136 * dpr,
          column * 480,
          32,
          480,
          136,
        );
      }
      return canvas.toDataURL().split(",")[1];
    }, images.get("crossPasted"));
    await writeFile(join(directory, "selection-comparison.png"), Buffer.from(preview, "base64"));
    const tipPreview = await original.evaluate(
      async ({ pair, reference }) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1000;
        canvas.height = 158;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#202124";
        ctx.fillRect(0, 0, 1000, 158);
        ctx.fillStyle = "white";
        ctx.font = "16px sans-serif";
        for (const [column, bytes] of pair.entries()) {
          const image = new Image();
          image.src = "data:image/png;base64," + bytes;
          await image.decode();
          ctx.fillText(column ? "桌面 Electron" : reference, column * 500 + 8, 22);
          ctx.drawImage(image, column * 500, 32, 500, 126);
        }
        return canvas.toDataURL().split(",")[1];
      },
      {
        pair: images.get("selectionCopyTip"),
        reference: sameEngine ? "原版 Electron" : "原版 Chrome",
      },
    );
    await writeFile(
      join(directory, "selection-tooltip-comparison.png"),
      Buffer.from(tipPreview, "base64"),
    );
  }
  if (backfillEdge) {
    const evidence = await original.evaluate(
      async ({ pairs, failed }) => {
        const canvas = document.createElement("canvas");
        canvas.width = 672;
        canvas.height = 610;
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#222";
        context.font = "18px sans-serif";
        for (const [row, pair] of pairs.entries())
          for (const [column, bytes] of pair.entries()) {
            const image = new Image();
            image.src = "data:image/png;base64," + bytes;
            await image.decode();
            const left = 10 + column * 332,
              top = 10 + row * 300;
            context.fillText(
              `${column ? "桌面" : "原版"} · ${row ? (failed ? "失败后" : "回填后") : "生成中"}`,
              left,
              top + 20,
            );
            context.drawImage(image, left, top + 30);
          }
        return canvas.toDataURL().split(",")[1];
      },
      { pairs: [images.get("generating"), images.get("completed")], failed: failedBackfill },
    );
    await writeFile(join(directory, "edge-comparison.png"), Buffer.from(evidence, "base64"));
  }
  for (const state of Object.keys(report.frames)) {
    if (cutEdge)
      assert.deepEqual(
        report.desktop[state].cut,
        report.original[state].cut,
        `${state}: 剪刀与选区`,
      );
    for (const field of ["nodes", "viewport", "edge"])
      assert.deepEqual(
        report.desktop[state][field],
        report.original[state][field],
        `${state}: ${field}`,
      );
    assert.equal(report.original[state].nodes.length, graph.nodes.length);
    assert.match(report.original[state].edge, /^M/);
  }
  if (looseLink) {
    assert.deepEqual(report.desktop.looseLink, report.original.looseLink);
  } else if (groupTools) {
    assert.deepEqual(report.desktop.group, report.original.group);
  } else if (arrange) {
    assert.deepEqual(report.desktop.arrange, report.original.arrange);
  } else if (backfillEdge) {
    assert.equal(
      report.desktop.generating.cut.buttons[0].distance,
      report.desktop.completed.cut.buttons[0].distance,
    );
  } else if (cutEdge) {
    assert.equal(report.original.restoredEdge.edge, report.original.idleEdge.edge);
  } else if (failedText) {
    assert.deepEqual(report.desktop.failed.parts, report.original.failed.parts);
  } else if (emptyText) {
    assert.deepEqual(report.desktop.empty.content, report.original.empty.content);
    assert.equal(report.desktop.empty.wheelViewport, report.original.empty.wheelViewport);
  } else if (markdown) {
    for (const state of ["top", "bottom"])
      assert.deepEqual(
        report.desktop[state].body,
        report.original[state].body,
        `${state}: 正文滚动与布局`,
      );
  } else if (!clipboard) {
    assert.deepEqual(
      report.original.idle.nodes.map((node) => node.selected),
      [false, false],
    );
    assert.deepEqual(
      report.original.selected.nodes.map((node) => node.selected),
      [true, false],
    );
    assert.notDeepEqual(
      report.original.selected.nodes[0].rect,
      report.original.dragged.nodes[0].rect,
    );
  }
  if (process.argv.includes("--strict")) {
    if (crossClipboard)
      assert.deepEqual(report.desktop.cross.selectionTools, report.original.cross.selectionTools);
    assert(Object.values(report.frames).every((value) => value === 0));
    assert(
      Object.keys(report.frames).every(
        (state) =>
          report.original[state].consecutive >= 3 && report.desktop[state].consecutive >= 3,
      ),
    );
  }
} finally {
  try {
    await writeFile(join(directory, "results.json"), JSON.stringify(report, null, 2));
  } finally {
    try {
      if (referenceWindowId)
        await app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(),
          referenceWindowId,
        );
    } finally {
      try {
        provider?.close();
        await Promise.all([browser?.close(), server?.close(), app?.close()]);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  }
}
