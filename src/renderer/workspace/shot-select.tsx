import { Select } from "@base-ui/react/select";
import { cameraMoves, shotSizes } from "@link-studio/core";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Footprints,
  Hand,
  Lock,
  MoveHorizontal,
  Plane,
  RotateCw,
  ScanSearch,
  Wind,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import "./shot-select.css";

const framing = {
  大远景: ["ELS", 0.25],
  远景: ["LS", 0.4],
  全景: ["FS", 0.7],
  中景: ["MS", 1.1],
  中近景: ["MCU", 1.5],
  近景: ["CU", 1.9],
  特写: ["BCU", 2.6],
  大特写: ["ECU", 3.6],
} as const;
const icons = {
  固定: Lock,
  推: ZoomIn,
  拉: ZoomOut,
  摇: MoveHorizontal,
  移: ArrowRightLeft,
  跟: Footprints,
  升: ArrowUp,
  降: ArrowDown,
  环绕: RotateCw,
  变焦: ScanSearch,
  甩镜: Wind,
  手持: Hand,
  航拍: Plane,
};

type Choice = keyof typeof framing | keyof typeof icons;
function ChoiceContent({ choice }: { choice: Choice }) {
  if (Object.hasOwn(framing, choice)) {
    const [abbreviation, scale] = framing[choice as keyof typeof framing];
    return (
      <>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect
            x="0.75"
            y="0.75"
            width="14.5"
            height="14.5"
            rx="2"
            fill="none"
            stroke="currentColor"
          />
          <g transform={`translate(8 6) scale(${scale}) translate(-8 -6)`} fill="currentColor">
            <circle cx="8" cy="5" r="1.6" />
            <path d="M5.2 11.5c0-1.9 1.25-3.3 2.8-3.3s2.8 1.4 2.8 3.3Z" />
          </g>
        </svg>
        <span>{choice}</span>
        <small>{abbreviation}</small>
      </>
    );
  }
  const Icon = icons[choice as keyof typeof icons];
  return (
    <>
      <Icon />
      <span>{choice}</span>
    </>
  );
}

type ShotSelectProps = { container: RefObject<HTMLElement | null> } & (
  | {
      label: "景别";
      value: string;
      change: (choice: keyof typeof framing) => void;
    }
  | { label: "运镜"; value: string; change: (choice: keyof typeof icons) => void }
);
export function ShotSelect(props: ShotSelectProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const dialog = props.container.current;
    if (!open || !dialog) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    dialog.addEventListener("keydown", dismiss, true);
    return () => dialog.removeEventListener("keydown", dismiss, true);
  }, [open, props.container]);
  return (
    <Select.Root<Choice>
      open={open}
      onOpenChange={setOpen}
      value={
        (props.label === "景别" ? shotSizes : cameraMoves).find(
          (choice) => choice === props.value,
        ) ?? null
      }
      onValueChange={(choice) => {
        if (!choice) return;
        if (props.label === "景别") props.change(choice as keyof typeof framing);
        else props.change(choice as keyof typeof icons);
      }}
    >
      <Select.Trigger className="shot-select-trigger" aria-label={props.label}>
        <Select.Value placeholder={props.label} />
        <Select.Icon render={<ChevronDown />} />
      </Select.Trigger>
      <Select.Portal container={props.container}>
        <Select.Positioner
          className="shot-select-position"
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        >
          <Select.Popup className="shot-select-popup">
            <Select.ScrollUpArrow className="shot-select-scroll">
              <ChevronUp />
            </Select.ScrollUpArrow>
            <Select.List>
              {(props.label === "景别" ? shotSizes : cameraMoves).map((choice) => (
                <Select.Item key={choice} value={choice} className="shot-select-option">
                  <Select.ItemText className="shot-choice-content">
                    <ChoiceContent choice={choice} />
                  </Select.ItemText>
                  <Select.ItemIndicator className="shot-choice-check">
                    <Check />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
            <Select.ScrollDownArrow className="shot-select-scroll">
              <ChevronDown />
            </Select.ScrollDownArrow>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
