import { expect, type Locator, test } from "@playwright/test";
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
  fixture = new URL("/tests/fixtures/drama-assistant.html", server.resolvedUrls?.local[0]).href;
});
test.afterAll(async () => {
  await server?.close();
});

const look = (panel: Locator) =>
  panel.evaluate((element) => {
    const tokens = getComputedStyle(element);
    const style = (selector: string) =>
      getComputedStyle(element.querySelector(selector) ?? element);
    return {
      scheme: tokens.colorScheme,
      color: tokens.color,
      surface: tokens.backgroundColor,
      heading: style(".assistant-heading").fontFamily,
      composer: style(".assistant-composer").borderRadius,
    };
  });

for (const colorScheme of ["light", "dark"] as const) {
  test(`画布与短剧使用同一小灵主题 · ${colorScheme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.emulateMedia({ colorScheme });
    await page.goto(`${fixture}?canvas`);
    const canvas = page.locator(".assistant-surface");
    await expect(canvas.locator(".assistant-composer")).toBeVisible();
    await expect(canvas.getByText("让小灵帮你把想法搭成分镜")).toBeVisible();
    const canvasLook = await look(canvas);
    await canvas.screenshot({ path: info.outputPath("canvas.png") });
    await page.goto(fixture);
    const open = page.getByRole("button", { name: "小灵", exact: true });
    await expect(open).toHaveAttribute("title", "打开小灵");
    await open.click();
    const panel = page.getByRole("complementary", { name: "短剧小灵" });
    await expect(open).toHaveAttribute("title", "收起小灵");
    await expect(panel.getByText("让小灵帮你改剧本、资产和分镜")).toBeVisible();
    await expect(panel.getByLabel("短剧消息")).toBeVisible();
    await expect(panel.getByText("描述短剧需求，/ 插入技能")).toBeVisible();
    expect(await look(panel)).toEqual(canvasLook);
    await panel.screenshot({ path: info.outputPath("drama.png") });
    await page.screenshot({ path: info.outputPath("workbench.png") });
    await panel.getByRole("button", { name: "停靠到右侧" }).click();
    await expect(panel.locator("xpath=../..")).toHaveAttribute("data-mode", "dock");
    const editor = panel.getByLabel("短剧消息");
    await editor.fill("保留这份草稿");
    await panel.getByRole("button", { name: "收起小灵" }).click();
    await expect(panel).toBeHidden();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索命令" }).fill("打开小灵");
    await page.getByRole("combobox", { name: "搜索命令" }).press("Enter");
    await expect(editor).toHaveText("保留这份草稿");
    await expect(panel.getByRole("button", { name: "夜班创作" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.locator("xpath=../..")).toHaveAttribute("data-mode", "sheet");
    const bounds = await panel.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
    await expect(editor).toHaveText("保留这份草稿");
    await panel.screenshot({ path: info.outputPath("narrow.png") });
  });
}

test("发送固定分集，审批后显示任务进度和失败原因", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(fixture);
  await page.getByRole("button", { name: "小灵", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "短剧小灵" });
  await panel.getByRole("button", { name: "停靠到右侧" }).click();
  await panel.getByRole("button", { name: "移除 总览" }).click();
  await expect(panel.getByRole("button", { name: "恢复当前短剧引用" })).toBeVisible();
  await panel.getByLabel("短剧消息").fill("拆解这集的资产");
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  const sent = JSON.parse((await page.getByTestId("sent").textContent()) ?? "null");
  expect(sent.dramaContext).toEqual({ episodeNo: 1, episodeOrder: 3 });
  await page.getByRole("button", { name: "命令面板", exact: true }).click();
  await page.getByRole("combobox", { name: "搜索命令" }).fill("第 2 集");
  await page.getByRole("combobox", { name: "搜索命令" }).press("Enter");
  await expect(panel.getByLabel("发送时的短剧引用")).toContainText("第 1 集");
  const card = panel.getByRole("region", { name: "运行短剧任务：资产拆解" });
  await expect(card).toContainText("第 1 集 · 预估 28 积分");
  await card.screenshot({ path: info.outputPath("approval.png") });
  await card.getByRole("button", { name: "批准并运行 ✦ 28" }).click();
  await expect(
    panel.getByText("资产拆解 · 第 1 集 · 运行中 · 40%", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-job-failed")));
  await expect(panel.getByText("测试服务暂时不可用", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "查看工序" }).click();
  await expect(page.getByRole("region", { name: "资产列表" })).toBeVisible();
});

test("资产入口召唤小灵，片场引用当前片段", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(fixture);
  const command = async (text: string) => {
    await page.getByRole("button", { name: "命令面板", exact: true }).click();
    const search = page.getByRole("combobox", { name: "搜索命令" });
    await search.fill(text);
    await search.press("Enter");
  };
  await command("资产管理");
  await page.getByRole("tab", { name: /^场景/ }).click();
  await page.getByRole("button", { name: "把 夜班站台 交给小灵" }).click();
  const panel = page.getByRole("complementary", { name: "短剧小灵" });
  const refs = panel.getByLabel("随消息发送的短剧引用");
  await expect(refs).toContainText("夜班站台");
  await refs.getByRole("button", { name: "移除 夜班站台" }).click();
  await expect(refs).not.toContainText("夜班站台");
  await panel.getByRole("button", { name: "恢复当前短剧引用" }).click();
  await expect(refs).toContainText("夜班站台");
  await page.getByRole("button", { name: "在画布中打开 夜班候车室" }).click();
  await expect(refs).toContainText("夜班候车室");
  await expect(refs).not.toContainText("夜班站台");
  await command("第 2 集");
  await expect(refs).toContainText("片段 1");
  await expect(refs).toContainText("第 2 集");
  await expect(refs).not.toContainText("夜班站台");
  await expect(refs).not.toContainText("夜班候车室");
});

test("可拒绝任务并提交修改说明", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(fixture);
  await page.getByRole("button", { name: "小灵", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "短剧小灵" });
  await panel.getByLabel("短剧消息").fill("拆解这集的资产");
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  const card = panel.getByRole("region", { name: "运行短剧任务：资产拆解" });
  await card.getByRole("button", { name: "不用了，并告诉小灵怎么改…" }).click();
  await expect(card.getByLabel("拒绝说明")).toBeFocused();
  await card.getByLabel("拒绝说明").fill("先核对场景名称");
  await card.getByRole("button", { name: "提交说明" }).click();
  await expect(panel.getByText("已拒绝任务")).toBeVisible();
  await expect(panel.getByRole("button", { name: "查看工序" })).toHaveCount(0);
});

test("模型下线时保留历史和草稿，并提示恢复方式", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture);
  await page.getByRole("button", { name: "小灵", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "短剧小灵" });
  const editor = panel.getByLabel("短剧消息");
  const send = panel.getByRole("button", { name: "发送", exact: true });
  await editor.fill("拆解这集的资产");
  await send.click();
  await panel.getByRole("button", { name: "不用了", exact: true }).click();
  await expect(panel.getByText("已拒绝任务")).toBeVisible();
  await editor.fill("保留模型下线前的草稿");
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-model-disabled")));
  await expect(editor).toBeHidden();
  await expect(panel.getByText("已拒绝任务")).toBeVisible();
  await expect(panel.getByText("暂时没有可用的 Agent 模型")).toBeVisible();
  await expect(panel.getByText("请联系管理员发布 Agent 模型后再来。")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-model-enabled")));
  await expect(editor).toHaveText("保留模型下线前的草稿");
  await expect(send).toBeEnabled();
});
