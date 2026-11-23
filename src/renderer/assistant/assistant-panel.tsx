import type { SettingsEvent, SettingsValues } from "@link-studio/core";
import { ArrowDown, Hand } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TranscriptHistory } from "./use-assistant-session";
import "./assistant-history-paging.css";

function compacting(state?: SettingsValues["agentState"]) {
  return !!(
    state?.activeRun &&
    state.compacting &&
    state.activeStatus === "running" &&
    !state.partial?.text
  );
}

export function AssistantCompactionStatus({
  state,
  events,
}: {
  state?: SettingsValues["agentState"];
  events: SettingsEvent[];
}) {
  if (!compacting(state)) return null;
  return (
    <WorkingLine
      since={runActivity(events, state?.activeRun).since}
      label="正在整理较早的对话…"
      showStop
    />
  );
}

function runActivity(events: SettingsEvent[], runId?: string) {
  const tools = new Map<string, string>();
  let since: number | undefined;
  let previous: unknown;
  for (const event of events) {
    if (event.runId !== runId) continue;
    const data = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "tool.start")
      tools.set(
        String(data.id ?? event.seq),
        String(data.label || data.verb || data.name || "执行操作"),
      );
    if (event.type === "tool.end") tools.delete(String(data.id ?? event.seq));
    if (event.type !== "run.status") continue;
    const status = (event.payload as { status?: string } | null)?.status;
    if (
      since === undefined ||
      status === "queued" ||
      status === "recovering" ||
      (status === "running" && (previous === "waiting_approval" || previous === "waiting_input"))
    )
      since = event.createdAt;
    previous = status;
  }
  return { since, tool: [...tools.values()].at(-1) };
}

