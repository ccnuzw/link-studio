import { NodeToolbar, Position, useReactFlow, useStore } from "@xyflow/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import {
  mediaPanelLayout,
  mediaPanelOffset,
  mediaPanelOverflow,
  mediaPanelViewport,
} from "./media-panel-layout";

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
  const nodeHeight = useStore((state) => state.nodeLookup.get(id)?.measured.height);
  const minZoom = useStore((state) => state.minZoom);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!canvas || !panel) return;
    let panelHeight = 0;
    let canvasHeight = 0;
    const observer = new ResizeObserver(() => {
      const panelBounds = panel.getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      if (!panelBounds.height || !canvasBounds.height) return;
      if (panelBounds.height === panelHeight && canvasBounds.height === canvasHeight) return;
      panelHeight = panelBounds.height;
      canvasHeight = canvasBounds.height;
      setHeight(panelHeight);
      if (!reveal) return;
      const viewport = flow.getViewport();
      const node = flow.getNodesBounds([id]);
      const fitted = mediaPanelViewport(node, viewport, canvasHeight, panelHeight, minZoom);
      if (fitted !== viewport) void flow.setViewport(fitted);
    });
    observer.observe(panel);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvas, flow, id, minZoom, nodeHeight, panel, reveal]);
  const layout = useStore((state) => {
    const node = state.nodeLookup.get(id);
    const [translateX, translateY, zoom] = state.transform;
    const { width, shift } = mediaPanelLayout(
      (node?.internals.positionAbsolute.x ?? 0) * zoom + translateX,
      (node?.measured.width ?? 576) * zoom,
      state.width,
    );
    const nodeTop = (node?.internals.positionAbsolute.y ?? 0) * zoom + translateY;
    const nodeBottom = nodeTop + (node?.measured.height ?? 0) * zoom;
    const lift =
      nodeBottom > 0 && nodeTop < state.height
        ? mediaPanelOverflow(nodeBottom + mediaPanelOffset + height, state.height)
        : 0;
    return `${width}|${shift}|${lift}`;
  });
  const [width, shift, lift] = layout.split("|");
  return (
    <NodeToolbar
      nodeId={id}
      position={Position.Bottom}
      offset={mediaPanelOffset}
      isVisible
      hidden={hidden}
    >
      <div
        ref={setPanel}
        className="media-panel-anchor"
        style={{ width: `${width}px`, translate: `${shift}px -${lift}px` }}
      >
        {children}
      </div>
    </NodeToolbar>
  );
}
