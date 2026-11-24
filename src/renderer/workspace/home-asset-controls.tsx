import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Ellipsis, type LucideIcon, Search } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function AssetToolbar({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null),
    mini = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = bar.current,
      sheet = element?.closest(".home-sheet"),
      header = sheet?.querySelector<HTMLElement>(":scope > header");
    if (!sheet || !element || !header) return;
    const update = () => {
      const progress = Math.min(
        1,
        Math.max(
          0,
          (header.getBoundingClientRect().bottom - element.getBoundingClientRect().top) /
            Math.max(1, element.offsetHeight),
        ),
      );
      element.style.transform = progress ? `scale(${1 - progress * 0.05})` : "";
      element.style.opacity = progress ? String(1 - progress * 0.7) : "";
      setHost(progress >= 0.9 && sheet.clientWidth >= 768 ? header : null);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(sheet);
    observer.observe(element);
    sheet.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      sheet.removeEventListener("scroll", update);
    };
  }, []);
  useLayoutEffect(() => {
    if (
      !host ||
      !mini.current ||
      !bar.current ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const from = bar.current.getBoundingClientRect(),
      to = mini.current.getBoundingClientRect();
    mini.current.animate(
      [
        { width: `${from.width}px`, translate: `0 ${from.top - to.top}px`, opacity: 0.6 },
        { width: `${to.width}px`, translate: "0 0", opacity: 1 },
      ],
      { duration: 320, easing: "cubic-bezier(.32,.72,0,1)" },
    );
  }, [host]);
  return (
    <>
      <div ref={bar} className="global-toolbar" inert={!!host}>
        {children}
      </div>
      {host &&
        createPortal(
          <div className="home-asset-mini">
            <div ref={mini} className="global-toolbar">
              {children}
            </div>
          </div>,
          host,
        )}
    </>
  );
}

type Option = { value: string; label: string; heading?: string };
export function AssetFilter({
  label,
  value,
  options,
  change,
  initial = "",
}: {
  label: string;
  value: string;
  initial?: string;
  options: Option[];
  change: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        className="home-asset-filter"
        aria-label={label}
        data-active={value !== initial}
      >
        <span>{value !== initial ? selected?.label : label}</span>
        <ChevronDown size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="home-asset-position" align="start" sideOffset={6}>
          <Menu.Popup className="home-asset-menu">
            <Menu.RadioGroup value={value} onValueChange={change}>
              {options.map((option) => (
                <Menu.Group key={option.value}>
                  {option.heading && <Menu.GroupLabel>{option.heading}</Menu.GroupLabel>}
                  <Menu.RadioItem value={option.value} closeOnClick>
                    {option.label}
                    <Menu.RadioItemIndicator>
                      <Check size={15} />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                </Menu.Group>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function AssetActions({
  label,
  trigger,
  actions,
}: {
  label: string;
  trigger?: ReactNode;
  actions: {
    label: string;
    run: () => void;
    icon?: LucideIcon;
    destructive?: boolean;
    disabled?: boolean;
  }[];
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger aria-label={label} className={trigger ? "home-asset-new" : "home-asset-more"}>
        {trigger ?? <Ellipsis size={16} />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="home-asset-position" align="end" sideOffset={6}>
          <Menu.Popup className="home-asset-menu home-action-menu">
            {actions.map((action) => (
              <Menu.Item
                key={action.label}
                data-destructive={action.destructive}
                disabled={action.disabled}
                onClick={action.run}
              >
                {action.icon && <action.icon size={16} />}
                {action.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function AssetSearch({
  value,
  change,
  label,
}: {
  value: string;
  change: (value: string) => void;
  label: string;
}) {
  return (
    <label className="global-search">
      <Search size={16} />
      <input
        maxLength={255}
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") change("");
        }}
      />
    </label>
  );
}
