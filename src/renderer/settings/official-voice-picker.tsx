import { Menu } from "@base-ui/react/menu";
import { Music2 } from "lucide-react";
import { useLayoutEffect, useState } from "react";

export type OfficialVoice = { name: string; url: string };

export function OfficialVoicePicker({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (voice: OfficialVoice) => void;
}) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [voices, setVoices] = useState<OfficialVoice[]>();
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!popup) return;
    function revealFocus() {
      const item = document.activeElement;
      if (item?.getAttribute("role") === "menuitem" && popup?.contains(item))
        item.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
    const observer = new ResizeObserver(revealFocus);
    observer.observe(popup);
    popup.addEventListener("focusin", revealFocus);
    return () => {
      observer.disconnect();
      popup.removeEventListener("focusin", revealFocus);
    };
  }, [popup]);
  function load(open: boolean) {
    if (!open || voices) return;
    void import("./official-voices.json").then(
      (catalog) => setVoices(catalog.default.slice(0, 100)),
      () => setVoices([]),
    );
  }
  return (
    <Menu.Root modal={false} onOpenChange={load}>
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
          <Menu.Popup ref={setPopup} className="trial-ref-menu trial-voice-menu">
            <Menu.Group>
              <Menu.GroupLabel>音色库</Menu.GroupLabel>
              {!voices?.length && <p>{voices ? "暂无音色" : "加载中…"}</p>}
              {voices?.map((voice) => (
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
