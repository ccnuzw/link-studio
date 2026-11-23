import { createContext, type ReactNode, useEffect, useState } from "react";

export const RefHighlight = createContext<{
  id: string | null;
  set: (id: string | null) => void;
} | null>(null);

export function RefHighlightProvider({ children }: { children: ReactNode }) {
  const [id, set] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    element?.classList.add("ref-hl");
    return () => element?.classList.remove("ref-hl");
  }, [id]);
  return <RefHighlight.Provider value={{ id, set }}>{children}</RefHighlight.Provider>;
}
