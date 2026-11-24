import type {
  CanvasOperation,
  EditableCanvasNode,
  ProjectCanvasView,
} from "../../../packages/link-studio-core/src/canvas.ts";
import type { CanvasAgentArrange } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import {
  type LayoutRect,
  layoutPositions,
} from "../../../packages/link-studio-core/src/canvas-layout.ts";
import {
  imageDisplaySize,
  parseCanvasAspect,
} from "../../../packages/link-studio-core/src/image-display-size.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { ProjectError } from "./errors.ts";

function invalid(message: string): never {
  throw new ProjectError("CANVAS_OPERATION_INVALID", message);
}

function intersects(first: LayoutRect, second: LayoutRect, gapX = 0, gapY = 0) {
  return (
    first.x < second.x + second.width + gapX &&
    second.x < first.x + first.width + gapX &&
    first.y < second.y + second.height + gapY &&
    second.y < first.y + first.height + gapY
  );
}

export function canvasBounds(
  node: EditableCanvasNode,
  current: (id: string) => EditableCanvasNode | undefined,
  assets: ProjectState["assets"],
): LayoutRect {
  if (node.type === "group")
    return {
      ...node.position,
      width: Math.max(200, node.width),
      height: Math.max(140, node.height),
    };
  const parent = (node.parentId ? current(node.parentId)?.position : undefined) ?? { x: 0, y: 0 };
  const metadata = node.data.assetId && assets[node.data.assetId]?.metadata;
  const dimensions = imageDisplaySize(metadata || {});
  const params = node.data.generation?.params;
  const ratio =
    node.data.kind === "audio"
      ? 1
      : ([
          node.data.mediaAspect,
          node.data.kind === "video" && metadata ? Number(metadata.displayAspect) : undefined,
          dimensions.width / dimensions.height,
          parseCanvasAspect(params?.aspectRatio),
          parseCanvasAspect(params?.customParams?.aspect_ratio),
          parseCanvasAspect(params?.customParams?.ratio),
        ].find(
          (aspect): aspect is number =>
            typeof aspect === "number" && aspect > 0 && Number.isFinite(aspect),
        ) ?? 16 / 9);
  return {
    x: node.position.x + parent.x,
    y: node.position.y + parent.y,
    width: Math.round(324 * Math.max(1, ratio)),
    height: Math.round(324 / Math.min(1, ratio)),
  };
}

export function groupFrame(members: LayoutRect[]) {
  const x = Math.min(...members.map((member) => member.x)) - 48;
  const y = Math.min(...members.map((member) => member.y)) - 72;
  return {
    x,
    y,
    width: Math.max(200, Math.max(...members.map((member) => member.x + member.width)) + 48 - x),
    height: Math.max(140, Math.max(...members.map((member) => member.y + member.height)) + 48 - y),
  };
}

export function compileArrange(
  canvas: ProjectCanvasView,
  target: CanvasAgentArrange,
  assets: ProjectState["assets"],
) {
  const nodes = new Map(
    canvas.nodes.filter((node) => node.type !== "unknown").map((node) => [node.id, node]),
  );
  const children = (parentId: string) =>
    [...nodes.values()].filter((node) => node.type === "creative" && node.parentId === parentId);
  if (target.groupId && nodes.get(target.groupId)?.type !== "group") invalid("指定的组不存在");
  const ids = target.groupId ? children(target.groupId).map((node) => node.id) : target.nodeIds;
  if (!ids?.length) invalid("请选择组或节点");
  const current = (id: string) => nodes.get(id) ?? invalid("节点不存在或不可编辑");
  const rect = (node: EditableCanvasNode) => canvasBounds(node, current, assets);
  const groups = new Set<string>();
  const positions = layoutPositions(
    ids.map((id) => {
      const node = current(id);
      if (node.type !== "creative") invalid("整理组成员请指定 groupId");
      if (node.parentId) groups.add(node.parentId);
      return { id, ...rect(node) };
    }),
    target.layout,
  );
  for (const [id, absolute] of positions) {
    const node = current(id);
    const parent =
      node.type === "creative" && node.parentId ? current(node.parentId).position : { x: 0, y: 0 };
    nodes.set(id, { ...node, position: { x: absolute.x - parent.x, y: absolute.y - parent.y } });
  }
  const warnings = refitAndPushGroups(canvas, nodes, groups, assets);
  const operations: CanvasOperation[] = [];
  for (const original of canvas.nodes) {
    const next = nodes.get(original.id);
    if (
      !next ||
      (next.position.x === original.position.x &&
        next.position.y === original.position.y &&
        !(
          next.type === "group" &&
          original.type === "group" &&
          (next.width !== original.width || next.height !== original.height)
        ))
    )
      continue;
    operations.push({ type: "putNode", node: next });
  }
  return { operations, touched: [], created: {}, warnings };
}

export function freeCanvasPosition(
  nodes: Iterable<EditableCanvasNode>,
  waiting: Set<string>,
  bounds: (node: EditableCanvasNode) => LayoutRect,
) {
  let right = -Infinity;
  let top = Infinity;
  for (const node of nodes) {
    if (waiting.has(node.id) || (node.type === "creative" && node.parentId)) continue;
    const rect = bounds(node);
    right = Math.max(right, rect.x + rect.width);
    top = Math.min(top, rect.y);
  }
  return top === Infinity ? { x: 0, y: 0 } : { x: right + 120, y: top };
}

