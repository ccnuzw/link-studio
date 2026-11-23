import {
  type ArrangeMode,
  type CanvasEdge,
  type CreativeData,
  cloneDirectorScene,
  type EditableCanvasNode,
  layoutPositions,
  type ProjectCanvasView,
  remapShotLinks,
  restoreMediaVersion,
} from "@link-studio/core";
import type { UploadHistoryData } from "./upload-history";

export type { ArrangeMode } from "@link-studio/core";

type Creative = Extract<EditableCanvasNode, { type: "creative" }>;
type Position = Creative["position"];
type Size = { width: number; height: number };
type MeasuredNode = Omit<Creative, "data"> &
  Partial<Size> & { measured?: Partial<Size>; data: CreativeData };

export function arrangeSelection(
  nodes: MeasuredNode[],
  parents: ReadonlyMap<string, Position>,
  mode: ArrangeMode,
) {
  const selected = nodes.map(({ id, position, measured, width, height, parentId }) => {
    const parent = parentId ? parents.get(parentId) : undefined;
    return {
      id,
      parent,
      x: position.x + (parent?.x ?? 0),
      y: position.y + (parent?.y ?? 0),
      width: measured?.width ?? width ?? 576,
      height: measured?.height ?? height ?? 324,
    };
  });
  const result = new Map<string, Position>();
  if (selected.length < 2) return result;
  const positions = layoutPositions(selected, mode);
  for (const node of selected) {
    const absolute = positions.get(node.id);
    if (!absolute) continue;
    const x = absolute.x - (node.parent?.x ?? 0);
    const y = absolute.y - (node.parent?.y ?? 0);
    if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return new Map<string, Position>();
    result.set(node.id, { x, y });
  }
  return result;
}

export type CanvasFragment = {
  nodes: EditableCanvasNode[];
  edges: CanvasEdge[];
  parentOrigins?: Map<string, Position>;
};

export function mapFragmentMedia(
  fragment: CanvasFragment,
  resolve: (id: string) => string,
): CanvasFragment {
  return {
    ...fragment,
    nodes: fragment.nodes.map((node) => {
      if (node.type === "group") return node;
      const data = node.data;
      return {
        ...node,
        data: {
          ...data,
          ...(data.assetId && { assetId: resolve(data.assetId) }),
          ...(data.outputs && {
            outputs: data.outputs.map((output) =>
              output.assetId ? { ...output, assetId: resolve(output.assetId) } : output,
            ),
          }),
          ...(data.manualReferenceIds && {
            manualReferenceIds: data.manualReferenceIds.map(resolve),
          }),
          ...(data.character && {
            character: {
              ...data.character,
              extraAssetIds: data.character.extraAssetIds.map(resolve),
              ...(data.character.voice && {
                voice: { ...data.character.voice, assetId: resolve(data.character.voice.assetId) },
              }),
            },
          }),
          ...(data.storyboard && {
            storyboard: data.storyboard.map((shot) =>
              shot.imageAssetId ? { ...shot, imageAssetId: resolve(shot.imageAssetId) } : shot,
            ),
          }),
          ...(data.directorThumbnailId && {
            directorThumbnailId: resolve(data.directorThumbnailId),
          }),
        },
      };
    }),
  };
}

export function detachExternalNodes(fragment: CanvasFragment): CanvasFragment {
  const copied = new Set(fragment.nodes.map((node) => node.id));
  return {
    edges: fragment.edges.filter((edge) => copied.has(edge.source)),
    nodes: fragment.nodes.map((node) => {
      if (node.type === "group" || !node.parentId || copied.has(node.parentId)) return node;
      const { parentId, ...orphan } = node,
        parent = fragment.parentOrigins?.get(parentId);
      return {
        ...orphan,
        position: { x: node.position.x + (parent?.x ?? 0), y: node.position.y + (parent?.y ?? 0) },
      };
    }),
  };
}

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
  return {
    nodes: nodes
      .filter((node) => node.type !== "unknown")
      .map((node) => {
        if (node.type !== "creative" || !node.data.uploaded) return node;
        const {
          uploadFailed: _failed,
          uploadPending: _pending,
          ...data
        }: UploadHistoryData = node.data;
        return { ...node, data };
      }),
    parentOrigins: parents,
    edges: canvas.edges.filter(({ target, readOnly }) => !readOnly && targets.has(target)),
  } satisfies CanvasFragment;
}

export function cloneSelection(
  fragment: CanvasFragment,
  canvas: ProjectCanvasView,
  newId: () => string,
  placement?: Position,
  offset = 32,
) {
  const ids = new Map(fragment.nodes.map(({ id }) => [id, newId()]));
  const current = new Map(canvas.nodes.map((node) => [node.id, node]));
  const labels = new Set(canvas.nodes.map(({ data }) => data.label));
  const outer = fragment.nodes.filter(
    (node) => !(node.type === "creative" && node.parentId && ids.has(node.parentId)),
  );
  const origin = (node: EditableCanvasNode) =>
    node.type === "creative" && node.parentId
      ? (current.get(node.parentId)?.position ?? fragment.parentOrigins?.get(node.parentId))
      : undefined;
  const left = Math.min(...outer.map((node) => node.position.x + (origin(node)?.x ?? 0)));
  const top = Math.min(...outer.map((node) => node.position.y + (origin(node)?.y ?? 0)));
  const clamp = (value: number) => Math.min(1e7, Math.max(-1e7, value));
  const nodes = fragment.nodes.map((node): EditableCanvasNode => {
    const parentId = node.type === "creative" ? node.parentId : undefined;
    const clonedParent = parentId ? ids.get(parentId) : undefined;
    const preservedParent =
      parentId && current.get(parentId)?.type === "group" ? parentId : undefined;
    const orphanOffset = !preservedParent ? origin(node) : undefined;
    const label = copyLabel(node.data.label, labels);
    const position = clonedParent
      ? node.position
      : {
          x: clamp(
            node.position.x + (placement ? placement.x - left : offset) + (orphanOffset?.x ?? 0),
          ),
          y: clamp(
            node.position.y + (placement ? placement.y - top : offset) + (orphanOffset?.y ?? 0),
          ),
        };
    const shared = { id: ids.get(node.id) as string, position };
    return node.type === "group"
      ? { ...node, ...shared, data: { ...node.data, label } }
      : {
          ...shared,
          type: "creative",
          data: {
            ...restoreMediaVersion(node.data),
            label,
            ...(node.data.director && {
              director: cloneDirectorScene(node.data.director, newId),
              directorThumbnailId: undefined,
            }),
            ...(node.data.storyboard && {
              storyboard: node.data.storyboard.map((shot) => remapShotLinks(shot, ids)),
            }),
          },
          ...(clonedParent || preservedParent ? { parentId: clonedParent ?? preservedParent } : {}),
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
  const base = original.replace(/\s副本[一二三四五六七八九十\d]*$/, "") || original;
  const digits = "零一二三四五六七八九";
  for (let index = 1; ; index++) {
    const number =
      index < 10
        ? digits[index]
        : index < 100
          ? `${index < 20 ? "" : digits[Math.floor(index / 10)]}十${index % 10 ? digits[index % 10] : ""}`
          : index;
    const suffix = index === 1 ? " 副本" : ` 副本${number}`;
    const label = [...base].slice(0, 40 - suffix.length).join("") + suffix;
    if (used.has(label)) continue;
    used.add(label);
    return label;
  }
}
