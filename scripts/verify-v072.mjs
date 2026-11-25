import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { readRenderedText } from "./read-rendered-text.mjs";

export async function replayRelease(page, width) {
  await mkdir("test-results/v072", { recursive: true });
  const drama = width === 1440;
  await page.evaluate(
    (kind) => {
      localStorage.setItem("test-project", "迁移回放");
      localStorage.setItem("project-kind", kind);
    },
    drama ? "drama" : "canvas",
  );
  await page.reload();
  await page.evaluate(async () => {
    const ok = (value) => ({ ok: true, value: structuredClone(value) });
    const service = window.desktop.projects;
    const prompt = "Track the light slowly across the station.";
    const sourceHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const episode = {
      episode_no: 1,
      title: "车站",
      script_md: "进站。",
      locked: true,
      storyboard_status: "ready",
      synopsis: "进站",
    };
    const segment = { id: "clip", episode_no: 1, seq: 0, seconds: 5, revision: 1, prompt };
    const doc = {
      revision: 1,
      title: "迁移回放",
      ratio: "9:16",
      outline_md: "进站",
      characters_md: "",
      episodes: [episode],
      segments: [segment],
    };
    const board = {
      id: "board",
      type: "creative",
      position: { x: 100, y: 100 },
      data: {
        kind: "image",
        label: "故事板",
        text: "原提示词",
        assetId: "old",
        drama: {
          episodes: [1],
          board: { segmentId: "clip", shotCount: 2, layout: "2x2", sourceHash },
        },
      },
    };
    const source = {
      id: "source",
      type: "creative",
      position: { x: 750, y: 125 },
      data: {
        kind: "image",
        label: "车站外景",
        text: "上游文字",
        drama: {
          type: "scene",
          episodes: [1],
          name: "车站外景",
          look: "",
          description: "",
          aliases: [],
        },
      },
    };
    const canvas = {
      nodes: [board, source],
      edges: [{ id: "edge", source: "source", target: "board" }],
      viewport: { x: 20, y: 50, zoom: 0.65 },
    };
    const assets = ["old", "new"].map((assetId) => ({
      assetId,
      mediaType: "image",
      displayName: `${assetId}.png`,
      availability: "ready",
      metadata: { width: 160, height: 90 },
      mimeType: "image/png",
      createdAt: "2026-11-22",
    }));
    const state = { canvas, assets, jobs: [], rev: 1 };
    window.releaseState = state;
    const view = () => ({ canvas, canvasRevision: state.rev, revision: state.rev });
    service.drama = async () => ok(doc);
    service.getCanvas = async () => ok(view());
    service.listAssets = async () => ok({ assets });
    service.listLibrary = async () => ok({ items: [], folders: [] });
    service.listJobs = async () => ok({ ...view(), jobs: state.jobs });
    service.submitJob = async ({ generation }) => {
      state.submission = generation;
      return ok({});
    };
    service.getAssetPreview = async ({ assetId }) =>
      ok({
        url: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYTsAAAAASUVORK5CYII=#${assetId}`,
      });
    service.applyCanvasOperations = async ({ operations }) => {
      if (state.hold)
        await new Promise((resolve) => {
          state.resume = resolve;
        });
      for (const op of operations) {
        if (op.type === "putNode")
          canvas.nodes[canvas.nodes.findIndex((node) => node.id === op.node.id)] = op.node;
        if (op.type === "setViewport") canvas.viewport = op.viewport;
      }
      state.rev++;
      return ok(view());
    };
    window.desktop.settings.list = async () =>
      ok({
        plugins: [
          { hash: "fixture", key: "doubao-video", kind: "video", origin: "builtin", auth: "none" },
        ],
        providers: [
          {
            id: "video",
            revision: 1,
            enabled: true,
            label: "视频",
            pluginHash: "fixture",
            model: "doubao-seedance-2-0",
            channel: {},
            config: { kind: "video", name: "视频", promptFormat: "seedance" },
          },
        ],
      });
  });
  await page.getByRole("button", { name: /迁移回放.*本地素材/ }).click();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const card = page.locator('.react-flow__node[data-id="board"]');
  if (!drama) {
    await card.click();
    const toolbar = page.getByRole("toolbar", { name: "故事板 的功能区" });
    await expect(toolbar.getByRole("button").last()).toHaveAccessibleName("加入资产库");
    await toolbar.screenshot({ path: "test-results/v072/image-toolbar.png" });
    await button("从资产库替换").click();
    await button("new.png").click();
    await button("替换主图").click();
    await page.waitForFunction(() => window.releaseState.canvas.nodes[0].data.assetId === "new");
    await button("历史记录，共 2 版").click();
    await button("第 1 版").click();
    await page.waitForFunction(() => window.releaseState.canvas.nodes[0].data.assetId === "old");
    const state = await page.evaluate(() => window.releaseState.canvas);
    assert.equal(state.nodes[0].data.text, "原提示词");
    assert.equal(state.nodes[0].data.uploaded, undefined);
    assert.equal(state.edges.length, 1);
    console.log("通过：选图替换、旧图切回及保存");
    return;
  }
  const stage = (name) => page.getByRole("tab", { name, exact: true });
  const face = (name) =>
    page.getByRole("group", { name: "视图" }).getByRole("button", { name, exact: true });
  await stage("片场").click();
  const line = button("故事板说明");
  await expect(line).toContainText("ignore panels 3-4");
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await line.click();
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await line.screenshot({ path: "test-results/v072/board-line-en.png" });
  const instruction = await readRenderedText(line);
  await button("立即生成").click();
  await page.waitForFunction(() => !!window.releaseState.submission);
  const submitted = await page.evaluate(() => window.releaseState.submission);
  assert.equal(
    submitted.prompt,
    `${instruction.trim()}\nTrack the light slowly across the station.`,
  );
  assert.deepEqual(submitted.referenceAssetIds, ["old"]);
  await page.getByRole("button", { name: "故事板" }).click();
  await face("画布").click();
  await page.evaluate(() => {
    window.releaseState.jobs = [
      {
        id: "task",
        kind: "image",
        purpose: "drama-board",
        nodeId: "board",
        status: "running",
        progress: 25,
        outputs: [],
      },
    ];
  });
  await face("片场").click();
  await expect(page.getByText("故事板生成中 · 25%", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window.releaseState;
    state.canvas.nodes[0].data.assetId = "new";
    state.jobs[0].status = "succeeded";
    state.rev++;
  });
  await expect(page.getByAltText("片段 1 的故事板")).toHaveAttribute("src", /#new$/);
  await stage("资产管理").click();
  await face("画布").click();
  await page.locator('.react-flow__node[data-id="source"] header strong').dblclick();
  const field = page.getByRole("textbox", { name: "节点名称" });
  await field.fill("刚改的新名字");
  await page.evaluate(() => {
    window.releaseState.hold = true;
  });
  await field.press("Enter");
  await stage("片场").click();
  await page.waitForFunction(() => !!window.releaseState.resume);
  await expect(stage("资产管理")).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => {
    const state = window.releaseState;
    state.hold = false;
    state.resume();
  });
  await expect(stage("片场")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByLabel("资产库", { exact: true }).getByText("刚改的新名字", { exact: true }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(() => window.releaseState.canvas.nodes[1].data.label),
    "刚改的新名字",
  );
  console.log("通过：英文故事板说明、画布任务切回后自动出图、跨工序等待保存");
}
