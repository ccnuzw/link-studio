import { useEffect, useRef, useState } from "react";
import { ModelModal } from "./model-editor";

export function useSettingsConfirm() {
  const [message, setMessage] = useState("");
  const pending = useRef<((value: boolean) => void) | undefined>(undefined);
  useEffect(() => () => pending.current?.(false), []);
  const confirm = (text: string) =>
    new Promise<boolean>((resolve) => {
      pending.current?.(false);
      pending.current = resolve;
      setMessage(text);
    });
  const finish = (value: boolean) => {
    pending.current?.(value);
    pending.current = undefined;
    setMessage("");
  };
  const confirmation = message && (
    <ModelModal title="确认操作" close={() => finish(false)}>
      <div className="model-dialog-body">{message}</div>
      <footer className="model-dialog-footer">
        <button type="button" onClick={() => finish(false)}>
          取消
        </button>
        <button className="settings-primary" type="button" onClick={() => finish(true)}>
          确认
        </button>
      </footer>
    </ModelModal>
  );
  return { confirm, confirmation };
}
