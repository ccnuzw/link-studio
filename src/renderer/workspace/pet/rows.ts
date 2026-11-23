export const PET_COLS = 8;

export const PET_CELL = { width: 192, height: 208 } as const;

export type PetRowName =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review"
  | "sleeping";

export type PetRow = {
  name: PetRowName;
  row: number;
  frames: number;
  durations: readonly number[];
};

const evenThenLast = (frames: number, each: number, last: number): number[] => [
  ...Array.from({ length: frames - 1 }, () => each),
  last,
];

const ROW_DEFS: ReadonlyArray<readonly [PetRowName, readonly number[]]> = [
  ["idle", [280, 110, 110, 140, 140, 320]],
  ["running-right", evenThenLast(8, 120, 220)],
  ["running-left", evenThenLast(8, 120, 220)],
  ["waving", evenThenLast(4, 140, 280)],
  ["jumping", evenThenLast(5, 140, 280)],
  ["failed", evenThenLast(8, 140, 240)],
  ["waiting", evenThenLast(6, 150, 260)],
  ["running", evenThenLast(6, 120, 220)],
  ["review", evenThenLast(6, 150, 280)],
  ["sleeping", evenThenLast(6, 220, 400)],
];

export const PET_ROWS: readonly PetRow[] = ROW_DEFS.map(([name, durations], row) => ({
  name,
  row,
  frames: durations.length,
  durations,
}));

export const PET_ROW = Object.fromEntries(PET_ROWS.map((r) => [r.name, r.row])) as Record<
  PetRowName,
  number
>;
