import type { ProjectAsset } from "@link-studio/core";
import { type RefObject, useEffect, useRef } from "react";
import { type CanvasFragment, detachExternalNodes, mapFragmentMedia } from "./selection-actions";

type Point = { x: number; y: number };
type CopiedSelection = {
  fragment: CanvasFragment;
  offset: number;
  handle: string;
  projectId: string;
  grant?: Promise<string | undefined>;
};
let copied: CopiedSelection | undefined;
let clipboardText = "";

export function CanvasShortcuts({
  surface,
  handle,
  projectId,
  receiveAssets,
  reportError,
  capture,
  paste,
  duplicate,
  group,
  renameGroup,
  deselectNodes,
  ungroup,
  history,
  save,
  toggleAssistant,
  changeView,
  selectTool,
  openGuide,
}: {
  surface: RefObject<HTMLElement | null>;
  handle: string;
  projectId: string;
  receiveAssets: (assets: ProjectAsset[], revision: number) => void;
  reportError: (message: string) => void;
  capture: () => CanvasFragment | undefined;
  paste: (fragment: CanvasFragment | string | File[], point?: Point, offset?: number) => void;
  duplicate: () => void;
  group: () => void;
  renameGroup: () => boolean;
  deselectNodes: () => void;
  ungroup: () => void;
  history: (direction: "undo" | "redo") => void;
  save: () => void;
  toggleAssistant: () => void;
  changeView: (action: "in" | "out" | "fit" | "reset") => void;
  selectTool: (hand: boolean) => void;
  openGuide: () => void;
}) {
  const callbacks = useRef({ paste, receiveAssets, reportError });
  callbacks.current = { paste, receiveAssets, reportError };
  const active = useRef(false),
    queue = useRef(Promise.resolve());
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const pendingCopy = useRef<{ text: string } | null>(null);
  const pointer = useRef<Point | undefined>(undefined);
  useEffect(() => {
    const available = (target: EventTarget | null) => {
      if (
        !(target instanceof Element) ||
        document.querySelector("dialog[open],.storyboard-dialog[role=dialog]")
      )
        return false;
      if (
        (target instanceof HTMLElement && target.isContentEditable) ||
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
      if (!pendingCopy.current || !event.clipboardData || event.defaultPrevented) return;
      clipboardText = pendingCopy.current.text;
      event.clipboardData.setData("text/plain", clipboardText);
      pendingCopy.current = null;
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (event.defaultPrevented || !available(event.target) || !data) return;
      const raw = data.getData("text/plain").replace(/\r\n?/g, "\n");
      const text = raw.trim() ? raw : "";
      if (data.files.length && !(text && data.types.includes("text/html")))
        paste(Array.from(data.files), pointer.current);
      else if (copied && (!text || clipboardText === text)) {
        const selection = copied,
          point = pointer.current,
          offset = selection.offset;
        if (!point) selection.offset += 48;
        const source =
          selection.projectId === projectId
            ? selection.fragment
            : detachExternalNodes(selection.fragment);
        if (selection.handle === handle || !selection.grant) paste(source, point, offset);
        else
          queue.current = queue.current
            .then(async () => {
              const grant = await selection.grant;
              if (!active.current) return;
              if (!grant) throw Error("选区中的源素材不可用");
              const result = await window.desktop.projects.pasteCanvasClipboard({
                projectHandle: handle,
                token: grant,
              });
              if (!active.current) return;
              if (!result.ok) throw Error("无法复制选区中的素材，请检查源文件后重试");
              const { ids, assets, revision } = result.value;
              const fragment = mapFragmentMedia(source, (id) => {
                if (!ids[id]) throw Error("选区中的素材引用不完整");
                return ids[id];
              });
              callbacks.current.receiveAssets(assets, revision);
              callbacks.current.paste(fragment, point, offset);
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            })
            .catch((error) => {
              if (active.current) callbacks.current.reportError(error.message);
            });
      } else if (text) paste(text, pointer.current);
      else return;
      event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;
      if (mod && key === "d" && available(event.target)) {
        event.preventDefault();
        duplicate();
        return;
      }
      if (event.repeat || event.altKey) return;
      if (
        mod &&
        key === "s" &&
        !event.shiftKey &&
        event.target instanceof Element &&
        (surface.current?.contains(event.target) || event.target === document.body)
      ) {
        event.preventDefault();
        save();
        return;
      }
      if (
        mod &&
        key === "/" &&
        !event.shiftKey &&
        !document.querySelector("dialog[open],[aria-modal=true]:not([hidden])")
      ) {
        event.preventDefault();
        toggleAssistant();
        return;
      }
      if (!available(event.target)) return;
      if (mod && key === "c") {
        const fragment = capture();
        if (!fragment) return;
        const assetIds = new Set<string>();
        mapFragmentMedia(fragment, (id) => {
          assetIds.add(id);
          return id;
        });
        const grant = window.desktop.projects
          .captureCanvasClipboard({ projectHandle: handle, assetIds: [...assetIds] })
          .then(
            (result) => (result.ok ? result.value.token : undefined),
            () => undefined,
          );
        copied = {
          fragment: structuredClone(fragment),
          offset: 48,
          handle,
          projectId,
          grant: assetIds.size ? grant : undefined,
        };
        const pending = {
          text: fragment.nodes
            .flatMap((node) =>
              node.type === "group"
                ? []
                : [
                    node.data.kind === "script" && node.data.text
                      ? node.data.text
                      : node.data.label,
                  ],
            )
            .join("\n"),
        };
        pendingCopy.current = pending;
        window.setTimeout(() => {
          if (pendingCopy.current === pending) pendingCopy.current = null;
        }, 0);
        return;
      }
      if (
        key === "enter" &&
        event.target instanceof Element &&
        event.target.closest("button,[role=button],a[href],summary")
      )
        return;
      if (
        key === "escape" &&
        document.querySelector("[role=menu]:not([hidden]),[aria-haspopup=menu][aria-expanded=true]")
      )
        return;
      if (!mod) {
        if ((key === "enter" || key === "f2") && renameGroup()) event.stopPropagation();
        else if (key === "enter") {
          const prompt = surface.current?.querySelector<HTMLElement>(
            '[data-node-prompt][contenteditable="true"]',
          );
          if (!prompt || !prompt.getClientRects().length) return;
          prompt.focus();
          const selection = window.getSelection();
          selection?.selectAllChildren(prompt);
          selection?.collapseToEnd();
        } else if (key === "escape") deselectNodes();
        else if (key === "v" || key === "h") selectTool(key === "h");
        else if (event.shiftKey && event.code === "Digit1") changeView("fit");
        else if (event.shiftKey && event.code === "Digit0") changeView("reset");
        else if (key === "?") openGuide();
        else return;
      } else if (key === "z" || key === "y")
        history(key === "y" || event.shiftKey ? "redo" : "undo");
      else if (key === "g") (event.shiftKey ? ungroup : group)();
      else if (key === "=" || key === "+") changeView("in");
      else if (key === "-") changeView("out");
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
  }, [
    handle,
    projectId,
    capture,
    duplicate,
    group,
    renameGroup,
    deselectNodes,
    history,
    paste,
    save,
    surface,
    toggleAssistant,
    ungroup,
    changeView,
    selectTool,
    openGuide,
  ]);
  return null;
}
