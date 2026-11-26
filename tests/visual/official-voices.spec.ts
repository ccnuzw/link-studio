import { type ElementHandle, expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let fixture: string;

const zayne = "fz-asset-20260908172456-9zvzx-audio.wav";
const xavier = "fz-asset-20260908172500-bpv4g-audio.wav";

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    publicDir: "src/renderer/public",
    cacheDir: "node_modules/.vite-official-voices",
    logLevel: "error",
    optimizeDeps: { entries: ["tests/fixtures/official-voices.html"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    oxc: { jsx: { runtime: "automatic" } },
  });
  await server.listen();
  fixture = new URL("/tests/fixtures/official-voices.html", server.resolvedUrls?.local[0]).href;
});

test.afterAll(async () => {
  await server?.close();
});

for (const [colorScheme, width] of [
  ["light", 1200],
  ["dark", 1200],
  ["dark", 320],
] as const) {
  test(`官方音色卡片 · ${colorScheme} · ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto(fixture);
    const picker = page.getByRole("dialog", { name: "资产库" });
    await picker.getByRole("tab", { name: "官方音色库" }).click();
    const cards = picker.getByRole("region", { name: "官方音色" });
    const first = cards.getByRole("button", { name: "Zayne 2.0", exact: true });
    await expect(first.locator("img")).toHaveJSProperty("complete", true);
    expect(
      await first.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBeGreaterThan(0);
    const card = cards.getByRole("article").first();
    if (colorScheme === "dark") await expect(card).toHaveCSS("background-color", "rgb(23, 23, 23)");
    await expect(card).toHaveCSS(
      "color",
      colorScheme === "dark" ? "rgb(250, 250, 250)" : "rgb(23, 23, 23)",
    );
    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(picker.getByText("已选择 1 个素材")).toBeVisible();
    expect(await picker.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await picker.screenshot({ path: testInfo.outputPath("官方音色库.png") });

    await cards.getByRole("button", { name: "试听 Zayne 2.0" }).click();
    const preview = page.getByRole("dialog", { name: "Zayne 2.0" });
    await expect(preview.getByText("English")).toBeVisible();
    await expect(preview.getByText("男生")).toBeVisible();
    const audio = (await preview
      .locator("audio")
      .elementHandle()) as ElementHandle<HTMLAudioElement>;
    await expect.poll(() => audio.evaluate((element) => element.duration)).toBeGreaterThan(0);
    await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(false);
    if (colorScheme === "dark" && width === 1200) {
      await preview.screenshot({ path: testInfo.outputPath("音色试听.png") });
    }
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(true);
  });
}

test("组合筛选、搜索和批量确认官方音色", async ({ page }) => {
  await page.goto(fixture);
  const picker = page.getByRole("dialog", { name: "资产库" });
  await picker.getByRole("tab", { name: "官方音色库" }).click();
  await picker.getByRole("button", { name: "语言", exact: true }).click();
  await picker.getByRole("button", { name: "English", exact: true }).click();
  await picker.getByRole("button", { name: "人群", exact: true }).click();
  await picker.getByRole("button", { name: "女生", exact: true }).click();
  const search = picker.getByRole("textbox", { name: /搜索/ });
  await search.fill("Zayne");
  await expect(picker.getByText("没有匹配的音色")).toBeVisible();
  await picker.getByRole("button", { name: "人群", exact: true }).click();
  await picker.getByRole("button", { name: "男生", exact: true }).click();
  await picker.getByRole("button", { name: "Zayne 2.0", exact: true }).click();
  await search.fill("Xavier");
  await picker.getByRole("button", { name: "Xavier 2.0", exact: true }).click();
  await expect(picker.getByText("已选择 2 个素材")).toBeVisible();
  await picker.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByTestId("confirmed")).toHaveText(`${zayne}, ${xavier}`);
});

test("音频节点单选替换和首页试听", async ({ page }) => {
  await page.goto(`${fixture}?single`);
  const picker = page.getByRole("dialog", { name: "资产库" });
  await expect(picker.getByRole("tab", { name: "官方音色库" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const first = picker.getByRole("button", { name: "Zayne 2.0", exact: true });
  await first.click();
  await picker.getByRole("button", { name: "Xavier 2.0", exact: true }).click();
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await picker.getByRole("button", { name: "放进节点" }).click();
  await expect(page.getByTestId("confirmed")).toHaveText(xavier);

  await page.goto(`${fixture}?home`);
  const homeCard = page.getByRole("button", { name: "Zayne 2.0", exact: true });
  await expect(homeCard.locator("img")).toHaveJSProperty("complete", true);
  await homeCard.click();
  const preview = page.getByRole("dialog", { name: "Zayne 2.0" });
  await expect(preview.getByText("English")).toBeVisible();
  await preview.getByRole("button", { name: "关闭" }).click();
  await expect(preview).toBeHidden();
});
