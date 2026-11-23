import assert from "node:assert/strict";
import { expect } from "@playwright/test";

async function replaySelectionTools(page, capture) {
  const mod = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+",
  );
  const buttons = [
    ["打组", "打组", `${mod}G`],
    ["复制选中节点", "复制", `${mod}D`],
    ["下载素材", "下载素材", ""],
    ["删除选中节点", "删除", "⌫"],
  ];
  const tip = page.locator('[data-slot="tooltip-content"],.canvas-control-tip'),
    geometry = [];
  for (const [name, label, key] of buttons) {
    const button = page.getByRole("button", { name, exact: true });
    await button.hover();
    await expect(tip).toHaveText(label + key);
    await expect(tip.locator("kbd")).toHaveCount(key ? 1 : 0);
    geometry.push(
      await tip.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      }),
    );
    if (name === "复制选中节点") {
      await capture("selectionCopyTip", { x: 500, y: 78, width: 500, height: 126 });
      await page.mouse.down();
      await expect
        .poll(() =>
          button.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
        )
        .toBe(0.96);
      await page.mouse.move(90, 94);
      await page.mouse.up();
      await expect
        .poll(() =>
          button.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
        )
        .toBe(1);
      await expect(page.locator(".react-flow__node")).toHaveCount(2);
    }
    await page.mouse.move(90, 94);
    await expect(tip).toHaveCount(0);
  }
  const arrange = page.getByRole("button", { name: "整理布局", exact: true });
  await arrange.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "复制选中节点", exact: true })).toBeFocused();
  await expect(tip).toHaveText(`复制${mod}D`);
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  return geometry;
}

export async function replayAcrossCanvases(page, openTarget, capture) {
  const nodes = page.locator(".react-flow__node"),
    edges = page.locator(".react-flow__edge");
  await nodes.first().click({ position: { x: 48, y: 64 } });
  await nodes.last().click({ position: { x: 48, y: 64 }, modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  const text = await page.evaluate(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    const data = new DataTransfer();
    document.body.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
    );
    return data.getData("text/plain");
  });
  assert.equal(text, "列车驶入站台。\n站台");
  await openTarget();
  await expect(nodes).toHaveCount(0);
  await page.getByRole("button", { name: "任务历史", exact: true }).hover();
  const states = [];
  let selectionTools;
  for (const suffix of [" 副本", " 副本二"]) {
    const handled = await page.evaluate((text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      const event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }, text);
    assert(handled);
    await expect(edges).toHaveCount(states.length + 1);
    const selected = page.locator(".react-flow__node.selected");
    await expect(selected).toHaveCount(2);
    for (const label of ["对白", "站台"])
      await expect(selected.getByText(label + suffix, { exact: true })).toBeVisible();
    states.push(
      await selected.evaluateAll((elements) =>
        elements.map((element) => ({
          position: element.style.transform,
          text: element.querySelector("p")?.textContent ?? null,
        })),
      ),
    );
    if (states.length === 1) {
      await page.mouse.move(90, 94);
      await page.evaluate(() =>
        document.querySelectorAll(".react-flow__edges svg").forEach((svg) => {
          svg.pauseAnimations();
          svg.setCurrentTime(0.5);
        }),
      );
      await page.keyboard.press("ControlOrMeta+s");
      await expect(
        page.locator("button[role=status] span,.canvas-save-indicator span"),
      ).toHaveCount(0, { timeout: 12000 });
      await capture("crossPasted");
      selectionTools = await replaySelectionTools(page, capture);
      await page.getByRole("button", { name: "任务历史", exact: true }).hover();
    }
  }
  await page.keyboard.press("ControlOrMeta+z");
  await expect(edges).toHaveCount(1);
  await expect(nodes).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(edges).toHaveCount(2);
  await expect(nodes).toHaveCount(4);
  return { text, states, selectionTools };
}

export async function replayCanvasClipboard(page, node) {
  const cards = page.locator(".react-flow__node");
  const geometry = (locator) =>
    locator.evaluate((element) => {
      const { x, y } = element.getBoundingClientRect();
      return {
        x,
        y,
        node: element.style.transform,
        viewport: document.querySelector(".react-flow__viewport").style.transform,
      };
    });
  const initial = await geometry(node);
  await node.click({ position: { x: 36, y: 40 } });
  await expect(node).toHaveClass(/selected/);
  const copies = await page.evaluate(async () => {
    const target = document.activeElement;
    const chord = () =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "c",
          code: "KeyC",
          metaKey: /Mac/.test(navigator.platform),
          ctrlKey: !/Mac/.test(navigator.platform),
          bubbles: true,
          cancelable: true,
        }),
      );
    const copy = () => {
      const data = new DataTransfer();
      data.setData("text/plain", "系统原有文字");
      const event = new ClipboardEvent("copy", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return { handled: event.defaultPrevented, text: data.getData("text/plain") };
    };
    const bare = copy();
    chord();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const expired = copy();
    chord();
    return { bare, expired, paired: copy(), consumed: copy() };
  });
  const untouched = { handled: false, text: "系统原有文字" };
  assert.deepEqual(copies, {
    bare: untouched,
    expired: untouched,
    paired: { handled: true, text: "列车驶入站台。" },
    consumed: untouched,
  });
  const paste = (text) =>
    page.evaluate((text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }, text);
  await page.getByRole("button", { name: "任务历史", exact: true }).hover();
  const states = [];
  for (const [text, label] of [
    ["列车驶入站台。", "对白 副本"],
    ["", "对白 副本二"],
    ["另外一段文字", "文本"],
  ]) {
    assert(await paste(text));
    await expect(cards).toHaveCount(3 + states.length);
    const selected = page.locator(".react-flow__node.selected");
    await expect(selected.getByText(label, { exact: true })).toBeVisible();
    states.push(await geometry(selected));
  }
  await page.mouse.move(106, 628);
  assert(await paste("列车驶入站台。"));
  await expect(cards).toHaveCount(6);
  const last = page.locator(".react-flow__node.selected");
  await expect(last.getByText("对白 副本三", { exact: true })).toBeVisible();
  states.push(await geometry(last));
  await page.keyboard.press("ControlOrMeta+=");
  await expect
    .poll(() =>
      page
        .locator(".react-flow__viewport")
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBe(1.2);
  await page.mouse.move(320, 530);
  assert(await paste("列车驶入站台。"));
  await expect(cards).toHaveCount(7);
  await expect(last.getByText("对白 副本四", { exact: true })).toBeVisible();
  const zoomed = await geometry(last);
  const duplicates = [];
  for (const [modifier, label] of [
    ["repeat", "对白 副本五"],
    ["shiftKey", "对白 副本六"],
  ]) {
    const handled = await page.evaluate((modifier) => {
      const event = new KeyboardEvent("keydown", {
        key: "d",
        code: "KeyD",
        metaKey: /Mac/.test(navigator.platform),
        ctrlKey: !/Mac/.test(navigator.platform),
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }, modifier);
    assert(handled, `${modifier}：原地复制应消费快捷键`);
    await expect(cards).toHaveCount(8 + duplicates.length);
    await expect(last.getByText(label, { exact: true })).toBeVisible();
    duplicates.push(await geometry(last));
  }
  return { initial, copies, states, zoomed, duplicates };
}
