import { useSyncExternalStore } from "react";

const compact = () => matchMedia("(max-width: 767px)");
function subscribe(change: () => void) {
  const query = compact();
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

export const useCompactLayout = () => useSyncExternalStore(subscribe, () => compact().matches);
