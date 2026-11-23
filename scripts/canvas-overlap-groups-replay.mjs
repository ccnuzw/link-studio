import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export function overlapGroupsFixture(graph) {
  graph.nodes[0].position = { x: 120, y: 100 };
  graph.nodes[1].position = { x: 1110, y: 190 };
  graph.nodes.unshift(
    ...[
      ["后组", 320, 265, 500, 370],
      ["前组", 560, 350, 520, 375],
    ].map(([label, x, y, width, height], index) => ({
      id: `group-${index}`,
      type: "group",
      position: { x, y },
      width,
      height,
      zIndex: -2000,
      data: { label },
    })),
  );
}

export async function replayOverlapGroups(page, capture) {
  const groups = page.locator(".react-flow__node-group"),
    rear = groups.filter({ hasText: "后组" }),
    front = groups.filter({ hasText: "前组" });
  const titled = (label) =>
    page.locator(".react-flow__node").filter({ has: page.getByText(label, { exact: true }) });
  const card = titled("对白"),
    video = titled("站台");
  const toolbar = page.getByRole("button", { name: "颜色", exact: true }),
    fan = page.getByRole("button", { name: "引用选中的节点生成" });
  const lit = () =>
    groups.evaluateAll((nodes) =>
      nodes
        .filter((node) => node.hasAttribute("data-drop-target"))
        .map((node) => (node.textContent.includes("后组") ? "后组" : "前组")),
    );
  const path = () => page.locator(".react-flow__edge-path").getAttribute("d");
  const snapshot = async () => ({
    rear: await rear.boundingBox(),
    front: await front.boundingBox(),
    card: await card.boundingBox(),
    video: await video.boundingBox(),
    edge: await path(),
  });
  const tick = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const begin = async (node, dx, dy) => {
    const box = await node.boundingBox();
    await page.mouse.move(box.x + dx, box.y + dy);
    await tick();
    await page.mouse.down();
    await tick();
    return box;
  };
  const start = await snapshot(),
    steps = [];
  const grab = async () => {
    const initial = await begin(card, 80, 50);
    await page.mouse.move(initial.x + 90, initial.y + 60);
    await expect(card).toHaveClass(/dragging/);
    await tick();
    const box = await card.boundingBox(),
      offsetX = initial.x + 90 - box.x,
      offsetY = initial.y + 60 - box.y;
    return async (cx, cy, target) => {
      await page.mouse.move(cx - box.width / 2 + offsetX, cy - box.height / 2 + offsetY, {
        steps: 4,
      });
      await expect.poll(lit).toEqual(target ? [target] : []);
      await expect
        .poll(async () => {
          const state = await card.boundingBox();
          return [state.x + state.width / 2, state.y + state.height / 2];
        })
        .toEqual([cx, cy]);
      steps.push({ cx, cy, target, edge: await path() });
    };
  };
  const frame = front.locator("[data-slot=group-frame],.canvas-group-frame");
  await frame.evaluate((el) => {
    window.groupTargetMotion = [];
    el.addEventListener("transitionrun", (event) => {
      const target = el.closest(".react-flow__node").hasAttribute("data-drop-target");
      if (event.propertyName !== "box-shadow" || window.auditNextGroupTarget !== target) return;
      const animation = el
        .getAnimations()
        .find((item) => item.transitionProperty === event.propertyName);
      if (!animation) return;
      window.auditNextGroupTarget = null;
      const previous = animation.currentTime,
        { duration } = animation.effect.getTiming();
      const samples = [0, 25, 50, 75, 100].map((percent) => {
        animation.currentTime = (duration * percent) / 100;
        return getComputedStyle(el).boxShadow;
      });
      animation.currentTime = previous;
      window.groupTargetMotion.push({ target, duration, samples });
    });
  });
  const move = await grab();
  await move(440, 440, "后组");
  await move(559, 447, "后组");
  await move(560, 447, "前组");
  const paint = await frame.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((anim) => anim.finished.catch(() => {})));
    const css = getComputedStyle(el);
    return {
      radius: css.borderRadius,
      shadow: css.boxShadow,
      border: css.borderColor,
      background: css.backgroundColor,
    };
  });
  await capture("frontTarget", { x: 1012, y: 650, width: 90, height: 94 });
  assert.deepEqual(await lit(), ["前组"]);
  assert.equal(await frame.evaluate((el) => getComputedStyle(el).boxShadow), paint.shadow);
  await move(470, 447, "后组");
  await tick();
  await frame.evaluate((el) =>
    Promise.all(el.getAnimations().map((anim) => anim.finished.catch(() => {}))),
  );
  await page.evaluate(() => {
    window.auditNextGroupTarget = true;
  });
  await move(634, 467, "前组");
  await expect.poll(() => page.evaluate(() => window.groupTargetMotion.length)).toBe(1);
  await frame.evaluate((el) =>
    Promise.all(el.getAnimations().map((anim) => anim.finished.catch(() => {}))),
  );
  await page.evaluate(() => {
    window.auditNextGroupTarget = false;
  });
  const beforeDrop = await snapshot();
  await page.mouse.up();
  await expect.poll(lit).toEqual([]);
  assert.deepEqual(await snapshot(), beforeDrop);
  await expect
    .poll(() => page.evaluate(() => window.groupTargetMotion.map(({ target }) => target)))
    .toEqual([true, false]);
  const motion = await page.evaluate(() => window.groupTargetMotion.slice());
  assert.deepEqual(
    motion.map(({ duration }) => duration),
    [150, 150],
  );
  await front.click({ position: { x: 450, y: 255 } });
  await expect(front).toHaveClass(/selected/);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(fan).toBeVisible();
  await front.click({ position: { x: 450, y: 255 } });
  await expect(toolbar).toBeVisible();
  const selectedPaint = await frame.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((anim) => anim.finished.catch(() => {})));
    return getComputedStyle(el).borderColor;
  });
  await capture("selectedFront", { x: 1012, y: 650, width: 90, height: 94 });
  const bounds = await begin(front, 450, 255);
  await page.mouse.move(bounds.x + 460, bounds.y + 265);
  await expect(front).toHaveClass(/dragging/);
  await tick();
  const active = await front.boundingBox();
  await page.mouse.move(
    bounds.x + 513 + bounds.x + 10 - active.x,
    bounds.y + 296 + bounds.y + 10 - active.y,
    { steps: 6 },
  );
  await expect(toolbar).toBeHidden();
  await expect(fan).toBeHidden();
  await expect.poll(lit).toEqual([]);
  await tick();
  const dragged = await snapshot();
  for (const key of ["front", "card"])
    assert.deepEqual(dragged[key], {
      ...beforeDrop[key],
      x: beforeDrop[key].x + 63,
      y: beforeDrop[key].y + 41,
    });
  for (const key of ["rear", "video"]) assert.deepEqual(dragged[key], start[key]);
  assert.notEqual(dragged.edge, beforeDrop.edge);
  await page.mouse.up();
  await expect(toolbar).toBeVisible();
  await expect(fan).toBeVisible();
  assert.deepEqual(await snapshot(), dragged);
  const cornerDrag = async (dx, dy) => {
    const corner = await front
      .locator(".react-flow__resize-control.handle.bottom.right")
      .boundingBox();
    assert(corner);
    const cx = corner.x + corner.width / 2,
      cy = corner.y + corner.height / 2;
    await page.mouse.move(cx, cy);
    await tick();
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
    await tick();
    await expect(toolbar).toBeVisible();
    await expect(fan).toBeVisible();
    assert.deepEqual(await card.boundingBox(), dragged.card);
    assert.equal(await path(), dragged.edge);
    await page.mouse.up();
    await tick();
    return front.boundingBox();
  };
  const larger = await cornerDrag(18, 24);
  assert.deepEqual(larger, {
    ...dragged.front,
    width: dragged.front.width + 18,
    height: dragged.front.height + 24,
  });
  assert.deepEqual(await cornerDrag(-18, -24), dragged.front);
  const exit = await grab();
  await exit(480, 447, "后组");
  await exit(319, 447, null);
  await exit(319, 680, null);
  await page.mouse.up();
  await expect.poll(lit).toEqual([]);
  const outside = await snapshot();
  await front.getByText("前组", { exact: true }).click();
  await expect(fan).toBeHidden();
  const empty = await begin(front, 450, 255);
  await page.mouse.move(empty.x + 440, empty.y + 245);
  await expect(front).toHaveClass(/dragging/);
  await tick();
  const activeEmpty = await front.boundingBox();
  await page.mouse.move(
    empty.x + 389 + empty.x - activeEmpty.x,
    empty.y + 216 + empty.y - activeEmpty.y,
    { steps: 6 },
  );
  await expect.poll(async () => (await front.boundingBox()).x).toBe(empty.x - 51);
  await page.mouse.up();
  assert.deepEqual(await card.boundingBox(), outside.card);
  assert.equal(await path(), outside.edge);
  const emptyState = await snapshot(),
    corner = front.locator(".react-flow__resize-control.handle.top.left");
  await front.click({ position: { x: 450, y: 255 } });
  await expect(toolbar).toBeVisible();
  const handle = await corner.boundingBox();
  assert(handle);
  assert(
    await corner.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === el;
    }),
  );
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(265, 300, { steps: 12 });
  await expect.poll(async () => (await front.boundingBox()).x).toBe(265);
  await expect(toolbar).toBeVisible();
  await page.mouse.up();
  await expect(toolbar).toBeVisible();
  const expanded = await snapshot();
  assert.equal(expanded.front.y, 300);
  assert.equal(
    expanded.front.x + expanded.front.width,
    emptyState.front.x + emptyState.front.width,
  );
  assert.deepEqual(expanded.card, outside.card);
  assert.deepEqual(expanded.video, start.video);
  await expect(fan).toBeHidden();
  const expandedBox = await begin(front, 690, 335);
  await page.mouse.move(expandedBox.x + 700, expandedBox.y + 345);
  await expect(front).toHaveClass(/dragging/);
  await tick();
  const activeExpanded = await front.boundingBox();
  await page.mouse.move(
    expandedBox.x + 745 + expandedBox.x - activeExpanded.x,
    expandedBox.y + 365 + expandedBox.y - activeExpanded.y,
    { steps: 5 },
  );
  await expect.poll(async () => (await front.boundingBox()).x).toBe(expandedBox.x + 45);
  await page.mouse.up();
  const afterResizeMove = await snapshot();
  assert.notEqual(afterResizeMove.front.x, expanded.front.x);
  assert.deepEqual(afterResizeMove.card, outside.card);
  assert.equal(afterResizeMove.edge, outside.edge);
  return {
    start,
    steps,
    paint,
    selectedPaint,
    beforeDrop,
    dragged,
    larger,
    outside,
    empty: emptyState,
    expanded,
    afterResizeMove,
    motion,
  };
}
