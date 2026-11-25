import type { Locator } from "@playwright/test";

export function readRenderedText(locator: Locator): Promise<string>;
