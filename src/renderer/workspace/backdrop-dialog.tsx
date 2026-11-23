import type { ComponentProps } from "react";

export function BackdropDialog({
  dismiss,
  isolateClicks,
  ...props
}: Omit<ComponentProps<"dialog">, "onClick"> & { dismiss?: () => void; isolateClicks?: boolean }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Native dialog cancel handles Escape. Only pointer clicks outside the dialog rectangle dismiss the backdrop.
    <dialog
      {...props}
      onClick={(event) => {
        if (isolateClicks) event.stopPropagation();
        if (!dismiss || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          dismiss();
      }}
    />
  );
}
