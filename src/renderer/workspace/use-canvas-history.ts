import type { ProjectCanvasView } from "@link-studio/core";
import { useEffect, useRef, useState } from "react";
import { canvasDiff } from "./canvas-model";

const LIMIT = 50;

export function useCanvasHistory(
  canvas: ProjectCanvasView,
  apply: (canvas: ProjectCanvasView) => void,
  dragging: boolean,
  mergeKey: string | null,
) {
  const last = useRef(canvas);
  const merge = useRef<{ key: string; at: number } | null>(null);
  const [undo, setUndo] = useState<ProjectCanvasView[]>([]);
  const [redo, setRedo] = useState<ProjectCanvasView[]>([]);
  useEffect(() => {
    if (dragging) return;
    const previous = last.current;
    const changes = canvasDiff(previous, canvas).filter(({ type }) => type !== "setViewport");
    last.current = canvas;
    if (!changes.length) return;
    const [change] = changes;
    const key =
      changes.length === 1 &&
      change?.type === "putNode" &&
      mergeKey?.startsWith(`${change.node.id}/`)
        ? mergeKey
        : null;
    const now = performance.now();
    if (!key || merge.current?.key !== key || now - merge.current.at > 900) {
      setUndo((stack) => [...stack.slice(1 - LIMIT), previous]);
    }
    merge.current = key ? { key, at: now } : null;
    setRedo([]);
  }, [canvas, dragging, mergeKey]);

  const restore = (direction: "undo" | "redo") => {
    const stack = direction === "undo" ? undo : redo;
    const next = stack.at(-1);
    if (!next || dragging) return;
    if (direction === "undo") {
      setUndo(stack.slice(0, -1));
      setRedo((current) => [...current.slice(1 - LIMIT), canvas]);
    } else {
      setRedo(stack.slice(0, -1));
      setUndo((current) => [...current.slice(1 - LIMIT), canvas]);
    }
    last.current = { ...next, viewport: canvas.viewport };
    merge.current = null;
    apply(last.current);
  };

  return {
    canUndo: undo.length > 0 && !dragging,
    canRedo: redo.length > 0 && !dragging,
    restore,
    reset(next: ProjectCanvasView) {
      last.current = next;
      merge.current = null;
      setUndo([]);
      setRedo([]);
    },
  };
}
