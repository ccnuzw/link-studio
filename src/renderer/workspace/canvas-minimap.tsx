import { MiniMap } from "@xyflow/react";

export function CanvasMiniMap() {
  return (
    <MiniMap
      position="bottom-left"
      pannable
      zoomable
      className="workspace-map"
      nodeColor="var(--map-node)"
      nodeBorderRadius={12}
      ariaLabel="画布小地图"
    />
  );
}
