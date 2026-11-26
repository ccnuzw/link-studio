import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { expectAssistantContrast } from "../e2e/assistant-theme";

let server: ViteDevServer;
let fixture: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    oxc: { jsx: { runtime: "automatic" } },
  });
  await server.listen();
  fixture = new URL("/tests/fixtures/canvas-request-cards.html", server.resolvedUrls?.local[0])
    .href;
});

test.afterAll(async () => {
  await server?.close();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`通知授权与后台等待条 · ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 500 });
    await page.emulateMedia({ colorScheme });
    await page.goto(`${fixture}?notice-with-watch`);
    const notice = page.getByRole("region", { name: "允许小灵发送系统通知？" });
    const allow = notice.getByRole("button", { name: "允许通知", exact: true });
    const deny = notice.getByRole("button", { name: "不允许", exact: true });
    const watch = page.getByRole("region", { name: "后台等待生成" });
    await expect(notice).toHaveCSS("color-scheme", colorScheme);
    await expect(watch.getByRole("button", { name: /0\/1 已结束/ })).toBeVisible();
    await expectAssistantContrast(notice.getByRole("heading"));
    await expectAssistantContrast(notice.getByText(/^切到后台后/));
    await expectAssistantContrast(allow);
    await expectAssistantContrast(deny);
    expect(await notice.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(
      126,
    );
    await page
      .locator(".assistant-frame")
      .screenshot({ path: testInfo.outputPath("notification-watch.png") });

    await deny.focus();
    await page.keyboard.press("Tab");
    await expect(allow).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(deny).toBeFocused();
    await expect(deny).toHaveCSS("outline-style", "solid");
    await deny.press("Enter");
    await expect(notice).toBeHidden();
    await expect(page.getByTestId("decision")).toHaveText("false");
    await watch.getByRole("button", { name: /0\/1 已结束/ }).click();
    await expect(watch.getByRole("button", { name: "夜班站台" })).toBeVisible();
    await watch.getByRole("button", { name: "不用等了" }).click();
    await expect(watch).toBeHidden();

    await page.reload();
    await allow.click();
    await expect(notice).toBeHidden();
    await expect(page.getByTestId("decision")).toHaveText("true");
    await expect(watch).toBeVisible();
  });

  for (const width of [320, 400]) {
    test(`画布小灵请求卡片 · ${colorScheme} · ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 760 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.goto(fixture);
      const deletion = page.getByRole("region", { name: "申请删除" });
      const edits = page.getByRole("region", { name: "画布变更审批" });
      const deleteButton = deletion.getByRole("button", { name: "删除 2 项" });
      const decision = page.getByTestId("decision");
      await expect(deleteButton).toBeEnabled();
      await expect(deletion).toHaveCSS("color-scheme", colorScheme);
      const danger = colorScheme === "light" ? "rgb(160, 48, 38)" : "rgb(255, 158, 145)";
      await expect(deleteButton).toHaveCSS("background-color", danger);
      await expect(deletion.getByRole("checkbox").first()).toHaveCSS("accent-color", danger);
      await expect(deletion.locator("label").first()).toHaveCSS("display", "flex");
      await expect(deletion.getByText("含产物")).toBeVisible();

      await deletion.getByRole("heading").hover();
      await expect(page.getByTestId("highlighted")).toHaveText("2");
      const preview = edits.getByText("预览 1 个镜头");
      await preview.focus();
      await preview.press("Enter");
      await expect(preview).toHaveCSS("outline-style", "solid");
      await expect(edits.getByText("列车进站。", { exact: true })).toBeVisible();
      const operation = edits.getByText("查看操作", { exact: true }).last();
      await operation.click();
      await expect(page.getByTestId("highlighted")).toHaveText("0");
      await expect(edits.locator("pre").last()).toBeVisible();
      await page.getByText("查看端点和出站内容", { exact: true }).click();
      await expect(page.getByText("供应商可能计费。")).toBeVisible();
      await expect(page.getByText(/参考素材 站台参考/)).toBeVisible();
      await expect(page.locator(".canvas-assistant")).toHaveJSProperty("scrollLeft", 0);
      expect(await page.locator(".canvas-assistant").evaluate((panel) => panel.scrollWidth)).toBe(
        width,
      );
      await operation.click();
      await page.screenshot({
        path: testInfo.outputPath("canvas-request-cards.png"),
        fullPage: true,
      });

      await deletion.getByRole("button", { name: "保留" }).click();
      await expect(decision).toHaveText("[]");
      const opening = deletion.getByRole("checkbox", { name: "删除「从一个想法开始」" });
      await opening.focus();
      await opening.press("Space");
      await expect(opening).not.toBeChecked();
      await deletion.getByRole("button", { name: "删除 1 项" }).click();
      await expect(decision).toHaveText("[0]");
      await deletion.getByRole("checkbox", { name: "删除「直接编辑样本」" }).uncheck();
      await expect(deletion.getByRole("button", { name: "删除 0 项" })).toBeDisabled();

      await edits.getByRole("button", { name: "应用画布变更" }).click();
      await expect(decision).toHaveText("[0,1]");
      await edits.getByRole("button", { name: "拒绝" }).click();
      await expect(decision).toHaveText("[]");
      const questionnaire = page.getByRole("form", { name: "小灵提问" });
      await questionnaire.getByRole("radio", { name: /安静/ }).click();
      await questionnaire.getByRole("textbox", { name: "还有什么要补充？" }).fill("留出停顿");
      await questionnaire.getByRole("button", { name: "提交回答" }).click();
      await expect(decision).toHaveText(
        '[{"id":"tone","value":"安静"},{"id":"detail","value":"留出停顿"}]',
      );
      await page.getByRole("button", { name: "允许通知", exact: true }).click();
      await expect(decision).toHaveText("true");
      await page.getByRole("button", { name: "不允许", exact: true }).click();
      await expect(decision).toHaveText("false");
      await expect(page.getByText("已删除选中项")).toBeVisible();
      await expect(page.getByText("画布变更执行失败 · 画布已更新")).toBeVisible();
      await expect(page.getByText("删除请求已失效")).toBeVisible();
    });
  }
}

test("指定连线始终计入删除，且提交期间不能重复确认", async ({ page }) => {
  await page.goto(`${fixture}?edges`);
  const deletion = page.getByRole("region", { name: "申请删除" });
  await expect(deletion.getByText("同时删除 2 条指定连线")).toBeVisible();
  await expect(deletion.getByRole("button", { name: "删除 4 项" })).toBeEnabled();
  for (const checkbox of await deletion.getByRole("checkbox").all()) await checkbox.uncheck();
  await deletion.getByRole("button", { name: "删除 2 项" }).click();
  await expect(page.getByTestId("decision")).toHaveText("[2]");

  await page.goto(`${fixture}?busy`);
  await expect(deletion.getByRole("button", { name: "删除 2 项" })).toBeDisabled();
  await expect(deletion.getByRole("button", { name: "保留" })).toBeDisabled();
  await expect(deletion.getByRole("checkbox").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "应用画布变更" })).toBeDisabled();
});
