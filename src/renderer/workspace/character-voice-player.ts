import { useSyncExternalStore } from "react";

let player: HTMLAudioElement | undefined;
let current: { handle: string; id: string } | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function stopCharacterVoice(handle?: string) {
  if (!current || (handle && current.handle !== handle)) return;
  current = undefined;
  if (player) {
    player.onended = player.onerror = null;
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
  notify();
}

export function useCharacterVoice(handle?: string, id?: string) {
  const playing = useSyncExternalStore(
    subscribe,
    () => !!id && current?.handle === handle && current?.id === id,
  );
  const toggle = async () => {
    if (!handle || !id) return;
    if (current?.handle === handle && current.id === id) return stopCharacterVoice();
    stopCharacterVoice();
    const request = { handle, id };
    current = request;
    notify();
    const finish = () => {
      if (current === request) stopCharacterVoice();
    };
    try {
      const result = await window.desktop.projects.getAssetPreview({
        projectHandle: handle,
        assetId: id,
      });
      if (current !== request) return;
      if (!result.ok) return finish();
      player ??= new Audio();
      player.src = result.value.url;
      player.onended = player.onerror = finish;
      await player.play();
    } catch {
      finish();
    }
  };
  return { playing, toggle };
}
