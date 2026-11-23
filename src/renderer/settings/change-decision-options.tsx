import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

const explain = "拒绝，并告诉助手怎么改…";

export function ChangeDecisionOptions({
  count,
  disabled,
  submit,
  generation = false,
  meta,
}: {
  count: number;
  disabled: boolean;
  submit: (apply: boolean, reason?: string) => void | Promise<void>;
  generation?: boolean;
  meta?: string;
}) {
  const options = [
    generation ? "批准生成" : `应用 ${count} 项变更`,
    "拒绝",
    generation ? "拒绝，并告诉 Agent 怎么改…" : explain,
  ];
  const [active, setActive] = useState(count ? 0 : 1);
  const highlightId = useId();
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body)
      buttons.current.find((button) => button && !button.disabled)?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const choose = (index: number) => {
    if (disabled || (!index && !count)) return;
    setActive(index);
    if (index === 2) setEditing(true);
    else void submit(index === 0);
  };
  return (
    <div
      role="listbox"
      aria-label="你的决定"
      className="change-decision-options"
      onKeyDown={(event) => {
        if (editing || disabled || event.nativeEvent.isComposing) return;
        if (/^[1-3]$/.test(event.key)) {
          event.preventDefault();
          choose(Number(event.key) - 1);
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        let next = (active + step + options.length) % options.length;
        if (!next && !count) next = step > 0 ? 1 : options.length - 1;
        buttons.current[next]?.focus();
      }}
    >
      {options.map((label, index) =>
        editing && index === 2 ? (
          <form
            key={index}
            onSubmit={(event) => {
              event.preventDefault();
              if (reason.trim() && !disabled) void submit(false, reason.trim());
            }}
          >
            <span className="choice-number">3</span>
            <input
              ref={input}
              aria-label={label}
              placeholder={
                generation ? "比如：改用 Seedream，只生成林夏" : "比如：只调可灵，别动其他模型"
              }
              maxLength={2000}
              value={reason}
              disabled={disabled}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key !== "Escape") return;
                event.stopPropagation();
                setEditing(false);
                requestAnimationFrame(() => buttons.current[2]?.focus());
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            key={index}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            role="option"
            aria-selected={active === index}
            disabled={disabled || (!index && !count)}
            onFocus={() => {
              setActive(index);
              setEditing(false);
            }}
            onMouseEnter={() => {
              if (!editing && !buttons.current[index]?.disabled) setActive(index);
            }}
            onClick={() => choose(index)}
          >
            {generation && active === index && (
              <motion.span
                className="generation-choice-highlight"
                aria-hidden
                layoutId={highlightId}
                transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
              />
            )}
            <span className="choice-number">{index + 1}</span>
            <span>{label}</span>
            {!index && meta && <span className="generation-credits">{meta}</span>}
          </button>
        ),
      )}
    </div>
  );
}
