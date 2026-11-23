import type { DramaImageParams, dramaImageFields } from "@link-studio/core";
import type { RefObject } from "react";
import { ChoiceButton } from "../choice-button";
import { FieldMenu } from "./drama-start-style";

type Picks = NonNullable<DramaImageParams["prop"]>;

function RatioIcon({ ratio }: { ratio: string }) {
  const [horizontal = 0, vertical = 0] = ratio.split(":").map(Number);
  if (!(horizontal > 0 && vertical > 0))
    return (
      <svg aria-hidden width="16" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor">
        <path
          d="M3 7V3h4 M13 3h4v4 M17 13v4h-4 M7 17H3v-4"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  const width = Math.min(30, Math.max(12, (12 * horizontal) / vertical));
  const height = Math.min(22, Math.max(12, (12 * vertical) / horizontal));
  const box = Math.ceil(width) + 2;
  return (
    <svg
      aria-hidden
      width={box}
      height="24"
      viewBox={`0 0 ${box} 24`}
      fill="none"
      stroke="currentColor"
    >
      <rect
        x={(box - width + 1.5) / 2}
        y={(24 - height + 1.5) / 2}
        width={width - 1.5}
        height={height - 1.5}
        rx="1.25"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function DramaStartParams({
  container,
  label,
  fields,
  params,
  onPick,
}: {
  container: RefObject<HTMLDialogElement | null>;
  label: string;
  fields: ReturnType<typeof dramaImageFields>;
  params: Picks;
  onPick: (change: Picks) => void;
}) {
  if (!fields.ratios.length && !fields.resolutions.length) return null;
  return (
    <FieldMenu
      container={container}
      kind="params"
      label={`${label}图片参数`}
      value={[params.aspectRatio, params.resolution].filter(Boolean).join(" · ")}
      icon={params.aspectRatio && <RatioIcon ratio={params.aspectRatio} />}
    >
      {() =>
        (
          [
            ["aspectRatio", fields.ratioLabel ?? "比例", fields.ratios],
            ["resolution", fields.resolutionLabel ?? "分辨率", fields.resolutions],
          ] as const
        ).map(
          ([key, title, values]) =>
            !!values.length && (
              <div key={key} className="drama-param-row">
                <span>{title}</span>
                {key === "resolution" && values.length > 6 ? (
                  <select
                    aria-label={title}
                    value={params[key] ?? ""}
                    onChange={(event) => onPick({ [key]: event.target.value })}
                  >
                    {!params[key] && <option value="">请选择</option>}
                    {values.map((value) => (
                      <option key={value} value={value}>
                        {value}
                        {fields.resolutionUnit}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div role="radiogroup" aria-label={title} data-param={key}>
                    {values.map((value) => (
                      <ChoiceButton
                        type="button"
                        role="radio"
                        key={value}
                        aria-checked={params[key] === value}
                        onClick={() => onPick({ [key]: value })}
                      >
                        {key === "aspectRatio" && <RatioIcon ratio={value} />}
                        {value}
                        {key === "resolution" && fields.resolutionUnit}
                      </ChoiceButton>
                    ))}
                  </div>
                )}
              </div>
            ),
        )
      }
    </FieldMenu>
  );
}
