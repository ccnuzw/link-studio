import { PET_ROW, PET_ROWS } from "./rows";

export type PetMode = "lively" | "quiet" | "hidden";

export type PetReactionKind = "celebrate" | "failed";
export type PetReaction = {
  kind: PetReactionKind;
  until: number;
};

export const IDLE_SLEEP_MS = 10 * 60 * 1000;
export const GREET_COOLDOWN_MS = 10_000;
export const REACTION_HOLD_MS = 600;

export type PetMoodInput = {
  dragging: boolean;
  dragDir: "left" | "right" | null;
  reaction: PetReaction | null;
  now: number;
  pending: boolean;
  busy: boolean;
  runningTasks: number;
  available: boolean | null;
  idleMs: number;
  hovering: boolean;
  mode: PetMode;
  reducedMotion: boolean;
  hasSleeping: boolean;
};

export type PetMoodResult = {
  row: number;
  loop: boolean;
  sleepFallback: boolean;
};

export function petMood(s: PetMoodInput): PetMoodResult {
  const out = (row: number, loop: boolean, sleepFallback = false): PetMoodResult => ({
    row,
    loop: loop && !s.reducedMotion,
    sleepFallback,
  });

  if (s.dragging) {
    if (s.dragDir === "left") return out(PET_ROW["running-left"], true);
    if (s.dragDir === "right") return out(PET_ROW["running-right"], true);
    return out(PET_ROW.idle, true);
  }
  if (s.reaction && s.now < s.reaction.until) {
    return out(s.reaction.kind === "celebrate" ? PET_ROW.jumping : PET_ROW.failed, false);
  }
  if (s.pending) return out(PET_ROW.waiting, true);
  if (s.busy) return out(PET_ROW.running, true);
  if (s.runningTasks > 0) return out(PET_ROW.review, true);
  if (s.available === false || (s.mode === "lively" && s.idleMs >= IDLE_SLEEP_MS)) {
    return s.hasSleeping ? out(PET_ROW.sleeping, true) : out(PET_ROW.idle, false, true);
  }
  if (s.hovering && s.mode === "lively") return out(PET_ROW.waving, false);
  return out(PET_ROW.idle, true);
}

export function reactionSpan(kind: PetReactionKind): number {
  const name = kind === "celebrate" ? "jumping" : "failed";
  const row = PET_ROWS.find((r) => r.name === name)!;
  return row.durations.reduce((a, b) => a + b, 0) + REACTION_HOLD_MS;
}

export function nextReaction(
  current: PetReaction | null,
  kind: PetReactionKind,
  now: number,
): PetReaction {
  if (current && current.kind === kind && now < current.until) return current;
  return { kind, until: now + reactionSpan(kind) };
}

export const canGreet = (lastGreetAt: number | null, now: number): boolean =>
  lastGreetAt === null || now - lastGreetAt >= GREET_COOLDOWN_MS;
