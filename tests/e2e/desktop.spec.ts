import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("桌面启动、画布交互与受限 IPC", async () => {
  const userData = await mkdtemp(join(tmpdir(), "link-studio-e2e-"));
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    LINK_STUDIO_TEST_USER_DATA: userData,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const application = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env: environment,
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const packaged = await application.evaluate(({ app }) => app.isPackaged);
    expect(packaged).toBe(Boolean(executablePath));
    await expect(page.locator("img.brand-mark")).toBeVisible();
    await expect
      .poll(() =>
        page.locator("img.brand-mark").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1024);
    await expect(page.getByRole("heading", { name: "让想法，连成画面" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "你好，我是小灵" })).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await page.getByRole("button", { name: "图片", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await page.getByRole("button", { name: "视频", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.getByRole("button", { name: "音频", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await page
      .getByRole("textbox", { name: "从一个想法开始内容" })
      .fill("一段等待被拍成电影的故事");
    await page.getByRole("button", { name: "运行环境", exact: true }).last().click();
    await expect(page.getByText("桌面连接正常")).toBeVisible();
    const boundary = await page.evaluate(() => ({
      hasNode: "require" in window || "process" in window,
      domains: Object.keys(window.desktop),
      methods: Object.keys(window.desktop.app),
    }));
    expect(boundary).toEqual({ hasNode: false, domains: ["app"], methods: ["getInfo"] });
    await page.evaluate(() => window.open("https://example.com"));
    const windowCount = await application.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length;
    });
    expect(windowCount).toBe(1);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: executablePath ? "test-results/m0-packaged.png" : "test-results/m0-workspace.png",
    });
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
