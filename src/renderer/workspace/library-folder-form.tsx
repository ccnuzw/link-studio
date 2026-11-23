import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { BackdropDialog } from "./backdrop-dialog";

export function LibraryFolderForm({
  handle,
  folder,
  close,
}: {
  handle: string;
  folder?: { id: string; name: string };
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const title = folder ? "重命名文件夹" : "新建文件夹";
  const [name, setName] = useState(folder?.name ?? ""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [touched, setTouched] = useState(false);
  const clean = name.trim(),
    invalid = !clean ? "请输入文件夹名称" : Array.from(clean).length > 30 ? "名称最多 30 个字" : "";
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);
  return (
    <BackdropDialog
      ref={dialog}
      aria-label={title}
      className="library-folder-form library-name-dialog"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) close();
      }}
      dismiss={busy ? undefined : close}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setTouched(true);
          if (invalid || busy) return;
          setBusy(true);
          try {
            const result = folder
              ? await window.desktop.projects.renameLibraryFolder({
                  projectHandle: handle,
                  folderId: folder.id,
                  name: clean,
                })
              : await window.desktop.projects.createLibraryFolder({
                  projectHandle: handle,
                  name: clean,
                });
            if (result.ok) close();
            else setMessage(result.error.message ?? `无法${title}`);
          } catch {
            setMessage(`无法${title}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <p>名称最多 {30} 个字，不能与已有文件夹重名。</p>
        </header>
        <div>
          <input
            ref={input}
            aria-label="文件夹名称"
            placeholder="例如：角色图"
            aria-invalid={touched && !!invalid}
            value={name}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setName(event.target.value);
              setMessage("");
            }}
          />
          {((touched && invalid) || message) && <span role="alert">{invalid || message}</span>}
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" disabled={busy}>
            {folder ? "保存" : "创建"}
          </button>
        </footer>
      </form>
      <button
        type="button"
        className="library-name-close"
        aria-label="Close"
        disabled={busy}
        onClick={close}
      >
        <X size={16} />
      </button>
    </BackdropDialog>
  );
}
