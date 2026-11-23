export type FacadePhase = "idle" | "loading" | "playing";

export type FacadeEvent = "play" | "ready" | "error" | "deactivate" | "revoke";

export const MIN_LOADING_MS = 320;

export const LOAD_TIMEOUT_MS = 15_000;

export function nextFacadePhase(phase: FacadePhase, event: FacadeEvent): FacadePhase {
  switch (event) {
    case "play":
      return phase === "idle" ? "loading" : phase;
    case "ready":
      return phase === "loading" ? "playing" : phase;
    case "error":
    case "deactivate":
    case "revoke":
      return "idle";
  }
}

export function remainingLoadingMs(startedAt: number, now: number): number {
  const elapsed = Math.max(0, now - startedAt);
  return Math.max(0, MIN_LOADING_MS - elapsed);
}

export const MAX_MOUNTED_VIDEOS = 4;

export type VideoSlotHandle = {
  isPlaying: () => boolean;

  release: () => void;
};

export type VideoSlotPool = {
  acquire: (id: string, handle: VideoSlotHandle) => void;

  release: (id: string) => void;

  size: () => number;
};

export function createVideoSlotPool(limit: number = MAX_MOUNTED_VIDEOS): VideoSlotPool {
  const slots = new Map<string, VideoSlotHandle>();
  return {
    acquire(id, handle) {
      if (!slots.has(id)) {
        for (const [otherId, other] of [...slots]) {
          if (slots.size < limit) break;
          if (other.isPlaying()) continue;
          slots.delete(otherId);
          other.release();
        }
      }
      slots.set(id, handle);
    },
    release(id) {
      slots.delete(id);
    },
    size: () => slots.size,
  };
}

export function formatMediaDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
