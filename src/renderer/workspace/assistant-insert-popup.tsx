import { Popover } from "@base-ui/react/popover";

export function AssistantInsertPopup({ className = "", ...props }: Popover.Popup.Props) {
  return (
    <Popover.Portal>
      <Popover.Positioner
        className="assistant-model-position"
        side="top"
        align="start"
        sideOffset={8}
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
      >
        <Popover.Popup {...props} className={`assistant-model-menu ${className}`} />
      </Popover.Positioner>
    </Popover.Portal>
  );
}
