import type { DirectorCamera } from "@link-studio/core";
import { Camera, Check, ChevronDown, Compass } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export const MENU_ATTR = "data-director-menu";

export function ViewModeSwitch({
  cameras,
  viewedId,
  select,
}: {
  cameras: DirectorCamera[];
  viewedId: string | null;
  select: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const viewedName = cameras.find((c) => c.id === viewedId)?.name;
  const inCamera = viewedId !== null;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const choose = (cameraId: string | null) => {
    select(cameraId);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div ref={rootRef} className="director-view-menu" {...{ [MENU_ATTR]: "" }}>
      {open && (
        <div role="menu" onKeyDown={onMenuKey} aria-label="视角" className="director-menu-items">
          <MenuItem
            icon={<Compass />}
            label="导演视角"
            checked={!inCamera}
            onClick={() => choose(null)}
          />
          {cameras.length === 0 && <p>先添加一台机位</p>}
          {cameras.map((camera) => (
            <MenuItem
              key={camera.id}
              icon={<Camera />}
              label={camera.name}
              checked={camera.id === viewedId}
              onClick={() => choose(camera.id)}
            />
          ))}
        </div>
      )}
      <button
        ref={triggerRef}
        onKeyDown={open ? onMenuKey : undefined}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="切换视角"
        onClick={() => setOpen((value) => !value)}
        className="director-menu-trigger"
      >
        {inCamera ? <Camera /> : <Compass />}
        {inCamera ? `机位视角 · ${viewedName ?? ""}` : "导演视角"}
        <ChevronDown className={open ? "rotated" : ""} />
      </button>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  checked,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      {...{ [MENU_ATTR]: "" }}
      onClick={onClick}
    >
      {icon && <span>{icon}</span>}
      <span>{label}</span>
      {checked && <Check />}
    </button>
  );
}
