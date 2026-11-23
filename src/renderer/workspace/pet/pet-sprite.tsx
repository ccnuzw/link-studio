import { PET_CELL } from "./rows";

export function PetSprite({
  size,
  row,
  loop,
  paused,
  sheet,
  onEnd,
}: {
  size: number;
  row: number;
  loop: boolean;
  paused: boolean;
  sheet: string;
  onEnd?: () => void;
}) {
  return (
    <span
      aria-hidden="true"
      className="pet-sprite-frame"
      style={{ width: size, height: Math.round((size * PET_CELL.height) / PET_CELL.width) }}
    >
      <span
        className="pet-sprite"
        data-row={row}
        data-loop={loop ? undefined : "false"}
        data-paused={paused ? "true" : undefined}
        onAnimationEnd={onEnd}
        style={{ backgroundImage: `url("${sheet}")`, transform: `scale(${size / PET_CELL.width})` }}
      />
    </span>
  );
}