function WorkingLine({
  since,
  label,
  showStop,
}: {
  since?: number;
  label: string;
  showStop?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (since === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return (
    <div className="agent-compacting-line" role="status">
      <i aria-hidden="true" />
      <span>{label}</span>
      {since !== undefined && <time>{Math.max(1, Math.round((now - since) / 1000))}s</time>}
      {showStop && (
        <small>
          <kbd>Esc</kbd>停止
        </small>
      )}
    </div>
  );
}

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

export function AssistantHeading({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <header className="assistant-heading">
      <span className="assistant-header-orb" aria-hidden="true" />
      {title}
      {children}
    </header>
  );
}

export function AssistantStatus({
  state,
  busy,
  opening,
  stale,
  events,
  showStop,
}: {
  state?: SettingsValues["agentState"];
  busy: boolean;
  opening: boolean;
  stale: boolean;
  events?: SettingsEvent[];
  showStop?: boolean;
}) {
  if (opening || compacting(state)) return null;
  if (events && state?.activeRun && !stale) {
    const waiting =
      state.activeStatus === "waiting_approval" || state.activeStatus === "waiting_input";
    if (waiting)
      return (
        <div className="assistant-waiting-line" role="status">
          <Hand size={14} aria-hidden="true" />
          <span>{state.activeStatus === "waiting_approval" ? "等你确认 ↓" : "等你回答 ↓"}</span>
        </div>
      );
    if (state.partial?.text) return null;
    const { since, tool } = runActivity(events, state.activeRun);
    const text =
      state.activeStatus === "recovering" ? "正在恢复…" : tool ? `正在${tool}…` : "思考中…";
    return <WorkingLine key={state.activeRun} label={text} since={since} showStop={showStop} />;
  }
  const statuses: Record<string, string> = {
    queued: "正在准备",
    running: "小灵正在工作",
    recovering: "正在恢复…",
    waiting_approval: "等待你的审批",
    waiting_input: "等待你的回答",
  };
  const label = busy
    ? "正在处理操作"
    : stale
      ? "会话状态暂不可用"
      : state?.otherActiveSession
        ? "另一个会话正在运行"
        : state?.activeRun
          ? (statuses[state.activeStatus ?? ""] ?? "运行中")
          : "就绪";
  return (
    <div
      className="assistant-status"
      role="status"
      data-idle={label === "就绪"}
      data-active={!!state?.activeRun}
    >
      {label}
    </div>
  );
}

export function AssistantTranscript({
  history,
  loadingSessions = false,
  sessionId,
  label,
  empty,
  children,
}: {
  history: TranscriptHistory;
  loadingSessions?: boolean;
  sessionId: string;
  label: string;
  empty?: ReactNode;
  children: ReactNode;
}) {
  const log = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const height = useRef(0);
  const first = useRef<number | undefined>(undefined);
  const follow = useRef(true);
  const reduce = useReducedMotion();
  const [away, setAway] = useState(false);
  const jump = () => {
    follow.current = true;
    setAway(false);
    log.current?.scrollTo({
      top: log.current.scrollHeight,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };
  const syncHeight = useCallback(() => {
    const el = log.current;
    if (!el) return;
    if (follow.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight > height.current + 1) setAway(true);
    height.current = el.scrollHeight;
  }, []);
  useLayoutEffect(() => {
    first.current = undefined;
    height.current = 0;
    follow.current = true;
    setAway(false);
  }, [sessionId]);
  useLayoutEffect(() => {
    const el = log.current;
    if (!el || empty) return;
    if (
      first.current !== undefined &&
      history.firstSeq !== undefined &&
      history.firstSeq < first.current &&
      !follow.current
    ) {
      el.scrollTop += el.scrollHeight - height.current;
      height.current = el.scrollHeight;
    }
    first.current = history.firstSeq;
    syncHeight();
  });
  const open = !loadingSessions && history.phase !== "latest" && history.phase !== "latest-error";
  const hasContent = open && !empty;
  useEffect(() => {
    const el = content.current;
    if (!el || !hasContent) return;
    const observer = new ResizeObserver(syncHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasContent, syncHeight]);
  const canLoad = history.phase === "ready" && history.hasMoreOlder;
  useEffect(() => {
    if (canLoad && log.current && log.current.scrollTop < 160) history.loadOlder();
  });
  return (
    <div className="assistant-transcript">
      {open && (
        <div
          ref={log}
          className="assistant-events"
          role="log"
          aria-label={label}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the transcript.
          tabIndex={0}
          onScroll={({ currentTarget }) => {
            currentTarget.dataset.scrolled = String(currentTarget.scrollTop > 4);
            const distance =
              currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop;
            follow.current = distance < 48;
            if (follow.current) setAway(false);
            if (canLoad && currentTarget.scrollTop < 160) history.loadOlder();
          }}
        >
          {typeof empty === "string" ? <p className="assistant-empty">{empty}</p> : empty}
          {empty ? (
            children
          ) : (
            <div className="assistant-history-content" ref={content}>
              {children}
            </div>
          )}
        </div>
      )}
      {!open && (
        <motion.div
          role="status"
          aria-live="polite"
          className="assistant-page-opening"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{
            duration: 0.18,
            ease: [0.2, 0, 0, 1],
            delay: history.phase === "latest-error" ? 0 : 0.15,
          }}
        >
          <span className="assistant-header-orb" aria-hidden="true" />
          {history.phase === "latest-error" ? (
            <>
              <span>对话加载失败</span>
              <button type="button" onClick={history.retryLatest}>
                重试
              </button>
            </>
          ) : (
            <span className="assistant-page-shimmer">正在加载对话…</span>
          )}
        </motion.div>
      )}
      <div className="assistant-page-overlay">
        <AnimatePresence>
          {(history.phase === "older" || history.phase === "older-error") && (
            <motion.div
              key={history.phase}
              className="assistant-page-pill"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.126 } }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            >
              {history.phase === "older" ? (
                <span className="assistant-page-shimmer" role="status">
                  加载更早的消息…
                </span>
              ) : (
                <button type="button" onClick={history.loadOlder}>
                  加载失败，点击重试
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {open && away && !empty && (
          <motion.button
            type="button"
            className="assistant-page-jump"
            aria-label="回到底部"
            onClick={jump}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, ...(!reduce && { scale: 0.9 }), transition: { duration: 0.084 } }}
            transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
          >
            <ArrowDown size={14} aria-hidden="true" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
