import { type HTMLMotionProps, motion } from "motion/react";
import { CanvasControlTip } from "./canvas-control-tip";

export function SelectionButton({
  label,
  shortcut,
  ...props
}: HTMLMotionProps<"button"> & {
  label: string;
  shortcut?: string;
}) {
  return (
    <CanvasControlTip label={label} shortcut={shortcut}>
      <motion.button
        type="button"
        aria-label={label}
        whileTap={props.disabled ? undefined : { scale: 0.96 }}
        {...props}
      />
    </CanvasControlTip>
  );
}
