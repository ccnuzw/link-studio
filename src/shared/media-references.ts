import { mediaReferenceBytes, type ProjectAsset, type ProjectCanvasView } from "@link-studio/core";

type Source = {
  label: string;
  assetId?: string;
  pendingKind?: ProjectAsset["mediaType"];
  part?: string;
  roleName?: string;
  avatarId?: string;
  voicePending?: boolean;
};

export function linkedMediaSources(
  canvas: ProjectCanvasView,
  targetId: string,
  running?: ReadonlySet<string>,
  pendingVoices?: ReadonlySet<string>,
): Source[] {
  const sources = new Map(canvas.nodes.map((node) => [node.id, node]));
  return canvas.edges.flatMap<Source>(({ target, source, readOnly }) => {
    if (readOnly || target !== targetId || source === targetId) return [];
    const node = sources.get(source);
    if (
      node?.type !== "creative" ||
      node.data.kind === "script" ||
      node.data.storyboard ||
      node.data.director
    )
      return [];
    const { character, label } = node.data;
    const assetId = running?.has(source) ? undefined : node.data.assetId;
    if (!character) return [{ label, assetId, ...(!assetId && { pendingKind: node.data.kind }) }];
    return [
      ...(assetId ? [{ label, assetId, part: "avatar" }] : []),
      ...(assetId ? character.extraAssetIds : []).map((assetId) => ({
        label: `${label} · 补充图`,
        assetId,
        part: "extra",
      })),
      ...(character.voice || pendingVoices?.has(source)
        ? [
            {
              label: `${label} · 音色`,
              assetId: character.voice?.assetId,
              part: "voice",
              roleName: character.name,
              avatarId: assetId,
              voicePending: pendingVoices?.has(source),
            },
          ]
        : []),
    ];
  });
}

export function hasPendingReference(
  linked: readonly Source[],
  op: string | undefined,
  counts: Partial<Record<ProjectAsset["mediaType"], number>>,
) {
  return linked.some(
    ({ pendingKind }) =>
      pendingKind &&
      (counts[pendingKind] ?? 0) > 0 &&
      (op === "omni" || ((op === "i2i" || op === "i2v") && pendingKind === "image")),
  );
}

export function mediaReferences({
  assets,
  linked,
  manual,
  imageOnly,
  video = false,
  limit,
  counts,
  bytes,
}: {
  assets: ProjectAsset[];
  linked: readonly Source[];
  manual: string[];
  imageOnly: boolean;
  video?: boolean;
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
  const role = linked.filter((link) => link.part && (video || link.part !== "voice"));
  if (video) {
    const priority = (part?: string) => (part === "voice" ? 2 : Number(part === "extra"));
    role.sort((left, right) => priority(left.part) - priority(right.part));
  }
  const ids = new Set(
    [...linked.filter((link) => !link.part).map((link) => link.assetId), ...manual].filter(
      (id): id is string => !!id && byId.has(id),
    ),
  );
  const images = new Set([...ids].filter((id) => byId.get(id)?.mediaType === "image"));
  const imageMax = counts ? (counts.image ?? 0) : limit;
  const notices: string[] = [];
  let dropped = false;
  for (const { assetId, part } of role) {
    if (!assetId || !byId.has(assetId)) continue;
    if (byId.get(assetId)?.mediaType === "image") {
      if (!(video && part === "avatar") && !images.has(assetId) && images.size >= imageMax) {
        dropped = true;
        continue;
      }
      images.add(assetId);
    }
    ids.add(assetId);
  }
  const chosen = [...ids].map((id) => byId.get(id)!);
  const errors: Partial<Record<ProjectAsset["mediaType"], string>> = {};
  const names = { image: "图片", video: "视频", audio: "音频" } as const;
  for (const kind of ["image", "video", "audio"] as const) {
    const max = Math.min(counts?.[kind] ?? limit, limit);
    if (chosen.filter((asset) => asset.mediaType === kind).length > max)
      errors[kind] = `参考${names[kind]}最多 ${max} 个，请移除多余的`;
  }
  if (dropped) notices.push(`参考图最多 ${imageMax} 张，多余补充图未带入`);
  const voices = role.filter((link) => link.part === "voice");
  if (imageMax && (imageOnly || (counts && !counts.audio)) && voices.some((link) => link.assetId))
    notices.push("当前模型不支持参考音频，角色卡声音未生效");
  for (const voice of voices) {
    if (voice.voicePending)
      errors.audio ??= `角色「${voice.roleName}」的声音尚未就绪，请等待声音生成完成`;
    if (!voice.assetId || voice.roleName === undefined) continue;
    if (!voice.avatarId || !images.has(voice.avatarId))
      errors.image ??= `角色「${voice.roleName}」的主图未就绪或当前方式不支持参考图片`;
    if (!ids.has(voice.assetId))
      errors.audio ??= `角色「${voice.roleName}」的声音未带入，请选择支持参考音频的生成方式`;
  }
  return {
    available,
    sources,
    unavailable: [...unavailable],
    error:
      errors.image ??
      errors.video ??
      errors.audio ??
      (ids.size > limit ? `参考素材最多 ${limit} 个，请移除多余的` : undefined),
    notices,
    chosen,
  };
}
