import assert from "node:assert/strict";
import { join } from "node:path";

export async function auditDirectorSidebar(page, side, output) {
  const panel = page
    .locator("aside")
    .filter({ has: page.getByRole("button", { name: "图层", exact: true }) });
  const tab = (name) => panel.getByRole("button", { name, exact: true });
  const field = (name) =>
    panel
      .locator("label")
      .filter({ has: page.getByText(name, { exact: true }) })
      .locator("input,select");
  const row = (name) => panel.getByText(name, { exact: true }).locator("..");
  const images = {},
    states = {},
    rectangles = {};
  async function capture(name) {
    const controls = panel.locator("button,[role=button],label,input,select,p");
    rectangles[name] = [
      await panel.boundingBox(),
      ...(await Promise.all((await controls.all()).map((item) => item.boundingBox()))),
    ];
    states[name] = [
      await panel.innerText(),
      await panel
        .locator("input,select")
        .evaluateAll((fields) => fields.map((field) => field.value)),
    ];
    images[name] = await panel.screenshot({ path: join(output, `${side}-sidebar-${name}.png`) });
  }
  await tab("图层").click();
  await page.mouse.move(4, 4);
  await capture("layers");
  await row("角色A").hover();
  await capture("hover");
  await row("角色A").press("Enter");
  assert.equal(await row("角色A").count(), 1);
  await row("角色A").click();
  await page.mouse.move(4, 4);
  await capture("actor");
  await field("名称").fill("  主角  ");
  await field("名称").press("Enter");
  assert.equal(await field("名称").inputValue(), "主角");
  await field("名称").fill("  ");
  await field("名称").press("Enter");
  assert.equal(await field("名称").inputValue(), "主角");
  await field("体型").fill("9");
  await field("体型").press("Enter");
  assert.equal(await field("体型").inputValue(), "1.20");
  await page.getByTitle("撤销（Ctrl+Z）").click();
  assert.equal(await field("体型").inputValue(), "1.00");
  await tab("+ 道具").click();
  await field("形状").selectOption("table");
  assert.equal(await field("高").inputValue(), "1.0");
  await field("位置 X").fill("1300.25");
  await field("位置 X").press("Enter");
  assert.equal(await field("位置 X").inputValue(), "1300.25");
  assert.equal(await field("位置 Z").inputValue(), "-1.50");
  await field("旋转").fill("720");
  await field("旋转").press("Enter");
  assert.equal(await field("旋转").inputValue(), "720");
  await field("深").focus();
  await capture("prop");
  await tab("+ 机位").click();
  await field("焦距").selectOption({ label: "50mm（FOV 27°）" });
  assert.equal(await field("FOV").inputValue(), "27");
  await field("画幅").selectOption("9:16");
  await field("看向").selectOption({ label: "主角" });
  await page.mouse.move(4, 4);
  await capture("camera");
  await tab("图层").click();
  await row("主角").hover();
  await row("主角").getByTitle("隐藏").click();
  assert.equal(await row("主角").getByTitle("显示").count(), 1);
  await row("主角").getByTitle("删除").click();
  await tab("属性").click();
  assert.equal(await field("名称").inputValue(), "机位2");
  assert.equal(await field("看向").inputValue(), "");
  await capture("remove");
  return { images, states, rectangles };
}
