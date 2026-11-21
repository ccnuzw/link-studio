import type {
  CanvasEdge,
  CreativeData,
  EditableCanvasNode,
  ProjectCanvasView,
} from "@link-studio/core";

type Creative = Extract<EditableCanvasNode, { type: "creative" }>;
type Position = Creative["position"];
type Size = { width: number; height: number };
type MeasuredNode = Omit<Creative, "data"> & { measured?: Partial<Size>; data: CreativeData };
export type ArrangeMode = "row" | "column" | "grid";

export function arrangeSelection(
  nodes: MeasuredNode[],
  parents: ReadonlyMap<string, Position>,
  mode: ArrangeMode,
) {
  const selected = nodes.map(({ id, position, measured, parentId }) => {
    const parent = parentId ? parents.get(parentId) : undefined;
    return {
      id,
      parent,
      x: position.x + (parent?.x ?? 0),
      y: position.y + (parent?.y ?? 0),
      width: measured?.width ?? 280,
      height: measured?.height ?? 200,
    };
  });
  const result = new Map<string, Position>();
  if (selected.length < 2) return result;
  const left = Math.min(...selected.map(({ x }) => x));
  const top = Math.min(...selected.map(({ y }) => y));
  selected.sort((first, second) =>
    mode === "row"
      ? first.x - second.x || first.y - second.y
      : first.y - second.y || first.x - second.x,
  );
  const columns =
    mode === "row"
      ? selected.length
      : mode === "column"
        ? 1
        : Math.ceil(Math.sqrt(selected.length));
  const widths: number[] = [];
  const heights: number[] = [];
  for (const [index, node] of selected.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    widths[column] = Math.max(widths[column] ?? 0, node.width);
    heights[row] = Math.max(heights[row] ?? 0, node.height);
  }
  for (const [index, node] of selected.entries()) {
    const x =
      left +
      widths.slice(0, index % columns).reduce((sum, width) => sum + width + 120, 0) -
      (node.parent?.x ?? 0);
    const y =
      top +
      heights.slice(0, Math.floor(index / columns)).reduce((sum, height) => sum + height + 80, 0) -
      (node.parent?.y ?? 0);
    if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return new Map<string, Position>();
    result.set(node.id, { x, y });
  }
  return result;
}

export type CanvasFragment = { nodes: EditableCanvasNode[]; edges: CanvasEdge[] };

export function captureSelection(canvas: ProjectCanvasView, selection: ReadonlySet<string>) {
  const nodes = canvas.nodes.filter(
    (node) =>
      selection.has(node.id) ||
      ("parentId" in node && !!node.parentId && selection.has(node.parentId)),
  );
  if (!nodes.length || nodes.some((node) => node.type === "unknown")) return undefined;
  const targets = new Set(nodes.map(({ id }) => id));
  const parents = new Map(
    canvas.nodes.filter((node) => node.type === "group").map(({ id, position }) => [id, position]),
  );
  const editable = nodes.flatMap((node): EditableCanvasNode[] => {
    if (node.type === "unknown") return [];
    if (node.type !== "creative" || !node.parentId || targets.has(node.parentId)) return [node];
    const { parentId, position, ...child } = node;
    const parent = parents.get(parentId);
    return [
      {
        ...child,
        position: { x: position.x + (parent?.x ?? 0), y: position.y + (parent?.y ?? 0) },
      },
    ];
  });
  return {
    nodes: editable,
    edges: canvas.edges.filter(({ target, readOnly }) => !readOnly && targets.has(target)),
  } satisfies CanvasFragment;
}

export function cloneSelection(
  fragment: CanvasFragment,
  canvas: ProjectCanvasView,
  newId: () => string,
  placement?: Position,
) {
  const ids = new Map(fragment.nodes.map(({ id }) => [id, newId()]));
  const current = new Map(canvas.nodes.map((node) => [node.id, node]));
  const labels = new Set(canvas.nodes.map(({ data }) => data.label));
  const outer = fragment.nodes.filter(
    (node) => !(node.type === "creative" && node.parentId && ids.has(node.parentId)),
  );
  const left = Math.min(...outer.map(({ position }) => position.x));
  const top = Math.min(...outer.map(({ position }) => position.y));
  const clamp = (value: number) => Math.min(1e7, Math.max(-1e7, value));
  const nodes = fragment.nodes.map((node): EditableCanvasNode => {
    const parentId = node.type === "creative" ? node.parentId : undefined;
    const clonedParent = parentId ? ids.get(parentId) : undefined;
    const label = copyLabel(node.data.label, labels);
    const position = clonedParent
      ? node.position
      : {
          x: clamp(node.position.x + (placement ? placement.x - left : 32)),
          y: clamp(node.position.y + (placement ? placement.y - top : 32)),
        };
    const shared = { id: ids.get(node.id) as string, position };
    return node.type === "group"
      ? { ...node, ...shared, data: { label } }
      : {
          ...shared,
          type: "creative",
          data: { ...node.data, label },
          ...(clonedParent ? { parentId: clonedParent } : {}),
        };
  });
  const edges = fragment.edges.flatMap(({ source, target }) => {
    const from = ids.get(source) ?? (current.get(source)?.type === "creative" ? source : undefined);
    const to = ids.get(target);
    return from && to ? [{ id: newId(), source: from, target: to }] : [];
  });
  return { nodes, edges };
}

function copyLabel(original: string, used: Set<string>) {
  const base = original.replace(/ 副本(?: \d+)?$/, "") || original;
  for (let index = 1; ; index++) {
    const suffix = index === 1 ? " 副本" : ` 副本 ${index}`;
    const label = base.slice(0, 255 - suffix.length).replace(/[\uD800-\uDBFF]$/, "") + suffix;
    if (used.has(label)) continue;
    used.add(label);
    return label;
  }
}
