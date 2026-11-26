import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let fixture: string;

test.use({ channel: "chrome", headless: true, reducedMotion: "reduce" });

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    oxc: { jsx: { runtime: "automatic" } },
  });
  await server.listen();
  fixture = new URL("/tests/fixtures/drama-studio-status.html", server.resolvedUrls?.local[0]).href;
});

test.afterAll(async () => {
  await server?.close();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`非助手状态主题与窄窗口 · ${colorScheme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.goto(fixture);
    await expect(page.getByRole("heading", { name: "工程化状态预览" })).toBeVisible();
    await expect(page.getByText("任务进度")).toBeVisible();
    await expect(page.getByText("故事板模型暂时不可用")).toBeVisible();
    await page.screenshot({ path: info.outputPath("desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator(".status-fixture").boundingBox();
    expect(bounds?.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath("narrow.png"), fullPage: true });
  });
}
