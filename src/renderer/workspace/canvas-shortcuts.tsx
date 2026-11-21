import { type RefObject, useEffect, useRef } from "react";
import type { CanvasFragment } from "./selection-actions";

type Point = { x: number; y: number };
const clipboardType = "application/x-link-studio-canvas-selection";

export function CanvasShortcuts({
  surface,
  capture,
  paste,
  duplicate,
  group,
  ungroup,
  history,
  save,
}: {
  surface: RefObject<HTMLElement | null>;
  capture: () => CanvasFragment | undefined;
  paste: (fragment: CanvasFragment | string, point?: Point) => void;
  duplicate: () => void;
  group: () => void;
  ungroup: () => void;
  history: (direction: "undo" | "redo") => void;
  save: () => void;
}) {
  const copied = useRef<{ token: string; fragment: CanvasFragment } | null>(null);
  const pointer = useRef<Point | undefined>(undefined);
  useEffect(() => {
    const available = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement) || document.querySelector("dialog[open]")) return false;
      if (
        target.isContentEditable ||
        target.closest("input,textarea,select,[role=dialog],[role=menu],[role=listbox]")
      )
        return false;
      return target === document.body || Boolean(surface.current?.contains(target));
    };
    const trackPointer = (event: PointerEvent) => {
      pointer.current =
        event.target instanceof Element &&
        event.target.closest(".react-flow__pane,.react-flow__node") &&
        surface.current?.contains(event.target)
          ? { x: event.clientX, y: event.clientY }
          : undefined;
    };
    const copy = (event: ClipboardEvent) => {
      if (
        event.defaultPrevented ||
        !available(event.target) ||
        !event.clipboardData ||
        window.getSelection()?.toString()
      )
        return;
      const fragment = capture();
      if (!fragment) return;
      const token = crypto.randomUUID();
      const text = fragment.nodes
        .map((node) =>
          node.type === "creative" && node.data.kind === "script" && node.data.text
            ? node.data.text
            : node.data.label,
        )
        .join("\n");
      event.clipboardData.setData("text/plain", text);
      event.clipboardData.setData(clipboardType, token);
      copied.current = { token, fragment };
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (event.defaultPrevented || !available(event.target) || !data || data.files.length) return;
      const token = data.getData(clipboardType);
      const text = data.getData("text/plain").replace(/\r\n?/g, "\n");
      if (copied.current && token === copied.current.token)
        paste(copied.current.fragment, pointer.current);
      else if (text.trim()) paste(text, pointer.current);
      else return;
      event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        !available(event.target)
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") history(key === "y" || event.shiftKey ? "redo" : "undo");
      else if (key === "d" && !event.shiftKey) duplicate();
      else if (key === "g") (event.shiftKey ? ungroup : group)();
      else if (key === "s" && !event.shiftKey) save();
      else return;
      event.preventDefault();
    };
    window.addEventListener("pointermove", trackPointer);
    window.addEventListener("copy", copy);
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", trackPointer);
      window.removeEventListener("copy", copy);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [capture, duplicate, group, history, paste, save, surface, ungroup]);
  return null;
}
