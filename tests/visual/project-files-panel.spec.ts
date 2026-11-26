import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { expectAssistantContrast } from "../e2e/assistant-theme";

let server: ViteDevServer;
let fixture: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: "node_modules/.vite-project-files-panel",
    logLevel: "error",
    optimizeDeps: { entries: ["tests/fixtures/project-files-panel.html"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    oxc: { jsx: { runtime: "automatic" } },
  });
  await server.listen();
  fixture = new URL("/tests/fixtures/project-files-panel.html", server.resolvedUrls?.local[0]).href;
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "desktop", {
      value: {
        projects: {
          getAssetPreview: async ({
            assetId,
            variant,
            library,
          }: {
            assetId: string;
            variant?: string;
            library?: boolean;
          }) => ({
            ok:
              (assetId === "image" && (variant === "thumb" || library)) ||
              (assetId === "video" && variant === "poster"),
            value: { url: `/resources/icons/icon-${assetId === "image" ? 32 : 64}.png` },
          }),
        },
      },
    });
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [320, 1000]) {
    test(`项目文件主题与布局 · ${colorScheme} · ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 840 });
      await page.emulateMedia({ colorScheme });
      await page.goto(fixture);
      const panel = page.getByRole("region", { name: "项目文件" });
      const image = panel.getByRole("article", { name: "雨夜站台.png" });
      const video = panel.getByRole("article", { name: "末班车_预告片.mp4" });
      await expect(image.locator("img")).toHaveJSProperty("naturalWidth", 32);
      await expect(video.locator("img")).toHaveJSProperty("naturalWidth", 64);
      await expect(panel).toHaveCSS(
        "background-color",
        colorScheme === "dark" ? "rgb(27, 27, 27)" : "rgb(255, 255, 255)",
      );
      await expectAssistantContrast(image.getByText("图片 · 1920×1080"));
      await expectAssistantContrast(panel.getByText("文件不可用"));
      await expectAssistantContrast(panel.getByRole("button", { name: "导入素材" }));
      const body = panel.locator(".project-files-body");
      expect((await panel.boundingBox())?.width).toBe(width === 320 ? 296 : 800);
      for (const surface of [panel, body]) {
        expect(await surface.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
          0,
        );
      }
      await panel.screenshot({ path: testInfo.outputPath("project-files.png") });
    });
  }
}

test("搜索筛选、素材操作和导入状态", async ({ page }) => {
  await page.goto(fixture);
  const panel = page.getByRole("region", { name: "项目文件" });
  const action = page.getByTestId("action");
  const search = panel.getByRole("searchbox", { name: "搜索项目素材" });
  const types = panel.getByRole("group", { name: "素材类型" });
  await types.getByRole("button", { name: "视频", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("1 / 4 项");
  await panel.getByRole("button", { name: /提取.*关键帧/ }).click();
  await expect(action).toHaveText("extract:video");
  await search.fill(".PNG");
  await expect(panel.getByText("没有匹配的素材")).toBeVisible();
  await types.getByRole("button", { name: "图片", exact: true }).click();
  await expect(panel.getByRole("article")).toHaveCount(2);
  const image = panel.getByRole("article", { name: "雨夜站台.png" });
  const missing = panel.getByRole("article", { name: /外部参考/ });
  await expect(missing.getByRole("button", { name: /加入画布|预览/ })).toHaveCount(0);
  for (const [card, name, result] of [
    [image, /预览/, "preview:image"],
    [image, /加入画布/, "add:image"],
    [image, /加入真人库/, "enroll:image"],
    [missing, /重新定位/, "relocate:missing"],
    [missing, /移除/, "remove:missing"],
    [panel, /管理个人资产库/, "library"],
  ] as const) {
    await card.getByRole("button", { name }).click();
    await expect(action).toHaveText(result);
  }
  await panel.getByRole("combobox", { name: "导入方式" }).selectOption("reference");
  await panel.getByRole("button", { name: "导入素材" }).click();
  await expect(action).toHaveText("import:reference");
  await expect(panel.getByText(/正在校验/)).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "10");
  await expect(panel.getByRole("button", { name: "关闭项目文件" })).toBeDisabled();
  await panel.getByRole("button", { name: "取消此文件" }).click();
  await panel.getByRole("button", { name: "复用现有素材" }).click();
  await expect(action).toHaveText("reuse");
  await panel.getByRole("button", { name: "关闭项目文件" }).click();
  await expect(panel).toBeHidden();
});

test("空项目、分批显示和节点素材选择", async ({ page }) => {
  const panel = page.getByRole("region", { name: "项目文件" });
  await page.goto(`${fixture}?empty`);
  await expect(panel.getByText("还没有项目素材")).toBeVisible();
  await page.goto(`${fixture}?many`);
  await expect(panel.getByRole("article")).toHaveCount(24);
  await panel.getByRole("button", { name: "显示更多素材" }).click();
  await expect(panel.getByRole("article")).toHaveCount(26);
  await page.setViewportSize({ width: 320, height: 540 });
  await panel.getByRole("article").last().scrollIntoViewIfNeeded();
  await panel.getByRole("button", { name: "导入素材" }).click();
  await expect(panel.getByRole("button", { name: "取消此文件" })).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole("button", { name: "管理个人资产库" })).toBeInViewport({ ratio: 1 });
  await page.goto(`${fixture}?target`);
  await expect(panel.getByText("选择音频素材")).toBeVisible();
  await expect(panel.getByRole("article")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "管理个人资产库" })).toHaveCount(0);
  await panel.getByRole("button", { name: /用于节点/ }).click();
  await expect(page.getByTestId("action")).toHaveText("add:audio");
});

for (const [colorScheme, width, height] of [
  ["light", 1000, 760],
  ["dark", 1000, 760],
  ["dark", 320, 570],
] as const) {
  test(`个人资产库主题、居中和可读性 · ${colorScheme} · ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme });
    await page.goto(colorScheme === "light" ? `${fixture}?library` : `${fixture}?library&empty`);
    const entry = page.getByRole("button", { name: "管理个人资产库" });
    const manager = page.getByRole("dialog", { name: "个人资产库管理" });
    await entry.click();
    await expect(manager.getByText(/在不同项目/)).toBeVisible();
    await expect(manager).toHaveCSS(
      "background-color",
      colorScheme === "dark" ? "rgb(27, 27, 27)" : "rgb(255, 255, 255)",
    );
    await expectAssistantContrast(manager.getByText(/在不同项目/));
    await expectAssistantContrast(manager.getByRole("searchbox"), "::placeholder");
    const picker = manager.getByRole("button", { name: "打开选材与上传" });
    await expectAssistantContrast(picker);
    await expect(picker).toBeInViewport({ ratio: 1 });
    const bounds = await manager.boundingBox();
    if (!bounds) throw new Error("未显示资产库弹窗");
    expect(bounds.x * 2 + bounds.width).toBeCloseTo(width, 0);
    expect(bounds.y * 2 + bounds.height).toBeCloseTo(height, 0);
    expect(await manager.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    if (colorScheme === "light") {
      await expect(manager.getByRole("button", { name: "打开文件夹 镜头参考" })).toBeVisible();
      await expect(manager.locator("img").first()).toHaveJSProperty("naturalWidth", 32);
    } else {
      await expect(manager.getByText(/选中素材节点/)).toBeVisible();
    }
    await manager.screenshot({ path: testInfo.outputPath("library-manager.png") });
    await page.keyboard.press("Escape");
    await expect(manager).toBeHidden();
    await expect(entry).toBeFocused();
    await entry.click();
    await picker.click();
    await expect(manager).toBeHidden();
    await expect(page.getByTestId("action")).toHaveText("picker");
  });
}

