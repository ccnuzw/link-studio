import { imageDisplaySize, type ProjectAsset } from "@link-studio/core";
import { imageFrameSize } from "./grid-placement";
import { assetNodeLabel, availableNodeLabel } from "./node-label";

const mediaLabels = { image: "图片", video: "视频", audio: "音频" };
export const assetPickLimit = 20;

export function pickAsset<Item extends { assetId: string }>(
  selected: Item[],
  asset: Item,
  appendOnly = false,
  limit = assetPickLimit,
) {
  if (selected.some((item) => item.assetId === asset.assetId))
    return appendOnly ? selected : selected.filter((item) => item.assetId !== asset.assetId);
  if (!appendOnly && limit === 1) return [asset];
  return selected.length >= limit ? selected : [...selected, asset];
}

export function planAssetNodes(
  assets: ProjectAsset[],
  origin: { x: number; y: number },
  existing: Iterable<string>,
  newId: () => string = () => crypto.randomUUID(),
) {
  const labels = new Set(existing);
  let left = origin.x;
  let top = origin.y;
  let rowHeight = 0;
  return assets.map((asset, index) => {
    if (index && index % 4 === 0) {
      left = origin.x;
      top += rowHeight + 40;
      rowHeight = 0;
    }
    const { width, height } = imageDisplaySize(asset.metadata);
    const aspect =
      asset.mediaType === "video" && Number(asset.metadata.displayAspect) > 0
        ? Number(asset.metadata.displayAspect)
        : width / height;
    const measured = asset.mediaType !== "audio" && imageFrameSize(aspect, 1);
    const frame = measured || { width: asset.mediaType === "audio" ? 324 : 576, height: 324 };
    const position = { x: left, y: top };
    left += frame.width + 40;
    rowHeight = Math.max(rowHeight, frame.height);
    const label = availableNodeLabel(
      assetNodeLabel(asset.displayName, mediaLabels[asset.mediaType]),
      labels,
    );
    labels.add(label);
    return {
      id: newId(),
      type: "creative" as const,
      position,
      selected: true,
      data: {
        kind: asset.mediaType,
        label,
        text: "",
        assetId: asset.assetId,
        uploaded: true as const,
        ...(measured && { mediaAspect: aspect }),
      },
    };
  });
}
