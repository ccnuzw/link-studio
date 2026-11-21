import type { SettingsValues } from "@link-studio/core";
import { ArrowDown, Sparkles } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";

export function submitShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.nativeEvent.isComposing
  )
    return;
  event.preventDefault();
  if (!event.repeat) event.currentTarget.form?.requestSubmit();
}

export function AssistantHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="assistant-heading">
      <h2>
        <Sparkles size={17} aria-hidden="true" />
        {title}
      </h2>
      {children}
    </header>
  );
}

export function AssistantStatus({
  state,
  busy,
  loading,
  stale,
}: {
  state?: SettingsValues["agentState"];
  busy: boolean;
  loading: boolean;
  stale: boolean;
}) {
  const statuses: Record<string, string> = {
    queued: "正在准备",
    running: "小灵正在工作",
    waiting_approval: "等待你的审批",
    waiting_input: "等待你的回答",
  };
  const label = busy
    ? "正在处理操作"
    : stale
      ? "会话状态暂不可用"
      : loading
        ? "正在读取会话"
        : state?.otherActiveSession
          ? "另一个会话正在运行"
          : state?.activeRun
            ? (statuses[state.activeStatus ?? ""] ?? "运行中")
            : "就绪";
  return (
    <div className="assistant-status" role="status" data-active={!!state?.activeRun}>
      {label}
    </div>
  );
}

export function AssistantTranscript({
  sessionId,
  label,
  empty,
  children,
}: {
  sessionId: string;
  label: string;
  empty?: string;
  children: ReactNode;
}) {
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const jump = () => {
    follow.current = true;
    setAway(false);
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  };
  useLayoutEffect(() => {
    if (!sessionId) return;
    follow.current = true;
    setAway(false);
  }, [sessionId]);
  useLayoutEffect(() => {
    if (log.current && follow.current) log.current.scrollTop = log.current.scrollHeight;
  });
  return (
    <div className="assistant-transcript">
      <div
        ref={log}
        className="assistant-events"
        role="log"
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the transcript.
        tabIndex={0}
        onScroll={({ currentTarget }) => {
          const distance =
            currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop;
          follow.current = distance < 32;
          setAway(!follow.current);
        }}
      >
        {empty && <p className="assistant-empty">{empty}</p>}
        {children}
      </div>
      {away && (
        <button type="button" className="assistant-latest" onClick={jump}>
          <ArrowDown size={14} aria-hidden="true" />
          回到最新
        </button>
      )}
    </div>
  );
}
