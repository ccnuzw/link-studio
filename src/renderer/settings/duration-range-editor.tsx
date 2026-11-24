import type { ModelConfig } from "@link-studio/core";

type Duration = NonNullable<NonNullable<ModelConfig["params"]>["duration"]>;
type Range = NonNullable<Duration["range"]>;

export function DurationRangeEditor({
  range,
  preferred,
  change,
}: {
  range: Range;
  preferred: string;
  change: (values: string[], preferred: string, fields: { range: Range }) => void;
}) {
  function update(next: Range, value: string) {
    const values: string[] = [];
    if (next.min >= 1 && next.max <= 30 && next.step >= 1) {
      for (let seconds = next.min; seconds <= next.max; seconds += next.step)
        values.push(String(seconds));
    }
    change(values, value, { range: next });
  }
  const progress =
    range.max > range.min ? (Number(preferred) - range.min) / (range.max - range.min) : 0;
  return (
    <div className="duration-range-editor">
      <div className="duration-range-fields">
        {(
          [
            ["最小", "min"],
            ["最大", "max"],
            ["默认", "default"],
            ["步长", "step"],
          ] as const
        ).map(([label, key]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={1}
              max={30}
              step={1}
              aria-label={`${range.label || "时长"}${label}`}
              data-field={key === "min" ? "durationRange" : undefined}
              value={key === "default" ? preferred : range[key] || ""}
              onChange={({ target }) =>
                key === "default"
                  ? update(range, target.value)
                  : update({ ...range, [key]: Number(target.value) }, preferred)
              }
            />
          </label>
        ))}
        <label>
          单位
          <input
            maxLength={32}
            aria-label={`${range.label || "时长"}单位`}
            value={range.unit ?? ""}
            onChange={({ target }) =>
              update({ ...range, unit: target.value || undefined }, preferred)
            }
          />
        </label>
      </div>
      <div className="model-number-meter" aria-hidden="true">
        <span style={{ width: `${100 * Math.min(1, Math.max(0, progress))}%` }} />
      </div>
      <small>
        最短 {range.min || "?"}
        <span>最长 {range.max || "?"}</span>
      </small>
    </div>
  );
}
