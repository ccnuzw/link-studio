import type { ProjectAsset, ProjectCanvasView } from "@link-studio/core";
import { linkKind } from "./link-rules";
import { MOTION_PRESETS, STYLE_PRESETS, TEMPLATE_PRESETS } from "./media-preset-data";
import { expandPrompt } from "./prompt-tokens";

const presetsByKind = { style: STYLE_PRESETS, motion: MOTION_PRESETS, tpl: TEMPLATE_PRESETS };
const mediaNames = { image: "图片", video: "视频", audio: "音频" };

export function composeCanvasPrompt(
  draft: string,
  graph: ProjectCanvasView,
  targetId: string,
  attachments: readonly Pick<ProjectAsset, "assetId" | "mediaType">[],
  runningNodes?: ReadonlySet<string>,
  referenceRunningNodes?: ReadonlySet<string>,
) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const target = byId.get(targetId);
  const sources = new Map(
    graph.edges.flatMap((edge) => {
      const node = byId.get(edge.source);
      if (edge.readOnly || edge.target !== targetId || node?.type !== "creative") return [];
      const data =
        runningNodes?.has(node.id) && linkKind(node.data) === "script"
          ? { ...node.data, text: "" }
          : referenceRunningNodes?.has(node.id)
            ? { ...node.data, assetId: undefined }
            : node.data;
      return [[node.id, data] as const];
    }),
  );
  return composeLinkedPrompt(
    draft,
    sources,
    target?.type === "creative" && target.data.kind === "video",
    attachments,
  );
}

type CreativeData = Extract<ProjectCanvasView["nodes"][number], { type: "creative" }>["data"];

export function composeLinkedPrompt(
  draft: string,
  sources: ReadonlyMap<string, CreativeData>,
  video: boolean,
  attachments: readonly Pick<ProjectAsset, "assetId" | "mediaType">[],
  syntax: "canvas" | "agent" = "canvas",
) {
  const cited = new Set<string>();
  const indexOf = (kind: keyof typeof mediaNames, assetId?: string) =>
    attachments
      .filter((asset) => asset.mediaType === kind)
      .findIndex((asset) => asset.assetId === assetId);
  const visuals: string[] = [];
  const voices: string[] = [];
  const names = new Map<string, string>();
  if (video) {
    for (const [id, data] of sources) {
      const role = data.character;
      const image = indexOf("image", data.assetId);
      if (!role || image < 0) continue;
      const subject = `${role.name}（图片${image + 1}中的人物）`;
      names.set(id, subject);
      const extras = [
        ...new Set(
          role.extraAssetIds
            .map((assetId) => indexOf("image", assetId))
            .filter((index) => index >= 0 && index !== image),
        ),
      ];
      visuals.push(
        `${role.name}：图片${image + 1}中的人物${extras.length ? `，补充视角：${extras.map((index) => `图片${index + 1}`).join("、")}` : ""}。`,
      );
      const audio = indexOf("audio", role.voice?.assetId);
      if (audio >= 0) voices.push(`${subject}说话时，音色参考音频${audio + 1}。`);
    }
  }
  const expand = (text: string, allowText: boolean, speechOnly = false): string => {
    const quotes = text.matchAll(/“[^”\n]*”|「[^」\n]*」|"[^"\n]*"/g);
    let quote = quotes.next().value;
    const resolve = (reference: string, label: string, offset: number): string => {
      while (quote && offset >= quote.index + quote[0].length) quote = quotes.next().value;
      const speech = speechOnly || !!(quote && offset > quote.index);
      const id =
        syntax === "agent" || sources.has(reference) ? reference : reference.replace(/^node:/, "");
      const data = sources.get(id);
      if (!data) return label;
      const kind = linkKind(data);
      if (kind === "script" && allowText) {
        cited.add(id);
        return expand(data.text.trim() || label, false, speech || syntax === "agent");
      }
      if (kind === "storyboard" || kind === "director" || kind === "script") return label;
      if (kind === "character")
        return names.get(id) || data.character?.name || (syntax === "agent" ? data.label : label);
      if (speech) return label;
      const index = indexOf(kind, data.assetId);
      return index >= 0 ? `${mediaNames[kind]}${index + 1}` : label;
    };
    if (syntax === "agent")
      return text.replace(
        /@\[([^\]\n]*)\]\((?:node:)?([^)\s]+)\)/g,
        (_token, label: string, id: string, offset: number) => resolve(id, label, offset),
      );
    return expandPrompt(
      text,
      resolve,
      (kind, id) => presetsByKind[kind].find((preset) => preset.id === id)?.prompt,
    );
  };
  const parts = [expand(draft, true).trim()];
  for (const [id, data] of sources) {
    if (!cited.has(id) && linkKind(data) === "script" && data.text.trim())
      parts.push(expand(data.text.trim(), false, true));
  }
  if (!parts.some(Boolean)) return "";
  if (visuals.length) parts.push(`【人物参考】\n${visuals.join("\n")}`);
  if (voices.length)
    parts.push(
      `【人物音色对应】\n${voices.join("\n")}\n角色声音样本只用于音色参考，本次台词以剧情为准。`,
    );
  return parts.filter(Boolean).join("\n\n");
}
