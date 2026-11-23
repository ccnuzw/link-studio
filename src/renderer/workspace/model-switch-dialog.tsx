import { X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

export function ModelSwitchDialog({
  labels,
  cancel,
  confirm,
}: {
  labels: string[];
  cancel: () => void;
  confirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="model-switch-dialog nodrag nopan nowheel"
      aria-label="切换模型"
      aria-describedby="model-switch-description"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          cancel();
      }}
    >
      <header>
        <h2>切换模型</h2>
        <p id="model-switch-description">
          新模型没有这些参数，切换后会被丢弃：{labels.join("、")}。
        </p>
      </header>
      <footer>
        <button type="button" onClick={cancel}>
          取消
        </button>
        <button type="button" onClick={confirm}>
          继续切换
        </button>
      </footer>
      <button type="button" aria-label="关闭" className="model-switch-close" onClick={cancel}>
        <X size={16} />
      </button>
    </dialog>
  );
}
