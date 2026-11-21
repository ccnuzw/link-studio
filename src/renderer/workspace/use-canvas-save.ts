import type {
  CanvasOperation,
  ProjectCanvasView,
  ProjectErrorCode,
  ProjectSession,
  ProjectValues,
} from "@link-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { canvasDiff, rebaseCanvas } from "./canvas-model";

type PendingSave = {
  input: Parameters<typeof window.desktop.projects.applyCanvasOperations>[0];
  canvas: ProjectCanvasView;
};

export function useCanvasSave(
  session: ProjectSession | null,
  canvas: ProjectCanvasView,
  editing: boolean,
  projectBusy: boolean,
  updateRevision: (projectHandle: string, revision: number) => void,
) {
  const [base, setBase] = useState<ProjectValues["getCanvas"] | null>(null);
  const [pristine, setPristine] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ProjectErrorCode | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const pending = useRef<PendingSave | null>(null);
  const key = JSON.stringify(canvas);
  const dirtyKey =
    base !== null &&
    (pending.current || (pristine !== key && canvasDiff(base.canvas, canvas).length > 0))
      ? key
      : null;
  const latest = useRef({ base, pristine, canvas, key });
  latest.current = { base, pristine, canvas, key };

  const load = (next: ProjectValues["getCanvas"] | null, initial?: ProjectCanvasView) => {
    pending.current = null;
    setError(null);
    setBase(next);
    setPristine(initial ? JSON.stringify(initial) : null);
  };

  const save = useCallback(
    async (active: ProjectSession, drain = true): Promise<ProjectSession | null> => {
      while (inFlight.current) if (!(await inFlight.current)) return null;
      const current = latest.current;
      if (!current.base) return active;
      const { projectHandle } = active;
      const write = async () => {
        let baseline = current.base;
        try {
          if (!baseline) return false;
          for (;;) {
            const draft = latest.current;
            const operations: CanvasOperation[] =
              draft.pristine === draft.key ? [] : canvasDiff(baseline.canvas, draft.canvas);
            const batch: PendingSave | null =
              pending.current ??
              (operations.length
                ? {
                    input: {
                      projectHandle,
                      operationId: crypto.randomUUID(),
                      operations,
                      expectedCanvasRevision: baseline.canvasRevision,
                    },
                    canvas: draft.canvas,
                  }
                : null);
            if (!batch) {
              setError(null);
              return true;
            }
            pending.current = batch;
            setSaving(true);
            const result = await window.desktop.projects.applyCanvasOperations(batch.input);
            if (!result.ok) {
              if (result.error.code !== "PROJECT_SAVE_FAILED") pending.current = null;
              setError(result.error.code);
              return false;
            }
            pending.current = null;
            baseline = { ...result.value, canvas: batch.canvas };
            latest.current = { ...latest.current, base: baseline, pristine: null };
            setBase(baseline);
            setPristine(null);
            updateRevision(projectHandle, baseline.revision);
            if (!drain) {
              setError(null);
              return true;
            }
          }
        } catch {
          setError("PROJECT_SAVE_FAILED");
          return false;
        }
      };
      const work = write();
      inFlight.current = work;
      try {
        if (!(await work)) return null;
        return {
          ...active,
          revision: Math.max(active.revision, latest.current.base?.revision ?? 1),
        };
      } finally {
        inFlight.current = null;
        setSaving(false);
      }
    },
    [updateRevision],
  );

  useEffect(() => {
    if (!session || dirtyKey === null || editing || projectBusy || saving || error) return;
    const timer = window.setTimeout(() => void save(session, false), 450);
    return () => window.clearTimeout(timer);
  }, [session, dirtyKey, editing, projectBusy, saving, error, save]);

  const recover = async (active: ProjectSession, discard: boolean) => {
    const result = await window.desktop.projects.getCanvas({ projectHandle: active.projectHandle });
    if (!result.ok) return null;
    const current = latest.current;
    const merged = discard
      ? result.value.canvas
      : current.base && rebaseCanvas(current.base.canvas, current.canvas, result.value.canvas);
    if (!merged) return null;
    load(result.value);
    updateRevision(active.projectHandle, result.value.revision);
    return merged;
  };

  return {
    load,
    save,
    recover,
    canvasRevision: base?.canvasRevision,
    loaded: base !== null,
    dirty: dirtyKey !== null,
    saving,
    error,
  };
}
