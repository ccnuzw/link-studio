export async function readRenderedText(locator) {
  await locator.waitFor({ state: "attached" });
  const [text, ...otherMatches] = await locator.allInnerTexts();
  if (text === undefined || otherMatches.length) {
    throw new Error(`读取渲染文本时预期恰好匹配一个元素：${locator}`);
  }
  return text;
}
