import type { PetMode } from "./mood";

export const MERGE_WINDOW_MS = 2000;
export const MAX_QUEUE = 5;
export const EASTER_COOLDOWN_MS = 30 * 60 * 1000;

export type BubblePriority = "approval" | "error" | "result" | "system" | "easter";
export const PRIORITY_RANK: Record<BubblePriority, number> = {
  approval: 4,
  error: 3,
  result: 2,
  system: 1,
  easter: 0,
};

export type BubbleSource = "assistant" | "result" | "system" | "easter";

export type BubbleMood = "idle" | "waving" | "jumping" | "failed" | "waiting" | "sleeping";

export type BubbleAction = { label: string; onClick: () => void };

export type BubbleInput = {
  id: string;
  key?: string;
  nodeIds?: string[];
  source: BubbleSource;
  priority: BubblePriority;
  text: string;
  mood: BubbleMood;
  ttl: number | null;
  action?: BubbleAction;
  onClick?: () => void;
};

export type Bubble = BubbleInput & {
  count: number;
  createdAt: number;
  updatedAt: number;
  version: number;
};

export type BubbleContext = {
  mode: PetMode;
  dragging: boolean;
  panelOpen: boolean;
  assistantBusy: boolean;
  assistantPending: boolean;
  pageVisible: boolean;
};

export type BubbleQueueState = {
  current: Bubble | null;
  queue: Bubble[];
  lastEasterAt: number | null;
  ctx: BubbleContext;
};

export type BubbleQueueAction =
  | { type: "push"; bubble: BubbleInput; now: number }
  | { type: "dismiss"; id?: string; now: number }
  | { type: "context"; patch: Partial<BubbleContext>; now: number }
  | { type: "clear" };

export const initialBubbleQueue = (): BubbleQueueState => ({
  current: null,
  queue: [],
  lastEasterAt: null,
  ctx: {
    mode: "lively",
    dragging: false,
    panelOpen: false,
    assistantBusy: false,
    assistantPending: false,
    pageVisible: true,
  },
});

export const bubbleText = (b: Bubble): string => b.text.replaceAll("{n}", String(b.count));

const rank = (b: Bubble) => PRIORITY_RANK[b.priority];
const isEaster = (b: Bubble | BubbleInput) => b.source === "easter";

const easterBlocked = (c: BubbleContext) =>
  c.mode !== "lively" || c.dragging || c.panelOpen || c.assistantBusy || c.assistantPending;

function nextIndex(queue: readonly Bubble[]): number {
  let best = -1;
  queue.forEach((b, i) => {
    if (best < 0 || rank(b) > rank(queue[best]!)) best = i;
  });
  return best;
}

function promote(state: BubbleQueueState): BubbleQueueState {
  if (state.current || state.ctx.dragging) return state;
  const { ctx } = state;
  const queue = state.queue.filter(
    (b) => !(isEaster(b) && easterBlocked(ctx)) && !(b.source === "assistant" && ctx.panelOpen),
  );
  const i = nextIndex(queue);
  if (i < 0) return { ...state, queue };
  return { ...state, current: queue[i]!, queue: queue.filter((_, j) => j !== i) };
}

function capQueue(queue: Bubble[]): Bubble[] {
  const next = [...queue];
  while (next.length > MAX_QUEUE) {
    let drop = 0;
    next.forEach((b, i) => {
      const d = next[drop]!;
      if (rank(b) < rank(d) || (rank(b) === rank(d) && b.createdAt < d.createdAt)) drop = i;
    });
    next.splice(drop, 1);
  }
  return next;
}

function putBack(state: BubbleQueueState): BubbleQueueState {
  const { current } = state;
  if (!current) return state;
  return {
    ...state,
    current: null,
    queue: isEaster(current) ? state.queue : [current, ...state.queue],
  };
}

function removeWhere(state: BubbleQueueState, test: (b: Bubble) => boolean): BubbleQueueState {
  return {
    ...state,
    current: state.current && test(state.current) ? null : state.current,
    queue: state.queue.filter((b) => !test(b)),
  };
}

function keepTop(state: BubbleQueueState): BubbleQueueState {
  const all = state.current ? [state.current, ...state.queue] : state.queue;
  const best = all[nextIndex(all)];
  if (!best) return state;
  if (state.ctx.dragging) return { ...state, current: null, queue: [best] };
  return { ...state, current: best, queue: [] };
}

function updateMatching(
  state: BubbleQueueState,
  match: (b: Bubble) => boolean,
  update: (b: Bubble) => Bubble,
): BubbleQueueState | null {
  if (state.current && match(state.current)) return { ...state, current: update(state.current) };
  const i = state.queue.findIndex(match);
  if (i < 0) return null;
  return { ...state, queue: state.queue.map((b, j) => (j === i ? update(b) : b)) };
}

function push(state: BubbleQueueState, input: BubbleInput, now: number): BubbleQueueState {
  const { ctx } = state;

  if (ctx.panelOpen) return state;
  if (isEaster(input)) {
    if (easterBlocked(ctx)) return state;
    if (state.lastEasterAt !== null && now - state.lastEasterAt < EASTER_COOLDOWN_MS) return state;
  }

  const byId = updateMatching(
    state,
    (b) => b.id === input.id,
    (old) => ({
      ...input,
      count: old.count,
      createdAt: old.createdAt,
      updatedAt: now,
      version: old.version + 1,
    }),
  );
  if (byId) return byId;

  if (input.key !== undefined) {
    const merged = updateMatching(
      state,
      (b) => b.key === input.key && now - b.updatedAt <= MERGE_WINDOW_MS,
      (old) => ({
        ...old,
        ...(input.nodeIds && { nodeIds: [...new Set([...(old.nodeIds ?? []), ...input.nodeIds])] }),
        count: old.count + 1,
        updatedAt: now,
        version: old.version + 1,
      }),
    );
    if (merged) return merged;
  }

  const bubble: Bubble = { ...input, count: 1, createdAt: now, updatedAt: now, version: 1 };
  const lastEasterAt = isEaster(bubble) ? now : state.lastEasterAt;
  const base = { ...state, lastEasterAt };

  if (!base.current && !ctx.dragging) return { ...base, current: bubble };
  if (base.current && rank(bubble) > rank(base.current)) {
    const yielded = putBack(base);
    return { ...yielded, current: bubble, queue: capQueue(yielded.queue) };
  }
  return { ...base, queue: capQueue([...base.queue, bubble]) };
}

export function bubbleQueue(state: BubbleQueueState, action: BubbleQueueAction): BubbleQueueState {
  switch (action.type) {
    case "push":
      return promote(push(state, action.bubble, action.now));

    case "dismiss": {
      if (action.id === undefined || action.id === state.current?.id) {
        return promote({ ...state, current: null });
      }
      const id = action.id;
      return { ...state, queue: state.queue.filter((b) => b.id !== id) };
    }

    case "context": {
      const prev = state.ctx;
      let next: BubbleQueueState = { ...state, ctx: { ...prev, ...action.patch } };
      const { ctx } = next;

      if (ctx.panelOpen) next = { ...next, current: null, queue: [] };
      if (easterBlocked(ctx)) next = removeWhere(next, isEaster);
      if (ctx.dragging && !prev.dragging) next = putBack(next);
      if (ctx.pageVisible && !prev.pageVisible) next = keepTop(next);
      return promote(next);
    }

    case "clear":
      return { ...state, current: null, queue: [] };
  }
}
