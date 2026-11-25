import { Menu } from "@base-ui/react/menu";
import { Music2 } from "lucide-react";
import { useState } from "react";
import catalog from "./official-voices.json";

export type OfficialVoice = { name: string; url: string };
const voices = catalog.slice(0, 100);

export function OfficialVoicePicker({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (voice: OfficialVoice) => void;
}) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  return (
    <Menu.Root modal={false} highlightItemOnHover={false}>
      <Menu.Trigger ref={setTrigger} disabled={disabled}>
        <Music2 size={14} />
        音色库
      </Menu.Trigger>
      <Menu.Portal container={trigger?.closest("dialog")}>
        <Menu.Positioner
          className="trial-ref-position"
          positionMethod="fixed"
          align="start"
          sideOffset={6}
          collisionBoundary={trigger?.closest("dialog") ?? document.documentElement}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        >
          <Menu.Popup
            className="trial-ref-menu trial-voice-menu"
            onFocusCapture={(event) => {
              if (event.target.getAttribute("role") === "menuitem")
                event.target.scrollIntoView({
                  block: "nearest",
                  inline: "nearest",
                  behavior: "instant",
                });
            }}
          >
            <Menu.Group>
              <Menu.GroupLabel>音色库</Menu.GroupLabel>
              {voices.map((voice) => (
                <Menu.Item key={voice.url} onClick={() => onPick(voice)}>
                  <span>{voice.name}</span>
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
