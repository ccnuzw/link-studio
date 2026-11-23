export async function copySettingsText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const previous = document.activeElement;
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    (previous?.closest("dialog[open]") ?? document.body).append(field);
    try {
      field.select();
      if (!document.execCommand("copy")) throw new Error("复制失败");
    } finally {
      field.remove();
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    }
  }
}
