import { NodeToolbar, Position, useReactFlow, useStore } from "@xyflow/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { mediaPanelLayout } from "./media-panel-layout";

const canvasControlsInset = 64;

export function MediaPanelAnchor({
  id,
  hidden,
  reveal,
  children,
}: {
  id: string;
  hidden: boolean;
  reveal: boolean;
  children: ReactNode;
}) {
  const flow = useReactFlow();
  const canvas = useStore((state) => state.domNode);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!canvas || !panel || !reveal) return;
    let panelHeight = 0;
    let canvasHeight = 0;
    const observer = new ResizeObserver(() => {
      const panelBounds = panel.getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      if (!panelBounds.height || !canvasBounds.height) return;
      if (panelBounds.height === panelHeight && canvasBounds.height === canvasHeight) return;
      panelHeight = panelBounds.height;
      canvasHeight = canvasBounds.height;
      const overflow = Math.ceil(panelBounds.bottom - canvasBounds.bottom + canvasControlsInset);
      if (overflow > 0) {
        const viewport = flow.getViewport();
        void flow.setViewport({ ...viewport, y: viewport.y - overflow });
      }
    });
    observer.observe(panel);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvas, flow, id, panel, reveal]);
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
        ref={setPanel}
        className="media-panel-anchor"
        style={{ width: `${width}px`, translate: `${shift}px 0` }}
      >
        {children}
      </div>
    </NodeToolbar>
  );
}
