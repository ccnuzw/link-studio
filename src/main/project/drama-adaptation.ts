import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { AdaptDramaSegment, dramaStyles } from "../../../packages/link-studio-core/src/drama.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { dramaDocument } from "./drama.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

const active = new Set<string>();
export async function adaptDramaSegment(
  store: ProjectStore,
  registry: SettingsRegistry,
  input: unknown,
  signal: AbortSignal,
) {
  if (!Value.Check(AdaptDramaSegment, input))
    throw new ProjectError("VALIDATION_FAILED", "转写参数无效");
  const doc = dramaDocument(store.snapshot);
  const segment = doc?.segments?.find((entry) => entry.id === input.segmentId);
  if (
    !doc ||
    !segment ||
    segment.revision !== input.revision ||
    segment.episode_no !== input.episodeNo ||
    (doc.episode_order ?? 0) !== input.episodeOrder
  )
    throw new ProjectError("AGENT_APPROVAL_STALE", "片段已更改，请重新读取");
  const source = segment.prompt;
  if (!source.trim()) throw new ProjectError("VALIDATION_FAILED", "原稿为空");
  const key = JSON.stringify([store.directory, segment.id, input.format]);
  if (active.has(key)) throw new ProjectError("VALIDATION_FAILED", "这个片段正在转写");
  active.add(key);
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
    const assets = new Map<string, string>();
    for (const match of source.matchAll(/@\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/g))
      if (!assets.has(match[2]!)) assets.set(match[2]!, match[1]!);
    const variables = {
      source_prompt: source,
      seconds: segment.seconds,
      ratio: doc.ratio ?? "9:16",
      style:
        dramaStyles.styles.find((style) => style.key === doc.style_key)?.prompt ||
        doc.style_custom ||
        "",
      assets: Array.from(assets, ([node_id, name]) => ({ node_id, name })),
    };
    const output = await registry.withDramaTextModel(doc.board_settings?.textModel ?? "", (model) =>
      registry.dramaAssetStage(
        model,
        `adapt_${input.format}`,
        variables,
        { source_prompt: source, max_seconds: segment.seconds },
        deadline,
      ),
    );
    if (
      !output ||
      typeof output !== "object" ||
      !("prompt" in output) ||
      typeof output.prompt !== "string" ||
      !output.prompt.trim() ||
      output.prompt.length > 24000
    )
      throw new ProjectError("VALIDATION_FAILED", "转写结果无效");
    const prompt = output.prompt;
    return await store.updateGeneration((state) => {
      const current = dramaDocument(state);
      const target = current?.segments?.find((entry) => entry.id === segment.id);
      const previous = segment.adaptations?.[input.format];
      const latest = target?.adaptations?.[input.format];
      if (
        !current ||
        !target ||
        target.episode_no !== input.episodeNo ||
        (current.episode_order ?? 0) !== input.episodeOrder ||
        target.seconds !== segment.seconds ||
        previous?.prompt !== latest?.prompt ||
        previous?.edited !== latest?.edited ||
        previous?.source_hash !== latest?.source_hash ||
        previous?.updated_at !== latest?.updated_at
      )
        throw new ProjectError("AGENT_APPROVAL_STALE", "片段或转写稿已更改，请重新读取");
      target.adaptations ??= {};
      target.adaptations[input.format] = {
        prompt,
        source_hash: createHash("sha256").update(source).digest("hex"),
        edited: false,
        updated_at: new Date().toISOString(),
      };
      target.revision++;
      current.overview_revision ??= current.revision;
      current.revision++;
      return { changed: true, result: current };
    }, deadline);
  } finally {
    active.delete(key);
  }
}
