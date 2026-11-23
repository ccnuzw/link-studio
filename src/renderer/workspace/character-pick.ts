import type { CanvasCharacter, CreativeData } from "@link-studio/core";

export type CharacterPurpose = "main" | "extra" | "voice";
export type CharacterPick = { purpose: CharacterPurpose; primary?: string; extras: string[] };
export const characterPickTitles = {
  main: "选择形象主图",
  extra: "选择补充图",
  voice: "选择音色音频",
};

export function characterShowsGenerator(data: CreativeData) {
  if (!data.character || !data.assetId) return true;
  const version =
    data.outputs?.find(
      (output) => output.id === data.activeOutputId && output.assetId === data.assetId,
    ) ?? data.outputs?.findLast((output) => output.assetId === data.assetId);
  return !!version && (!!version.model || version.id !== version.assetId);
}

export function characterPickReason(request: CharacterPick | undefined, id: string) {
  if (request?.purpose !== "extra") return;
  if (id === request.primary) return "已是主图";
  if (request.extras.includes(id)) return "已添加";
}

export function bindCharacterPick(
  character: CanvasCharacter,
  primary: string | undefined,
  purpose: CharacterPurpose | "human",
  ids: string[],
) {
  const first = ids[0];
  if (!first) return { character, primary };
  if (purpose === "human")
    return {
      primary: first,
      character: {
        ...character,
        extraAssetIds: ids
          .slice(1)
          .filter((id) => id !== first)
          .slice(0, 4),
      },
    };
  if (purpose === "main")
    return {
      primary: first,
      character: {
        ...character,
        extraAssetIds: character.extraAssetIds.filter((id) => id !== first),
      },
    };
  if (purpose === "voice")
    return {
      primary,
      character: { ...character, voice: { assetId: first, origin: "library" as const } },
    };
  const extraAssetIds = [
    ...new Set([...character.extraAssetIds, ...ids.filter((id) => id !== primary)]),
  ].slice(0, 4);
  return { primary, character: { ...character, extraAssetIds } };
}

export function bindCharacterMedia(
  data: CreativeData,
  purpose: CharacterPurpose | "human",
  ids: string[],
  createdAt: string,
): CreativeData {
  if (!data.character || !ids.length) return data;
  const { primary, character } = bindCharacterPick(data.character, data.assetId, purpose, ids);
  if ((purpose !== "main" && purpose !== "human") || !primary) return { ...data, character };
  const outputs = data.outputs?.length
    ? data.outputs
    : data.assetId
      ? [
          {
            kind: "image" as const,
            id: data.assetId,
            assetId: data.assetId,
            createdAt: new Date(0).toISOString(),
          },
        ]
      : [];
  return {
    ...data,
    character,
    assetId: primary,
    activeOutputId: primary,
    outputs: outputs.some((item) => item.id === primary)
      ? outputs
      : [...outputs, { id: primary, assetId: primary, kind: "image" as const, createdAt }].slice(
          -50,
        ),
  };
}
