import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { SettingsRegistry } from "../src/main/settings/registry.ts";
import {
  createSkillRows,
  listResponse,
  replaySkillList,
  skillGeometry,
} from "./settings-skills-list-path.mjs";
import { openSettingsPage } from "./verify-settings-rollback.mjs";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = path.resolve("../video-canvas");
const output = path.resolve("test-results/settings-skills-window");
const temp = await mkdtemp(path.join(tmpdir(), "settings-skills-window-"));
const root = path.join(temp, "web");
const options = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  colorScheme: "light",
};
const noModel = "暂时没有可用的 Agent 模型";
const requireTest = createRequire(import.meta.resolve("@playwright/test"));
const { PNG } = createRequire(requireTest.resolve("playwright"))("playwright-core/lib/utilsBundle");
const endpoints = new Map(
  Object.entries({
    "/admin/ai/me": { role: "super_admin", user_id: 1 },
    "/me": { id: 1, username: "fixture", role: "super_admin" },
    "/agent/models": [],
    "/admin/assistant/sessions": [],
    "/ws/ticket": { ticket: "fixture" },
    "/credits": { balance: 0 },
    "/generation-tasks": [],
    "/payment/store": { enabled: false, products: [], methods: [] },
    "/admin/system/updates": { enabled: false, dev_build: true, current: "dev", has_update: false },
  }),
);
const requested = new Set();
let browser, registry;
try {
  await mkdir(output, { recursive: true });
  execFileSync("git", [
    "-C",
    reference,
    "archive",
    "-o",
    path.join(temp, "web.tar"),
    revision,
    "web",
  ]);
  execFileSync("tar", ["-xf", path.join(temp, "web.tar"), "-C", temp]);
  await symlink(path.join(reference, "web/node_modules"), path.join(root, "node_modules"), "dir");
  execFileSync(path.join(root, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: root,
    env: { ...process.env, VITE_API_BASE_URL: "/api/v1" },
  });
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--allow-file-access-from-files"],
  });
  const baseline = await browser.newPage(options);
  await baseline.addInitScript(() => {
    localStorage.setItem("video_design_token", "fixture");
    localStorage.setItem(
      "video-design-settings",
      JSON.stringify({ state: { theme: "light" }, version: 0 }),
    );
  });
  const unexpected = [],
    errors = [];
  let skillRows = [];
  baseline.on("pageerror", (error) => errors.push(error.message));
  await baseline.routeWebSocket("**/*", () => {});
  await baseline.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://fixture.local") {
      if (url.pathname.startsWith("/api/v1/")) {
        const endpoint = url.pathname.slice(7);
        requested.add(endpoint);
        if (
          endpoint.endsWith("/versions/1/files") &&
          (route.request().method() !== "GET" || url.searchParams.get("path") !== "SKILL.md")
        ) {
          unexpected.push(`${route.request().method()} ${url.pathname}${url.search}`);
          return route.abort();
        }
        if (endpoint === "/admin/agent/skills")
          return route.fulfill({
            json: { code: 0, msg: "ok", data: listResponse(skillRows, url.searchParams) },
          });
        if (endpoints.has(endpoint))
          return route.fulfill({ json: { code: 0, msg: "ok", data: endpoints.get(endpoint) } });
      } else if (url.pathname === "/admin/agent/skills")
        return route.fulfill({ path: path.join(root, "dist/index.html") });
      else if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.svg")
        return route.fulfill({ path: path.join(root, "dist", url.pathname) });
    }
    unexpected.push(url.pathname);
    await route.abort();
  });
  await baseline.goto("http://fixture.local/admin/agent/skills");
  await expect(baseline.getByText("没有符合条件的技能", { exact: true })).toBeVisible();
  await baseline.getByRole("button", { name: "小镜", exact: true }).click();
  await expect(baseline.getByText(noModel, { exact: true })).toBeVisible();
  assert.equal(
    await baseline.locator("html").evaluate((root) => root.classList.contains("dark")),
    false,
  );
  await expect(baseline.locator("[data-admin-root][data-entering]")).toHaveCount(0);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  for (const endpoint of ["/admin/agent/skills", "/agent/models"])
    assert.ok(requested.has(endpoint));

  registry = await SettingsRegistry.open(
    path.join(temp, "desktop"),
    "resources/provider-plugins",
    "out/provider-runtime/runner",
    {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => Buffer.from(value).toString(),
    },
  );
  registry.canvasView({ theme: "light" });
  const allowed = new Set([
    "list",
    "channelList",
    "channelLoads",
    "canvasView",
    "agentLayout",
    "agentPreferences",
  ]);
  const rpc = async (method, input) => {
    if (method === "agentList") return { ok: true, value: [] };
    assert.ok(allowed.has(method), method);
    return { ok: true, value: await registry[method](input) };
  };
  const desktop = await openSettingsPage(browser, rpc);
  await desktop.getByRole("button", { name: "技能管理", exact: true }).click();
  await expect(desktop.getByRole("button", { name: "切换到深色", exact: true })).toBeVisible();
  await expect(desktop.getByText("共 0 个", { exact: true })).toBeVisible();
  await desktop.getByRole("button", { name: "设置助手", exact: true }).click();
  await expect(desktop.getByText(noModel, { exact: true })).toBeVisible();
  const panels = [],
    labels = [],
    images = [],
    geometry = {};
  for (const [side, page, name] of [
    ["baseline", baseline, "小镜"],
    ["desktop", desktop, "小灵设置助手"],
  ]) {
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const panel = page.getByRole("complementary", { name, exact: true });
    panels.push(await panel.locator(":scope > div").first().boundingBox());
    labels.push(await page.getByText(noModel, { exact: true }).boundingBox());
    geometry[side] = await skillGeometry(page, side === "desktop");
    images.push(
      PNG.sync.read(
        await page.screenshot({ path: path.join(output, `${side}.png`), animations: "disabled" }),
      ),
    );
  }
  const pixels = (images, left, top, width, height) => {
    let changed = 0;
    for (let row = top; row < top + height; row++)
      for (let col = left; col < left + width; col++) {
        const offset = (row * images[0].width + col) * 4;
        if (images[0].data.readUInt32LE(offset) !== images[1].data.readUInt32LE(offset)) changed++;
      }
    return { changed, total: width * height };
  };
  for (const image of images) assert.deepEqual([image.width, image.height], [1280, 720]);
  async function savePair(images, filename) {
    const { width, height } = images[0];
    assert.deepEqual([images[1].width, images[1].height], [width, height]);
    const pair = new PNG({ width: width * 2, height });
    for (const [index, image] of images.entries())
      PNG.bitblt(image, pair, 0, 0, width, height, index * width, 0);
    await writeFile(path.join(output, filename), PNG.sync.write(pair));
  }
  await savePair(images, "pair.png");
  const drawerAligned = JSON.stringify(panels[0]) === JSON.stringify(panels[1]);
  const { x, y, width, height } = panels[0];
  const report = {
    revision,
    options,
    browser: browser.version(),
    state: "空技能列表、无 Agent 模型、无会话、抽屉展开",
    panels,
    geometry,
    labels,
    full: pixels(images, 0, 0, 1280, 720),
    drawer: drawerAligned ? pixels(images, x, y, width, height) : null,
    requested: [...requested],
  };
  assert.deepEqual(panels[1], panels[0]);
  assert.deepEqual(labels[1], labels[0]);
  const nav = desktop.getByRole("navigation", { name: "设置分类" });
  await expect(nav.getByRole("button", { name: "技能管理" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  assert.ok(
    (await nav.boundingBox()).y + (await nav.boundingBox()).height <= geometry.desktop.panel.y,
  );
  await expect(desktop.getByRole("button", { name: "切换设置侧栏" })).toHaveCount(0);
  const trigger = desktop.getByRole("button", { name: "设置助手", exact: true });
  await desktop.setViewportSize({ width: 1080, height: 720 });
  await expect
    .poll(async () => (await desktop.locator(".channel-settings-body").boundingBox()).width)
    .toBe(612);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await desktop.setViewportSize({ width: 767, height: 580 });
  await desktop.getByRole("button", { name: "收起设置助手", exact: true }).click();
  await expect(trigger).toBeFocused();
  const fixture = createSkillRows();
  skillRows = fixture.map((row) => row.baseline);
  const record = fixture.find((row) => row.desktop.name === "fixture-003");
  const file = record.desktop.versions[0].files[0];
  const preview = { ...file, text: record.content, binary: false, truncated: false };
  const version = {
    ...record.baseline,
    version: 1,
    active: true,
    sha256: "a".repeat(64),
    created_by: 1,
    created_at: record.baseline.updated_at,
  };
  const detail = "/admin/agent/skills/fixture-003";
  endpoints.set(detail, { ...record.baseline, versions: [version] });
  endpoints.set(detail + "/versions/1", {
    ...version,
    frontmatter: {},
    body: record.content,
    files: [file],
    issues: [],
  });
  endpoints.set(detail + "/versions/1/files", preview);
  await baseline.reload();
  const populated = await openSettingsPage(
    browser,
    rpc,
    fixture.map((row) => row.desktop),
    { "fixture-003/1/SKILL.md": preview },
  );
  populated.on("pageerror", (error) => errors.push(error.message));
  await populated.getByRole("button", { name: "技能管理", exact: true }).click();
  const [referencePath, desktopPath] = await Promise.all([
    replaySkillList(baseline),
    replaySkillList(populated),
  ]);
  assert.deepEqual(desktopPath, referencePath);
  const listImages = [];
  for (const [side, page, triggerName] of [
    ["baseline", baseline, "小镜"],
    ["desktop", populated, "设置助手"],
  ]) {
    await page.getByRole("button", { name: triggerName, exact: true }).click();
    await expect(page.getByText(noModel, { exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    listImages.push(
      PNG.sync.read(
        await page.screenshot({
          path: path.join(output, `${side}-populated.png`),
          animations: "disabled",
        }),
      ),
    );
  }
  await savePair(listImages, "pair-populated.png");
  report.skillList = {
    fixtureSize: fixture.length,
    checkpoints: desktopPath,
    state: "短剧筛选、搜索为空、第 1 页、每页 30 条、助手展开",
    full: pixels(listImages, 0, 0, 1280, 720),
  };
  const mobileImages = [];
  report.rows = {};
  for (const [side, page, triggerName] of [
    ["baseline", baseline, "小镜"],
    ["desktop", populated, "设置助手"],
  ]) {
    const row = page.locator('[data-skill-name="fixture-003"]');
    const pending = page.locator('[data-skill-name="fixture-006"]');
    await expect(page.getByRole("columnheader")).toHaveText([
      "技能",
      "说明",
      "用在哪里",
      "版本",
      "更新",
    ]);
    const cells = row.getByRole("cell");
    await expect(cells).toHaveText([
      "分镜 003fixture-003",
      "独有的连戏说明",
      "视频",
      "v1",
      "2026-01-01",
    ]);
    const date = await cells.last().locator("[title]").getAttribute("title");
    assert.match(date, /^2026-01-01 \d\d:\d\d$/);
    await expect(pending.getByTitle("画布 Agent", { exact: true })).toHaveText("画布 Agent");
    await expect(pending.getByTitle("短剧 · 视频提示词", { exact: true })).toHaveText("视频");
    await expect(pending.getByText("v2 待生效", { exact: true })).toBeVisible();
    report.rows[side] = {
      date,
      cells: await Promise.all((await cells.all()).map((cell) => cell.boundingBox())),
    };
    await page.getByRole("button", { name: triggerName, exact: true }).click();
    const dialog = page.getByRole("dialog");
    async function verifyDetail() {
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("分镜 003");
      await expect(dialog).toContainText("独有的连戏说明");
      await expect(dialog).toContainText("SKILL.md");
      await expect(
        dialog.locator(
          side === "baseline" ? '[data-slot="file-preview"]' : ".skill-file-preview pre",
        ),
      ).toContainText("对照上一镜的道具位置。");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(
        page
          .getByRole("group", { name: "状态筛选" })
          .getByRole("button", { name: "短剧", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    }
    await row.press("Enter");
    await verifyDetail();
    const mobile = { width: 390, height: 700 };
    await page.setViewportSize(mobile);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(row).toHaveRole("button");
    await expect(row).toContainText("独有的连戏说明");
    await expect(pending).toContainText("v2 待生效");
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const card = await row.boundingBox();
    report.rows[side].mobileCard = card;
    report.rows[side].mobileFooter = await page
      .locator(side === "baseline" ? '[data-slot="data-panel-footer"]' : ".skills-pagination")
      .boundingBox();
    assert.ok(
      card.x >= 0 && card.x + card.width <= mobile.width,
      `${side} card: ${JSON.stringify(card)}`,
    );
    mobileImages.push(
      PNG.sync.read(
        await page.screenshot({
          path: path.join(output, `${side}-mobile.png`),
          animations: "disabled",
        }),
      ),
    );
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.locator("[data-skill-name]:visible")).toHaveCount(10);
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(page.locator("[data-skill-name]:visible")).toHaveCount(30);
    if (side === "baseline") {
      const railTrigger = page.getByRole("button", { name: "Toggle Sidebar", exact: true });
      await railTrigger.click();
      await dialog.getByRole("link", { name: "技能", exact: true }).click();
    } else {
      await page
        .getByRole("navigation", { name: "设置分类" })
        .getByRole("button", { name: "技能管理" })
        .click();
    }
    await expect(dialog).toBeHidden();
    const filters = page.getByRole("group", { name: "状态筛选" });
    await expect(filters.getByRole("button", { name: "全部", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("[data-skill-name]:visible")).toHaveCount(30);
    await filters.getByRole("button", { name: "短剧", exact: true }).click();
    await page.keyboard.press("/");
    const search = page.getByRole("searchbox", { name: "搜索名称或说明（/）" });
    await expect(search).toBeFocused();
    await search.fill("连戏");
    await expect(page.locator("[data-skill-name]:visible")).toHaveCount(1);
    await row.click();
    await verifyDetail();
    await expect(row).toBeVisible();
    await expect(search).toHaveValue("连戏");
    if (side === "desktop") {
      await page.setViewportSize(options.viewport);
      await expect(dialog).toBeHidden();
      await expect(row).toHaveRole("row");
    }
  }
  assert.equal(report.rows.desktop.date, report.rows.baseline.date);
  await savePair(mobileImages, "pair-mobile.png");
  report.mobile = {
    state: "短剧筛选、每页 30 条、助手收起、390×700",
    full: pixels(mobileImages, 0, 0, 390, 700),
  };
  report.requested = [...requested];
  assert.ok(requested.has(detail + "/versions/1/files"));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--require-match")) {
    assert.equal(report.full.changed, 0, "空库整窗");
    assert.equal(report.skillList.full.changed, 0, "有数据整窗");
    assert.equal(report.mobile.full.changed, 0, "窄屏整窗");
  }
} finally {
  await browser?.close();
  registry?.close();
  await rm(temp, { recursive: true, force: true });
}
