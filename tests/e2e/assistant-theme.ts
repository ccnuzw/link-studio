import { expect, type Locator } from "@playwright/test";

function luminance(color: string) {
  const channels = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/)?.slice(1);
  if (!channels) throw new Error(`预期不透明的 RGB 颜色，实际为 ${color}`);
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const value = Number(channels[index]) / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * weight;
  }, 0);
}

export async function expectAssistantContrast(target: Locator, pseudo?: string) {
  const { foreground, background, opacity } = await target.evaluate((element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    let background = style.backgroundColor;
    for (
      let parent = pseudo ? element : element.parentElement;
      parent && background === "rgba(0, 0, 0, 0)";
      parent = parent.parentElement
    ) {
      background = getComputedStyle(parent).backgroundColor;
    }
    return { foreground: style.color, background, opacity: style.opacity };
  }, pseudo);
  const values = [luminance(foreground), luminance(background)];
  expect(opacity).toBe("1");
  expect(
    (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05),
    `${target}${pseudo ?? ""} ${foreground} / ${background}`,
  ).toBeGreaterThanOrEqual(4.5);
}

export async function expectAssistantPicker(select: Locator) {
  await select.press("Space");
  await expect(select.and(select.page().locator("select:open"))).toBeVisible();
  await expectAssistantContrast(select, "::picker(select)");
  await expectAssistantContrast(select.locator("option:checked"));
  await select.press("Escape");
  await expect(select.and(select.page().locator("select:open"))).toHaveCount(0);
}
