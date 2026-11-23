import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function replayLooseLink(page, capture) {
  const nodes = page.locator(".react-flow__node"),
    edges = page.locator(".react-flow__edge-path");
  const text = nodes.filter({ has: page.getByText("对白", { exact: true }) }),
    video = nodes.filter({ has: page.getByText("站台", { exact: true }) });
  const menu = page.getByRole("menu"),
    items = menu.getByRole("menuitem"),
    line = page.locator('svg.canvas-fan-lines > path,svg.fixed.z-40 > path[stroke-width="1"]');
  const graph = async () => ({
    nodes: await nodes.evaluateAll((els) =>
      els.map((el) => [el.style.transform, el.classList.contains("selected")]),
    ),
    paths: await edges.evaluateAll((els) => els.map((el) => el.getAttribute("d"))),
  });
  const original = await graph();
  const live = page.locator(".react-flow__connection-path");
  const drag = async (node, side, x, y, scene) => {
    const port = node.locator(`.react-flow__handle-${side}`).first(),
      box = await port.boundingBox();
    assert(box);
    await page.mouse.move(
      box.x + box.width / 2 + (side === "right" ? 4 : -4),
      box.y + box.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 12 });
    await expect(live).toBeVisible();
    const pendingPath = await live.evaluate((el) => {
      const css = getComputedStyle(el);
      return { path: el.getAttribute("d"), stroke: css.stroke, width: css.strokeWidth };
    });
    if (scene) {
      await capture(
        scene,
        scene === "forwardDrag"
          ? { x: 656, y: 157, width: 124, height: 294 }
          : { x: 737, y: 295, width: 171, height: 330 },
      );
    }
    await page.mouse.up();
    await expect(live).toHaveCount(0);
    return pendingPath;
  };
  const pending = async (x, y) => {
    await expect(menu.getByText("引用该节点生成", { exact: true })).toBeVisible();
    await expect(items).toHaveCount(9);
    await expect(line).toHaveCount(1);
    const preview = await line.evaluate((el) => {
      const end = el.getPointAtLength(el.getTotalLength()),
        css = getComputedStyle(el);
      return {
        path: el.getAttribute("d"),
        end: [end.x, end.y],
        stroke: css.stroke,
        width: css.strokeWidth,
        pointer: getComputedStyle(el.ownerSVGElement).pointerEvents,
      };
    });
    assert.deepEqual(preview.end, [x, y]);
    assert.equal(preview.pointer, "none");
    await menu.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((anim) => anim.finished.catch(() => {})));
    });
    return {
      preview,
      rect: await menu.boundingBox(),
      scroll: await menu.evaluate((el) => [
        el.clientWidth,
        el.clientHeight,
        el.scrollHeight,
        el.scrollTop,
      ]),
      items: await items.evaluateAll((els) =>
        els.map((el) => [el.textContent, el.getAttribute("aria-disabled") === "true"]),
      ),
    };
  };
  const closed = async () => {
    await expect(menu).toBeHidden();
    await expect(line).toHaveCount(0);
  };
  await drag(text, "right", 1002, 332);
  await closed();
  assert.deepEqual(await graph(), original);
  const forwardDrag = await drag(text, "right", 764, 172, "forwardDrag");
  const forward = await pending(764, 172);
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.mouse.move(725, 131);
  await capture("forwardMenu", { x: 751, y: 165, width: 230, height: 435 });
  await page.keyboard.press("Escape");
  await closed();
  assert.deepEqual(await graph(), original);
  const history = await page.getByRole("button", { name: "任务历史", exact: true }).boundingBox();
  const chromeX = Math.floor(history.x + history.width - 3),
    chromeY = Math.floor(history.y + history.height / 2);
  await drag(text, "right", chromeX, chromeY);
  const overChrome = await pending(chromeX, chromeY);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.mouse.click(740, 115);
  await closed();
  assert.deepEqual(await graph(), original);
  const reverseDrag = await drag(video, "left", 752, 610, "reverseDrag");
  const reverse = await pending(752, 610);
  await page.mouse.move(725, 575);
  await capture("reverseMenu", { x: 738, y: 601, width: 240, height: 280 });
  await items.nth(1).hover();
  await page.mouse.wheel(0, 540);
  await expect
    .poll(() => menu.evaluate((el) => el.scrollTop + el.clientHeight))
    .toBe(reverse.scroll[2]);
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press("Enter");
  await closed();
  await expect(nodes).toHaveCount(3);
  await expect(edges).toHaveCount(2);
  const created = await graph();
  assert.deepEqual(created.nodes.at(-1), ["translate(176px, 448px)", true]);
  assert.equal(created.paths[0], original.paths[0]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(nodes).toHaveCount(2);
  await expect(edges).toHaveCount(1);
  assert.deepEqual(await graph(), original);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(nodes).toHaveCount(3);
  await expect(edges).toHaveCount(2);
  return { forwardDrag, forward, overChrome, reverseDrag, reverse, created, redone: await graph() };
}
