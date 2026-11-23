import { type RefObject, useEffect, useState } from "react";

export function useTemporaryHand(area: RefObject<HTMLElement | null>, enabled: boolean) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    let pointerDown = false,
      releaseAfterDrag = false;
    const reset = () => {
      pointerDown = false;
      releaseAfterDrag = false;
      setHeld(false);
    };
    const press = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.isComposing ||
        event.defaultPrevented ||
        !(event.target instanceof Element)
      )
        return;
      const panPortal = event.target.closest("[data-canvas-space-pan]");
      if (!panPortal && event.target !== document.body && !area.current?.contains(event.target))
        return;
      if (
        event.target.closest("input,textarea,select,[contenteditable=true]") ||
        document.querySelector("[aria-modal=true]:not([hidden])")
      )
        return;
      if (!panPortal && event.target.closest("[role=dialog],[role=menu]")) return;
      event.preventDefault();
      if (!event.repeat) {
        releaseAfterDrag = false;
        setHeld(true);
      }
    };
    const release = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        if (pointerDown) releaseAfterDrag = true;
        else reset();
      }
    };
    const down = () => {
      pointerDown = true;
    };
    const up = () => {
      pointerDown = false;
      if (releaseAfterDrag) reset();
    };
    window.addEventListener("keydown", press);
    window.addEventListener("keyup", release);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", press);
      window.removeEventListener("keyup", release);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", reset);
      window.removeEventListener("blur", reset);
    };
  }, [area, enabled]);
  return enabled && held;
}
