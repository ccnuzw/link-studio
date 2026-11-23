export type FlagStorage = Pick<Storage, "getItem" | "setItem">;

const PREFIX = "director:";

const defaultStorage = (): FlagStorage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

export function readFlag(
  name: string,
  fallback: boolean,
  storage: FlagStorage | undefined = defaultStorage(),
): boolean {
  try {
    const value = storage?.getItem(PREFIX + name);
    return value === null || value === undefined ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

export function writeFlag(
  name: string,
  value: boolean,
  storage: FlagStorage | undefined = defaultStorage(),
) {
  try {
    storage?.setItem(PREFIX + name, value ? "1" : "0");
  } catch {}
}

export function readNumber(
  name: string,
  fallback: number,
  storage: FlagStorage | undefined = defaultStorage(),
): number {
  try {
    const raw = storage?.getItem(PREFIX + name);
    if (raw === null || raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeNumber(
  name: string,
  value: number,
  storage: FlagStorage | undefined = defaultStorage(),
) {
  try {
    storage?.setItem(PREFIX + name, String(value));
  } catch {}
}
