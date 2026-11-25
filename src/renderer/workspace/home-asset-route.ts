import { requirePresent } from "@link-studio/core";

const tabs = {
  history: "history",
  library: "personal",
  official: "voices",
  humans: "humans",
} as const;
export type AssetTab = (typeof tabs)[keyof typeof tabs];
export function homeAssetRoute() {
  const [page, search] = location.hash.slice(1).split("?");
  if (page !== "assets") return;
  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "history";
  const section = Object.hasOwn(tabs, tab) ? tabs[tab as keyof typeof tabs] : "history";
  return { section, folder: section === "personal" ? (params.get("folder") ?? "") : "" };
}
export function navigateHomeAssets(section: AssetTab, folder = "", replace = false) {
  const params = new URLSearchParams();
  if (section !== "history")
    params.set(
      "tab",
      requirePresent(
        Object.keys(tabs).find((tab) => tabs[tab as keyof typeof tabs] === section),
        "Object.keys(tabs).find((tab) => tabs[tab as keyof typeof tabs] === section)",
      ),
    );
  if (section === "personal" && folder) params.set("folder", folder);
  const hash = `#assets${params.size ? `?${params}` : ""}`;
  if (location.hash !== hash) {
    history[replace ? "replaceState" : "pushState"](history.state, "", hash);
    window.dispatchEvent(new Event("hashchange"));
  }
}
