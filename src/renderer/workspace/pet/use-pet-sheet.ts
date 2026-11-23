import { useEffect, useState } from "react";
import sheet from "./spritesheet.webp";

type SheetState = "loading" | "failed" | "ready";
let settled: SheetState = "loading";
let inflight: Promise<SheetState> | undefined;

function loadSheet() {
  if (!inflight) {
    const image = new Image();
    image.src = sheet;
    inflight = image.decode().then(
      () => (settled = "ready"),
      () => (settled = "failed"),
    );
  }
  return inflight;
}

export function usePetSheet(enabled: boolean) {
  const [state, setState] = useState(settled);
  useEffect(() => {
    if (!enabled) return;
    setState(settled);
    if (settled !== "loading") return;
    let mounted = true;
    const timer = window.setTimeout(() => setState("failed"), 4000);
    void loadSheet().then((result) => {
      window.clearTimeout(timer);
      if (mounted) setState(result);
    });
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);
  return { sheet, status: enabled ? state : "off" };
}
