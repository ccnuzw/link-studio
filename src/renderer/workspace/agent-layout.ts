import { type AgentLayout, defaultAgentLayout } from "@link-studio/core";
import { useSyncExternalStore } from "react";

let snapshot = defaultAgentLayout;
let loaded = false;
let syncing = false;
let pending: Partial<AgentLayout> = {};
const listeners = new Set<() => void>();
const read = () => snapshot;

function publish(next: AgentLayout) {
  snapshot = next;
  listeners.forEach((notify) => notify());
}

async function sync() {
  if (syncing) return;
  syncing = true;
  let patch = {};
  try {
    while (!loaded || Object.keys(pending).length) {
      patch = pending;
      pending = {};
      const result = await window.desktop.settings.agentLayout(patch);
      if (!result.ok) throw new Error(result.code);
      loaded = true;
      publish({ ...result.value, ...pending });
    }
  } catch (error) {
    pending = { ...patch, ...pending };
    console.error("小灵布局偏好未同步", error);
  } finally {
    syncing = false;
  }
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  void sync();
  return () => {
    listeners.delete(notify);
  };
}

export const useAgentLayout = () => useSyncExternalStore(subscribe, read);
export function saveAgentLayout(patch: Partial<AgentLayout>) {
  pending = { ...pending, ...patch };
  publish({ ...snapshot, ...patch });
  void sync();
}
