import { createContext, useContext, useEffect, useId, useRef } from "react";
import type { AutosaveStatus } from "./drama-autosave";

export const DramaSaveStatus = createContext<(id: string, status?: AutosaveStatus) => void>(
  () => {},
);

export const DramaFlushers = createContext<Set<() => Promise<void>> | null>(null);

export function useDramaFlush(flush: () => Promise<void>) {
  const writers = useContext(DramaFlushers);
  const latest = useRef(flush);
  latest.current = flush;
  useEffect(() => {
    const write = () => latest.current();
    writers?.add(write);
    return () => {
      writers?.delete(write);
    };
  }, [writers]);
}

export function useDramaSaveStatus(status: AutosaveStatus) {
  const report = useContext(DramaSaveStatus);
  const id = useId();
  useEffect(() => {
    report(id, status);
    return () => report(id);
  }, [id, status, report]);
}
