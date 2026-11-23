import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactNode, RefObject } from "react";

export function ShotConfirm({
  open,
  change,
  focus,
  restoreFocus = false,
  small,
  title,
  description,
  children,
}: {
  open: boolean;
  change: (open: boolean) => void;
  focus: RefObject<HTMLButtonElement | null>;
  restoreFocus?: boolean;
  small?: boolean;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={change}>
      <AlertDialog.Portal
        className="storyboard-layer"
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <AlertDialog.Backdrop className="shot-confirm-backdrop" />
        <AlertDialog.Popup
          className="shot-confirm"
          data-small={small || undefined}
          initialFocus={focus}
          finalFocus={restoreFocus}
        >
          {small ? (
            <section className="shot-confirm-heading">
              <AlertDialog.Title render={<h3 />}>{title}</AlertDialog.Title>
            </section>
          ) : (
            <AlertDialog.Title render={<h3 />}>{title}</AlertDialog.Title>
          )}
          {description && <AlertDialog.Description>{description}</AlertDialog.Description>}
          <div>
            <AlertDialog.Close>取消</AlertDialog.Close>
            {children}
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
