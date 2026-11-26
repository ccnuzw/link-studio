import { expect, type Locator, type Page } from "@playwright/test";

export async function blankCanvasPosition(pane: Locator, preferred?: { x: number; y: number }) {
  const position = await pane.evaluate((element, preferred) => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    if (preferred && document.elementFromPoint(left + preferred.x, top + preferred.y) === element)
      return preferred;
    const visibleLeft = Math.max(0, left);
    const visibleTop = Math.max(0, top);
    const width = Math.min(innerWidth, right) - visibleLeft;
    const height = Math.min(innerHeight, bottom) - visibleTop;
    if (width <= 0 || height <= 0) return null;
    const fractions = [0.5, 0.25, 0.75, 0.125, 0.875, 0.05, 0.95];
    for (const row of fractions) {
      for (const column of fractions) {
        const x = visibleLeft + width * column;
        const y = visibleTop + height * row;
        if (document.elementFromPoint(x, y) === element) return { x: x - left, y: y - top };
      }
    }
    return null;
  }, preferred);
  if (!position) throw Error("找不到可点击的画布空白区域");
  return position;
}

export async function clickBlankCanvas(page: Page) {
  const pane = page.locator(".react-flow__pane:visible");
  await pane.click({ position: await blankCanvasPosition(pane) });
}

export async function createCanvasProject(page: Page, name?: string) {
  await page.getByRole("button", { name: /^新建画布项目/ }).click();
  const dialog = page.getByRole("dialog", { name: "新建画布项目" });
  if (name) await dialog.getByLabel("新项目名称").fill(name);
  await dialog.getByRole("button", { name: "选择保存位置…" }).click();
}

export async function createDramaProject(page: Page, name?: string) {
  await page
    .getByRole("radiogroup", { name: "创作方式" })
    .getByRole("radio", { name: "短剧" })
    .click();
  await page.getByRole("button", { name: /^新建短剧项目/ }).click();
  const dialog = page.getByRole("dialog", { name: "新建短剧项目" });
  if (name) await dialog.getByLabel("新项目名称").fill(name);
  await dialog.getByRole("button", { name: "选择保存位置…" }).click();
}

export async function editTextNode(preview: Locator, ...drafts: string[]) {
  await preview.dblclick();
  const dialog = preview.page().getByRole("dialog");
  const editor = dialog.getByRole("textbox", { name: "文本内容" });
  await expect(editor).toBeFocused();
  for (const draft of drafts) {
    await editor.fill(draft);
    await expect(editor).toHaveText(draft);
  }
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
}

export async function chooseCanvasZoom(
  page: Page,
  command: "适应画布" | "缩小" | "放大" | "缩放到 100%",
) {
  await page.getByRole("button", { name: "缩放", exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${command}`) }).click();
}

export async function projectAction(page: Page, name: string) {
  const taskDialog = page.getByRole("dialog", { name: "生成任务", exact: true });
  if (name === "生成任务") {
    if (!(await taskDialog.isVisible()))
      await page
        .getByRole("toolbar", { name: "画布编辑" })
        .getByRole("button", { name: "任务", exact: true })
        .click();
    await taskDialog.getByRole("button", { name: "任务管理", exact: true }).click();
    return;
  }
  if (await taskDialog.isVisible())
    await taskDialog.getByRole("button", { name: "关闭任务", exact: true }).click();
  if (name === "项目文件") {
    await page
      .getByRole("toolbar", { name: "画布编辑" })
      .getByRole("button", { name: "素材", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "项目素材", exact: true }).click();
    return;
  }
  if (name === "所选节点属性") {
    await page.getByRole("button", { name: "节点属性", exact: true }).click();
    return;
  }
  if (name === "模型设置" || name === "运行环境") {
    const navigation = page.getByRole("navigation", { name: "设置分类" });
    if (!(await navigation.isVisible())) {
      const homeSettings = page.getByRole("button", { name: "应用设置", exact: true });
      if (await homeSettings.isVisible()) await homeSettings.click();
      else {
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await page.getByRole("menuitem", { name: "应用设置", exact: true }).click();
      }
    }
    await navigation
      .getByRole("button", { name: name === "运行环境" ? "诊断" : "模型与渠道", exact: true })
      .click();
    return;
  }
  if (name === "保存项目") {
    await page.getByLabel("画布名称", { exact: true }).press("ControlOrMeta+s");
    return;
  }
  const label = name === "关闭项目" ? "返回项目列表" : name === "导出画布" ? "导出画布文件…" : name;
  await page.getByRole("button", { name: "画布菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

export async function openCanvasAssetLibrary(page: Page) {
  await page
    .getByRole("toolbar", { name: "画布编辑" })
    .getByRole("button", { name: "素材", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "从资产库添加", exact: true }).click();
}

export async function confirmDramaScript(page: Page) {
  const setup = page.getByRole("dialog", { name: "开拍设置" });
  await setup.getByRole("button", { name: "原文类型" }).click();
  await setup
    .getByRole("dialog", { name: "原文类型" })
    .getByRole("button", { name: /^剧本.*直接导入/ })
    .click();
}

export async function addCanvasNode(page: Page, name: string) {
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  await page
    .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
