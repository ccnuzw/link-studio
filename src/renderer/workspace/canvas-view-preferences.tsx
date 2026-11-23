import { type CanvasViewPreferences, defaultCanvasView } from "@link-studio/core";
import { Background, BackgroundVariant, useStore } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";

const patterns = {
  dots: BackgroundVariant.Dots,
  lines: BackgroundVariant.Lines,
  cross: BackgroundVariant.Cross,
};
export type ViewPreferences = CanvasViewPreferences;

export function useCanvasViewPreferences() {
  const [preferences, setPreferences] = useState(defaultCanvasView);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const change = useCallback((patch: Partial<ViewPreferences>) => {
    const version = ++sequence.current;
    setPreferences((current) => ({ ...current, ...patch }));
    void window.desktop.settings
      .canvasView(patch)
      .then((result) => {
        if (version !== sequence.current) return;
        setFailed(!result.ok);
        if (result.ok) setPreferences(result.value);
      })
      .catch(() => {
        if (version === sequence.current) setFailed(true);
      });
  }, []);
  useEffect(() => {
    change({});
  }, [change]);
  return [preferences, change, failed] as const;
}

export function CanvasBackgroundLayer({ background }: Pick<ViewPreferences, "background">) {
  const dotSize = useStore((state) => (state.transform[2] < 0.5 ? null : 2 / state.transform[2]));
  if (background === "none" || (background === "dots" && dotSize === null)) return null;
  return (
    <Background
      variant={patterns[background]}
      gap={20}
      size={background === "dots" ? (dotSize ?? undefined) : undefined}
    />
  );
}
