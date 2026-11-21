import type { Page } from "@playwright/test";

export async function projectAction(page: Page, name: string) {
  await page.getByLabel("项目更多操作", { exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

export async function addCanvasNode(page: Page, name: string) {
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  await page
    .getByRole("region", { name: "添加节点菜单" })
    .getByRole("button", { name, exact: true })
    .click();
}
