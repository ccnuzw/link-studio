import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function replayArrangeMenu(page, capture) {
  const nodes = page.locator(".react-flow__node");
  for (const [index, label] of ["对白", "站台", "场记"].entries()) {
    await nodes
      .filter({ has: page.getByText(label, { exact: true }) })
      .click({ position: { x: 45, y: 50 }, modifiers: index ? ["ControlOrMeta"] : [] });
  }
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);
  const geometry = () =>
    page.evaluate(() => ({
      nodes: [...document.querySelectorAll(".react-flow__node")].map((el) => ({
        position: el.style.transform,
        selected: el.classList.contains("selected"),
      })),
      edge: document.querySelector(".react-flow__edge-path").getAttribute("d"),
    }));
  const initial = await geometry(),
    states = {},
    menuPaint = {};
  const trigger = page.getByRole("button", { name: "整理布局", exact: true }),
    popup = page.getByRole("menu"),
    items = popup.getByRole("menuitem");
  const labels = ["横向排列", "纵向排列", "网格排列"];
  await page.evaluate(() => {
    window.arrangeMotion = {};
    const read = (event) => {
      const menu = event.target;
      if (!menu.matches("[role=menu]")) return;
      const phase = menu.hasAttribute("data-open") ? "opening" : "closing";
      const anim = menu
        .getAnimations()
        .find((animation) => animation.animationName === event.animationName);
      if (!anim || window.arrangeMotion[phase]) return;
      const { duration } = anim.effect.getTiming(),
        elapsed = anim.currentTime;
      const samples = [0, 0.25, 0.5, 0.75, 0.99].map((fraction) => {
        anim.currentTime = duration * fraction;
        const style = getComputedStyle(menu);
        return { opacity: style.opacity, matrix: style.transform };
      });
      window.arrangeMotion[phase] = { duration, samples };
      anim.currentTime = elapsed;
      if (phase === "closing") document.removeEventListener("animationstart", read, true);
    };
    document.addEventListener("animationstart", read, true);
  });
  await page.mouse.move(95, 97);
  await trigger.press("ArrowDown");
  await expect(items).toHaveText(labels);
  for (const [state, index, key] of [
    ["arrangeFirst", 0, null],
    ["arrangeLast", 2, "End"],
    ["arrangeMiddle", 1, "ArrowUp"],
  ]) {
    if (key) await page.keyboard.press(key);
    await expect(items.nth(index)).toBeFocused();
    menuPaint[state] = await popup.evaluate(async (menu) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(
        menu.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
      const styleOf = (el) => {
        const style = getComputedStyle(el),
          { x, y, width, height } = el.getBoundingClientRect();
        return {
          x,
          y,
          width,
          height,
          gap: style.gap,
          radius: style.borderRadius,
          color: style.color,
          background: style.backgroundColor,
        };
      };
      return [menu, ...menu.querySelectorAll("[role=menuitem],svg")].map(styleOf);
    });
    const { x, y } = menuPaint[state][0];
    await capture(state, { x: Math.floor(x) - 8, y: Math.floor(y) - 6, width: 176, height: 138 });
  }
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
  assert.deepEqual(await geometry(), initial);
  const motion = await page.evaluate(() => window.arrangeMotion);
  assert(motion.opening && motion.closing, "菜单应有进出场动画");
  const positions = [
    [
      [120, 200],
      [1512, 200],
      [816, 200],
    ],
    [
      [120, 200],
      [120, 604],
      [120, 1008],
    ],
    [
      [120, 200],
      [816, 200],
      [120, 604],
    ],
  ];
  for (const [index, label] of labels.entries()) {
    if (index === 0) {
      await trigger.click();
      await popup.getByRole("menuitem", { name: label, exact: true }).click();
    } else {
      await trigger.press("ArrowDown");
      await expect(items.first()).toBeFocused();
      await page.keyboard.press(index === 1 ? "ArrowDown" : "End");
      await expect(items.nth(index)).toBeFocused();
      await page.keyboard.press("Enter");
    }
    const expected = positions[index].map(([x, y]) => `translate(${x}px, ${y}px)`);
    await expect
      .poll(async () => (await geometry()).nodes.map((node) => node.position))
      .toEqual(expected);
    states[label] = await geometry();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(geometry).toEqual(initial);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(geometry).toEqual(states[label]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(geometry).toEqual(initial);
  }
  await page.keyboard.press("h");
  await expect(page.getByRole("radio", { name: "抓手", exact: true })).toBeChecked();
  await expect(trigger).toBeVisible();
  const hand = await trigger.evaluate((button) => {
    const box = button.getBoundingClientRect();
    return {
      pointer: getComputedStyle(button).pointerEvents,
      hit: Boolean(document.elementFromPoint(box.x + 20, box.y + 20)?.closest(".react-flow__pane")),
    };
  });
  assert.deepEqual(hand, { pointer: "none", hit: true });
  const anchor = await trigger.boundingBox(),
    start = { x: anchor.x + 20, y: anchor.y + 20 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 690, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => trigger.evaluate((el) => el.getBoundingClientRect().bottom))
    .toBeGreaterThan(780);
  await page.keyboard.press("v");
  await expect(page.getByRole("radio", { name: "选择", exact: true })).toBeChecked();
  await page.mouse.move(95, 97);
  await trigger.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  const side = await popup.getAttribute("data-side");
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  const bottom = await popup.evaluate(async (menu) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(menu.getAnimations().map((animation) => animation.finished.catch(() => {})));
    const scroll = getComputedStyle(menu, "::-webkit-scrollbar"),
      thumb = getComputedStyle(menu, "::-webkit-scrollbar-thumb");
    return {
      top: menu.getBoundingClientRect().top,
      height: menu.clientHeight,
      width: menu.clientWidth,
      scroll: menu.scrollTop,
      total: menu.scrollHeight,
      scrollWidth: scroll.width,
      thumb: thumb.backgroundColor,
    };
  });
  assert.equal(side, "bottom");
  assert(bottom.height < bottom.total && bottom.scroll > 0);
  const { x } = menuPaint.arrangeFirst[0],
    viewportHeight = await page.evaluate(() => innerHeight);
  await capture("arrangeBottom", {
    x: Math.floor(x) - 8,
    y: viewportHeight - 124,
    width: 176,
    height: 124,
  });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  return { initial, states, menuPaint, motion, hand, bottom: { side, ...bottom } };
}
