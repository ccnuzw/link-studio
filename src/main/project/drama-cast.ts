import { dramaAssetMeta } from "../../../packages/link-studio-core/src/canvas.ts";
import type {
  DramaDocument,
  DramaJobRecord,
} from "../../../packages/link-studio-core/src/drama.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { projectCanvas } from "./canvas.ts";

type Entry = NonNullable<DramaJobRecord["known_cast"]>[number];

export function dramaKnownCast(state: ProjectState, doc: DramaDocument) {
  const firstUnit = doc.planning?.recent_batches?.[0];
  const recent = firstUnit
    ? (doc.episodes.find((episode) => (episode.unit_to ?? 0) >= firstUnit)?.episode_no ?? 1)
    : 1;
  const candidates = projectCanvas(state.canvas)
    .nodes.flatMap((node) => {
      if (node.type !== "creative") return [];
      const asset = dramaAssetMeta(node.data);
      if (!asset?.name.trim()) return [];
      const first = asset.episodes?.length ? Math.min(...asset.episodes) : 0;
      const last = asset.episodes?.length
        ? Math.max(...asset.episodes)
        : asset.episodes
          ? recent
          : 0;
      const rank = asset.type === "character" ? 0 : last >= recent ? 1 : 2;
      const desc = Array.from(
        (asset.type === "character" && node.data.character?.description) ||
          asset.description ||
          node.data.text ||
          "",
      )
        .slice(0, 80)
        .join("");
      const entry: Entry = {
        type: asset.type,
        name: asset.name,
        aliases: asset.aliases,
        ...(rank !== 2 && asset.look && { look: asset.look }),
        ...(rank !== 2 && desc && { desc }),
      };
      return [{ first, rank, entry }];
    })
    .sort((left, right) => left.rank - right.rank || left.first - right.first);
  const kept: typeof candidates = [];
  const size = (entry: Entry) =>
    Array.from(
      JSON.stringify(entry).replace(
        /[<>&\u2028\u2029]/gu,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    ).length + 1;
  let remaining = 11998;
  for (const candidate of candidates) {
    const { entry } = candidate;
    if (size(entry) > remaining) {
      delete entry.look;
      delete entry.desc;
    }
    const chars = size(entry);
    if (chars <= remaining) {
      remaining -= chars;
      kept.push(candidate);
    }
  }
  return kept.sort((left, right) => left.first - right.first).map((item) => item.entry);
}
