import { CircleCheck, Info, OctagonX } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Toaster, toast } from "sonner";

const toasterId = "plugin-actions";

export function reportPluginAction(
  message: string,
  level: "success" | "error" | "info" = "success",
) {
  toast[level](message, { toasterId });
}

export function reportChannelAction(
  message: string,
  level: "success" | "error" | "info" = "success",
  description?: string,
) {
  toast[level](message, { toasterId: "channel-actions", description });
}

export function reportTrialError(message: string) {
  toast.error(message, { toasterId: "trial-actions" });
}

export function PluginNotice({
  detailOpen,
  actionOpen,
  channel = false,
  trial = false,
}: {
  detailOpen: boolean;
  actionOpen: boolean;
  channel?: boolean;
  trial?: boolean;
}) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "plugin-notice-layer";
    element.popover = "manual";
    return element;
  });
  useEffect(() => {
    const surface =
      (trial && document.querySelector('dialog[data-variant="trial"]')) ||
      (actionOpen &&
        document.querySelector(
          'dialog[role="alertdialog"][open],dialog[data-variant="channel-delete"][open]',
        )) ||
      (detailOpen &&
        document.querySelector(
          channel ? "dialog.model-dialog-wide[open]" : "dialog.adapter-dialog[open]",
        ));
    (surface || document.body).append(host);
    host.showPopover();
    return () => host.remove();
  }, [host, channel, trial, detailOpen, actionOpen]);
  return createPortal(
    <Toaster
      id={trial ? "trial-actions" : channel ? "channel-actions" : toasterId}
      customAriaLabel={trial ? "试跑通知" : channel ? "渠道通知" : "插件通知"}
      position="top-center"
      theme="dark"
      icons={{
        success: <CircleCheck size={16} />,
        error: <OctagonX size={16} />,
        info: <Info size={16} />,
      }}
      style={
        {
          "--normal-bg": "oklch(.205 0 0)",
          "--normal-text": "oklch(.985 0 0)",
          "--normal-border": "oklch(1 0 0 / 10%)",
          "--border-radius": "0.625rem",
        } as CSSProperties
      }
    />,
    host,
  );
}
