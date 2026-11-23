import { type ReactNode, useState } from "react";

export function SettingsDrawer({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  return (
    <aside className="settings-drawer" aria-label="小灵设置助手" inert={!open} data-open={open}>
      <div className="settings-drawer-glass">{mounted && children}</div>
    </aside>
  );
}
