import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function replayGroupTools(page, capture) {
  const nodes = page.locator(".react-flow__node");
  for (const [index, label] of ["对白", "站台"].entries())
    await nodes
      .filter({ has: page.getByText(label, { exact: true }) })
      .click({ position: { x: 45, y: 50 }, modifiers: index ? ["ControlOrMeta"] : [] });
  await page.getByRole("button", { name: /打组/ }).click();
  const name = page.getByRole("textbox", { name: "组名" });
  await name.fill("镜头一");
  await name.press("Enter");
  const group = page.locator(".react-flow__node-group"),
    trigger = page.getByRole("button", { name: "颜色", exact: true });
  await group.click({ position: { x: 18, y: 20 } });
  await expect(trigger).toBeVisible();
  const measure = (locator) =>
    locator.evaluate(async (element) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(
        element.getAnimations({ subtree: true }).map((anim) => anim.finished.catch(() => {})),
      );
      const sample = (el) => {
        const { x, y, width, height } = el.getBoundingClientRect(),
          style = getComputedStyle(el);
        return {
          x,
          y,
          width,
          height,
          radius: style.borderRadius,
          background: style.backgroundColor,
          color: style.color,
        };
      };
      return [element, ...element.querySelectorAll("section,h4,button")].map(sample);
    });
  await page.mouse.move(96, 98);
  const toolbar = trigger.locator("xpath=..");
  await expect.poll(() => toolbar.evaluate((el) => el.getBoundingClientRect().height)).toBe(52);
  const toolbarPaint = await measure(toolbar);
  const bar = toolbarPaint[0];
  await capture("groupToolbar", {
    x: Math.floor(bar.x) - 8,
    y: Math.floor(bar.y) - 5,
    width: Math.ceil(bar.width) + 16,
    height: 66,
  });
  for (const [button, label, key] of [
    ["解组", "解散这个组，节点原地保留", "G"],
    ["删除组", "删除组和组内节点", "⌫"],
  ]) {
    await toolbar.getByRole("button", { name: button, exact: true }).hover();
    const tip = page
      .locator('[data-slot="tooltip-content"],.canvas-control-tip')
      .filter({ hasText: label });
    await expect(tip).toBeVisible();
    await expect(tip.locator("kbd")).toContainText(key);
    await page.mouse.move(96, 98);
    await expect(tip).toBeHidden();
  }
  await trigger.click();
  const popup = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("region", { name: "背景颜色" }) });
  const swatch = (label) => popup.getByRole("button", { name: label, exact: true });
  const record = async (state) => {
    await page.mouse.move(96, 98);
    const paint = await measure(popup),
      { x, y } = paint[0];
    await capture(state, { x: Math.floor(x) - 8, y: Math.floor(y) - 8, width: 304, height: 300 });
    return paint;
  };
  const paint = {};
  await expect(popup.getByRole("button")).toHaveCount(18);
  for (const label of ["背景颜色：无", "标签颜色：无"])
    await expect(swatch(label)).toHaveAttribute("aria-pressed", "true");
  paint.initial = await record("groupDefaults");
  for (const label of ["背景颜色：蓝", "标签颜色：红"]) await swatch(label).click();
  for (const label of ["背景颜色：蓝", "标签颜色：红"])
    await expect(swatch(label)).toHaveAttribute("aria-pressed", "true");
  paint.selected = await record("groupSelected");
  await swatch("背景颜色：无").click();
  await expect(swatch("标签颜色：红")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("h");
  await expect(page.getByRole("radio", { name: "抓手", exact: true })).toBeChecked();
  const hand = {
    visible: await trigger.isVisible(),
    fan: await page.getByRole("button", { name: "引用选中的节点生成", exact: true }).isVisible(),
  };
  if (hand.visible)
    hand.pointer = await trigger.evaluate((el) => getComputedStyle(el).pointerEvents);
  assert.deepEqual(hand, { visible: true, fan: true, pointer: "none" });
  await page.keyboard.press("v");
  await expect(page.getByRole("radio", { name: "选择", exact: true })).toBeChecked();
  await trigger.click();
  await expect(swatch("背景颜色：无")).toHaveAttribute("aria-pressed", "true");
  await expect(swatch("标签颜色：红")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  const geometry = () =>
    page.locator(".react-flow__node:not(.react-flow__node-group)").evaluateAll((els) =>
      els.map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return [x, y, width, height];
      }),
    );
  const positions = await geometry(),
    remove = page
      .locator(".react-flow__node-toolbar")
      .getByRole("button", { name: "删除组", exact: true });
  const dialog = page.getByRole("alertdialog", { name: "删除「镜头一」？" });
  await remove.click();
  await expect(dialog).toContainText(
    "里面的 2 个节点会一起被删除，相关连线也会断开。可以用撤销恢复。",
  );
  await page.mouse.move(96, 98);
  const confirmation = await measure(dialog),
    focus = await page.evaluate(() => document.activeElement.textContent);
  assert.equal(focus, "删除组和节点");
  const { x, y } = confirmation[0];
  await capture("groupDelete", {
    x: Math.floor(x) - 8,
    y: Math.floor(y) - 8,
    width: 400,
    height: 200,
  });
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  await expect(nodes).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await remove.click();
  await dialog.getByRole("button", { name: "删除组和节点" }).click();
  await expect(nodes).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(nodes).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect.poll(geometry).toEqual(positions);
  await nodes
    .filter({ has: page.getByText("对白", { exact: true }) })
    .click({ position: { x: 45, y: 50 } });
  await expect(group).not.toHaveClass(/selected/);
  await group.click({ position: { x: 18, y: 20 } });
  await expect(group).toHaveClass(/selected/);
  await expect(trigger).toBeHidden();
  await group.click({ position: { x: 18, y: 20 } });
  await page.getByRole("button", { name: "解组", exact: true }).click();
  await expect(group).toHaveCount(0);
  assert.deepEqual(await geometry(), positions);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  return { paint, hand, positions, confirmation, focus, toolbarPaint };
}
