import {
  type CreativeData,
  type GenerationJob,
  jobIsTerminal,
  type modelGenerationOptions,
  type ProjectCanvasView,
} from "@link-studio/core";
import { agentReferenceErrors } from "../../../packages/link-studio-core/src/agent-reference-errors";
import type { ProjectState } from "../../../packages/link-studio-core/src/project";
import { CanvasGenerationFeedback } from "./errors";

type Asset = Pick<ProjectState["assets"][string], "assetId" | "availability" | "mediaType">;
type Media = Asset["mediaType"];
export type RoleJob = Pick<GenerationJob, "nodeId" | "status" | "kind" | "purpose" | "createdAt">;
type Options = Pick<
  ReturnType<typeof modelGenerationOptions>,
  "referenceLimit" | "frameLimit" | "references"
>;
type Candidate = { id: string; kind: Media; part?: "avatar" | "extra" | "voice" };

function refuse(
  code: keyof typeof agentReferenceErrors,
  message: string = agentReferenceErrors[code],
): never {
  throw new CanvasGenerationFeedback(code, message);
}

export function agentSources(graph: ProjectCanvasView, target: string) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const sources = new Map<string, CreativeData>();
  for (const edge of graph.edges) {
    if (edge.readOnly || edge.target !== target || edge.source === target) continue;
    const node = byId.get(edge.source);
    if (node?.type === "creative" && !node.data.director && !node.data.storyboard)
      sources.set(node.id, node.data);
  }
  return sources;
}

function activeRoleJobs(sources: ReadonlyMap<string, CreativeData>, jobs: readonly RoleJob[]) {
  const voices = new Set<string>();
  const avatars = new Set<string>();
  const latest = new Map<string, RoleJob>();
  for (const job of jobs) {
    if (
      !sources.get(job.nodeId)?.character ||
      (job.purpose !== "character-voice" && job.kind !== "image")
    )
      continue;
    const key = `${job.nodeId}:${job.purpose === "character-voice" ? "voice" : "avatar"}`;
    const previous = latest.get(key);
    if (!previous || previous.createdAt <= job.createdAt) latest.set(key, job);
  }
  for (const job of latest.values())
    if (!jobIsTerminal(job.status) || job.status === "outcome_unknown")
      (job.purpose === "character-voice" ? voices : avatars).add(job.nodeId);
  return { voices, avatars };
}

export function checkApprovedRoleJobs(
  graph: ProjectCanvasView,
  target: string,
  video: boolean,
  refs: readonly string[],
  jobs: readonly RoleJob[],
) {
  const sources = agentSources(graph, target);
  const { voices, avatars } = activeRoleJobs(sources, jobs);
  if (video && voices.size) refuse("AGENT_ROLE_VOICE_PENDING");
  for (const id of avatars) {
    const source = sources.get(id);
    if (
      source?.character &&
      source.assetId &&
      [source.assetId, ...source.character.extraAssetIds].some((asset) => refs.includes(asset))
    )
      refuse("AGENT_ROLE_AVATAR_PENDING");
  }
}

export function agentReferenceInput(
  sources: Map<string, CreativeData>,
  data: CreativeData,
  assets: Record<string, Asset>,
  jobs: readonly RoleJob[],
  options: Options,
  modes: readonly string[],
  generateAudio: boolean,
) {
  const { voices, avatars } = activeRoleJobs(sources, jobs);
  const video = data.kind === "video";
  const ordinary: Candidate[] = [],
    role: Candidate[] = [];
  for (const [nodeId, source] of sources) {
    if (source.kind === "script") continue;
    if (!source.character) {
      if (source.assetId) ordinary.push({ id: source.assetId, kind: source.kind });
      continue;
    }
    if (!source.assetId || avatars.has(nodeId)) {
      sources.set(nodeId, { ...source, assetId: undefined });
      continue;
    }
    role.push({ id: source.assetId, kind: "image", part: "avatar" });
    for (const id of source.character.extraAssetIds)
      role.push({ id, kind: "image", part: "extra" });
    if (source.character.voice)
      role.push({ id: source.character.voice.assetId, kind: "audio", part: "voice" });
  }
  const hasImage = [...ordinary, ...role].some((ref) => ref.kind === "image");
  const chosen = data.videoMode ?? data.imageMode;
  const mode =
    modes.includes("t2i") && modes.includes("i2i")
      ? hasImage
        ? "i2i"
        : "t2i"
      : chosen && modes.includes(chosen)
        ? chosen
        : hasImage && modes.includes("i2v")
          ? "i2v"
          : modes[0];
  const supports = (kind: Media) =>
    (options.references[kind] ?? 0) > 0 &&
    (mode === "omni" || (mode !== "t2v" && mode !== "t2i" && kind === "image"));
  const refs: Asset[] = [],
    seen = new Set<string>();
  const counts = { image: 0, video: 0, audio: 0 };
  const take = (candidate: Candidate, optional = false) => {
    const { id, kind } = candidate;
    if (!supports(kind) || seen.has(id)) return;
    const limit = mode === "i2v" ? options.frameLimit : (options.references[kind] ?? 0);
    if (optional && counts[kind] >= limit) return;
    const asset = assets[id];
    if (asset?.availability !== "ready" || asset.mediaType !== kind)
      refuse("AGENT_REFERENCE_UNAVAILABLE");
    seen.add(id);
    counts[kind]++;
    refs.push(asset);
  };
  for (const item of ordinary) take(item);
  for (const id of data.manualReferenceIds ?? []) {
    const asset = assets[id];
    if (!asset) {
      if (mode !== "t2v" && mode !== "t2i") refuse("AGENT_REFERENCE_UNAVAILABLE");
      continue;
    }
    take({ id, kind: asset.mediaType });
  }
  if (supports("image")) {
    if (video)
      role.sort((left, right) => Number(left.part === "extra") - Number(right.part === "extra"));
    for (const item of role) take(item, !video || item.part === "extra");
  }
  if (video)
    for (const source of sources.values()) {
      if (!source.character?.voice) continue;
      const name = source.character.name || source.label;
      if (!source.assetId || !seen.has(source.assetId))
        refuse(
          "AGENT_ROLE_AVATAR_NOT_READY",
          `角色「${name}」的主图未就绪或当前方式不支持参考图片`,
        );
      if (!seen.has(source.character.voice.assetId))
        refuse(
          "AGENT_ROLE_VOICE_NOT_INCLUDED",
          `角色「${name}」的声音未带入，请选择支持参考音频的生成方式`,
        );
      if (!generateAudio) refuse("AGENT_ROLE_AUDIO_DISABLED", "使用角色音色时请开启声音生成");
    }
  for (const kind of ["image", "video", "audio"] as const) {
    const max =
      mode === "i2v" && kind === "image"
        ? Math.min(options.frameLimit, options.references.image ?? 0)
        : (options.references[kind] ?? 0);
    if (counts[kind] > max)
      refuse(
        "AGENT_REFERENCE_LIMIT",
        `参考${{ image: "图片", video: "视频", audio: "音频" }[kind]}最多 ${max} 个，请移除多余的参考素材`,
      );
  }
  if (refs.length > options.referenceLimit)
    refuse(
      "AGENT_REFERENCE_LIMIT",
      `参考素材最多 ${options.referenceLimit} 个，请移除多余的参考素材`,
    );
  if (video)
    for (const [nodeId, source] of sources) {
      if (voices.has(nodeId))
        refuse(
          "AGENT_ROLE_VOICE_PENDING",
          `角色「${source.character?.name || source.label}」的声音尚未就绪，请等待声音生成完成`,
        );
    }
  return { mode, refs };
}
