import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
const narrow = process.argv.includes("--narrow"),
  viewport = narrow ? { width: 390, height: 844 } : { width: 1200, height: 800 };
const out = resolve(`test-results/library-action-parity${narrow ? "-narrow" : ""}`),
  temp = await mkdtemp(join(tmpdir(), "library-compare-"));
await mkdir(out, { recursive: true });
const web = resolve(process.env.VIDEO_CANVAS_WEB),
  view = await readFile(join(web, "src/pages/assets/library-view.tsx"), "utf8");
const deletion = view.match(/<AlertDialog open=\{deleting !== null\}[\s\S]*?<\/AlertDialog>/)?.[0];
assert(deletion);
const folders = [
  { id: "first", name: "外景", createdAt: "2026-09-01", itemCount: 2 },
  { id: "next", name: "角色图", createdAt: "2026-09-02", itemCount: 1 },
];
const browser = await chromium.launch({ channel: "chrome" }),
  results = {};
try {
  for (const side of ["upstream", "desktop"]) {
    const upstream = side === "upstream",
      root = upstream ? web : process.cwd(),
      assets = join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
    assert(css);
    const entry = "/src/__library_action_fixture.tsx";
    const imports = upstream
      ? `import {FolderPickerDialog} from '@/components/assets/folder-picker-dialog';import {AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction} from '@/components/ui/alert-dialog';`
      : `import {LibraryLocationDialog,DeleteLibraryFolder} from '/src/renderer/workspace/library-management';`;
    const picker = upstream
      ? '<FolderPickerDialog title="移动到" confirmLabel="移动" initialFolderId="first" currentFolderId="first" open={open} onOpenChange={setOpen} onConfirm={confirm}/>'
      : 'open && <LibraryLocationDialog handle="test" currentFolder="first" close={()=>setOpen(false)} confirm={confirm}/>';
    const code = `import {createRoot} from 'react-dom/client';import {useState} from 'react';${imports}function Fixture(){const [open,setOpen]=useState(false),[result,setResult]=useState('');const target=${JSON.stringify(folders[0])};const deleting=open?target:null,setDeleting=()=>setOpen(false),confirmDelete=()=>{setResult('delete');setOpen(false);},confirm=async id=>setResult(id);return <><button onClick={()=>setOpen(true)}>打开</button><output>{result}</output>{location.search==='?delete'?(${upstream ? deletion : "open && <DeleteLibraryFolder folder={target} close={()=>setOpen(false)} confirm={confirmDelete}/>"}):(${picker})}</>;}createRoot(document.querySelector('main')).render(<Fixture/>);`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(temp, side),
      resolve: { alias: { "@": join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "actions",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? code : undefined),
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
          await page.route(`${origin}assets/**`, (route) =>
            route.fulfill({
              path: join(assets, basename(new URL(route.request().url()).pathname)),
            }),
          );
          let failNext = true;
          await page.route(/\/asset-folders(?:\?|$)/, (route) => {
            if (page.url().endsWith("?retry") && failNext) {
              failNext = false;
              return route.fulfill({ status: 503, json: { detail: "unavailable" } });
            }
            return route.fulfill({
              json: {
                items: folders.map((folder) => ({
                  ...folder,
                  created_at: folder.createdAt,
                  item_count: folder.itemCount,
                })),
              },
            });
          });
          if (!upstream)
            await page.addInitScript((folders) => {
              let failed = false;
              window.desktop = {
                projects: {
                  listLibraryFolders: async () => {
                    if (location.search === "?retry" && !failed) {
                      failed = true;
                      return { ok: false };
                    }
                    return { ok: true, value: folders };
                  },
                },
              };
            }, folders);
          await page.route(`${origin}audit*`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><meta charset="utf-8"><link rel="stylesheet" href="/assets/${css}"><main style="position:fixed;inset:0;background:${theme === "light" ? "#fafafa" : "#171717"}"></main><style>main>button{position:fixed;opacity:0;top:0;left:0}</style><script type="module" src="${entry}"></script></html>`,
            }),
          );
          const open = async (mode) => {
            await page.goto(`${origin}audit?${mode}`);
            await page.getByRole("button", { name: "打开" }).click();
          };
          const capture = async (frame, dialog, control) => {
            await page.mouse.move(0, 0);
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all(
                document
                  .getAnimations()
                  .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                  .map((animation) => animation.finished.catch(() => {})),
              );
            });
            results[`${side}-${theme}-${frame}`] = {
              dialog: await dialog.boundingBox(),
              control: await control.boundingBox(),
            };
            await page.screenshot({ path: join(out, `${side}-${theme}-${frame}.png`) });
          };
          await open("move");
          const move = page.getByRole("dialog", { name: "移动到" }),
            confirm = move.getByRole("button", { name: "移动", exact: true });
          await expect(move.getByRole("radio", { name: /外景/ })).toHaveAttribute(
            "aria-checked",
            "true",
          );
          await expect(confirm).toBeDisabled();
          await capture("move", move, confirm);
          await move.getByRole("button", { name: "新建文件夹" }).click();
          const draft = move.getByRole("textbox", { name: "新文件夹名称" });
          await expect(draft).toBeFocused();
          await draft.press("Enter");
          await expect(move.getByRole("alert")).toHaveText("请输入文件夹名称");
          await capture("invalid", move, draft);
          await draft.fill("备选");
          await capture("draft", move, draft);
          await draft.press("Escape");
          await expect(draft).toHaveCount(0);
          await expect(move).toBeVisible();
          await move.getByRole("radio", { name: /角色图/ }).press("Space");
          await confirm.click();
          await expect(page.locator("output")).toHaveText("next");
          await expect(move).toHaveCount(0);
          await open("retry");
          await expect(move.getByText("文件夹加载失败")).toBeVisible();
          await expect(move.getByRole("button", { name: "新建文件夹" })).toBeDisabled();
          await move.getByRole("button", { name: "重试" }).click();
          await expect(move.getByRole("radio", { name: /外景/ })).toHaveAttribute(
            "aria-checked",
            "true",
          );
          await expect(move.getByRole("button", { name: "新建文件夹" })).toBeEnabled();
          await open("delete");
          const alert = page.getByRole("alertdialog"),
            cancel = alert.getByRole("button", { name: "取消" });
          await expect(cancel).toBeFocused();
          await capture("delete", alert, cancel);
          await page.mouse.click(2, 2);
          await expect(alert).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(alert).toHaveCount(0);
          await expect(page.locator("output")).toBeEmpty();
          await page.getByRole("button", { name: "打开" }).click();
          await alert.getByRole("button", { name: "删除" }).click();
          await expect(page.locator("output")).toHaveText("delete");
        } finally {
          await page.close();
        }
      }
    } finally {
      await server.close();
    }
  }
  for (const theme of ["light", "dark"])
    for (const frame of ["move", "draft", "invalid", "delete"]) {
      const key = `${theme}-${frame}`;
      const [before, after] = ["upstream", "desktop"].map((side) =>
        execFileSync(
          resolve("out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
          [
            "-v",
            "error",
            "-i",
            join(out, `${side}-${key}.png`),
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          { maxBuffer: 5000000 },
        ),
      );
      let diff = 0;
      for (let index = 0; index < before.length; index += 3)
        if (before.readUIntBE(index, 3) !== after.readUIntBE(index, 3)) diff++;
      results[key] = diff;
      console.log(key, diff);
    }
  await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));
  for (const key of Object.keys(results).filter((key) => key.startsWith("upstream-")))
    assert.deepEqual(results[key], results[key.replace("upstream-", "desktop-")], key);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
