import type { DesktopAPI } from "@link-studio/core";

declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
