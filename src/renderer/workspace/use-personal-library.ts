import type { ProjectValues } from "@link-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";

export function usePersonalLibrary(handle: string, enabled = true, filingChannelId?: string) {
  const [snapshot, setSnapshot] = useState<ProjectValues["listLibrary"]>({
    items: [],
    folders: [],
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    enabled ? "loading" : "ready",
  );
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    const items: ProjectValues["listLibrary"]["items"] = [];
    let before: number | undefined;
    let folders: ProjectValues["listLibrary"]["folders"] = [];
    let removedSourceIds: string[] | undefined;
    try {
      do {
        const result = await window.desktop.projects.listLibrary({
          projectHandle: handle,
          ...(before && { before }),
          ...(filingChannelId && { filingChannelId }),
        });
        if (generation.current !== current) return;
        if (!result.ok) throw new Error();
        if (!before) {
          folders = result.value.folders;
          removedSourceIds = result.value.removedSourceIds;
        }
        items.push(...result.value.items);
        before = result.value.next;
      } while (before);
      setSnapshot({ items, folders, removedSourceIds });
      setStatus("ready");
    } catch {
      if (current === generation.current) setStatus("error");
    }
  }, [handle, enabled, filingChannelId]);
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = window.desktop.projectEvents?.onLibraryChanged?.(reload);
    setStatus("loading");
    void reload();
    return () => {
      generation.current++;
      unsubscribe?.();
    };
  }, [enabled, reload]);
  return { ...snapshot, status, reload };
}
