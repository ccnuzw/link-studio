import { _electron } from "@playwright/test";

export const compactViewport = { width: 1024, height: 672 };

export const desktopElectron = {
  async launch(options: Parameters<typeof _electron.launch>[0]) {
    const application = await _electron.launch(options);
    try {
      const page = await application.firstWindow();
      await page.setViewportSize({ width: 1440, height: 888 });
      return application;
    } catch (error) {
      await application.close();
      throw error;
    }
  },
};
