import assert from "node:assert/strict";
import { join } from "node:path";

export async function auditDirectorChrome(page, side, output) {
  const states = {},
    rectangles = {},
    images = {};
  const header = page.getByRole("dialog").locator("header").first(),
    main = page.getByRole("dialog").locator("main"),
    tools = page.getByRole("navigation", { name: "工具" });
  const snap = header.getByTitle(/^吸附/),
    labels = header.getByTitle("显示人物和机位名称"),
    rotate = tools.getByTitle("旋转（2）");
  async function capture(name, region, controls) {
    await page.mouse.move(4, 4);
    await page.waitForTimeout(260);
    states[name] = {
      snap: await snap.getAttribute("aria-pressed"),
      labels: await labels.getAttribute("aria-pressed"),
      rotate: await rotate.getAttribute("aria-pressed"),
      exportable: await header.getByRole("button", { name: "导出视频" }).isEnabled(),
      empty: await main.getByText("添加人物或机位开始摆位").count(),
      retry: await main.getByRole("button", { name: "重试" }).count(),
    };
    rectangles[name] = await Promise.all([region, ...controls].map((item) => item.boundingBox()));
    images[name] = await region.screenshot({ path: join(output, `${side}-chrome-${name}.png`) });
  }
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("director:assets-open", "0");
    window.failModel = true;
    const decode = window.atob.bind(window);
    window.atob = (value) => {
      if (window.failModel && value.startsWith("Z2xURg")) throw Error("model unavailable");
      return decode(value);
    };
  });
  if (side === "upstream")
    await page.route("**/director/*.glb", async (route) => {
      if (await page.evaluate(() => window.failModel))
        await route.fulfill({ status: 503, body: "" });
      else await route.continue();
    });
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  const retry = main.getByRole("button", { name: "重试" });
  await retry.waitFor();
  await capture("failed", main, [
    retry,
    retry.locator(".."),
    main.locator("canvas").first(),
    page.getByTitle("切换视角"),
  ]);
  await page.evaluate(() => {
    window.failModel = false;
  });
  await retry.click();
  await retry.waitFor({ state: "hidden" });
  if (side === "desktop") await page.locator('[data-figure-status="ready"]').waitFor();
  else
    await page.waitForFunction(async () => {
      const { figureModelStatus } = await import("/src/utils/director/figure.ts");
      return figureModelStatus("male") === "ready";
    });
  await capture("recovered", main, [
    main.locator("canvas").first(),
    main.locator("canvas").last(),
    page.getByTitle("切换视角"),
  ]);
  await snap.click();
  await labels.click();
  await rotate.click();
  await capture("toggles", header, await header.locator("button,svg").all());
  assert.equal(states.toggles.snap, "false");
  assert.equal(states.toggles.rotate, "true");
  assert.equal(states.toggles.labels, "false");
  await page.keyboard.press("1");
  assert.equal(await rotate.getAttribute("aria-pressed"), "false");
  const sidebar = page
    .locator("aside")
    .filter({ has: page.getByRole("button", { name: "图层", exact: true }) });
  for (const name of ["角色A", "机位1"]) {
    const row = sidebar.getByText(name, { exact: true }).locator("..");
    await row.hover();
    await row.getByTitle("删除", { exact: true }).click();
  }
  const empty = main.getByText("添加人物或机位开始摆位");
  await empty.waitFor();
  await capture("empty", main, [
    empty,
    main.getByRole("button", { name: "添加一台机位" }),
    main.getByRole("button", { name: "添加一台机位" }).locator("../.."),
    page.getByTitle("切换视角"),
  ]);
  assert.equal(states.empty.exportable, false);
  const switchView = page.getByTitle("切换视角");
  const menu = main.getByRole("menu", { name: "视角" });
  await switchView.click();
  assert.equal(await menu.getByRole("menuitemradio").count(), 1);
  await capture("no-camera-menu", menu, [
    menu.getByRole("menuitemradio"),
    menu.getByText("先添加一台机位"),
  ]);
  await page.keyboard.press("Escape");
  assert.ok(await switchView.evaluate((node) => node === document.activeElement));
  await main.getByRole("button", { name: "左右分栏" }).click();
  await capture("empty-split", main, [
    empty,
    main.getByRole("button", { name: "添加一台机位" }),
    page.getByTitle("切换视角"),
  ]);
  await main.getByRole("button", { name: "添加一台机位" }).click();
  assert.equal(await header.getByRole("button", { name: "导出视频" }).isEnabled(), true);
  assert.equal(await main.getByText("添加人物或机位开始摆位").count(), 0);
  await header.getByText("保存中…").waitFor();
  await header.getByText("已保存到节点").waitFor();
  await capture("saved", header, await header.locator("button,svg").all());
  const longName = "走廊尽头向右跟拍人物转身回望的第二机位";
  await sidebar.getByRole("button", { name: "+ 机位", exact: true }).click();
  const nameField = sidebar
    .locator("label")
    .filter({ has: page.getByText("名称", { exact: true }) })
    .locator("input");
  await nameField.fill(longName);
  await nameField.press("Enter");
  await switchView.click();
  const item = menu.getByRole("menuitemradio", { name: longName, exact: true });
  const label = item.locator("span").last();
  assert.ok(
    await label.evaluate(
      (node) =>
        node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === "ellipsis",
    ),
  );
  await capture("long-camera-menu", menu, [item, label]);
  await item.click();
  assert.equal(await switchView.textContent(), `机位视角 · ${longName}`);
  return { states, rectangles, images };
}
