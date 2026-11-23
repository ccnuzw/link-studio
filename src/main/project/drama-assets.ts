import { randomUUID } from "node:crypto";
import type {
  CanvasOperation,
  CreativeData,
  EditableCanvasNode,
} from "../../../packages/link-studio-core/src/canvas.ts";
import { dramaAssetMeta } from "../../../packages/link-studio-core/src/canvas.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import { dramaDocument } from "./drama.ts";
import { assetModel } from "./drama-image-models.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

type AssetMeta = Extract<CreativeData["drama"], { type: string }>;
export type DramaAsset = Omit<AssetMeta, "episodes"> & { episodes: number[]; voice_prompt: string };
type AssetNode = Extract<EditableCanvasNode, { type: "creative" }>;

const normalize = (name: string) => name.trim().toLowerCase();

function episodeUnion(existing: number[] | null, incoming: number[]) {
  if (existing && (!existing.length || !incoming.length)) return [];
  return [...new Set([...(existing ?? []), ...incoming])].sort((first, second) => first - second);
}

export function mergeDramaAssets(state: ProjectState, assets: DramaAsset[]) {
  const original = projectCanvas(state.canvas).nodes;
  const doc = dramaDocument(state);
  const settings = doc?.board_settings;
  const index = new Map<string, AssetNode>();
  const changes = new Map<string, AssetNode>();
  const created: { node_id: string; asset: DramaAsset }[] = [];
  const identity = (meta: AssetMeta, name: string) =>
    JSON.stringify([meta.type, normalize(meta.look), normalize(name)]);
  function remember(node: AssetNode) {
    const meta = dramaAssetMeta(node.data);
    if (!meta) return;
    for (const name of [meta.name, ...meta.aliases]) {
      const key = identity(meta, name);
      if (!index.has(key)) index.set(key, node);
    }
  }
  for (const node of original) if (node.type === "creative" && node.data.drama) remember(node);
  for (const asset of assets) {
    const match = [asset.name, ...asset.aliases]
      .map((name) => index.get(identity(asset, name)))
      .find(Boolean);
    if (match) {
      const node = structuredClone(changes.get(match.id) ?? match);
      const meta = dramaAssetMeta(node.data)!;
      const aliases = [...meta.aliases, ...asset.aliases];
      if (normalize(meta.name) !== normalize(asset.name)) aliases.push(asset.name);
      const seen = new Set<string>();
      meta.aliases = aliases
        .map((alias) => alias.trim())
        .filter((alias) => {
          const key = normalize(alias);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      meta.episodes = episodeUnion(meta.episodes, asset.episodes);
      changes.set(node.id, node);
      remember(node);
      continue;
    }
    const name = asset.name.trim();
    const look = asset.look.trim();
    const description = asset.description.trim();
    const providerId = assetModel(settings, asset.type);
    const params = doc?.image_params?.[asset.type];
    const sameRow = [...original, ...changes.values()].filter(
      (node) => node.type === "creative" && dramaAssetMeta(node.data)?.type === asset.type,
    );
    const position = {
      x: sameRow.reduce((right, node) => Math.max(right, node.position.x + 440), 0),
      y: sameRow[0]?.position.y ?? { character: 0, scene: 800, prop: 1600 }[asset.type],
    };
    const node: AssetNode = {
      id: randomUUID(),
      type: "creative",
      position,
      data: {
        kind: "image",
        text: "",
        label: look ? `${name} · ${look}` : name,
        ...((providerId || params) && {
          generation: { ...(providerId && { providerId }), ...(params && { params }) },
        }),
        drama: {
          type: asset.type,
          name,
          look,
          description,
          aliases: [...asset.aliases],
          episodes: episodeUnion(null, asset.episodes),
        },
        ...(asset.type === "character" && {
          character: {
            name,
            look: look || "基础形象",
            description,
            extraAssetIds: [],
            ...(asset.voice_prompt.trim() && { voicePrompt: asset.voice_prompt.trim() }),
          },
        }),
      },
    };
    changes.set(node.id, node);
    created.push({ node_id: node.id, asset });
    remember(node);
  }
  const operations: CanvasOperation[] = Array.from(changes.values(), (node) => ({
    type: "putNode",
    node,
  }));
  if (operations.length) state.canvas = applyCanvas(state, operations);
  return created;
}

export async function commitBreakdownBatch(
  store: ProjectStore,
  jobId: string,
  episodes: number[],
  assets: DramaAsset[],
  signal?: AbortSignal,
) {
  return store.updateGeneration((state) => {
    const document = dramaDocument(state);
    const job = document?.jobs?.find((candidate) => candidate.id === jobId);
    if (!document || !job || job.step !== "breakdown" || job.status !== "running")
      throw new ProjectError("DRAMA_STEP_NOT_READY", "拆解任务未运行");
    const scope = new Set(episodes);
    if (
      !scope.size ||
      scope.size !== episodes.length ||
      episodes.some((number) => !job.episodes.includes(number)) ||
      assets.length === 0 ||
      assets.some((asset) => asset.episodes.some((number) => !scope.has(number)))
    )
      throw new ProjectError("VALIDATION_FAILED", "拆解结果超出任务范围");
    if (episodes.every((number) => job.done_episodes?.includes(number)))
      return { changed: false, result: [] };
    const selected = document.episodes.filter((episode) => scope.has(episode.episode_no));
    if (
      selected.length !== scope.size ||
      selected.some((episode) => episode.locked || !episode.script_md.trim())
    )
      throw new ProjectError("DRAMA_STEP_NOT_READY", "所选集须已有剧本且尚未拆解");
    const created = mergeDramaAssets(state, assets);
    for (const episode of selected) {
      episode.locked = true;
      episode.revision = (episode.revision ?? 1) + 1;
    }
    document.overview_revision ??= document.revision;
    document.revision++;
    job.done_episodes = [...(job.done_episodes ?? []), ...episodes];
    job.new_nodes = [...(job.new_nodes ?? []), ...created.map((entry) => entry.node_id)];
    return { changed: true, result: created };
  }, signal);
}
