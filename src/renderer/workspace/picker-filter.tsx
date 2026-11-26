import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown } from "lucide-react";
import { Fragment, type ReactNode, type RefObject, useState } from "react";

export function PickerFilter({
  label,
  icon,
  options,
  value,
  change,
  container,
  canvasGroup,
}: {
  label: string;
  icon?: ReactNode;
  options: Record<string, string>;
  value: string;
  change: (value: string) => void;
  container: RefObject<HTMLDialogElement | null>;
  canvasGroup?: boolean;
}) {
  const active = value !== Object.keys(options)[0];
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={label}
        title={active ? `${label}：${options[value]}` : label}
        className={`asset-pick-icon asset-pick-filter${icon ? "" : " asset-pick-filter-text"}`}
        data-active={active || undefined}
      >
        {icon ?? (
          <>
            {active ? options[value] : label}
            <ChevronDown size={13} aria-hidden="true" />
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Positioner
          className="asset-filter-position"
          align="start"
          sideOffset={6}
          positionMethod="fixed"
          collisionBoundary={document.documentElement}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        >
          <Popover.Popup aria-label={label} className="asset-pick-menu">
            {Object.entries(options).map(([key, name], index) => (
              <Fragment key={key}>
                {canvasGroup && index === 2 && (
                  <>
                    <hr data-ui-divider />
                    <div className="asset-filter-heading">画布</div>
                  </>
                )}
                <button
                  type="button"
                  aria-pressed={key === value}
                  onClick={() => {
                    setOpen(false);
                    change(key);
                  }}
                >
                  <span>
                    <span>{name}</span>
                  </span>
                  {key === value && <Check size={16} />}
                </button>
              </Fragment>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
