import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("技能导入需要确认，重启后可筛选和管理已保存版本", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-skills-e2e-"));
  const source = join(directory, "SKILL.md");
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: join(directory, "profile") };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const launch = () =>
    electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ["."] }), env });
  const openSkills = async (app: Awaited<ReturnType<typeof launch>>) => {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByRole("button", { name: "技能管理" }).click();
    return page;
  };
  try {
    await writeFile(
      source,
      "---\nname: shot-list\ntitle: 镜头清单\ndescription: 整理镜头\n---\n# 镜头顺序\n",
    );
    const first = await launch();
    try {
      await first.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, source);
      const page = await openSkills(first);
      await expect(page.getByText("技能库为空")).toBeVisible();
      await page.keyboard.press("/");
      await expect(page.getByRole("searchbox")).toBeFocused();
      await page.getByRole("button", { name: "导入技能" }).click();
      const modal = page.getByRole("dialog", { name: "导入技能" });
      await modal.getByRole("button", { name: "选择 SKILL.md" }).click();
      await expect(modal.getByText("# 镜头顺序", { exact: false })).toBeVisible();
      await modal.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByText("技能库为空")).toBeVisible();

      const session = await page.context().newCDPSession(page);
      const drop = { x: 180, y: 235, data: { items: [], files: [source], dragOperationsMask: 1 } };
      await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...drop });
      await session.send("Input.dispatchDragEvent", { type: "dragOver", ...drop });
      await session.send("Input.dispatchDragEvent", { type: "drop", ...drop });
      await expect(modal.getByText("新技能 · v1")).toBeVisible();
      await modal.getByRole("checkbox", { name: "启用技能" }).check();
      await modal.getByRole("checkbox", { name: "画布 Agent" }).check();
      await modal.getByRole("button", { name: "确认导入" }).click();
      await expect(page.getByRole("status")).toContainText("已导入「镜头清单」v1");
    } finally {
      await first.close();
    }

    const second = await launch();
    try {
      const page = await openSkills(second);
      await page.getByRole("button", { name: "画布 Agent", exact: true }).click();
      await expect(page.getByRole("button", { name: "镜头清单" })).toBeVisible();
      await page.getByRole("searchbox").fill("不存在");
      await expect(page.getByText("没有符合条件的技能")).toBeVisible();
      await page.getByRole("searchbox").fill("整理镜头");
      await page.getByRole("button", { name: "镜头清单" }).click();
      const detail = page.getByRole("dialog", { name: "技能详情" });
      await expect(detail.getByText("生效版本 · v1")).toBeVisible();
      await detail.getByRole("textbox", { name: "显示名称" }).fill("拍摄清单");
      await detail.getByRole("button", { name: "保存设置" }).click();
      await expect(detail.getByRole("status")).toContainText("设置已保存");
      await detail.getByRole("button", { name: "删除技能" }).click();
      await detail.getByRole("button", { name: "确认删除" }).click();
      await expect(page.getByRole("status")).toContainText("已删除「拍摄清单」");
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
