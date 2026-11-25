import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactElement } from "react";

export function CanvasControlTip({
  label,
  shortcut,
  side = "top",
  sideOffset = 8,
  container,
  children,
}: {
  label: string;
  shortcut?: string;
  side?: "top" | "right" | "bottom";
  sideOffset?: number;
  container?: Tooltip.Portal.Props["container"];
  children: ReactElement;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal container={container}>
        <Tooltip.Positioner className="strip-tip-pos" side={side} sideOffset={sideOffset}>
          <Tooltip.Popup role="tooltip" className="strip-tip canvas-more-tip canvas-control-tip">
            {label}
            {shortcut && <kbd>{shortcut}</kbd>}
            <Tooltip.Arrow style={({ side }) => (side === "right" ? { top: "50%" } : undefined)} />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
