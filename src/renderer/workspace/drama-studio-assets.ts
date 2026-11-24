import { dramaAssetMeta, type ProjectCanvasView } from "@link-studio/core";
import { linkKind } from "./link-rules";

export const studioAssetDragType = "application/x-drama-asset";

export function studioAssets(graph: ProjectCanvasView | undefined, episodeNo: number) {
  return (graph?.nodes ?? []).flatMap((node) => {
    if (node.type !== "creative") return [];
    const meta = dramaAssetMeta(node.data);
    const type = meta?.type ?? (node.data.kind === "audio" ? "audio" : undefined);
    if (!type) return [];
    const episodes = node.data.drama?.episodes;
    return [
      {
        type,
        source: {
          id: node.id,
          label: node.data.label || meta?.name || "音频",
          kind: linkKind(node.data),
          assetId: node.data.assetId,
        },
        here: !!episodes && (!episodes.length || episodes.includes(episodeNo)),
        voice: node.data.character?.voice,
      },
    ];
  });
}
