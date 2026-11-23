import { useEffect, useRef, useState } from "react";
import { focusOnMount } from "../focus-on-mount";

export function ShotText({
  value,
  commit,
  label,
  placeholder,
  required,
  focus,
  maxLength,
}: {
  value: string;
  commit: (text: string) => void;
  label: string;
  placeholder: string;
  required?: boolean;
  focus?: boolean;
  maxLength: number;
}) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  const [touched, setTouched] = useState(false);
  if (value !== shown) {
    setShown(value);
    setText(value);
  }
  return (
    <textarea
      aria-label={label}
      aria-invalid={(required && touched && !text.trim()) || undefined}
      placeholder={placeholder}
      ref={focus ? focusOnMount : undefined}
      rows={1}
      value={text}
      maxLength={maxLength}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        setTouched(true);
        if (value !== text) commit(text);
      }}
    />
  );
}

const clampDuration = (input: number) => Math.round(Math.min(60, Math.max(1, input)) * 10) / 10;

export function ShotDuration({ value, change }: { value: number; change: (next: number) => void }) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  const [flash, setFlash] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (shown !== value) {
    setShown(value);
    setText(String(value));
  }
  const parsed = text.trim() ? Number(text) : NaN;
  const corrected = Number.isFinite(parsed) ? clampDuration(parsed) : value;
  const commit = (next: number) => {
    setText(String(next));
    if (next !== value) change(next);
  };
  return (
    <label className="shot-duration" title="时长范围 1–60 秒" data-corrected={flash || undefined}>
      <input
        aria-label="时长（秒）"
        inputMode="decimal"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          commit(corrected);
          if (Number.isFinite(parsed) && parsed !== corrected) {
            setFlash(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setFlash(false), 300);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            commit(clampDuration(corrected + (event.key === "ArrowUp" ? 0.5 : -0.5)));
          }
        }}
      />
      <span>s</span>
    </label>
  );
}
