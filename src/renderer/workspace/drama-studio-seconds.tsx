import { Popover } from "@base-ui/react/popover";
import { ChevronDown, MonitorPlay, Timer } from "lucide-react";
import { type ReactNode, useState } from "react";

const choices = [3, 4, 5, 6, 8, 10, 12, 15, 20, 30];

export function BarPicker({
  name,
  title,
  icon,
  label,
  disabled,
  modelMenu,
  children,
}: {
  name: string;
  title?: string;
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  modelMenu?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="studio-seconds-chip"
        data-model={modelMenu || undefined}
        disabled={disabled}
        title={title}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown size={16} opacity={0.5} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          align="start"
          sideOffset={6}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className="studio-seconds-position"
          data-model={modelMenu || undefined}
        >
          <Popover.Popup
            className="studio-seconds-menu"
            aria-label={name}
            data-model={modelMenu || undefined}
            data-resolution={name === "分辨率" || undefined}
          >
            {children(() => setOpen(false))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function StudioSegmentSeconds({
  seconds,
  max,
  ratio,
  disabled,
  change,
  resolutionField,
  resolution,
  pickResolution,
}: {
  seconds: number;
  max: number;
  ratio?: string;
  disabled?: boolean;
  change: (seconds: number) => void;
  resolutionField?: { label: string; choices: readonly string[]; defaultValue?: string };
  resolution?: string;
  pickResolution?: (value: string) => void;
}) {
  const hit = resolutionField?.choices.find(
    (value) => value === (resolution || resolutionField.defaultValue),
  );
  const options = [...new Set([...choices.filter((value) => value <= max), seconds])].sort(
    (left, right) => left - right,
  );
  return (
    <div className="drama-studio-seconds">
      <BarPicker
        name="片段时长"
        icon={<Timer size={16} />}
        label={`${seconds}s`}
        disabled={disabled}
        title={`片段时长 · 模型上限 ${max}s`}
      >
        {(close) =>
          options.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={value === seconds}
              data-warning={value > max || undefined}
              onClick={() => {
                close();
                change(value);
              }}
            >
              {value}s{value > max && <small>超出模型上限</small>}
            </button>
          ))
        }
      </BarPicker>
      {resolutionField && pickResolution && (
        <BarPicker
          name="分辨率"
          label={hit ?? resolutionField.defaultValue ?? "分辨率"}
          icon={<MonitorPlay size={16} />}
        >
          {(close) => (
            <>
              <div className="studio-resolution-label">{resolutionField.label}</div>
              {resolutionField.choices.map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={value === hit}
                  onClick={() => {
                    close();
                    pickResolution(value);
                  }}
                >
                  {value}
                </button>
              ))}
            </>
          )}
        </BarPicker>
      )}
      <span className="studio-ratio">{ratio || "比例未定"}</span>
    </div>
  );
}
