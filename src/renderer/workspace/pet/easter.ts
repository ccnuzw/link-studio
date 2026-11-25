import { requirePresent } from "@link-studio/core";
import { EASTER_LINES, type EasterKind } from "./lines";

export type StampStorage = Pick<Storage, "getItem" | "setItem">;

const FIRST_OPEN_KEY = "link-studio-pet-last-open";
const NIGHT_KEY = "link-studio-pet-last-night";

const pad = (n: number) => String(n).padStart(2, "0");

export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const isNightHour = (d: Date): boolean => d.getHours() >= 23 || d.getHours() < 5;

export function nightKey(d: Date): string | null {
  if (!isNightHour(d)) return null;
  if (d.getHours() < 5) return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
  return dayKey(d);
}

export function browserStorage(): StampStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function claim(storage: StampStorage | null, key: string, value: string): boolean {
  if (!storage) return false;
  let stored: string | null;
  try {
    stored = storage.getItem(key);
  } catch {
    return false;
  }
  if (stored === value) return false;
  try {
    storage.setItem(key, value);
  } catch {}
  return true;
}

export const claimFirstOpenToday = (
  now: Date = new Date(),
  storage: StampStorage | null = browserStorage(),
): boolean => claim(storage, FIRST_OPEN_KEY, dayKey(now));

export function claimNightEgg(
  now: Date = new Date(),
  storage: StampStorage | null = browserStorage(),
): boolean {
  const night = nightKey(now);
  return night !== null && claim(storage, NIGHT_KEY, night);
}

export function pickEasterLine(kind: EasterKind, rand: () => number = Math.random): string {
  const lines = EASTER_LINES[kind];
  return requirePresent(
    lines[Math.min(lines.length - 1, Math.floor(rand() * lines.length))],
    "lines[Math.min(lines.length - 1, Math.floor(rand() * lines.length))]",
  );
}
