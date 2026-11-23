import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const temp = await mkdtemp(join(tmpdir(), "asset-picker-parity-"));
const reloadMode = process.argv.includes("--human-reload");
const humanMode = reloadMode || process.argv.includes("--humans");
const narrow = process.argv.includes("--narrow");
const paged = process.argv.includes("--paged");
const folderMode = process.argv.includes("--folders");
const nameMode = process.argv.includes("--folder-name");
const viewport = narrow ? { width: 390, height: 844 } : { width: 1200, height: 800 };
const output = resolve(
  `test-results/asset-picker-parity${nameMode ? "-folder-name" : folderMode ? "-folders" : reloadMode ? "-human-reload" : humanMode ? "-humans" : ""}${narrow ? "-narrow" : ""}${paged ? "-paged" : ""}`,
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const results = {};
const count = paged ? 85 : 21;
const samples = Array.from({ length: count }, (_, index) => ({
  id: String(index + 1),
  kind: "audio",
  file_name: `配乐 ${String(index + 1).padStart(2, "0")}.wav`,
  url: "",
  created_at: "2026-10-01T08:00:00Z",
  duration_ms: 3200,
}));
const local = samples.map((item) => ({
  assetId: item.id,
  displayName: item.file_name,
  mediaType: item.kind,
  createdAt: item.created_at,
  availability: "ready",
  metadata: { durationMs: item.duration_ms },
}));
const picture =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=";
const photos = ["主图.png", "补图.png", "审核中.png", "失败.png", "备选.png"].map(
  (file_name, index) => ({ id: String(index + 1), kind: "image", file_name, url: picture }),
);
const statuses = ["active", "active", "pending", "failed", "active"];
const human = {
  id: "person",
  name: "林舟",
  status: "active",
  images: photos.map((asset, index) => ({ id: asset.id, asset, status: statuses[index] })),
};
const filings = photos.map((photo, index) => ({
  id: photo.id,
  humanId: human.id,
  humanName: human.name,
  name: photo.file_name,
  hasSource: true,
  status: statuses[index] === "pending" ? "processing" : statuses[index],
  order: index,
}));
const characters = photos.slice(0, 2).map((photo) => ({
  assetId: photo.id,
  displayName: photo.file_name,
  mediaType: "image",
  availability: "ready",
  metadata: { filingChannel: "test", filingImage: photo.id },
}));
try {
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream";
    const root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd();
    const assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    const entry = "/src/__picker_parity.tsx";
    const component = upstream
      ? `import {AssetPickerDialog} from '@/components/assets/asset-picker-dialog';`
      : `import {AssetPickerDialog} from '/src/renderer/workspace/asset-picker-dialog';`;
    const props =
      (upstream
        ? `open={true} onOpenChange={()=>{}} onConfirm={done}`
        : `assets={${JSON.stringify(folderMode ? [] : humanMode ? characters : local)}} jobs={[]} handle="test" projectName="画布" importing={false} capacity={1000} upload={async()=>{}} close={()=>{}} confirm={done}`) +
      (humanMode
        ? upstream
          ? ` kind="image" limit={3} reasonOf={asset=>({'1':'已是主图','2':'已添加'}[asset.id])} title="选择补充图" withHumans confirmLabel="确定"`
          : ` lockedKind="image" character={{purpose:'extra',primary:'1',extras:['2']}} attachFiled={async({image})=>({assetId:image.id})}`
        : "");
    const folderProps =
      folderMode && !upstream
        ? `attachLibrary={async assetId=>({assetId,availability:'ready'})}`
        : "";
    const nameFixture = upstream
      ? `import {FolderNameDialog} from '@/components/assets/folder-name-dialog';const form=<FolderNameDialog mode="rename" open initial="外景" onClose={()=>{}} onSubmit={async()=>{}}/>;`
      : `import {LibraryFolderForm} from '/src/renderer/workspace/library-folder-form';const form=<LibraryFolderForm handle="test" folder={{id:'folder',name:'外景'}} close={()=>{}}/>;`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "picker-fixture",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) =>
            id === entry
              ? nameMode
                ? `import {createRoot} from 'react-dom/client';${nameFixture}createRoot(document.querySelector('main')).render(form);`
                : `import {createRoot} from 'react-dom/client';import {useState} from 'react';${component}function Fixture(){const [ids,set]=useState(null);const done=items=>set(items.map(item=>item.id??item.assetId));return ids?<output>{ids.join(',')}</output>:<AssetPickerDialog ${props} ${folderProps}/>;}createRoot(document.querySelector('main')).render(<Fixture/>);`
              : undefined,
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport,
          deviceScaleFactor: 1,
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        try {
          if (humanMode) {
            const secondPhoto = { ...photos[0], id: "6", file_name: "第二组.png" };
            const secondHuman = {
              ...human,
              id: "person2",
              name: "季南",
              images: [{ id: "6", asset: secondPhoto, status: "active" }],
            };
            let calls = 0;
            await page.route(/\/virtual-humans(?:\?|$)/, (route) =>
              reloadMode && calls++ === 0
                ? route.fulfill({ status: 503, json: { detail: "unavailable" } })
                : route.fulfill({
                    json: {
                      items: reloadMode ? [human, secondHuman] : [human],
                      filing_ready: true,
                    },
                  }),
            );
            const media = reloadMode
              ? [
                  ...filings,
                  {
                    ...filings[0],
                    id: secondPhoto.id,
                    name: secondPhoto.file_name,
                    humanId: secondHuman.id,
                    humanName: secondHuman.name,
                  },
                ]
              : filings;
            if (!upstream)
              await page.addInitScript(
                ({ media, picture, reloadMode }) => {
                  let calls = 0;
                  window.desktop = {
                    projects: {
                      getAssetPreview: async () => ({ ok: true, value: { url: picture } }),
                    },
                    settings: {
                      channelList: async () => ({
                        ok: true,
                        value: [{ id: "test", revision: 1, filing: { enabled: true } }],
                      }),
                      filingAssets: async () =>
                        reloadMode && calls++ === 0
                          ? { ok: false, code: "unavailable" }
                          : { ok: true, value: media },
                      filingPreview: async () => ({ ok: true, value: picture }),
                    },
                  };
                },
                { media, picture, reloadMode },
              );
          }
          await page.route(`${origin}assets/**`, (route) =>
            route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
          );
          await page.route(/\/(asset-folders|asset-library\/items)(?:\?|$)/, (route) => {
            const url = new URL(route.request().url()),
              rows = url.pathname.endsWith("/asset-library/items")
                ? samples.filter((item) => item.file_name.includes(url.searchParams.get("q") ?? ""))
                : [];
            const offset = Number(url.searchParams.get("cursor")),
              limit = Number(url.searchParams.get("limit") ?? 40);
            return route.fulfill({
              json: {
                items: rows
                  .slice(offset, offset + limit)
                  .map((item) => ({ id: item.id, asset: item, created_at: item.created_at })),
                next_cursor: offset + limit < rows.length ? String(offset + limit) : "",
              },
            });
          });
          await page.route(/\/assets\/generated(?:\?|$)/, (route) =>
            route.fulfill({ json: { items: [], next_cursor: "" } }),
          );
          if (folderMode) {
            const folders = ["配乐", "空文件夹"].map((name, index) => ({
              id: `folder${index}`,
              name,
              created_at: "2026-10-01T08:00:00Z",
              item_count: index ? 0 : 2,
            }));
            await page.route(/\/asset-folders(?:\?|$)/, (route) =>
              route.fulfill({ json: { items: folders } }),
            );
            await page.route(/\/asset-library\/items(?:\?|$)/, (route) => {
              const params = new URL(route.request().url()).searchParams,
                folder = params.get("folder_id"),
                keyword = params.get("q") ?? "";
              return route.fulfill({
                json: {
                  items: samples
                    .slice(0, 3)
                    .filter((item, index) =>
                      keyword
                        ? item.file_name.includes(keyword)
                        : index < 2
                          ? folder === "folder0"
                          : folder === "root",
                    )
                    .map((asset) => ({ id: asset.id, asset, created_at: asset.created_at })),
                  next_cursor: "",
                },
              });
            });
            if (!upstream)
              await page.addInitScript(
                ({ folders, local }) => {
                  window.desktop = {
                    projects: {
                      listLibrary: async () => ({
                        ok: true,
                        value: {
                          folders: folders.map((folder) => ({
                            ...folder,
                            createdAt: folder.created_at,
                            itemCount: folder.item_count,
                          })),
                          items: local.slice(0, 3).map((asset, index) => ({
                            asset,
                            folderId: index < 2 ? "folder0" : null,
                          })),
                        },
                      }),
                    },
                  };
                },
                { folders, local },
              );
          }
          await page.route(`${origin}audit`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main style="position:fixed;inset:0;background:${theme === "light" ? "#fafafa" : "#171717"}"></main><script type="module" src="${entry}"></script></html>`,
            }),
          );
          await page.goto(`${origin}audit`);
          if (nameMode) {
            const dialog = page.getByRole("dialog", { name: "重命名文件夹" }),
              input = dialog.getByLabel("文件夹名称");
            await expect(input).toBeFocused();
            await expect(input).toHaveValue("外景");
            const save = dialog.getByRole("button", { name: "保存" });
            await page.mouse.move(0, 0);
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all(
                document
                  .getAnimations()
                  .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                  .map((a) => a.finished.catch(() => {})),
              );
            });
            results[`${side}-${theme}`] = {
              dialog: await dialog.boundingBox(),
              input: await input.boundingBox(),
              save: await save.boundingBox(),
            };
            await page.screenshot({ path: join(output, `${side}-${theme}.png`) });
            continue;
          }
          if (folderMode) {
            const dialog = page.getByRole("dialog", { name: "资产库" }),
              folder = dialog.getByRole("button", { name: "打开文件夹 配乐", exact: true }),
              empty = dialog.getByRole("button", { name: "打开文件夹 空文件夹", exact: true });
            const root = dialog
                .getByRole("navigation", { name: "当前位置" })
                .getByRole("button", { name: "个人资产库" }),
              search = dialog.getByRole("textbox", { name: "搜索文件名" });
            const capture = async (suffix) => {
              await page.mouse.move(0, 0);
              await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.all(
                  document
                    .getAnimations()
                    .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                    .map((a) => a.finished.catch(() => {})),
                );
              });
              await page.screenshot({ path: join(output, `${side}-${theme}${suffix}.png`) });
            };
            await expect(folder).toContainText("2 项");
            await expect(
              dialog.getByRole("button", { name: samples[2].file_name, exact: true }),
            ).toBeVisible();
            await capture("");
            results[`${side}-${theme}`] = {
              folder: await folder.boundingBox(),
              empty: await empty.boundingBox(),
            };
            await empty.click();
            await expect(dialog.getByText("这个文件夹是空的")).toBeVisible();
            await capture("-empty");
            await root.click();
            await folder.click();
            await dialog.getByRole("button", { name: samples[1].file_name }).click();
            await root.click();
            await search.fill("01.wav");
            await expect(folder).toHaveCount(0);
            await dialog.getByRole("button", { name: samples[0].file_name }).click();
            await dialog.getByRole("button", { name: "确认", exact: true }).click();
            await expect(page.locator("output")).toHaveText("2,1");
            continue;
          }
          if (humanMode) {
            const dialog = page.getByRole("dialog", { name: "选择补充图" }),
              tabs = dialog.getByRole("tablist"),
              tab = tabs.getByRole("tab", { name: "真人库" });
            await tab.click();
            if (reloadMode) {
              const retry = dialog.getByRole("button", { name: "重试" });
              await expect(retry).toBeVisible();
              await expect(dialog.getByText("加载失败", { exact: true })).toBeVisible();
              await page.mouse.move(0, 0);
              await expect
                .poll(() =>
                  tab.evaluate((button) =>
                    Math.abs(
                      button.getBoundingClientRect().x -
                        button.querySelector("span").getBoundingClientRect().x,
                    ),
                  ),
                )
                .toBeLessThan(0.05);
              await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.all(
                  document
                    .getAnimations()
                    .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                    .map((a) => a.finished.catch(() => {})),
                );
              });
              if (process.env.PARITY_STYLES)
                console.log(
                  side,
                  theme,
                  "error",
                  await retry.evaluate((button) =>
                    [button, button.parentElement, button.parentElement.previousElementSibling].map(
                      (el) => {
                        const { x, y, width, height } = el.getBoundingClientRect();
                        const style = getComputedStyle(el);
                        return [x, y, width, height, style.font, style.color];
                      },
                    ),
                  ),
                );
              await page.screenshot({ path: join(output, `${side}-${theme}-error.png`) });
              await retry.click();
              const second = dialog
                .getByRole("region", { name: "季南" })
                .getByRole("button", { name: "第二组.png" });
              await second.click();
              await dialog.getByRole("textbox", { name: "搜索真人名称" }).fill("林舟");
              await expect(second).toHaveCount(0);
              await dialog.getByRole("textbox", { name: "搜索真人名称" }).fill("");
              await expect(second).toHaveAttribute("aria-pressed", "true");
            }
            const person = dialog.getByRole("region", { name: human.name }),
              heading = person.getByRole("heading"),
              first = person.getByRole("button", { name: photos[0].file_name, exact: true });
            for (const [index, reason] of ["已是主图", "已添加", "备案中", "备案失败"].entries()) {
              const card = person.getByRole("button", {
                name: photos[index].file_name,
                exact: true,
              });
              await expect(card).toBeDisabled();
              await expect(card.locator("..").getByText(reason, { exact: true })).toBeVisible();
            }
            await person.getByRole("button", { name: "备选.png" }).click();
            const confirm = dialog.getByRole("button", { name: "确定", exact: true }),
              search = dialog.getByRole("textbox", { name: "搜索真人名称" }).locator("..");
            await search.locator("input").fill("无人");
            await expect(dialog.getByText("没有找到“无人”")).toBeVisible();
            await search.locator("input").fill("");
            await expect(person.getByRole("button", { name: "备选.png" })).toHaveAttribute(
              "aria-pressed",
              "true",
            );
            await confirm.focus();
            await page.evaluate(() => document.activeElement.blur());
            await page.mouse.move(0, 0);
            await expect
              .poll(() =>
                tab.evaluate((button) =>
                  Math.abs(
                    button.getBoundingClientRect().x -
                      button.querySelector("span").getBoundingClientRect().x,
                  ),
                ),
              )
              .toBeLessThan(0.05);
            await dialog.evaluate(async (element) => {
              await document.fonts.ready;
              await Promise.all(Array.from(element.querySelectorAll("img"), (img) => img.decode()));
              await Promise.all(
                document
                  .getAnimations()
                  .filter((item) => item.effect?.getTiming().iterations !== Infinity)
                  .map((item) => item.finished.catch(() => {})),
              );
            });
            const areas = { dialog, first, heading, search, tabs, confirm };
            results[`${side}-${theme}`] = Object.fromEntries(
              await Promise.all(
                Object.entries(areas).map(async ([key, locator]) => [
                  key,
                  await locator.boundingBox(),
                ]),
              ),
            );
            if (process.env.PARITY_STYLES && theme === "light")
              for (const [key, locator] of Object.entries({
                tab,
                slide: tab.locator("span").first(),
                heading,
                status: heading.getByText("可用"),
                reason: person.getByText("已添加"),
                input: search.locator("input"),
                label: dialog.getByText(`已选择 ${reloadMode ? 2 : 1} 个素材`, { exact: true }),
              }))
                console.log(
                  side,
                  key,
                  await locator.evaluate((element) => {
                    const style = getComputedStyle(element),
                      bounds = element.getBoundingClientRect();
                    return [
                      bounds.x,
                      bounds.y,
                      bounds.width,
                      bounds.height,
                      style.font,
                      style.color,
                      style.fontFamily,
                      style.padding,
                      style.lineHeight,
                      style.backgroundColor,
                    ];
                  }),
                );
            await page.screenshot({ path: join(output, `${side}-${theme}.png`) });
            await confirm.click();
            await expect(page.locator("output")).toHaveText(reloadMode ? "6,5" : "5");
            continue;
          }
          const dialog = page.getByRole("dialog", { name: "资产库" });
          const card = (index) =>
            dialog.getByRole("button", { name: samples[index].file_name, exact: true });
          const first = card(0),
            confirm = dialog.getByRole("button", { name: "确认", exact: true });
          await expect(first).toBeVisible();
          await expect(confirm).toBeDisabled();
          if (paged) {
            const cards = dialog.locator(
              upstream ? "[data-slot=library-card]" : ".asset-pick-card",
            );
            const more = dialog.locator(upstream ? "[data-slot=load-more]" : ".asset-pick-more");
            await expect(cards).toHaveCount(40);
            await first.click();
            await more.scrollIntoViewIfNeeded();
            await expect(cards).toHaveCount(80);
            await card(79).click();
            await expect(cards).toHaveCount(85);
            await card(84).click();
            await expect(more).toHaveCount(0);
            await dialog.getByRole("textbox", { name: "搜索文件名" }).fill("85.wav");
            await expect(cards).toHaveCount(1);
            await expect(card(84)).toHaveAttribute("aria-pressed", "true");
            await dialog.getByRole("textbox", { name: "搜索文件名" }).fill("");
            await expect(cards).toHaveCount(40);
            await confirm.click();
            await expect(page.locator("output")).toHaveText("1,80,85");
            continue;
          }
          await first.click();
          await card(1).click();
          await page.mouse.move(0, 0);
          await first.evaluate((element) => {
            for (let parent = element.parentElement; parent; parent = parent.parentElement)
              if (parent.scrollTop) parent.scrollTop = 0;
          });
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(
              document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
            );
          });
          const tray = dialog.getByRole("list", { name: "已选素材", includeHidden: true });
          const areas = {
            dialog,
            first,
            search: dialog.getByRole("textbox", { name: "搜索文件名" }).locator(".."),
            tabs: dialog.getByRole("tablist"),
            ...(!narrow && { tray }),
            confirm,
          };
          if (narrow) await expect(dialog.getByRole("list", { name: "已选素材" })).toHaveCount(0);
          results[`${side}-${theme}`] = Object.fromEntries(
            await Promise.all(
              Object.entries(areas).map(async ([key, locator]) => [
                key,
                await locator.boundingBox(),
              ]),
            ),
          );
          if (process.env.PARITY_STYLES) {
            const sample = upstream
              ? dialog.locator("[data-slot=library-card]").first()
              : first.locator("..");
            const pieces = {
              dialog,
              first: sample,
              note: sample.locator("svg").first(),
              chip: upstream ? sample.getByText("0:03") : sample.locator("small"),
              name: sample.getByText(samples[0].file_name, { exact: true }),
              confirm,
            };
            for (const [key, locator] of Object.entries(pieces))
              console.log(
                side,
                theme,
                key,
                await locator.evaluate((element) => {
                  const style = getComputedStyle(element);
                  return [
                    element.getBoundingClientRect().toJSON(),
                    ...[
                      "font",
                      "lineHeight",
                      "color",
                      "backgroundColor",
                      "backgroundImage",
                      "borderRadius",
                      "boxShadow",
                      "letterSpacing",
                      "opacity",
                      "webkitFontSmoothing",
                    ].map((prop) => style[prop]),
                  ];
                }),
              );
          }
          await page.screenshot({ path: join(output, `${side}-${theme}.png`) });
          await dialog.getByRole("tab", { name: "生成历史" }).click();
          await dialog.getByRole("button", { name: "视频", exact: true }).click();
          await expect(dialog.getByText("暂无相关资产")).toBeVisible();
          await page.mouse.move(0, 0);
          await expect
            .poll(() =>
              dialog.getByRole("tab", { name: "生成历史" }).evaluate((tab) => {
                const slide = tab.querySelector("span");
                if (!slide) return false;
                const target = tab.getBoundingClientRect(),
                  actual = slide.getBoundingClientRect();
                return (
                  Math.abs(actual.x - target.x) < 0.05 &&
                  Math.abs(actual.width - target.width) < 0.05
                );
              }),
            )
            .toBe(true);
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(
              document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
            );
          });
          await page.screenshot({ path: join(output, `${side}-${theme}-history.png`) });
          await dialog.getByRole("tab", { name: "个人资产库" }).click();
          await (narrow
            ? first
            : dialog.getByRole("button", { name: `取消选择 ${samples[0].file_name}` })
          ).click();
          for (let index = 2; index < count; index++) await card(index).click();
          await expect(first).toBeDisabled();
          await expect(dialog.getByText("一次最多引入 20 个")).toBeVisible();
          if (!narrow) {
            await expect(tray.getByRole("button")).toHaveCount(8);
            await expect(dialog.getByText("+12", { exact: true })).toBeVisible();
          } else await expect(dialog.getByText("+12", { exact: true })).toBeHidden();
          await confirm.click();
          await expect(page.locator("output")).toHaveText(
            samples
              .slice(1)
              .map((item) => item.id)
              .join(","),
          );
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  const decoder = resolve(
    "out/media",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  if (paged) console.log("Both pickers: 40 → 80 → 85, search reset to 40; selected IDs 1,80,85");
  const frames = paged
    ? []
    : nameMode
      ? ["light", "dark"]
      : folderMode
        ? ["light", "dark", "light-empty", "dark-empty"]
        : reloadMode
          ? ["light", "dark", "light-error", "dark-error"]
          : humanMode
            ? ["light", "dark"]
            : ["light", "dark", "light-history", "dark-history"];
  for (const theme of frames) {
    const [before, after] = ["upstream", "desktop"].map((side) =>
      execFileSync(
        decoder,
        [
          "-v",
          "error",
          "-i",
          join(output, `${side}-${theme}.png`),
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { maxBuffer: 4000000 },
      ),
    );
    let difference = 0;
    for (let offset = 0; offset < before.length; offset += 3)
      if (before.readUIntBE(offset, 3) !== after.readUIntBE(offset, 3)) difference++;
    results[theme] = difference;
    console.log(theme, difference, "of", before.length / 3, "pixels");
  }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  if (!paged)
    for (const theme of ["light", "dark"])
      assert.deepEqual(results[`desktop-${theme}`], results[`upstream-${theme}`]);
  if (process.env.PARITY_EXACT === "1")
    for (const frame of frames) assert.equal(results[frame], 0, frame);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
