import {
  boardLine,
  dramaAssetMeta,
  dramaBoardMeta,
  type GenerationJob,
  jobIsTerminal,
  modelGenerationModes,
  type modelGenerationOptions,
  type ProjectAsset,
  type ProjectCanvasView,
  promptLang,
} from "@link-studio/core";
import { composeLinkedPrompt } from "./compose-canvas-prompt";
import { parsePrompt } from "./prompt-tokens";

type CreativeData = Extract<ProjectCanvasView["nodes"][number], { type: "creative" }>["data"];
type Options = ReturnType<typeof modelGenerationOptions>;
type BoardSelection = { segmentId: string; sourceHash: string; off: boolean };
type BoardView = {
  state: "none" | "off" | "unsupported" | "stale" | "image";
  reason: string;
  thumbnail?: string;
  shotCount?: number;
};

function boardView(
  graph: ProjectCanvasView,
  ready: Map<string, ProjectAsset>,
  modes: readonly string[],
  imageLimit: number,
  selection?: BoardSelection,
): BoardView {
  if (!selection) return { state: "none", reason: "" };
  const node = graph.nodes.findLast(
    (item) =>
      item.type === "creative" && dramaBoardMeta(item.data)?.segmentId === selection.segmentId,
  );
  const thumbnail = node?.type === "creative" && node.data.assetId;
  if (!thumbnail || ready.get(thumbnail)?.mediaType !== "image")
    return { state: "none", reason: "" };
  if (selection.off) return { state: "off", reason: "本次已关掉故事板", thumbnail };
  if (!modes.includes("omni") || imageLimit <= 0)
    return {
      state: "unsupported",
      thumbnail,
      reason:
        modes.includes("i2v") && imageLimit > 0
          ? "当前模型把第一张图当首帧，故事板未带入"
          : "当前模型不收参考图，故事板未带入",
    };
  return {
    state: dramaBoardMeta(node.data)?.sourceHash === selection.sourceHash ? "image" : "stale",
    thumbnail,
    shotCount: dramaBoardMeta(node.data)?.shotCount,
    reason: "",
  };
}

