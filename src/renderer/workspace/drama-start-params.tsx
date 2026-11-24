import type { DramaImageParams, dramaImageFields } from "@link-studio/core";
import type { RefObject } from "react";
import { ChoiceButton } from "../choice-button";
import { FieldMenu } from "./drama-start-style";

import { RatioIcon } from "./ratio-icon";

type Picks = NonNullable<DramaImageParams["prop"]>;

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
