import { Menu } from "@base-ui/react/menu";
import { Camera, ChevronDown, Columns3, PanelLeft, PanelRight } from "lucide-react";

export type FrameChoice = "首帧" | "尾帧" | "自定义";
const choices = [
  { label: "首帧", Icon: PanelLeft },
  { label: "尾帧", Icon: PanelRight },
  { label: "自定义", Icon: Columns3 },
] as const;

export function FrameMenu({
  disabled,
  choose,
}: {
  disabled: boolean;
  choose: (choice: FrameChoice) => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        className="canvas-frame-trigger"
        disabled={disabled}
        aria-label="截取帧"
        title="截取帧"
      >
        <Camera size={16} />
        <span>截取帧</span>
        <ChevronDown size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="canvas-frame-positioner"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        >
          <Menu.Popup className="canvas-frame-menu" aria-label="截取帧">
            <Menu.Group>
              {choices.map(({ label, Icon }) => (
                <Menu.Item key={label} onClick={() => choose(label)}>
                  <Icon />
                  {label}
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
