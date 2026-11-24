import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const upstream = resolve(process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web"),
  root = process.cwd(),
  out = resolve("test-results/home-assets");
const sql = execFileSync(
  "git",
  ["-C", upstream, "show", "ff4070c7:backend/migrations/0044_official_voices.sql"],
  { encoding: "utf8" },
);
assert.equal(
  execFileSync("git", ["-C", upstream, "rev-parse", "--short=8", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  "ff4070c7",
);
const catalog = JSON.parse(await readFile("src/renderer/settings/official-voices.json", "utf8"));
assert.equal(catalog.length, 181);
for (const voice of catalog) {
  const bytes = await readFile(resolve("src/renderer/public/official-voices", basename(voice.url)));
  const row = sql.split("\n").find((row) => row.includes(basename(voice.url)));
  assert.ok(
    row?.includes(createHash("sha256").update(bytes).digest("hex")) &&
      row.includes(voice.avatar) &&
      row.includes(`'${voice.age}', '${voice.gender}', '${voice.lang}'`),
  );
  assert.equal(voice.wave.length, 112);
}
const entries = catalog.map((voice) => ({
  kind: "audio",
  id: voice.url,
  fileName: voice.name,
  url: "/official-voices/" + basename(voice.url),
  thumbnailUrl: "/official-voices/" + voice.avatar,
  voiceAge: voice.age,
  voiceGender: voice.gender,
  voiceLang: voice.lang,
}));
const temp = await mkdtemp(join(tmpdir(), "home-assets-"));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const snapshots = new Map();
try {
  for (const baseline of [true, false]) {
    const entry = "/src/__home_asset_test.tsx",
      source = baseline ? upstream : root;
    const server = await createServer({
      root: source,
      publicDir: resolve("src/renderer/public"),
      cacheDir: join(temp, baseline ? "original" : "studio"),
      configFile: false,
      resolve: { alias: { "@": join(source, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        ...(baseline
          ? [
              (
                await import(
                  createRequire(join(upstream, "package.json")).resolve("@tailwindcss/vite")
                )
              ).default(),
            ]
          : []),
        {
          name: "asset-test",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return id;
            if (
              baseline &&
              (id === "@/api/official-voice" || id.endsWith("/src/api/official-voice"))
            )
              return "\0catalog-fixture";
          },
          load(id) {
            if (id === "\0catalog-fixture")
              return `const rows=${JSON.stringify(entries)};export const peekOfficialVoices=()=>rows,listAllOfficialVoices=async()=>rows,listOfficialVoices=async()=>({items:rows,total:rows.length});`;
            if (id === entry)
              return `import {createRoot} from 'react-dom/client';${baseline ? `import '/src/index.css';import {OfficialView} from '/src/pages/assets/official-view';import {HistoryAssetCard} from '/src/components/assets/asset-card';import {AssetPreview} from '/src/components/assets/asset-preview';import {AssetMasonry} from '/src/components/assets/asset-grid';import {useState} from 'react';const entries=['海岸','夜空'].map((label,index)=>({id:String(index),label,asset:{id:String(index),fileName:label+'.png',kind:'image',url:'${entries[0].thumbnailUrl}',width:300,height:200}}));function History(){const [id,set]=useState(null);return <><AssetMasonry>{entries.map(e=><HistoryAssetCard key={e.id} item={{asset:e.asset,prompt:e.label,canvas:{id:'demo'},libraryItemId:null,modelLabel:'示例模型',createdAt:'2026-10-05'}} natural onPreview={()=>set(e.id)} onAddToLibrary={()=>{}} onOpenCanvas={()=>{}} />)}</AssetMasonry><AssetPreview entries={entries} targetId={id} onTargetChange={set} onClose={()=>set(null)}/></>}const ui=location.hash==='#history-audit'?<History/>:<OfficialView/>;` : `import '/src/renderer/styles.css';import '/src/renderer/desktop-shell.css';import {GlobalAssets} from '/src/renderer/workspace/global-assets';const ui=<div className="home-sheet" style={{height:'100vh',border:0}}><header>Link Studio</header><GlobalAssets resume={()=>{}} settings={()=>{}}/></div>;`}createRoot(document.querySelector('main')).render(ui)`;
          },
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          colorScheme: theme,
          viewport: { width: 1100, height: 820 },
          reducedMotion: "reduce",
        });
        page.setDefaultTimeout(7000);
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.route(origin + "audit", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html class="${theme}"><meta charset=utf-8><style>body{margin:0}main{width:1000px;margin:auto}main .global-assets{padding:0}</style><main></main><script type=module src="${entry}"></script>`,
          }),
        );
        const png = await readFile(
          join(root, "src/renderer/public/official-voices", catalog[0].avatar),
        );
        await page.route("link-media://global-assets/**", (route) =>
          route.fulfill({ body: png, contentType: "image/png" }),
        );
        await page.addInitScript(() => {
          const ok = (value) => Promise.resolve({ ok: true, value });
          const items = ["海岸", "夜空"].map((name, i) => ({
            id: `00000000-0000-4000-8000-00000000000${i}`,
            name: name + ".png",
            prompt: name,
            saved: false,
            createdAt: "2026-10-05",
            model: "示例模型",
            aspect: 1.5,
            canvasId: "demo",
          }));
          const folders = [{ id: "folder", name: "角色", createdAt: "2026-10-05", itemCount: 1 }];
          const rows = [
            {
              folderId: "folder",
              asset: {
                mediaType: "image",
                assetId: items[0].id,
                displayName: "海岸.png",
                metadata: { width: 300, height: 200 },
              },
            },
          ];
          const channel = {
            id: "channel",
            name: "测试渠道",
            revision: 1,
            filing: { enabled: true },
            hasFilingKeys: true,
          };
          const members = [
            {
              id: "image",
              humanId: "actor",
              humanName: "演员",
              name: "封面",
              status: "active",
              cover: true,
              refs: [],
              order: 0,
            },
          ];
          const retries = new Set();
          window.desktop = {
            dialogs: {
              dropGlobalAsset: async (file, operationId) => {
                if (!retries.has(file.name)) {
                  retries.add(file.name);
                  return { ok: false, error: { message: "测试读取失败" } };
                }
                return ok({ imported: true });
              },
            },
            settings: {
              channelList: () => ok([channel]),
              filingAssets: () => ok(members),
              filingPreview: () => ok(null),
            },
            projects: {
              saveAssetCopy: (input) => {
                window.lastSave = input;
                return ok({ saved: true });
              },
              listLibraryFolders: () => ok(folders),
              collectHistory: () => ok({ saved: true }),
              createLibraryFolder: ({ name }) => {
                folders.push({ id: "added", name, createdAt: "2026-10-06", itemCount: 0 });
                return ok({});
              },
              filingLibraryPage: () => ok({ page: "fixture", selected: { choice: "image" } }),
              filingLibraryClose: () => ok({}),
              globalHistory: () => ok({ items, canvases: [{ id: "demo", name: "测试画布" }] }),
              globalLibrary: () => ok({ items: rows, folders }),
            },
          };
        });
        await page.goto(origin + "audit#assets?tab=official");
        const cards = page.locator(
          baseline ? '[data-slot="official-voice-card"]' : ".home-voice-card",
        );
        await expect(cards.first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const geometry = await cards.first().evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [Math.round(r.width), Math.round(r.height), el.getAttribute("aria-label")];
        });
        if (baseline) snapshots.set(theme, geometry);
        else assert.deepEqual(geometry, snapshots.get(theme));
        async function filter(name, label) {
          await page.getByRole("button", { name, exact: true }).click();
          if (name === "语言" && label === "English")
            assert.equal(
              await page
                .getByRole(baseline ? "button" : "menuitemradio", { name: label, exact: true })
                .evaluate((el) => el.offsetHeight),
              40,
            );
          await page
            .getByRole(baseline ? "button" : "menuitemradio", { name: label, exact: true })
            .click();
        }
        await filter("语言", "English");
        await filter("人群", "女孩");
        const input = page.getByRole("textbox", { name: "搜索音色名称" });
        await input.fill("少年");
        await expect(cards.first()).toHaveAttribute("aria-label", "Shiny");
        const first = await cards.first().getAttribute("aria-label");
        if (baseline) snapshots.set(theme + "name", first);
        else assert.equal(first, snapshots.get(theme + "name"));
        await input.fill("nothing-matches-123");
        await expect(cards).toHaveCount(0);
        await input.press("Escape");
        await expect(cards.first()).toBeVisible();
        await cards.first().click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await expect
          .poll(() => dialog.locator("audio").evaluate((el) => el.duration))
          .toBeGreaterThan(0);
        await expect
          .poll(() => dialog.locator("audio").evaluate((el) => el.currentTime))
          .toBeGreaterThan(0);
        await dialog.screenshot({
          path: join(out, `${baseline ? "baseline" : "studio"}-${theme}-audio.png`),
        });
        await dialog.getByRole("button", { name: "暂停", exact: true }).click();
        await expect.poll(() => dialog.locator("audio").evaluate((el) => el.paused)).toBe(true);
        await dialog.getByRole("slider").press("Home");
        await dialog.getByRole("slider").press("ArrowRight");
        await expect
          .poll(() => dialog.locator("audio").evaluate((el) => el.currentTime))
          .toBeGreaterThanOrEqual(1);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        if (baseline) {
          await page.goto(origin + "audit#history-audit");
          await page.reload();
          const card = page.locator('[data-slot="history-card"]').first();
          await card.hover();
          await card.screenshot({ path: join(out, `baseline-${theme}-hover.png`) });
          await card.getByRole("button", { name: "海岸" }).click();
          await expect(page.getByRole("button", { name: "下载原文件" })).toBeVisible();
          await page.keyboard.press("ArrowRight");
          await expect(page.getByText("本页 2 / 2")).toBeVisible();
          await page.screenshot({
            animations: "disabled",
            path: join(out, `baseline-${theme}-preview.png`),
          });
        } else {
          await filter("人群", "全部");
          await filter("语言", "全部");
          await expect(cards).toHaveCount(181);
          await page.screenshot({ path: join(out, `studio-${theme}-voices.png`) });
          await page.locator(".home-sheet").evaluate((el) => (el.scrollTop = 350));
          await expect(page.locator(".home-asset-mini")).toBeVisible();
          await page.locator(".home-sheet").evaluate((el) => (el.scrollTop = 0));
          await expect(page.locator(".home-asset-mini")).toHaveCount(0);
          await page.getByRole("radio", { name: "生成历史" }).click();
          await filter("时间", "今天");
          await expect(page.getByRole("button", { name: "时间" })).toHaveText("今天");
          const card = page.locator(".global-card").first();
          await expect(card.locator(".global-caption")).toHaveCSS("opacity", "0");
          await card.hover();
          await expect(card.locator(".global-caption")).toHaveCSS("opacity", "1");
          await card.screenshot({ path: join(out, `studio-${theme}-hover.png`) });
          await card.locator(".global-cover").click();
          await expect(dialog.getByRole("img", { name: "海岸" })).toBeVisible();
          await page.keyboard.press("ArrowRight");
          await expect(dialog.getByRole("img", { name: "夜空" })).toBeVisible();
          await expect(dialog.getByText("本页 2 / 2")).toBeVisible();
          await dialog.getByRole("button", { name: "下载原文件" }).click();
          assert.deepEqual(await page.evaluate(() => window.lastSave), {
            library: "history",
            assetId: "00000000-0000-4000-8000-000000000001",
          });
          await page.screenshot({ path: join(out, `studio-${theme}-preview.png`) });
          await dialog.getByRole("button", { name: "加入资产库…" }).click();
          const location = page.getByRole("dialog", { name: "加入资产库", exact: true });
          await location.getByRole("button", { name: "加入", exact: true }).click();
          await expect(dialog.getByRole("button", { name: "已在资产库" })).toBeDisabled();
          await page.keyboard.press("Escape");
          await page.getByRole("radio", { name: "个人资产库" }).click();
          await page.getByRole("button", { name: "打开文件夹 角色" }).click();
          await expect(page).toHaveURL(/folder=folder/);
          await page.reload();
          await expect(page.locator(".home-breadcrumb")).toContainText("角色");
          await page.getByRole("button", { name: "海岸.png 操作" }).click();
          await page.getByRole("menuitem", { name: "加入真人库" }).click();
          await expect(dialog.getByRole("button", { name: "提交备案" })).toBeEnabled();
          await dialog.getByRole("button", { name: "取消" }).click();
          await page.goBack();
          await expect(page.getByRole("button", { name: "打开文件夹 角色" })).toBeVisible();
          await page.getByRole("button", { name: "新建", exact: true }).click();
          await page.getByRole("menuitem", { name: "新建文件夹" }).click();
          await dialog.getByRole("textbox").fill("道具");
          await dialog.getByRole("button", { name: "创建", exact: true }).click();
          await expect(page.getByRole("button", { name: "打开文件夹 道具" })).toBeVisible();
          await page
            .locator("input[type=file]")
            .setInputFiles({ name: "素材.png", mimeType: "image/png", buffer: png });
          const task = page.locator(".home-import-card");
          await expect(task).toContainText("测试读取失败");
          await task.getByRole("button", { name: "重试" }).click();
          await expect(task).toHaveCount(0);
          await page.getByRole("radio", { name: "真人库", exact: true }).click();
          await page.getByRole("button", { name: "演员", exact: true }).click();
          await expect(dialog.getByRole("textbox", { name: "真人名称" })).toHaveValue("演员");
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "失败 0" }).click();
          await expect(page.getByText("暂无符合条件的真人")).toBeVisible();
        }
        assert.deepEqual(pageErrors, []);
        console.log(baseline ? "baseline" : "studio", theme, geometry, first, "passed");
        await page.close();
      }
    } finally {
      await server.close();
    }
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
