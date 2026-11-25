import { expect } from "@playwright/test";

export function createSkillRows() {
  return Array.from({ length: 121 }, (_, index) => {
    const number = index + 1;
    const suffix = String(number).padStart(3, "0");
    const enabled = number % 2 === 0;
    const drama = number % 3 === 0;
    const createdAt = "2026-01-01T00:00:00.000Z";
    const name = `fixture-${suffix}`,
      title = `分镜 ${suffix}`;
    const description = number === 3 ? "独有的连戏说明" : "镜头调度";
    const pending = number === 6;
    const content = `# ${title}\n\n${description}\n\n对照上一镜的道具位置。\n`;
    const file = { path: "SKILL.md", size: Buffer.byteLength(content), kind: "skill", text: true };
    const version = { version: 1, description, createdAt, files: [file] };
    return {
      content,
      desktop: {
        name,
        title,
        enabled,
        origin: "local",
        activeVersion: 1,
        updatedAt: createdAt,
        scopes: [...(enabled ? ["agent"] : []), ...(drama ? ["video"] : [])],
        versions: pending ? [{ ...version, version: 2 }, version] : [version],
      },
      baseline: {
        name,
        title,
        description,
        enabled,
        source: "imported",
        readonly: false,
        active_version: 1,
        latest_version: pending ? 2 : 1,
        pending_version: pending,
        version_count: pending ? 2 : 1,
        file_count: 1,
        total_bytes: file.size,
        has_scripts: false,
        unsupported_fields: [],
        drama_steps: drama ? ["video"] : [],
        in_use: enabled || drama,
        updated_at: createdAt,
      },
    };
  });
}

export function listResponse(rows, params) {
  const status = params.get("status") ?? "all";
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const page = Number(params.get("page") ?? 1),
    size = Number(params.get("page_size") ?? 20);
  const matches = rows.filter(
    (item) =>
      ({
        all: true,
        agent: item.enabled,
        drama: item.drama_steps.length > 0,
        unused: !item.in_use,
        builtin: item.readonly,
      })[status] &&
      [item.name, item.title, item.description].some((text) => text.toLowerCase().includes(query)),
  );
  return {
    list: matches.slice((page - 1) * size, page * size),
    total: matches.length,
    page,
    page_size: size,
    has_imported: rows.length > 0,
  };
}

export async function skillGeometry(page, desktop) {
  const selectors = {
    panel: ["data-panel", "skills-panel"],
    toolbar: ["table-toolbar", "skills-toolbar"],
    empty: ["empty-state", "skills-no-results"],
    filters: ["segmented", "skills-filters"],
    search: ["search-input", "skills-search"],
  };
  const result = {};
  for (const [key, [slot, local]] of Object.entries(selectors)) {
    const element = page.locator(desktop ? `.${local}` : `[data-slot="${slot}"]`);
    await expect(element).toBeVisible();
    result[key] = await element.boundingBox();
  }
  result.drama = await page
    .getByRole("group", { name: "状态筛选" })
    .getByRole("button", { name: "短剧" })
    .boundingBox();
  return result;
}

export async function replaySkillList(page) {
  const rows = page.locator("table:visible tbody tr");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const filter = (name) =>
    page.getByRole("group", { name: "状态筛选" }).getByRole("button", { name, exact: true });
  const count = (total) => expect(page.getByText(`共 ${total} 个`, { exact: true })).toBeVisible();
  const checkpoints = [];
  async function check(label, total, length, first) {
    await count(total);
    await expect(rows).toHaveCount(length);
    if (first) await expect(rows.first()).toContainText(first);
    checkpoints.push({ label, total, length, first });
  }
  await check("初始列表", 121, 20, "分镜 001");
  await page.getByRole("button", { name: /^第 3 页/ }).click();
  await check("第三页", 121, 20, "分镜 041");
  await button("最后一页").click();
  await check("末页", 121, 1, "分镜 121");
  await expect(button("最后一页")).toBeDisabled();
  const size = page.getByRole("combobox", { name: "每页条数" });
  if (await size.evaluate((element) => element.tagName === "SELECT")) await size.selectOption("30");
  else {
    await size.click();
    await page.getByRole("option", { name: "30", exact: true }).click();
  }
  await check("每页 30 回到首页", 121, 30, "分镜 001");
  await expect(button("第一页")).toBeDisabled();
  await filter("画布 Agent").click();
  await check("画布 Agent", 60, 30, "分镜 002");
  await filter("未使用").click();
  await check("未使用", 41, 30, "分镜 001");
  await filter("短剧").click();
  await check("短剧", 40, 30, "分镜 003");
  await page.keyboard.press("/");
  const search = page.getByRole("searchbox", { name: "搜索名称或说明（/）" });
  await expect(search).toBeFocused();
  await search.fill("连戏");
  await check("短剧内按说明搜索", 1, 1, "分镜 003");
  await search.fill("没有这种分镜");
  await check("无匹配", 0, 0);
  await expect(page.getByText("没有符合条件的技能", { exact: true })).toBeVisible();
  await button("清空搜索").click();
  await expect(search).toHaveValue("");
  await expect(filter("短剧")).toHaveAttribute("aria-pressed", "true");
  await check("清空并保留短剧筛选", 40, 30, "分镜 003");
  return checkpoints;
}