export function dramaVideoInput(
  prompt: string,
  seconds: number,
  ratio: string,
  options: Options,
  graph: ProjectCanvasView,
  assets: ProjectAsset[],
  jobs: GenerationJob[],
  selection?: BoardSelection,
  resolution?: string,
) {
  const sources = new Map<string, CreativeData>();
  const labels = new Map(
    parsePrompt(prompt).flatMap((part) =>
      part.type === "ref" ? [[part.id, part.label] as const] : [],
    ),
  );
  const ready = new Map(
    assets.filter((asset) => asset.availability === "ready").map((asset) => [asset.assetId, asset]),
  );
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const ordinary: string[] = [];
  const portraits: string[] = [];
  const voices: string[] = [];
  const extras: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  for (const [id, label] of labels) {
    const node = nodes.get(id);
    const meta = node?.type === "creative" && dramaAssetMeta(node.data);
    if (
      node?.type !== "creative" ||
      (!meta && node.data.kind !== "audio") ||
      (meta && meta.type === "character" && !node.data.character)
    ) {
      notices.push(`引用已失效：${label}`);
      continue;
    }
    const data = node.data;
    const running = jobs.filter((job) => job.nodeId === id && !jobIsTerminal(job.status));
    const assetId = running.some((job) => job.purpose !== "character-voice")
      ? undefined
      : data.assetId;
    sources.set(id, { ...data, assetId });
    if (data.character) {
      if (assetId && ready.get(assetId)?.mediaType === "image") portraits.push(assetId);
      else if (data.character.voice) errors.push(`${label} 缺少可用的角色主图`);
      extras.push(
        ...data.character.extraAssetIds.filter((extra) => ready.get(extra)?.mediaType === "image"),
      );
      const voice = data.character.voice?.assetId;
      if (voice && ready.get(voice)?.mediaType === "audio") voices.push(voice);
      else if (voice) errors.push(`${label} 的音色不可用`);
      if (running.some((job) => job.purpose === "character-voice"))
        errors.push(`${label} 的声音仍在生成`);
    } else if (assetId && ready.get(assetId)?.mediaType === data.kind) ordinary.push(assetId);
  }
  const modes = options.modes ?? modelGenerationModes("video", options);
  const board = boardView(graph, ready, modes, options.references.image ?? 0, selection);
  const withBoard = board.state === "image" || board.state === "stale";
  if (board.state === "stale") notices.push("故事板已过期，原稿在出图之后改过");
  const required = [
    ...new Set([
      ...(withBoard && board.thumbnail ? [board.thumbnail] : []),
      ...ordinary,
      ...portraits,
      ...voices,
    ]),
  ];
  const hasImage = required.some((id) => ready.get(id)?.mediaType === "image");
  const hasAudio = required.some((id) => ready.get(id)?.mediaType === "audio");
  const desired =
    (hasImage || hasAudio) && modes.includes("omni")
      ? "omni"
      : hasImage && modes.includes("i2v")
        ? "i2v"
        : modes.includes("t2v")
          ? "t2v"
          : modes[0];
  const op = desired === "t2v" || desired === "i2v" || desired === "omni" ? desired : undefined;
  const chosen: ProjectAsset[] = [];
  const imageLimit =
    op === "i2v" ? options.frameLimit : op === "omni" ? (options.references.image ?? 0) : 0;
  const audioLimit = op === "omni" ? (options.references.audio ?? 0) : 0;
  for (const id of new Set([...required, ...extras])) {
    const asset = ready.get(id)!;
    const limit = asset.mediaType === "audio" ? audioLimit : imageLimit;
    if (
      chosen.length >= options.referenceLimit ||
      chosen.filter((entry) => entry.mediaType === asset.mediaType).length >= limit
    ) {
      if (asset.mediaType === "audio") errors.push("当前模型或生成方式无法带入全部参考音频");
      else if (portraits.includes(id) || (ordinary.includes(id) && imageLimit > 0)) {
        const reason = portraits.includes(id)
          ? "参考图数量超过模型上限，角色主图无法带入"
          : `参考图最多 ${imageLimit} 个，请移除多余的`;
        errors.push(withBoard ? `${reason}（含故事板 1 张，可以在参考素材里关掉故事板）` : reason);
      } else notices.push(`参考图最多 ${imageLimit} 张，部分图片未带入`);
    } else chosen.push(asset);
  }
  if (hasAudio && options.defaultParameters.generateAudio === false)
    errors.push("使用参考音频时请开启声音生成");
  const durations = options.durations
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const range = options.durationRange;
  const duration = durations.length
    ? (durations.find((value) => value >= seconds) ?? durations.at(-1))
    : range
      ? Math.max(range.min, Math.min(range.max, seconds))
      : options.manualDuration
        ? Math.min(30, seconds)
        : undefined;
  if (!prompt.trim()) errors.push("请填写提示词");
  if (op === "omni" && !chosen.length) errors.push("至少需要一个参考素材");
  if (
    (op === "i2v" || options.requiresImage) &&
    !chosen.some((asset) => asset.mediaType === "image")
  )
    errors.push("当前模型需要参考图");
  if (duration && duration !== seconds)
    notices.push(`片段 ${seconds}s 超出模型范围，按 ${duration}s 生成`);
  const chosenIds = new Set(chosen.map((asset) => asset.assetId));
  const refs = [...labels].map(([id, label]) => {
    const source = sources.get(id);
    const used = source?.assetId && chosenIds.has(source.assetId);
    const voice = source?.character?.voice?.assetId;
    return {
      id,
      label,
      kind:
        (source && dramaAssetMeta(source)?.type) ?? (source?.kind === "audio" ? "audio" : "scene"),
      thumbnail:
        source?.assetId && ready.get(source.assetId)?.mediaType === "image"
          ? source.assetId
          : undefined,
      voiceId: voice && chosenIds.has(voice) ? voice : undefined,
      state: !source
        ? "已失效"
        : !used
          ? "只用文字"
          : source.kind === "audio"
            ? "参考音频"
            : "参考图",
      truncated: source?.character?.extraAssetIds.some(
        (extra) => ready.has(extra) && !chosenIds.has(extra),
      ),
      voice: voice ? (chosenIds.has(voice) ? "音色" : "声音未带入") : undefined,
    };
  });
  const counts = {
    images: chosen.filter((asset) => asset.mediaType === "image").length,
    imageMax: options.references.image ?? 0,
    audios: chosen.filter((asset) => asset.mediaType === "audio").length,
    audioMax: options.references.audio ?? 0,
  };
  const line =
    withBoard && chosen[0]?.assetId === board.thumbnail
      ? boardLine(board.shotCount ?? 0, ratio, promptLang(prompt))
      : "";
  return {
    boardLine: line,
    board,
    refs,
    counts,
    notices: [...new Set(notices)],
    errors: [...new Set(errors)],
    input: {
      prompt: composeLinkedPrompt(line ? `${line}\n${prompt}` : prompt, sources, true, chosen),
      referenceAssetIds: chosen.map((asset) => asset.assetId),
      op,
      ...(duration && { duration }),
      ...(resolution &&
        !options.hiddenParameters.includes("resolution") &&
        options.resolutions.includes(resolution) && { resolution }),
      ...(options.ratios.includes(ratio) && { aspectRatio: ratio }),
    },
  };
}
