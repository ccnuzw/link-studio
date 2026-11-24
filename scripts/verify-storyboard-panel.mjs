import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { build } from "vite";

const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router';
import {ReactFlowProvider} from '@xyflow/react';
import {TooltipProvider} from '@/components/ui/tooltip';
import {CanvasEditor} from '@/components/canvas-editor/canvas-editor';
import './src/index.css';
const canvas={id:'1001',title:'分镜往返',revision:1,graph:window.graph};
createRoot(document.querySelector('main')).render(<MemoryRouter><TooltipProvider><ReactFlowProvider><CanvasEditor canvas={canvas} recovery={null} onConflict={()=>{}} menuItems={()=>[]}/></ReactFlowProvider></TooltipProvider></MemoryRouter>);`;

const model = {
  key: "audit-video",
  label: "视频回放模型",
  kind: "video",
  pricing: { billing: "per_call", unit: 0 },
  capabilities: {
    ops: ["t2v", "i2v"],
    refs: {
      image: { on: true, max: 1, max_mb: 10 },
      video: { on: false, max: 0, max_mb: 0 },
      audio: { on: false, max: 0, max_mb: 0 },
    },
    prompt: { max_length: 2000 },
    params: {
      duration: {
        type: "number",
        label: "时长",
        open: true,
        min: 4,
        max: 12,
        step: 2,
        default: 4,
        unit: "秒",
      },
    },
  },
};

export async function captureSettledPanel(panel, path) {
  await panel.evaluate(async (element) => {
    await document.fonts.ready;
    await Promise.all([...element.querySelectorAll("img")].map((image) => image.decode()));
  });
  let previous;
  let stable = 0;
  for (let sample = 0; sample < 20; sample++) {
    const png = await panel.screenshot({ animations: "disabled" });
    stable = previous?.equals(png) ? stable + 1 : 1;
    if (stable === 3) {
      writeFileSync(path, png);
      return png;
    }
    previous = png;
  }
  throw new Error(`面板未稳定：${path}`);
}

export async function verifyStoryboardPanel(browser, web, graph) {
  writeFileSync(join(web, "panel.tsx"), entry);
  writeFileSync(
    join(web, "panel.html"),
    '<!doctype html><meta charset="utf-8"><main></main><script type="module" src="/panel.tsx"></script>',
  );
  const tailwind = await import(createRequire(join(web, "panel.tsx")).resolve("@tailwindcss/vite"));
  await build({
    root: web,
    configFile: false,
    logLevel: "error",
    plugins: [tailwind.default()],
    define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/api/v1") },
    resolve: { alias: { "@": join(web, "src") } },
    oxc: { jsx: { runtime: "automatic" } },
    build: { outDir: "panel-dist", rollupOptions: { input: join(web, "panel.html") } },
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  const requests = [];
  const errors = [];
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((graph) => {
      window.graph = graph;
    }, graph);
    await page.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== "http://localhost") return route.abort();
      if (url.pathname === "/panel.html")
        return route.fulfill({ path: join(web, "panel-dist/panel.html") });
      if (url.pathname === "/assets/42")
        return route.fulfill({
          path: fileURLToPath(new URL("../resources/icons/icon-32.png", import.meta.url)),
        });
      if (url.pathname.startsWith("/assets/"))
        return route.fulfill({ path: join(web, "panel-dist/assets", basename(url.pathname)) });
      const ok = (data) => route.fulfill({ json: { code: 0, msg: "ok", data } });
      if (url.pathname === "/api/v1/models")
        return ok(url.searchParams.get("kind") === "video" ? [model] : []);
      if (url.pathname === "/api/v1/generation-tasks" && request.method() === "POST") {
        requests.push(request.postDataJSON());
        return route.fulfill({ status: 400, json: { code: 400, msg: "回放结束，未调用模型" } });
      }
      if (url.pathname === "/api/v1/canvas/1001" && request.method() === "PUT")
        return ok({
          revision: request.postDataJSON().revision + 1,
          updated_at: "2026-11-23T10:00:00Z",
        });
      return route.abort();
    });
    await page.goto("http://localhost/panel.html");
    await page
      .locator('.react-flow__node[data-id="video"]')
      .click({ position: { x: 16, y: 24 }, timeout: 8000 });
    const submit = page.getByRole("button", { name: "开始生成", exact: true });
    await expect(page.getByRole("tab", { name: "图生视频" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("button", { name: "生成参数" })).toHaveText("8秒");
    await expect(
      page.locator('[contenteditable="true"]').filter({ hasText: "列车进站" }),
    ).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(
      page.getByText("图生方式需要至少 1 张参考图片", { exact: true }).first(),
    ).toBeVisible();
    assert.equal(requests.length, 0);
    await page.getByRole("button", { name: "引用画布里的素材", exact: true }).click();
    await page.getByRole("menuitem", { name: /月台分镜图/ }).click();
    await expect(submit).toBeEnabled();
    const panel = page
      .locator(".bg-panel")
      .filter({ has: submit })
      .filter({ has: page.getByRole("tablist", { name: "生成方式" }) })
      .last();
    const output = fileURLToPath(new URL("../test-results/storyboard-readback/", import.meta.url));
    mkdirSync(output, { recursive: true });
    await page.mouse.move(1, 1);
    const capture = join(output, "upstream-ready.png");
    await captureSettledPanel(panel, capture);
    console.log(capture);
    assert.equal(requests.length, 0);
    await submit.click();
    await expect(page.getByText("回放结束，未调用模型", { exact: true }).first()).toBeVisible();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      kind: "video",
      model_id: model.key,
      canvas_id: "1001",
      node_id: "video",
      node_ids: ["video"],
      input: { op: "i2v", duration: 8, prompt: "列车进站", images: [42] },
    });
    assert.deepEqual(errors, []);
    console.log(
      "固定版面板通过：图生视频、8秒、列车进站；缺图禁用，补图后确认前 0 次，确认后 1 次：",
      JSON.stringify(requests[0]),
    );
    return { capture, request: requests[0] };
  } catch (error) {
    console.error({
      errors,
      requests,
      panel: (await page.locator("body").textContent())?.slice(-1500),
    });
    throw error;
  } finally {
    await page.close();
  }
}
