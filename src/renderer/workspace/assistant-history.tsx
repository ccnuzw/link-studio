import { Check, ChevronDown, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export function AssistantHistory({
  title,
  sessions,
  current,
  locked,
  select,
  rename,
  remove,
}: {
  title: string;
  sessions: { id: string; title: string }[];
  current: string;
  locked: boolean;
  select: (id: string) => void;
  rename: (title: string) => void;
  remove: (id: string) => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState("");
  const committing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const finish = (commit: boolean) => {
    if (committing.current) return;
    committing.current = true;
    if (commit && draft?.trim() && draft.trim() !== title) rename(draft.trim());
    setDraft(null);
  };
  if (draft !== null)
    return (
      <input
        aria-label="会话标题"
        maxLength={40}
        ref={input}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(event.key === "Enter");
          }
        }}
      />
    );
  return (
    <>
      <h2 className="assistant-session-title">
        <button
          type="button"
          popoverTarget={id}
          title="历史会话 · 双击改名"
          onDoubleClick={() => {
            if (!current) return;
            menu.current?.hidePopover();
            committing.current = false;
            setDraft(title);
          }}
          aria-label={`历史会话，当前：${title}`}
        >
          <span>{title}</span>
          <ChevronDown size={14} />
        </button>
      </h2>
      <div
        id={id}
        ref={menu}
        popover="auto"
        onToggle={() => setConfirming("")}
        className="composer-popover assistant-history"
      >
        <p className="history-label">历史会话</p>
        {!sessions.length && <p className="history-empty">还没有会话</p>}
        {sessions.map((session) => (
          <div key={session.id} className="assistant-history-row">
            <button
              type="button"
              disabled={locked && session.id !== current}
              title={locked && session.id !== current ? "运行中不能切换会话" : undefined}
              aria-current={session.id === current}
              onClick={() => {
                select(session.id);
                menu.current?.hidePopover();
              }}
            >
              <span>{session.title}</span>
              {session.id === current && <Check size={16} aria-hidden />}
            </button>
            <button
              type="button"
              disabled={locked}
              data-confirming={confirming === session.id || undefined}
              aria-label={`${confirming === session.id ? "确认删除" : "删除"}「${session.title}」`}
              onClick={() => {
                if (confirming === session.id) {
                  setConfirming("");
                  remove(session.id);
                } else setConfirming(session.id);
              }}
            >
              <Trash2 size={14} />
              {confirming === session.id && "删除?"}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
