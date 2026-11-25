import type { SettingsEvent, SettingsValues } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import { useLayoutEffect, useRef, useState } from "react";
import type { RunRating } from "../../../packages/link-studio-core/src/agent-feedback";

type Page = SettingsValues["agentState"];
type ReadPage = (
  sessionId: string,
  after: number,
  before?: number,
) => Promise<{ ok: true; value: Page } | { ok: false; code: string }>;

type Phase = "latest" | "latest-error" | "ready" | "older" | "older-error";
export interface TranscriptHistory {
  phase: Phase;
  hasMoreOlder: boolean;
  firstSeq?: number;
  loadOlder: () => void;
  retryLatest: () => void;
}

export function useAssistantSession(sessionId: string, readPage: ReadPage, visible = true) {
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    events: SettingsEvent[];
    state?: Page;
    error?: string;
    phase: Phase;
    hasMoreOlder: boolean;
  }>();
  const reload = useRef<() => Promise<void>>(async () => {});
  const older = useRef<() => void>(() => {});
  const feedback = useRef<(session: string, run: string, value: RunRating | null) => void>(
    () => {},
  );
  const cache = useRef(new Map<string, { events: SettingsEvent[]; hasMoreOlder: boolean }>());
  useLayoutEffect(() => {
    cache.current.clear();
  }, [readPage]);
  useLayoutEffect(() => {
    setSnapshot(undefined);
    if (!sessionId || !visible) return;
    let closed = false;
    const cached = cache.current.get(sessionId);
    let events: SettingsEvent[] = cached?.events ?? [];
    let cursor = events.at(-1)?.seq ?? 0;
    let state: Page | undefined;
    let error: string | undefined;
    let phase: Phase = "latest";
    let hasMoreOlder = cached?.hasMoreOlder ?? false;
    const publish = () => setSnapshot({ sessionId, events, state, phase, hasMoreOlder, error });
    feedback.current = (session, run, value) => {
      if (closed || session !== sessionId) return;
      events = events.map((event) =>
        event.type === "run.status" && event.runId === run
          ? { ...event, feedback: value ?? undefined }
          : event,
      );
      publish();
    };
    older.current = async () => {
      const before = events[0]?.seq;
      if (closed || !before || !hasMoreOlder || (phase !== "ready" && phase !== "older-error"))
        return;
      phase = "older";
      publish();
      try {
        const result = await readPage(sessionId, 0, before);
        if (closed) return;
        if (result.ok) {
          const page = result.value.events.filter((event) => event.seq < before);
          events = [...page, ...events];
          hasMoreOlder = !!page.length && !!result.value.hasMoreOlder;
          phase = "ready";
        } else phase = "older-error";
      } catch {
        if (closed) return;
        phase = "older-error";
      }
      publish();
    };
    let timer: ReturnType<typeof setTimeout>;
    let inflight: Promise<void> | undefined;
    let changed = false;
    let frame = 0;
    const poll = () => {
      if (inflight) return inflight;
      changed = false;
      clearTimeout(timer);
      inflight = (async () => {
        let delay = 1000;
        try {
          const latest = !state;
          if (latest && phase === "latest-error") {
            phase = "latest";
            error = undefined;
            publish();
          }
          const result = await readPage(sessionId, cursor, latest && !cached ? 0 : undefined);
          if (closed) return;
          if (result.ok) {
            state = result.value;
            if (latest) {
              if (!cached) hasMoreOlder = !!state.hasMoreOlder;
              phase = "ready";
            }
            const tail = state.events.filter((event) => event.seq > cursor);
            if (tail.length) {
              events = [...events, ...tail];
              cursor = requirePresent(tail[tail.length - 1], "tail[tail.length - 1]").seq;
            }
            error = undefined;
            delay = (!latest || cached) && tail.length === 100 ? 0 : state.activeRun ? 250 : 1000;
          } else {
            error = result.code;
            if (latest) phase = "latest-error";
          }
        } catch {
          if (closed) return;
          error = "AGENT_STATE_UNAVAILABLE";
          if (!state) phase = "latest-error";
        } finally {
          inflight = undefined;
          if (!closed) {
            publish();
            if (changed) schedule();
            else if (state) timer = setTimeout(() => void poll(), delay);
          }
        }
      })();
      return inflight;
    };
    function schedule() {
      changed = true;
      if (frame || inflight || closed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (changed && !closed) void poll();
      });
    }
    const unsubscribe = window.desktop.projectEvents.onAgentChanged((id) => {
      if (id === sessionId) schedule();
    });
    reload.current = async () => {
      await inflight;
      if (!closed) await poll();
    };
    void poll();
    return () => {
      closed = true;
      unsubscribe();
      cancelAnimationFrame(frame);
      if (state) cache.current.set(sessionId, { events, hasMoreOlder });
      clearTimeout(timer);
      older.current = () => {};
      reload.current = async () => {};
    };
  }, [sessionId, readPage, visible]);
  const current = visible && snapshot?.sessionId === sessionId ? snapshot : undefined;
  const history: TranscriptHistory = {
    firstSeq: current?.events[0]?.seq,
    phase: current?.phase ?? (visible && sessionId ? "latest" : "ready"),
    hasMoreOlder: !!current?.hasMoreOlder,
    loadOlder: () => older.current(),
    retryLatest: () => void reload.current(),
  };
  return {
    events: current?.events ?? [],
    state: current?.state,
    readError: current?.error,
    history,
    recordFeedback: (run: string, value: RunRating | null) =>
      feedback.current(sessionId, run, value),
    refreshSession: () => reload.current(),
  };
}

export function useAssistantAction(onError: (code: string) => void) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    onError("");
    try {
      await action();
    } catch {
      onError("AGENT_REQUEST_UNCERTAIN");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}
