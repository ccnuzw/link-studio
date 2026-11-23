import { GripVertical } from "lucide-react";
import { motion, Reorder, useDragControls } from "motion/react";
import { type ReactNode, useState } from "react";

export function ShotTableRow({
  id,
  number,
  highlight,
  disabled,
  finish,
  dropImage,
  children,
}: {
  id: string;
  number: number;
  highlight?: boolean;
  disabled: boolean;
  finish: () => void;
  dropImage: (file: File) => void;
  children: ReactNode;
}) {
  const drag = useDragControls();
  const [fileOver, setFileOver] = useState(false);
  return (
    <Reorder.Item
      as="div"
      value={id}
      role="group"
      aria-label={`镜头 ${number}`}
      data-shot-id={id}
      data-highlight={highlight || undefined}
      data-file-over={fileOver || undefined}
      onDragOver={(event) => {
        if (
          !Array.from(event.dataTransfer.items).some(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          ) &&
          !Array.from(event.dataTransfer.files).some((file) => file.type.startsWith("image/"))
        )
          return;
        event.preventDefault();
        setFileOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileOver(false);
      }}
      onDrop={(event) => {
        setFileOver(false);
        const file = Array.from(event.dataTransfer.files).find((file) =>
          file.type.startsWith("image/"),
        );
        if (!file) return;
        event.preventDefault();
        event.stopPropagation();
        dropImage(file);
      }}
      dragListener={false}
      dragControls={drag}
      onDragEnd={finish}
      className="shot-grid storyboard-row"
      inert={disabled}
      whileDrag={{ scale: 1.01, boxShadow: "0 24px 48px -12px rgb(0 0 0 / 0.35)", zIndex: 10 }}
    >
      <div className="shot-handle">
        <button
          type="button"
          aria-label={`拖动第 ${number} 镜排序`}
          onPointerDown={(event) => drag.start(event)}
        >
          <GripVertical size={16} />
        </button>
      </div>
      <div className="shot-number">
        <motion.span
          key={number}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
        >
          {String(number).padStart(2, "0")}
        </motion.span>
      </div>
      {children}
    </Reorder.Item>
  );
}
