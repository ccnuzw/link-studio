import { mediaReferenceBytes, type ProjectAsset, type ProjectCanvasView } from "@link-studio/core";

export function linkedMediaSources(canvas: ProjectCanvasView, targetId: string) {
  const sources = new Map(canvas.nodes.map((node) => [node.id, node]));
  return canvas.edges.flatMap(({ target, source, readOnly }) => {
    if (readOnly || target !== targetId || source === targetId) return [];
    const node = sources.get(source);
    if (node?.type !== "creative" || node.data.kind === "script") return [];
    const { character, label, assetId } = node.data;
    if (!character) return [{ label, assetId }];
    return [
      ...(assetId ? [{ label, assetId }] : []),
      ...character.extraAssetIds.map((assetId) => ({ label: `${label} · 补充图`, assetId })),
      ...(character.voice ? [{ label: `${label} · 音色`, assetId: character.voice.assetId }] : []),
    ];
  });
}

export function mediaReferences({
  assets,
  linked,
  manual,
  imageOnly,
  limit,
  counts,
  bytes,
}: {
  assets: ProjectAsset[];
  linked: ReturnType<typeof linkedMediaSources>;
  manual: string[];
  imageOnly: boolean;
  limit: number;
  counts?: Partial<Record<ProjectAsset["mediaType"], number>>;
  bytes?: Partial<Record<ProjectAsset["mediaType"], number>>;
}) {
  const available = assets.filter(
    ({ availability, sizeBytes, mediaType }) =>
      availability === "ready" &&
      sizeBytes <= (bytes?.[mediaType] ?? mediaReferenceBytes) &&
      (!imageOnly || mediaType === "image") &&
      (!counts || (counts[mediaType] ?? 0) > 0),
  );
  const byId = new Map(available.map((asset) => [asset.assetId, asset]));
  const sources = new Map<string, string>();
  const unavailable = new Set<string>();
  for (const { label, assetId } of linked) {
    if (assetId && byId.has(assetId)) {
      if (!sources.has(assetId)) sources.set(assetId, label);
    } else unavailable.add(label);
  }
  const ids = [...new Set([...manual.filter((id) => byId.has(id)), ...sources.keys()])];
  const used = { image: 0, video: 0, audio: 0 };
  const chosen: ProjectAsset[] = [];
  for (const id of ids) {
    const asset = byId.get(id);
    if (!asset || chosen.length >= limit) continue;
    if (counts && used[asset.mediaType] >= (counts[asset.mediaType] ?? 0)) continue;
    used[asset.mediaType]++;
    chosen.push(asset);
  }
  return {
    available,
    sources,
    unavailable: [...unavailable],
    overflow: ids.length - chosen.length,
    chosen,
  };
}
