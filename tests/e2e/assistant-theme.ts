import { expect, type Locator } from "@playwright/test";

export async function expectDraft(editor: Locator, expected: string | RegExp) {
  const contents = expect.poll(() =>
    editor.evaluate((element) =>
      Array.from(element.querySelectorAll(":scope > p"))
        .map((paragraph) => {
          const copy = paragraph.cloneNode(true) as HTMLElement;
          copy
            .querySelectorAll(".ProseMirror-trailingBreak,.ProseMirror-separator")
            .forEach((item) => {
              item.remove();
            });
          copy.querySelectorAll("br").forEach((item) => {
            item.replaceWith("\n");
          });
          copy.querySelectorAll(".agent-editor-chip").forEach((item) => {
            item.replaceWith("@" + item.textContent);
          });
          return copy.textContent;
        })
        .join("\n"),
    ),
  );
  if (typeof expected === "string") await contents.toBe(expected);
  else await contents.toMatch(expected);
}

function luminance(channels: number[]) {
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const value = Number(channels[index]) / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * weight;
  }, 0);
}

export async function expectAssistantContrast(target: Locator, pseudo?: string) {
  const { foreground, background, opacity } = await target.evaluate((element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    const layers = [style.backgroundColor];
    for (
      let parent = pseudo ? element : element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      layers.push(getComputedStyle(parent).backgroundColor);
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    const paint = (color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
    };
    const channels = () => Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    paint("white");
    layers.reverse().forEach(paint);
    const background = channels();
    paint(style.color);
    return { foreground: channels(), background, opacity: style.opacity };
  }, pseudo);
  const values = [luminance(foreground), luminance(background)];
  expect(opacity).toBe("1");
  expect(
    (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05),
    `${target}${pseudo ?? ""} ${foreground} / ${background}`,
  ).toBeGreaterThanOrEqual(4.5);
}

export async function chooseAssistantModel(
  trigger: Locator,
  option: { name: string } | { id: string },
) {
  await trigger.click();
  const popup = trigger.page().getByRole("dialog", { name: "选择 Agent 模型" });
  const radio =
    "id" in option
      ? popup.locator(`[role="radio"][value="${option.id}"]`)
      : popup
          .getByRole("radio")
          .filter({ has: trigger.page().getByText(option.name, { exact: true }) });
  await radio.click();
  await expect(radio).toBeChecked();
  await radio.press("Escape");
  await expect(popup).toBeHidden();
}

export async function expectAssistantPicker(trigger: Locator) {
  await trigger.press("Space");
  const popup = trigger.page().getByRole("dialog", { name: "选择 Agent 模型" });
  await expect(popup).toHaveAttribute("data-side", "top");
  await expect
    .poll(async () => {
      const anchor = await trigger.boundingBox(),
        box = await popup.boundingBox();
      return (
        !!anchor &&
        !!box &&
        box.width === 260 &&
        Math.abs(anchor.y - box.y - box.height - 8) <= 1 &&
        Math.abs(anchor.x + anchor.width - box.x - box.width) <= 1
      );
    })
    .toBe(true);
  const checked = popup.getByRole("radio", { checked: true });
  await checked.hover();
  await expectAssistantContrast(checked.locator(".agent-model-option-name"));
  await popup.press("Escape");
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
}

export async function expectReadableModelHover(trigger: Locator) {
  const page = trigger.page();
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    await trigger.hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "Agent 模型" })).toBeVisible();
    const name = trigger.locator(".composer-model-name");
    await expect(name).toBeVisible();
    await expectAssistantContrast(name);
  }
  await page.emulateMedia({ colorScheme: null });
}
