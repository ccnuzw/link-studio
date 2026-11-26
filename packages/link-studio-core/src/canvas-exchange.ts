import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CanvasEdge,
  CanvasGroup,
  CanvasViewport,
  CreativeCanvasNode,
  type EditableCanvasNode,
  type ProjectCanvasView,
  remapShotLinks,
  restoreMediaVersion,
} from "./canvas.ts";

const strict = { additionalProperties: false };
const ExchangeNode = Type.Union([CreativeCanvasNode, CanvasGroup]);
const ExchangeDocument = Type.Object(
  {
    format: Type.Literal("link-studio.canvas"),
    version: Type.Literal(1),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    exportedAt: Type.String({ minLength: 1, maxLength: 64 }),
    nodes: Type.Array(ExchangeNode, { maxItems: 1000 }),
    edges: Type.Array(CanvasEdge, { maxItems: 4000 }),
    viewport: CanvasViewport,
  },
  strict,
);

export type CanvasExchangeDocument = Static<typeof ExchangeDocument>;
export type CanvasExchangeReport = { missingAssetIds: string[]; droppedEdgeCount: number };

export function serializeCanvasExchange(canvas: ProjectCanvasView, title: string): string {
  const nodes = canvas.nodes.filter((node): node is EditableCanvasNode => node.type !== "unknown");
  const ids = new Set(nodes.map(({ id }) => id));
  const edges = canvas.edges.filter(
    (edge) => !edge.readOnly && ids.has(edge.source) && ids.has(edge.target),
  );
  return JSON.stringify(
    {
      format: "link-studio.canvas",
      version: 1,
      title: title.trim().slice(0, 200) || "未命名画布",
      exportedAt: new Date().toISOString(),
      nodes: nodes.map((node) =>
        node.type === "creative" ? { ...node, data: restoreMediaVersion(node.data) } : node,
      ),
      edges,
      viewport: canvas.viewport,
    } satisfies CanvasExchangeDocument,
    null,
    2,
  );
}

export function parseCanvasExchange(value: unknown): CanvasExchangeDocument {
  if (!Value.Check(ExchangeDocument, value)) throw new Error("画布交换文件格式无效或版本不支持");
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (ids.has(node.id)) throw new Error("画布交换文件包含重复节点");
    ids.add(node.id);
  }
  const groups = new Set(value.nodes.filter((node) => node.type === "group").map(({ id }) => id));
  for (const node of value.nodes) {
    if (node.type === "creative" && node.parentId && !groups.has(node.parentId))
      throw new Error("画布交换文件包含无效父组");
  }
  const edges = new Set<string>();
  const connections = new Set<string>();
  const creativeIds = new Set(
    value.nodes.filter((node) => node.type === "creative").map(({ id }) => id),
  );
  for (const edge of value.edges) {
    if (
      edges.has(edge.id) ||
      edge.source === edge.target ||
      !ids.has(edge.source) ||
      !ids.has(edge.target) ||
      !creativeIds.has(edge.source) ||
      !creativeIds.has(edge.target) ||
      connections.has(`${edge.source}\u0000${edge.target}`)
    )
      throw new Error("画布交换文件包含无效连线");
    edges.add(edge.id);
    connections.add(`${edge.source}\u0000${edge.target}`);
  }
  return value;
}

export function prepareCanvasExchange(
  document: CanvasExchangeDocument,
  availableAssetIds: ReadonlySet<string>,
): { document: CanvasExchangeDocument; report: CanvasExchangeReport } {
  const missing = new Set<string>();
  const nodes = document.nodes.map((entry) => {
    if (entry.type !== "creative") return entry;
    const node = { ...entry, data: restoreMediaVersion(entry.data) };
    const {
      assetId,
      outputs: savedOutputs,
      activeOutputId,
      directorThumbnailId,
      character,
      ...data
    } = node.data;
    const validAssetId = assetId && availableAssetIds.has(assetId) ? assetId : undefined;
    if (assetId && !validAssetId) missing.add(assetId);
    const outputs = (savedOutputs ?? []).filter((output) => {
      if (!output.assetId) return true;
      if (availableAssetIds.has(output.assetId)) return true;
      missing.add(output.assetId);
      return false;
    });
    const active = outputs.find(({ id }) => id === activeOutputId);
    const present = (id: string) => {
      if (availableAssetIds.has(id)) return true;
      missing.add(id);
      return false;
    };
    const preparedCharacter =
      character &&
      (() => {
        const { voice, ...characterData } = character;
        return {
          ...characterData,
          extraAssetIds: character.extraAssetIds.filter(present),
          ...(voice && present(voice.assetId) && { voice }),
        };
      })();
    return {
      ...node,
      data: {
        ...data,
        ...(directorThumbnailId && present(directorThumbnailId) && { directorThumbnailId }),
        ...(node.data.manualReferenceIds && {
          manualReferenceIds: node.data.manualReferenceIds.filter(present),
        }),
        ...(node.data.storyboard && {
          storyboard: node.data.storyboard.map(({ imageAssetId, ...shot }) =>
            imageAssetId && present(imageAssetId) ? { ...shot, imageAssetId } : shot,
          ),
        }),
        ...(validAssetId && { assetId: validAssetId }),
        ...(outputs.length > 0 && { outputs }),
        ...(active && { activeOutputId: active.id }),
        ...(preparedCharacter && { character: preparedCharacter }),
      },
    };
  });
  return {
    document: { ...document, nodes },
    report: { missingAssetIds: [...missing], droppedEdgeCount: 0 },
  };
}

export function mergeCanvasExchange(
  current: ProjectCanvasView,
  imported: CanvasExchangeDocument,
  newId: () => string,
): ProjectCanvasView {
  const ids = new Map(imported.nodes.map(({ id }) => [id, newId()]));
  const nodes = imported.nodes.map((node) => {
    const id = ids.get(node.id) as string;
    const parentId = node.type === "creative" && node.parentId ? ids.get(node.parentId) : undefined;
    const text =
      node.type === "creative" && node.data.kind !== "script"
        ? node.data.text.replace(
            /(@\[[^\]\n]*\]\()([^)\s]+)(\))/g,
            (token, prefix: string, source: string) =>
              ids.has(source) ? `${prefix}${ids.get(source)})` : token,
          )
        : undefined;
    return node.type === "creative"
      ? {
          ...node,
          id,
          data: {
            ...node.data,
            text: text ?? node.data.text,
            ...(node.data.storyboard && {
              storyboard: node.data.storyboard.map((shot) => remapShotLinks(shot, ids)),
            }),
          },
          ...(parentId ? { parentId } : {}),
        }
      : { ...node, id };
  });
  const edges = imported.edges.map((edge) => ({
    ...edge,
    id: newId(),
    source: ids.get(edge.source) as string,
    target: ids.get(edge.target) as string,
  }));
  return {
    nodes: [...current.nodes, ...nodes],
    edges: [...current.edges, ...edges],
    viewport: current.viewport,
  };
}
