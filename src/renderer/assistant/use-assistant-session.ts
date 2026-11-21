import type { SettingsEvent, SettingsValues } from "@link-studio/core";
import { useLayoutEffect, useRef, useState } from "react";

type Page = SettingsValues["agentState"];
type ReadPage = (
  sessionId: string,
  after: number,
) => Promise<{ ok: true; value: Page } | { ok: false; code: string }>;

export function useAssistantSession(sessionId: string, readPage: ReadPage, visible = true) {
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    events: SettingsEvent[];
    state?: Page;
    error?: string;
  }>();
  const reload = useRef<() => Promise<void>>(async () => {});
  useLayoutEffect(() => {
    setSnapshot(undefined);
    if (!sessionId || !visible) return;
    let closed = false;
    let cursor = 0;
    let events: SettingsEvent[] = [];
    let state: Page | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let inflight: Promise<void> | undefined;
    const poll = () => {
      if (inflight) return inflight;
      clearTimeout(timer);
      inflight = (async () => {
        let delay = 1000;
        try {
          const result = await readPage(sessionId, cursor);
          if (closed) return;
          if (result.ok) {
            state = result.value;
            if (state.events.length) {
              events = [...events, ...state.events];
              cursor = state.events.at(-1)?.seq ?? cursor;
            }
            setSnapshot({ sessionId, events, state });
            delay = state.events.length === 100 ? 0 : state.activeRun ? 250 : 1000;
          } else {
            setSnapshot({ sessionId, events, state, error: result.code });
          }
        } catch {
          if (!closed) setSnapshot({ sessionId, events, state, error: "AGENT_STATE_UNAVAILABLE" });
        } finally {
          inflight = undefined;
          if (!closed) timer = setTimeout(() => void poll(), delay);
        }
      })();
      return inflight;
    };
    reload.current = async () => {
      await inflight;
      if (!closed) await poll();
    };
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
      reload.current = async () => {};
    };
  }, [sessionId, readPage, visible]);
  return {
    events: snapshot?.sessionId === sessionId ? snapshot.events : [],
    state: snapshot?.sessionId === sessionId ? snapshot.state : undefined,
    readError: snapshot?.sessionId === sessionId ? snapshot.error : undefined,
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
