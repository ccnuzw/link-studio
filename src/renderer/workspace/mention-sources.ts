import type { ProjectAsset, ProjectCanvasView } from "@link-studio/core";
import { canLinkKinds, type LinkKind, linkKind } from "./link-rules";

export type MentionSource = {
  id: string;
  label: string;
  kind: LinkKind;
  assetId?: string;
  text?: string;
};

export function mentionSources(
  graph: ProjectCanvasView,
  targetId: string,
  assets: readonly ProjectAsset[],
  running: ReadonlySet<string>,
  accepts: (kind: LinkKind) => boolean,
) {
  const byId = new Map<string, MentionSource>();
  const linked = new Set<string>();
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.readOnly) continue;
    if (edge.target === targetId) linked.add(edge.source);
    const next = children.get(edge.source) ?? [];
    next.push(edge.target);
    children.set(edge.source, next);
  }
  const downstream = new Set([targetId]);
  for (const id of downstream) for (const child of children.get(id) ?? []) downstream.add(child);
  const target = graph.nodes.find((node) => node.id === targetId);
  const ready = new Set(
    assets.filter((asset) => asset.availability === "ready").map((asset) => asset.assetId),
  );
  const candidates = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== "creative") continue;
    const { character, text, assetId, label } = node.data;
    const kind = linkKind(node.data);
    if (kind === "storyboard") {
      linked.delete(node.id);
      continue;
    }
    byId.set(node.id, {
      id: node.id,
      kind,
      assetId,
      ...(kind === "script" && { text }),
      label: character ? [character.name, character.look].filter(Boolean).join(" · ") : label,
    });
    if (
      target?.type !== "creative" ||
      target.data.uploaded ||
      node.id === targetId ||
      !canLinkKinds(kind, linkKind(target.data)) ||
      !accepts(kind)
    )
      continue;
    if (
      character ||
      (!running.has(node.id) && (kind === "script" ? text.trim() : assetId && ready.has(assetId)))
    )
      candidates.add(node.id);
  }
  return {
    byId,
    linked,
    entries: [...new Set([...linked, ...candidates])].flatMap((id) => {
      const source = byId.get(id);
      return source && candidates.has(id) && (linked.has(id) || !downstream.has(id))
        ? [{ source, linked: linked.has(id) }]
        : [];
    }),
  };
}
