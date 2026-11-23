import { Popover } from "@base-ui/react/popover";
import { dramaStyles } from "@link-studio/core";
import { Check, ChevronDown, Pencil } from "lucide-react";
import { type ReactNode, type RefObject, useState } from "react";

const posters = import.meta.glob<string>("./drama-style-assets/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});
type Container = RefObject<HTMLDialogElement | null>;
function showFieldLayer(element: HTMLDivElement | null) {
  if (element?.isConnected && !element.matches(":popover-open")) element.showPopover();
}

export function FieldMenu({
  container,
  label,
  value,
  kind,
  icon,
  locked,
  title,
  changed,
  children,
}: {
  container: Container;
  label: string;
  value: string;
  kind: string;
  icon?: ReactNode;
  locked?: boolean;
  title?: string;
  changed?: (open: boolean) => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  function toggle(next: boolean) {
    if (next !== open) changed?.(next);
    setOpen(next);
  }
  return (
    <Popover.Root open={open} onOpenChange={toggle}>
      <Popover.Trigger
        type="button"
        className="drama-field-trigger"
        aria-label={label}
        data-unconfirmed={(kind === "source" && value === "请选择") || undefined}
        disabled={locked}
        title={locked ? "剧本按原分集" : title}
      >
        {icon}
        <span>{value}</span>
        <ChevronDown size={16} />
      </Popover.Trigger>
      <Popover.Portal
        container={container}
        className="drama-field-portal"
        popover="manual"
        ref={showFieldLayer}
      >
        <Popover.Positioner
          className="drama-menu-position"
          align="start"
          sideOffset={6}
          positionMethod="absolute"
          collisionBoundary={document.documentElement}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        >
          <Popover.Popup aria-label={label} className="drama-field-menu" data-kind={kind}>
            {children(() => toggle(false))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function DramaStartStyle({
  container,
  genre,
  styleKey,
  custom,
  seconds,
  script,
  lockedUnits,
  onGenre,
  onStyle,
  onCustom,
  onSeconds,
}: {
  container: Container;
  genre: string;
  styleKey: string;
  custom: string;
  seconds: string;
  script: boolean;
  lockedUnits?: number;
  onGenre: (value: string) => void;
  onStyle: (value: string) => void;
  onCustom: (value: string) => void;
  onSeconds: (value: string) => void;
}) {
  const [draft, setDraft] = useState(seconds);
  const [input, setInput] = useState(seconds);
  const valid = (value: string) =>
    Number.isInteger(Number(value)) && Number(value) >= 30 && Number(value) <= 180;
  function pickSeconds(value: string) {
    setInput(value);
    if (valid(value)) setDraft(String(Number(value)));
  }
  return (
    <div className="drama-start-field">
      <span>风格</span>
      <div className="drama-start-chips">
        <FieldMenu
          container={container}
          label="题材"
          kind="genre"
          value={dramaStyles.genres.find((item) => item.key === genre)?.name ?? "题材"}
        >
          {(close) => (
            <>
              <div className="drama-genre-grid">
                {dramaStyles.genres.map((item) => (
                  <button
                    type="button"
                    className="drama-menu-row"
                    key={item.key}
                    aria-pressed={genre === item.key}
                    onClick={() => {
                      onGenre(item.key);
                      close();
                    }}
                  >
                    {item.name}
                    {genre === item.key && <Check size={16} />}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="drama-menu-row"
                onClick={() => {
                  onGenre("");
                  close();
                }}
              >
                不指定
              </button>
            </>
          )}
        </FieldMenu>
        <FieldMenu
          container={container}
          label="画风"
          kind="style"
          value={
            styleKey === "custom"
              ? "自定义画风"
              : (dramaStyles.styles.find((item) => item.key === styleKey)?.name ?? "画风")
          }
        >
          {() => (
            <>
              <div className="drama-style-grid">
                {dramaStyles.styles.map((item) => (
                  <button
                    type="button"
                    key={item.key}
                    aria-pressed={styleKey === item.key}
                    title={item.prompt}
                    onClick={() => onStyle(item.key)}
                  >
                    <div className="drama-style-poster">
                      <img
                        src={posters[`./drama-style-assets/${item.key}.webp`]}
                        alt={`${item.name}风格预览`}
                        width={640}
                        height={400}
                        loading="lazy"
                        decoding="async"
                      />
                    </div>
                    <span>{item.name}</span>
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={styleKey === "custom"}
                  onClick={() => onStyle("custom")}
                >
                  <i>
                    <Pencil size={16} />
                  </i>
                  <span>自定义</span>
                </button>
              </div>
              {styleKey === "custom" && (
                <textarea
                  aria-label="自定义画风"
                  maxLength={500}
                  placeholder="描述你想要的画风，如：黏土定格，暖色，微缩景观感"
                  value={custom}
                  onChange={(event) => onCustom(event.currentTarget.value)}
                />
              )}
            </>
          )}
        </FieldMenu>
        <FieldMenu
          container={container}
          label="单集时长"
          kind="seconds"
          locked={lockedUnits !== undefined}
          value={
            lockedUnits !== undefined
              ? `按原分集 · ${lockedUnits} 集`
              : `${seconds}s/集${script ? "（参考）" : ""}`
          }
          changed={(open) => {
            if (open) {
              setDraft(seconds);
              setInput(seconds);
            } else onSeconds(draft);
          }}
        >
          {() => (
            <>
              <div className="drama-seconds-list">
                {[60, 90, 120, 180].map((value) => (
                  <button
                    type="button"
                    className="drama-menu-row"
                    aria-pressed={Number(draft) === value}
                    key={value}
                    onClick={() => pickSeconds(String(value))}
                  >
                    {value} 秒 / 集{Number(draft) === value && <Check size={16} />}
                  </button>
                ))}
              </div>
              <label className="drama-custom-seconds">
                自定义时长　30–180 秒
                <span>
                  <input
                    type="number"
                    aria-label="自定义单集时长（秒）"
                    min={30}
                    max={180}
                    step={1}
                    aria-invalid={!!input && !valid(input)}
                    value={input}
                    onChange={(event) => pickSeconds(event.currentTarget.value)}
                  />{" "}
                  秒 / 集
                </span>
              </label>
              {!!input && !valid(input) && <p role="alert">请输入 30–180 的整数</p>}
            </>
          )}
        </FieldMenu>
      </div>
    </div>
  );
}
