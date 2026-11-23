export type ThumbState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed" };

export type ThumbCache = {
  get: (key: string) => ThumbState;

  request: (key: string) => Promise<string | null>;

  subscribe: (listener: () => void) => () => void;

  clear: () => void;
};

const IDLE: ThumbState = { status: "idle" };
const LOADING: ThumbState = { status: "loading" };
const FAILED: ThumbState = { status: "failed" };

export function createThumbCache(render: (key: string) => Promise<string | null>): ThumbCache {
  const states = new Map<string, ThumbState>();
  const inflight = new Map<string, Promise<string | null>>();
  const listeners = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();

  const notify = () => listeners.forEach((listener) => listener());
  const set = (key: string, state: ThumbState) => {
    states.set(key, state);
    notify();
  };

  return {
    get: (key) => states.get(key) ?? IDLE,
    request: (key) => {
      const known = states.get(key);
      if (known?.status === "ready") return Promise.resolve(known.url);
      const running = inflight.get(key);
      if (running) return running;
      set(key, LOADING);
      const task = queue.then(async () => {
        try {
          const url = await render(key);
          set(key, url ? { status: "ready", url } : FAILED);
          return url;
        } catch {
          set(key, FAILED);
          return null;
        } finally {
          inflight.delete(key);
        }
      });
      inflight.set(key, task);
      queue = task;
      return task;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    clear: () => {
      states.clear();
      notify();
    },
  };
}
