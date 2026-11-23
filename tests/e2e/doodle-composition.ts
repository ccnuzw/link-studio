import { expect, type Page } from "@playwright/test";

export async function annotateWithComposition(page: Page) {
  const toolbar = page.getByRole("toolbar", { name: "图片标注工具栏" });
  const save = toolbar.getByRole("button", { name: "保存", exact: true });
  const undo = toolbar.getByRole("button", { name: "撤销" }),
    redo = toolbar.getByRole("button", { name: "重做" });
  await expect(save).toBeEnabled();
  const colors = toolbar.getByRole("button", { name: "颜色", exact: true });
  await colors.click();
  const palette = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("button", { name: "颜色 #facc15" }) });
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  const afterEscape = {
    toolbar: await toolbar.count(),
    selected: await page.locator(".react-flow__node.selected").count(),
    focus: await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
  };
  expect(afterEscape).toEqual({ toolbar: 1, selected: 1, focus: "颜色" });
  await toolbar.getByRole("button", { name: "文字", exact: true }).click();
  const upper = page.locator("canvas.upper-canvas");
  const rect = await upper.boundingBox();
  if (!rect) throw Error("标注层未显示");
  const geometry = await upper.evaluate((element) => ({
    dpr: devicePixelRatio,
    zoom: element.getBoundingClientRect().width / element.clientWidth,
    width: (element as HTMLCanvasElement).width,
    height: (element as HTMLCanvasElement).height,
  }));
  expect([geometry.width, geometry.height]).toEqual([4096, 2048]);
  const textarea = page.locator("textarea[data-fabric]");
  await upper.click({ position: { x: 32, y: 36 } });
  await expect(textarea).toBeFocused();
  await textarea.press("Escape");
  await expect(toolbar).toBeVisible();
  await expect(undo).toBeDisabled();
  await upper.click({ position: { x: 32, y: 36 } });
  await expect(textarea).toBeFocused();
  const cdp = await page.context().newCDPSession(page);
  const composition = async (text: string) => {
    await cdp.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  };
  const insert = (text: string) => cdp.send("Input.insertText", { text });
  await textarea.evaluate((element) => {
    const events: string[] = [];
    Object.assign(window, { annotationInputEvents: events });
    for (const name of ["compositionstart", "compositionupdate", "compositionend"])
      element.addEventListener(name, (event) =>
        events.push(`${name}:${(event as CompositionEvent).data}`),
      );
  });
  try {
    await composition("jing");
    await expect(textarea).toHaveValue("jing");
    await expect(undo).toBeDisabled();
    await composition("jingtou");
    await expect(textarea).toHaveValue("jingtou");
    await insert("镜头");
    await expect(textarea).toHaveValue("镜头");
    await textarea.press("Enter");
    await composition("zhuanchang");
    await insert("转场");
    await expect(textarea).toHaveValue("镜头\n转场");
    await textarea.press("Escape");
    await expect(textarea).toHaveCount(0);
    await expect(toolbar).toBeVisible();
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(redo).toBeDisabled();
    await expect(undo).toBeEnabled();
    const events = await page.evaluate(
      () => Reflect.get(window, "annotationInputEvents") as string[],
    );
    expect(events).toContain("compositionend:镜头");
    expect(events).toContain("compositionend:转场");
    await toolbar.getByRole("button", { name: "画笔" }).click();
    await page.mouse.move(rect.x + 200, rect.y + 125);
    await page.mouse.down();
    await page.mouse.move(rect.x + 260, rect.y + 165, { steps: 8 });
    await page.mouse.up();
    await save.click();
    await expect(toolbar).toBeHidden();
    return { rect, ...geometry, events, afterEscape };
  } finally {
    await cdp.detach();
  }
}
