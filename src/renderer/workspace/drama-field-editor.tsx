import type { DramaDocument, ProjectRequest } from "@link-studio/core";
import { Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { DramaNotice } from "./drama-studio-status";

export type FieldAccess = {
  projectHandle: string;
  saved: (doc: DramaDocument) => void;
  flush?: () => Promise<void>;
};

export function DramaFieldEditor({
  projectHandle,
  saved,
  flush,
  label,
  target,
}: FieldAccess & {
  label: string;
  target: NonNullable<ProjectRequest<"drama">["editField"]>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState(target.previous);
  const [draft, setDraft] = useState(base);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function save() {
    setBusy(true);
    try {
      await flush?.();
      const result = await window.desktop.projects.drama({
        projectHandle,
        editField: { ...target, previous: base, value: draft },
      });
      if (!result.ok || !result.value) {
        if (!result.ok && result.error.code === "AGENT_APPROVAL_STALE") {
          const latest = await window.desktop.projects.drama({ projectHandle });
          if (latest.ok && latest.value) saved(latest.value);
          throw Error("内容已在别处更新。你的草稿仍在此处，可复制后关闭并重新编辑。");
        }
        throw Error(result.ok ? "短剧不存在" : result.error.message || result.error.code);
      }
      saved(result.value);
      dialog.current?.close();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="dp-action"
        type="button"
        aria-label={`编辑${label}`}
        onClick={() => {
          setBase(target.previous);
          setDraft(target.previous);
          setProblem("");
          dialog.current?.showModal();
        }}
      >
        <Pencil size={14} />
        编辑
      </button>
      <dialog
        className="dp-dialog"
        ref={dialog}
        aria-label={`编辑${label}`}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <h2>编辑{label}</h2>
        <textarea
          aria-label={label}
          maxLength={24000}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        {problem && <DramaNotice tone="error">{problem}</DramaNotice>}
        <footer>
          <button
            type="button"
            className="dp-action"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            取消
          </button>
          <button
            type="button"
            className="dp-action dp-primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </footer>
      </dialog>
    </>
  );
}
