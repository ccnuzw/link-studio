import type { ChannelView, SettingsValues } from "@link-studio/core";
import { useEffect } from "react";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";

type Images = SettingsValues["filingAssets"];

export function useFilingPoll(
  channel: ChannelView | undefined,
  images: Images,
  busy: boolean,
  update: (images: Images) => void,
  notify: (message: string) => void,
) {
  useEffect(() => {
    const pending = images.filter((image) => image.status === "processing");
    if (busy || !channel?.filing?.enabled || !channel.hasFilingKeys || !pending.length) return;
    let active = true;
    let timer = window.setTimeout(refresh, 3000);
    async function refresh() {
      let updated: Images | undefined;
      for (const image of pending) {
        if (!active || !channel) return;
        try {
          const result = await settingsRequests.filingAssets({
            id: channel.id,
            expectedRevision: channel.revision,
            action: "refresh",
            assetId: image.id,
          });
          if (!active) return;
          if (result.ok) updated = result.value;
          else notify(settingsError(result.code));
        } catch {
          if (active) notify("暂时无法查询审核状态，稍后自动重试。");
        }
      }
      if (!active) return;
      if (updated) update(updated);
      else timer = window.setTimeout(refresh, 3000);
    }
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [channel, images, busy, update, notify]);
}
