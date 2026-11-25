import { useRef, useState } from "react";
import type { AutosaveStatus } from "./drama-autosave";
import type { FieldAccess } from "./drama-field-editor";
import { useDramaFlush, useDramaSaveStatus } from "./drama-save-status";

export function DramaProjectTitle({ title, access }: { title: string; access: FieldAccess }) {
  const [draft, setDraft] = useState<string>();
  const [status, setStatus] = useState<AutosaveStatus>("saved");
  const base = useRef(title);
  const discard = useRef(false);
  useDramaSaveStatus(status);
  const pending = useRef<Promise<boolean> | null>(null);
  function commit() {
    pending.current ??= write().finally(() => {
      pending.current = null;
    });
    return pending.current;
  }
  useDramaFlush(async () => {
    if ((draft !== undefined || pending.current) && !(await commit()))
      throw Error("项目名尚未保存");
  });
  async function write() {
    const value = draft?.trim();
    if (discard.current || !value || value === title) {
      discard.current = false;
      setDraft(undefined);
      setStatus("saved");
      return true;
    }
    setStatus("saving");
    try {
      const result = await window.desktop.projects.drama({
        projectHandle: access.projectHandle,
        editField: { field: "title", previous: base.current, value },
      });
      if (!result.ok && result.error.code === "AGENT_APPROVAL_STALE") {
        setStatus("conflict");
        const latest = await window.desktop.projects.drama({ projectHandle: access.projectHandle });
        if (latest.ok && latest.value) access.saved(latest.value);
        return false;
      }
      if (!result.ok || !result.value) throw Error();
      access.saved(result.value);
      setDraft(undefined);
      setStatus("saved");
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }
  return (
    <input
      className="dp-title-edit"
      aria-label="项目名"
      title={
        status === "conflict"
          ? "名称已在别处更新。按 Escape 载入新名称，或编辑后再次保存。"
          : "编辑项目名"
      }
      maxLength={64}
      value={draft ?? title}
      readOnly={status === "saving"}
      onFocus={() => {
        base.current = title;
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        setStatus("dirty");
      }}
      onBlur={() => {
        if (status !== "saving") void commit();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") discard.current = true;
        if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
      }}
    />
  );
}
