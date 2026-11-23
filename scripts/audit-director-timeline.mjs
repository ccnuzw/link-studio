import assert from "node:assert/strict";
import { join } from "node:path";

export async function auditDirectorTimeline(page, side, output) {
  const panel = page.getByTitle("回到开头").locator("xpath=ancestor::section[1]");
  const duration = panel.locator("select").first(),
    clock = panel.getByText(/^F\d+ ·/),
    actor = panel.getByRole("button", { name: "角色A", exact: true }),
    camera = panel.getByRole("button", { name: "机位1", exact: true });
  const ruler = panel.getByText("0s", { exact: true }).locator(".."),
    lanes = ruler.locator(".."),
    record = panel.getByRole("button", { name: "记录关键帧", exact: true }),
    marker = lanes.locator('[title*="右键切换"]');
  const images = {},
    states = {},
    rectangles = {};
  async function capture(name, live = false) {
    if (!live) {
      await page.mouse.move(4, 4);
      await page.evaluate(() => document.activeElement?.blur?.());
    }
    await page.waitForTimeout(100);
    states[name] = {
      clock: await clock.innerText(),
      keys: await marker.evaluateAll((nodes) => nodes.map((node) => node.title)),
      canPreset: await panel.getByRole("button", { name: "套用" }).isEnabled(),
      deletable: await panel.getByTitle("删除选中的关键帧（Delete）").count(),
      duration: await duration.inputValue(),
      focus: await panel.evaluate((section) =>
        [...section.querySelectorAll("button, input, select")].indexOf(document.activeElement),
      ),
    };
    const controls = [
      panel,
      panel.getByTitle("回到开头"),
      clock,
      duration,
      record,
      panel.locator("select").nth(1),
      panel.getByRole("button", { name: "套用" }),
      ruler,
      lanes,
      actor,
      ...(await marker.all()),
    ];
    rectangles[name] = await Promise.all(controls.map((locator) => locator.boundingBox()));
    images[name] = await panel.screenshot({ path: join(output, `${side}-timeline-${name}.png`) });
  }
  async function at(ratio) {
    const box = await ruler.boundingBox();
    await page.mouse.click(box.x + box.width * ratio, box.y + 12);
  }
  await capture("initial");
  await actor.click();
  await at(0.25);
  await record.click();
  await at(0.75);
  await record.click();
  await camera.click();
  await marker.first().click({ button: "right" });
  assert.match(await marker.first().getAttribute("title"), /线性/);
  const key = await marker.first().boundingBox(),
    dest = await marker.last().boundingBox();
  await page.mouse.move(key.x + key.width / 2, key.y + key.height / 2);
  await page.mouse.down();
  await capture("pressed", true);
  await page.mouse.move((key.x + dest.x + key.width) / 2, key.y + key.height / 2, { steps: 4 });
  await capture("dragging", true);
  assert.deepEqual(states.dragging, states.pressed);
  const midpoint = await marker.first().boundingBox();
  assert.ok(Math.abs(midpoint.x - (key.x + dest.x) / 2) < 1);
  await page.mouse.move(dest.x + dest.width / 2, dest.y + dest.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.equal(await marker.count(), 1);
  await capture("collision");
  assert.equal(states.collision.canPreset, true);
  assert.match(states.collision.keys[0], /3\.75s · 线性/);
  await panel.getByTitle("删除选中的关键帧（Delete）").click();
  assert.equal(await marker.count(), 0);
  await page.getByTitle("撤销（Ctrl+Z）").click();
  assert.equal(await marker.count(), 1);
  await page.getByTitle("撤销（Ctrl+Z）").click();
  assert.equal(await marker.count(), 2);
  await capture("undo");
  await duration.selectOption("2.5");
  await capture("retime");
  assert.deepEqual(
    states.retime.keys.map((key) => key.split("s")[0]),
    ["0.63", "1.88"],
  );
  const b = await ruler.boundingBox();
  await page.mouse.move(b.x + b.width * 0.2, b.y + 12);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.8, b.y + 12, { steps: 6 });
  await page.mouse.up();
  await capture("scrub");
  assert.match(states.scrub.clock, /2\.00s/);
  await panel.getByTitle("回到开头").click();
  await capture("rewind");
  await camera.click();
  await panel.getByTitle("回到开头").click();
  for (const [name, control] of [
    ["duration", duration],
    ["record", record],
    ["preset", panel.locator("select").nth(1)],
    ["strength", panel.locator('input[type="number"]')],
  ]) {
    await page.keyboard.press("Tab");
    assert.ok(
      await control.evaluate(
        (node) => node === document.activeElement && node.matches(":focus-visible"),
      ),
    );
    await capture("focus-" + name, true);
  }
  return { images, states, rectangles };
}
