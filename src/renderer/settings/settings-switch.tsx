import { useId } from "react";

export function SettingsSwitch({
  label,
  text,
  checked,
  disabled,
  reason,
  onChange,
}: {
  label: string;
  text?: string;
  checked: boolean;
  disabled?: boolean;
  reason?: string;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="settings-switch" htmlFor={id} title={reason}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings-switch-track" aria-hidden="true" />
      {text && <span>{text}</span>}
    </label>
  );
}
