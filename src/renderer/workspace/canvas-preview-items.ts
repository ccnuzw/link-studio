import type { ProjectAsset } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";

type PreviewNode = {
  id: string;
  parentId?: string;
  type: string;
  position: { x: number; y: number };
  measured?: { height?: number };
  data: {
    label: string;
    kind?: string;
    assetId?: string;
    character?: unknown;
    director?: unknown;
    storyboard?: unknown;
  };
};

export function canvasPreviewItem(node: PreviewNode, asset?: ProjectAsset) {
  const { data } = node;
  if (
    node.type !== "creative" ||
    data.character ||
    data.director ||
    data.storyboard ||
    (data.kind !== "image" && data.kind !== "video") ||
    !asset ||
    asset.availability !== "ready" ||
    (asset.mediaType !== "image" && asset.mediaType !== "video")
  )
    return;
  return {
    id: node.id,
    nodeId: node.id,
    label: data.label,
    assetId: asset.assetId,
    kind: asset.mediaType,
    bytes: asset.sizeBytes,
    fileName: asset.displayName,
  };
}

export function collectCanvasPreviews(nodes: PreviewNode[], assets: ProjectAsset[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byAsset = new Map(assets.map((asset) => [asset.assetId, asset]));
  const positioned = nodes
    .flatMap((node) => {
      const item = canvasPreviewItem(node, byAsset.get(node.data.assetId ?? ""));
      if (!item) return [];
      const parent = byId.get(node.parentId ?? "");
      return [
        {
          item,
          x: node.position.x + (parent?.position.x ?? 0),
          y: node.position.y + (parent?.position.y ?? 0),
          height: node.measured?.height ?? 324,
        },
      ];
    })
    .sort((first, second) => first.y - second.y);
  const rows: (typeof positioned)[] = [];
  let bottom = -Infinity;
  for (const entry of positioned) {
    if (entry.y > bottom) {
      rows.push([]);
      bottom = entry.y + entry.height / 2;
    }
    requirePresent(rows[rows.length - 1], "rows[rows.length - 1]").push(entry);
  }
  return rows.flatMap((row) =>
    row.sort((first, second) => first.x - second.x).map((entry) => entry.item),
  );
}

export function previewBytes(bytes?: number) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
