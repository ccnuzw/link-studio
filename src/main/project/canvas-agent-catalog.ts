import { requirePresent } from "@link-studio/core";
import type { ProjectCanvasView } from "../../../packages/link-studio-core/src/canvas.ts";

export function agentCanvasCatalog(
  canvas: ProjectCanvasView,
  selection: string[],
  redact: (text: string) => string,
) {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const members = new Map<string, string[]>();
  for (const node of canvas.nodes) {
    if (!("parentId" in node) || !node.parentId) continue;
    const group = members.get(node.parentId) ?? [];
    group.push(node.id);
    members.set(node.parentId, group);
  }

  function describeNode(node: ProjectCanvasView["nodes"][number]) {
    const label = redact(node.data.label);
    if (node.type !== "creative") return { id: node.id, type: node.type, label };
    const { data } = node;
    const kind = data.director
      ? "director"
      : data.storyboard
        ? "storyboard"
        : data.character
          ? "character"
          : data.kind;
    return { id: node.id, type: "canvas", kind, label };
  }

  const selectedIds = [...new Set(selection)].filter((id) => byId.has(id));
  const selected = selectedIds.map((id) => {
    const node = requirePresent(byId.get(id), "byId.get(id)");
    const children = members.get(id) ?? [];
    return {
      ...describeNode(node),
      ...(node.type === "group" && children.length > 0 && { memberIds: children.slice(0, 50) }),
      ...(node.type === "group" && children.length > 50 && { moreMembers: children.length - 50 }),
    };
  });
  const ordered = new Set([...selectedIds, ...byId.keys()]);
  const nodes = [...ordered].slice(0, 200).map((id) => {
    const node = requirePresent(byId.get(id), "byId.get(id)");
    const description = describeNode(node);
    if (node.type !== "creative") {
      const count = members.get(id)?.length ?? 0;
      return { ...description, ...(count && { members: count }), hasOutput: false };
    }
    const { data } = node;
    const shots = data.storyboard;
    const summary = shots
      ? shots.length
        ? `${shots.length} 镜 · ${requirePresent(shots[0], "shots[0]").scene}`
        : "0 镜"
      : data.text;
    const runes = Array.from(redact(summary));
    const prompt = runes.length > 60 ? `${runes.slice(0, 60).join("")}…` : runes.join("");
    return {
      ...description,
      ...(node.parentId && { group: node.parentId }),
      ...(data.textStatus && { status: data.textStatus }),
      hasOutput: Boolean(data.assetId || data.outputs?.length),
      ...(prompt && { prompt }),
    };
  });
  return {
    nodes: nodes.length ? nodes : null,
    total: byId.size,
    omitted: byId.size - nodes.length,
    edgeCount: canvas.edges.length,
    ...(selected.length && { selected }),
  };
}
