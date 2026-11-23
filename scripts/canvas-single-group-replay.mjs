import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function replaySingleGroup(page, capture) {
  const group = page.locator(".react-flow__node-group"),
    button = (name) => page.getByRole("button", { name, exact: true });
  const color = button("颜色"),
    arrange = button("整理布局"),
    ungroup = button("解组");
  const popup = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("region", { name: "背景颜色" }) });
  await group.getByText("单成员组", { exact: true }).click();
  await expect(group).toHaveClass(/selected/);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const firstClick = await color.isVisible();
  assert.equal(firstClick, false);
  await group.click({ position: { x: 18, y: 20 } });
  await expect(arrange).toBeDisabled();
  await expect.poll(() => arrange.evaluate((el) => el.getBoundingClientRect().height)).toBe(40);
  await color.focus();
  await page.keyboard.press("Tab");
  await expect(ungroup).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(color).toBeFocused();
  const bar = arrange.locator("xpath=.."),
    box = await bar.boundingBox(),
    target = await arrange.boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  const disabled = await arrange.evaluate((el) => {
    const rect = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    return {
      hitButton: !!document
        .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        ?.closest("button"),
      pointer: style.pointerEvents,
      opacity: style.opacity,
      background: style.backgroundColor,
    };
  });
  assert.deepEqual(disabled, {
    hitButton: false,
    pointer: "none",
    opacity: "0.35",
    background: "rgba(0, 0, 0, 0)",
  });
  await capture("disabledHover", {
    x: Math.floor(box.x) - 8,
    y: Math.floor(box.y) - 8,
    width: 374,
    height: 68,
  });
  await page.mouse.move(94, 95);
  await color.click();
  const hueNames = ["无", "红", "橙", "黄", "绿", "青", "蓝", "紫", "粉"];
  const order = ["背景颜色", "标签颜色"].flatMap((field) =>
    hueNames.map((hue) => `${field}：${hue}`),
  );
  const swatches = popup.getByRole("button");
  await expect(swatches).toHaveCount(order.length);
  const initialFocus = await popup.evaluate((el) => {
    const active = document.activeElement;
    return active === el ? "dialog" : (active?.getAttribute("aria-label") ?? active?.tagName);
  });
  assert.equal(initialFocus, order[0]);
  for (const [index, label] of order.entries()) {
    const swatch = swatches.nth(index);
    if (index) await page.keyboard.press("Tab");
    await expect(swatch).toBeFocused();
    await expect(swatch).toHaveAccessibleName(label);
    if (label === "背景颜色：绿") {
      await page.keyboard.down("Space");
      await expect(page.locator("[data-tool=pan],.flow-container[data-hand=true]")).toHaveCount(1);
      await page.keyboard.up("Space");
      await expect(page.locator("[data-tool=pan],.flow-container[data-hand=true]")).toHaveCount(0);
      await expect(swatch).toHaveAttribute("aria-pressed", "false");
    }
    if (label === "背景颜色：绿" || label === "标签颜色：粉") {
      await swatch.press("Enter");
      await expect(swatch).toHaveAttribute("aria-pressed", "true");
    }
  }
  await page.keyboard.press("Escape");
  await expect(color).toBeFocused();
  await expect(popup).toBeHidden();
  await page.keyboard.press("h");
  await page.mouse.move(240, 140);
  await page.mouse.down();
  await page.mouse.move(810, 540, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("v");
  await color.click();
  await expect(popup).toBeVisible();
  await page.mouse.move(94, 95);
  const placement = await popup.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((anim) => anim.finished.catch(() => {})));
    const rect = el.getBoundingClientRect(),
      trigger = document.querySelector('button[aria-label="颜色"]').getBoundingClientRect();
    const doc = document.documentElement;
    return {
      side: el.getAttribute("data-side"),
      left: rect.left,
      top: rect.top,
      rightGap: innerWidth - rect.right,
      gap: rect.top - trigger.bottom,
      shifted: rect.left < trigger.left,
      clipped: rect.bottom > innerHeight,
      availableWidth: doc.clientWidth,
      availableHeight: doc.clientHeight,
      scrollHeight: doc.scrollHeight,
      thumb: getComputedStyle(doc, "::-webkit-scrollbar-thumb").backgroundColor,
    };
  });
  assert.equal(placement.side, "bottom");
  assert(placement.shifted && placement.clipped);
  assert.equal(placement.gap, 10);
  assert.deepEqual(
    [
      placement.left,
      placement.top,
      placement.rightGap,
      placement.availableWidth,
      placement.availableHeight,
      placement.scrollHeight,
    ],
    [723, 610, 13, 1016, 692, 900],
  );
  await capture("cornerPalette", { x: 704, y: 548, width: 320, height: 152 });
  for (const label of ["背景颜色：绿", "标签颜色：粉"])
    await expect(popup.getByRole("button", { name: label })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  await page.keyboard.press("Escape");
  await expect(color).toBeFocused();
  await page.keyboard.press("h");
  await page.mouse.move(820, 535);
  await page.mouse.down();
  await page.mouse.move(250, 135, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("v");
  const zoomStates = [];
  for (const [action, factor] of [
    ["缩小", 0.833333],
    ["放大", 1],
    ["放大", 1.2],
  ]) {
    await button("缩放").click();
    await page.getByRole("menuitem", { name: new RegExp(`^${action}`) }).click();
    await expect
      .poll(() =>
        page
          .locator(".react-flow__viewport")
          .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a),
      )
      .toBe(factor);
    const frame = await group.boundingBox(),
      pill = await bar.boundingBox();
    const relative = {
      width: Math.round(frame.width / factor),
      barHeight: pill.height,
      offset: frame.y - pill.y - pill.height,
    };
    assert.equal(relative.width, 632);
    assert.equal(relative.barHeight, 52);
    zoomStates.push({ factor, ...relative });
  }
  const field = group.getByRole("textbox", { name: "组名" });
  await color.focus();
  await page.keyboard.press("F2");
  await expect(field).toBeFocused();
  const renameField = await field.evaluate((el) => ({
    selection: [el.selectionStart, el.selectionEnd],
    limit: el.maxLength,
    width: el.offsetWidth,
    height: el.offsetHeight,
  }));
  assert.deepEqual(renameField, { selection: [0, 4], limit: 40, width: 144, height: 24 });
  await field.fill("不保留");
  await field.press("Escape");
  const originalName = group.getByText("单成员组", { exact: true });
  await expect(originalName).toBeVisible();
  await originalName.dblclick();
  await expect(field).toBeFocused();
  await field.fill("  车站   夜景  ");
  await field.press("Enter");
  const newName = group.getByText("车站 夜景", { exact: true });
  await expect(newName).toBeVisible();
  await newName.dblclick();
  await field.fill("  ");
  await field.press("Tab");
  await expect(newName).toBeVisible();
  return { firstClick, disabled, initialFocus, order, placement, zoomStates, renameField };
}
