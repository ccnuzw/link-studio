import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";

type Mark = "touched" | "danger";

export function createAgentMarks() {
  const store = createStore(() => new Map<string, Mark>());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    store,
    touch(ids: readonly string[]) {
      const next = new Map(store.getState());
      for (const id of ids) {
        if (next.get(id) !== "danger") next.set(id, "touched");
        clearTimeout(timers.get(id));
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            const current = store.getState();
            if (current.get(id) !== "touched") return;
            const rest = new Map(current);
            rest.delete(id);
            store.setState(rest, true);
          }, 1500),
        );
      }
      store.setState(next, true);
    },
    danger(ids: readonly string[]) {
      const next = new Map(store.getState());
      for (const [id, mark] of next) if (mark === "danger") next.delete(id);
      for (const id of ids) next.set(id, "danger");
      store.setState(next, true);
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      store.setState(new Map(), true);
    },
  };
}

export const AgentMarks = createContext(createAgentMarks());

export function useAgentMark(id: string) {
  return useStore(useContext(AgentMarks).store, (marks) => marks.get(id));
}