test("个人资产库新建、重命名、搜索移动与删除文件夹", async ({ page }) => {
  await page.goto(`${fixture}?library`);
  await page.getByRole("button", { name: "管理个人资产库" }).click();
  const manager = page.getByRole("dialog", { name: "个人资产库管理" });
  const search = manager.getByRole("searchbox", { name: "搜索文件名" });
  await manager.getByRole("button", { name: "新建文件夹" }).click();
  const create = page.getByRole("dialog", { name: "新建文件夹" });
  await create.getByLabel("文件夹名称").fill("公共参考");
  await create.getByRole("button", { name: "创建" }).click();
  await manager.getByRole("button", { name: "公共参考 操作" }).click();
  await manager.getByRole("menuitem", { name: "重命名" }).click();
  const rename = page.getByRole("dialog", { name: "重命名文件夹" });
  await expect(rename.getByLabel("文件夹名称")).toBeFocused();
  await rename.getByLabel("文件夹名称").fill("外景");
  await rename.getByRole("button", { name: "保存" }).click();
  await manager.getByRole("button", { name: "打开文件夹 外景" }).click();
  await expect(manager.getByText("这个文件夹是空的")).toBeVisible();
  await search.fill("无匹配");
  await expect(manager.getByText("没有找到匹配的素材")).toBeVisible();
  await search.fill("雨夜");
  await expect(manager.getByText("图片 · 根目录")).toBeVisible();
  await manager.getByRole("button", { name: "雨夜站台.png 操作" }).click();
  await manager.getByRole("menuitem", { name: "移动到…" }).click();
  const move = page.getByRole("dialog", { name: "移动到" });
  await move.getByRole("radio", { name: /外景/ }).click();
  await move.getByRole("button", { name: "移动", exact: true }).click();
  await expect(manager.getByText("图片 · 外景")).toBeVisible();
  await expect(manager.getByRole("status")).toHaveText("已移动");
  await search.clear();
  await manager.getByRole("button", { name: "根目录" }).click();
  const folder = manager.getByRole("button", { name: "打开文件夹 外景" });
  await expect(folder).toContainText("1 项");
  await manager.getByRole("button", { name: "外景 操作" }).click();
  await manager.getByRole("menuitem", { name: "删除" }).click();
  const deletion = page.getByRole("alertdialog", { name: "删除文件夹「外景」？" });
  await expect(deletion).toContainText("其中 1 个素材");
  await deletion.getByRole("button", { name: "删除", exact: true }).click();
  await expect(folder).toHaveCount(0);
  await expect(manager.getByRole("status")).toHaveText("已删除文件夹，移出 1 个素材");
});
