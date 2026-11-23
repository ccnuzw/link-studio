import { NodeToolbar, Position, useStore } from "@xyflow/react";
import type { ReactNode } from "react";
import { mediaPanelLayout } from "./media-panel-layout";

export function MediaPanelAnchor({
  id,
  hidden,
  children,
}: {
  id: string;
  hidden: boolean;
  children: ReactNode;
}) {
  const layout = useStore((state) => {
    const node = state.nodeLookup.get(id);
    const [translateX, , zoom] = state.transform;
    const { width, shift } = mediaPanelLayout(
      (node?.internals.positionAbsolute.x ?? 0) * zoom + translateX,
      (node?.measured.width ?? 576) * zoom,
      state.width,
    );
    return `${width}|${shift}`;
  });
  const [width, shift] = layout.split("|");
  return (
    <NodeToolbar nodeId={id} position={Position.Bottom} offset={16} isVisible hidden={hidden}>
      <div
        className="media-panel-anchor"
        style={{ width: `${width}px`, translate: `${shift}px 0` }}
      >
        {children}
      </div>
    </NodeToolbar>
  );
}
