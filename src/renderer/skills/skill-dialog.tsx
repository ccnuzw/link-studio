import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";

export function SkillDialog({
  title,
  steps,
  busy,
  close,
  children,
  footer,
}: {
  title: string;
  steps?: ReactNode;
  busy?: boolean;
  close: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={label}
      className="skill-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="skill-dialog-frame">
        <header>
          <h2 id={label}>{title}</h2>
          {steps}
          <button
            type="button"
            className="skill-icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={close}
          >
            <X size={19} />
          </button>
        </header>
        <div className="skill-dialog-body">{children}</div>
        <footer>{footer}</footer>
      </div>
    </dialog>
  );
}
