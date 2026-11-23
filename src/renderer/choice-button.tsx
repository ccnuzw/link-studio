import type { ComponentProps, KeyboardEvent } from "react";

function navigateRadio(event: KeyboardEvent<HTMLButtonElement>) {
  const directions: Record<string, number> = {
    ArrowLeft: -1,
    ArrowUp: -1,
    ArrowRight: 1,
    ArrowDown: 1,
  };
  const direction = directions[event.key];
  if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  if (!group) return;
  const choices = Array.from(
    group.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]:not(:disabled):not([aria-disabled="true"])',
    ),
  ).filter((button) => button.closest('[role="radiogroup"]') === group);
  const current = choices.indexOf(event.currentTarget);
  if (current < 0) return;
  event.preventDefault();
  event.stopPropagation();
  const next = choices[(current + direction + choices.length) % choices.length];
  next?.focus();
  next?.click();
}

export function ChoiceButton({
  role = "radio",
  ...props
}: Omit<ComponentProps<"button">, "role"> & { role?: "radio" | "checkbox" }) {
  return (
    <button
      type="button"
      {...props}
      role={role}
      onKeyDown={role === "radio" ? navigateRadio : props.onKeyDown}
    />
  );
}