export function refitAndPushGroups(
  canvas: ProjectCanvasView,
  nodes: Map<string, EditableCanvasNode>,
  groups: Set<string>,
  assets: ProjectState["assets"],
  explicit = new Set<string>(),
  pending = new Set<string>(),
) {
  const current = (id: string) => nodes.get(id) ?? invalid("节点不存在或不可编辑");
  const rect = (node: EditableCanvasNode) => canvasBounds(node, current, assets);
  const grown = new Set<string>();
  const moved = new Set<string>();
  for (const groupId of groups) {
    const group = current(groupId);
    if (
      group.type !== "group" ||
      canvas.nodes.some((node) => node.type === "unknown" && node.parentId === groupId)
    )
      invalid("组含有不可编辑成员");
    const members = [...nodes.values()]
      .filter((node) => node.type === "creative" && node.parentId === groupId)
      .map((node) => ({ node, ...rect(node) }));
    if (!members.length) continue;
    const { x, y, width, height } = groupFrame(members);
    const original = canvas.nodes.find((node) => node.id === groupId);
    const old = original?.type === "group" ? rect(original) : undefined;
    if (
      !old ||
      x < old.x ||
      y < old.y ||
      x + width > old.x + old.width ||
      y + height > old.y + old.height
    )
      grown.add(groupId);
    nodes.set(groupId, { ...group, position: { x, y }, width, height });
    for (const member of members)
      nodes.set(member.node.id, { ...member.node, position: { x: member.x - x, y: member.y - y } });
  }
  for (const id of pending) {
    const node = current(id);
    nodes.set(id, { ...node, position: freeCanvasPosition(nodes.values(), pending, rect) });
    pending.delete(id);
  }
  if (grown.size) {
    const roots = [...nodes.values()]
      .filter((node) => node.type === "group" || !node.parentId)
      .sort(
        (first, second) =>
          first.position.x - second.position.x ||
          first.position.y - second.position.y ||
          (first.id < second.id ? -1 : 1),
      );
    const placed: (LayoutRect & { id: string })[] = [];
    const fixed = roots.filter((node) => explicit.has(node.id)).map(rect);
    for (const node of roots) {
      const bounds = rect(node);
      if (
        !explicit.has(node.id) &&
        placed.some((other) => grown.has(other.id) && intersects(bounds, other))
      ) {
        const blockers = [...fixed, ...placed.filter((other) => !explicit.has(other.id))];
        for (let index = 0; index < blockers.length; index++) {
          const blocker = blockers.find((other) => intersects(bounds, other, 120, 80));
          if (!blocker) break;
          if (bounds.x === blocker.x && bounds.y > blocker.y)
            bounds.y = blocker.y + blocker.height + 80;
          else bounds.x = blocker.x + blocker.width + 120;
        }
        nodes.set(node.id, { ...node, position: { x: bounds.x, y: bounds.y } });
        grown.add(node.id);
        moved.add(node.id);
      }
      placed.push({ id: node.id, ...bounds });
    }
  }
  if (!explicit.size && !groups.size && !moved.size) return [];
  const objects = [...nodes.values()].map((node) => {
    const parent = node.type === "creative" ? node.parentId : undefined;
    return {
      id: node.id,
      parent,
      root: parent && nodes.get(parent)?.type === "group" ? parent : node.id,
      rect: canvasBounds(node, (id) => nodes.get(id), assets),
      touched:
        explicit.has(node.id) ||
        groups.has(node.id) ||
        moved.has(node.id) ||
        (parent && moved.has(parent)),
    };
  });
  const pairs = new Map<string, [string, string]>();
  for (const first of objects) {
    if (!first.touched) continue;
    for (const second of objects) {
      if (first.id === second.id || first.id === second.parent || second.id === first.parent)
        continue;
      if (!intersects(first.rect, second.rect)) continue;
      const left = first.parent === second.parent ? first.id : first.root;
      const right = first.parent === second.parent ? second.id : second.root;
      const pair: [string, string] = left < right ? [left, right] : [right, left];
      pairs.set(pair.join("\0"), pair);
    }
  }
  const remaining = [...pairs.keys()].sort().map((key) => pairs.get(key)!);
  const counts = new Map<string, number>();
  const score = ([left, right]: [string, string]) =>
    (counts.get(left) ?? 0) + (counts.get(right) ?? 0);
  const warnings: string[] = [];
  while (remaining.length && warnings.length < 5) {
    let best = 0;
    for (let index = 1; index < remaining.length; index++) {
      if (score(remaining[index]!) < score(remaining[best]!)) best = index;
    }
    const [left, right] = remaining.splice(best, 1)[0]!;
    warnings.push(
      `「${current(left).data.label}」（${left}）与「${current(right).data.label}」（${right}）重叠；节点可用 move 或 canvas_arrange 调整；组与组之间重叠要对组逐个 move（canvas_apply_ops），canvas_arrange 只重排组内成员，不会移动组本身`,
    );
    for (const id of [left, right]) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return warnings;
}
