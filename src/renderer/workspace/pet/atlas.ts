import type { PetRow } from "./rows";

export const PET_SPRITE_CLASS = "pet-sprite";

const fmt = (n: number) => String(Math.round(n * 10000) / 10000);
const px = (n: number) => (n === 0 ? "0px" : `${-n}px`);

export function buildKeyframes(
  rows: readonly PetRow[],
  cell: { width: number; height: number },
  opts: { selector?: string } = {},
): string {
  const sel = opts.selector ?? `.${PET_SPRITE_CLASS}`;
  const out: string[] = [
    `${sel}{animation-timing-function:step-end;animation-iteration-count:infinite}`,
  ];

  for (const r of rows) {
    const y = r.row * cell.height;
    const total = r.durations.reduce((a, b) => a + b, 0);
    let acc = 0;
    const frames = r.durations.map((d, i) => {
      const at = `${fmt((acc / total) * 100)}%`;
      acc += d;
      return `${at}{background-position:${px(i * cell.width)} ${px(y)}}`;
    });
    frames.push(`100%{background-position:${px((r.frames - 1) * cell.width)} ${px(y)}}`);
    out.push(`@keyframes pet-row-${r.row}{${frames.join("")}}`);
  }
  for (const r of rows) {
    const total = r.durations.reduce((a, b) => a + b, 0);
    out.push(
      `${sel}[data-row="${r.row}"]{animation-name:pet-row-${r.row};animation-duration:${total}ms}`,
    );
  }

  out.push(`${sel}[data-loop="false"]{animation-iteration-count:1;animation-fill-mode:forwards}`);
  out.push(`${sel}[data-paused="true"]{animation-play-state:paused}`);
  out.push(
    `@media (prefers-reduced-motion:reduce){${sel}[data-row]{animation:none}${rows
      .map((r) => `${sel}[data-row="${r.row}"]{background-position:0px ${px(r.row * cell.height)}}`)
      .join("")}}`,
  );
  return out.join("\n") + "\n";
}
