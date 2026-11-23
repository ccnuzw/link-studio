import { expect, type Locator, type Page } from "@playwright/test";

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
  await page.getByRole("button", { name: "画布菜单", exact: true }).click();
  const label = name === "关闭项目" ? "返回项目列表" : name;
  if (!["返回项目列表", "新建画布", "导出画布"].includes(label))
    await page.getByRole("menuitem", { name: "桌面项目操作" }).press("ArrowRight");
  await page.getByRole("menuitem", { name: label, exact: true }).click();
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
