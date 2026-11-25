import { useEffect, useRef } from "react";

export function CanvasExportProgress({ stage, cancel }: { stage: string; cancel?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="grid-split-dialog"
      aria-label={stage}
      onCancel={(event) => {
        event.preventDefault();
        cancel?.();
      }}
    >
      <h2>{stage}</h2>
      <progress aria-label={stage} />
      {cancel && (
        <button type="button" onClick={cancel}>
          取消导出
        </button>
      )}
    </dialog>
  );
}
