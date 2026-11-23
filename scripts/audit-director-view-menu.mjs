import assert from "node:assert/strict";
import { join } from "node:path";

export async function auditDirectorViewMenu(page, side, output) {
  const trigger = page.getByTitle("切换视角");
  const menu = page.getByRole("menu", { name: "视角" });
  const items = menu.getByRole("menuitemradio");
  const images = {},
    rectangles = {},
    states = {};
  const box = await trigger.boundingBox();
  const clip = {
    x: Math.floor(box.x + box.width / 2) - 114,
    y: Math.floor(box.y) - 106,
    width: 228,
    height: 152,
  };
  async function capture(name, focus, checked) {
    await page.waitForTimeout(200);
    const expanded = (await trigger.getAttribute("aria-expanded")) === "true";
    const buttons = await items.all();
    const active = await page.evaluate(
      () =>
        document.activeElement?.closest('[role="menuitemradio"]')?.textContent ??
        document.activeElement?.getAttribute("title"),
    );
    assert.equal(active, focus);
    const selected = await items.evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getAttribute("aria-checked") === "true")
        .map((node) => node.textContent),
    );
    assert.deepEqual(selected, checked ? [checked] : []);
    states[name] = { expanded, active, selected, label: await trigger.textContent() };
    const targets = [trigger, ...(await trigger.locator("svg").all()), ...(expanded ? [menu] : [])];
    for (const button of buttons)
      targets.push(button, ...(await button.locator("span, svg").all()));
    rectangles[name] = await Promise.all(targets.map((target) => target.boundingBox()));
    images[name] = await page.screenshot({ clip, path: join(output, `${side}-view-${name}.png`) });
  }
  await trigger.click();
  await capture("open", "机位1", "机位1");
  await page.keyboard.press("ArrowDown");
  await capture("wrap-down", "导演视角", "机位1");
  await page.keyboard.press("ArrowUp");
  await capture("wrap-up", "机位1", "机位1");
  await page.keyboard.press("Escape");
  await capture("escape", "切换视角");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await capture("choose", "切换视角");
  assert.equal(await trigger.textContent(), "导演视角");
  await trigger.click();
  await page.mouse.click(4, 4);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await trigger.click();
  await items.getByText("机位1").click();
  return { images, rectangles, states };
}
