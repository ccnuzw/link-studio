import { Handle, Position } from "@xyflow/react";
import { Plus } from "lucide-react";
import type { PointerEvent } from "react";
import "./node-port.css";

function followPointer(event: PointerEvent<HTMLDivElement>) {
  const port = event.currentTarget;
  const bounds = port.getBoundingClientRect();
  port.style.setProperty("--port-x", `${event.clientX - bounds.left}px`);
  port.style.setProperty("--port-y", `${event.clientY - bounds.top}px`);
}

function resetPointer(event: PointerEvent<HTMLDivElement>) {
  event.currentTarget.style.removeProperty("--port-x");
  event.currentTarget.style.removeProperty("--port-y");
}

export function NodePort({ type, hidden }: { type: "target" | "source"; hidden?: boolean }) {
  return (
    <Handle
      type={type}
      position={type === "target" ? Position.Left : Position.Right}
      isConnectable={!hidden}
      className="canvas-node-port"
      style={hidden ? { visibility: "hidden", pointerEvents: "none" } : undefined}
      onPointerMove={followPointer}
      onPointerLeave={resetPointer}
    >
      {!hidden && (
        <span aria-hidden="true" className="canvas-port-icon">
          <Plus size={14} />
        </span>
      )}
    </Handle>
  );
}
