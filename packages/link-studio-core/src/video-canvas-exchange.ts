import { Value } from "@sinclair/typebox/value";
import {
  CanvasGroup,
  CreativeCanvasNode,
  type ProjectCanvasView,
  restoreMediaVersion,
} from "./canvas.ts";
import { parseCanvasExchange } from "./canvas-exchange.ts";
import type { ProjectAsset } from "./projects-api.ts";
import { mapVideoCanvas } from "./video-canvas-mapper.ts";
import { exportVideoCanvasParameters } from "./video-canvas-parameters.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function exportVideoCanvas(
  canvas: ProjectCanvasView,
  title: string,
  assets: readonly ProjectAsset[],
) {
  const byId = new Map(
    assets.filter((asset) => asset.availability === "ready").map((asset) => [asset.assetId, asset]),
  );
  const manifest: Record<string, unknown> = {};
  const skipped = new Set<string>();
  function register(id?: string) {
    if (!id) return;
    const asset = byId.get(id);
    if (!asset) {
      skipped.add(id);
      return;
    }
    const dimension = (key: string) => {
      const value = asset.metadata[key];
      return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.round(value))
        : 0;
    };
    manifest[asset.sha256] ??= {
      kind: asset.mediaType,
      mimeType: asset.mimeType,
      byteSize: asset.sizeBytes,
      width: dimension("width"),
      height: dimension("height"),
      durationMs: dimension("durationMs"),
      fileName: asset.displayName,
    };
    return asset;
  }
  const ids = new Set<string>();
  const byNode = new Map(canvas.nodes.map((node) => [node.id, node]));
  const legacyTargets = new Map<string, string>();
  for (const edge of canvas.edges) {
    const target = byNode.get(edge.target);
    if (!edge.readOnly && target?.type === "creative" && target.data.shotId)
      legacyTargets.set(`${edge.source}/${target.data.shotId}/${target.data.kind}`, target.id);
  }
  const nodes: Record<string, unknown>[] = [];
  for (const node of canvas.nodes) {
    if (node.type === "unknown") throw new Error("画布含有无法导出为原版格式的节点");
    ids.add(node.id);
    if (node.type === "group") {
      nodes.push(node);
      continue;
    }
    const source = restoreMediaVersion(node.data);
    const role = source.character;
    const kind = role
      ? "character"
      : source.director
        ? "director"
        : source.storyboard
          ? "storyboard"
          : source.kind;
    const data: Record<string, unknown> = { kind, label: source.label };
    if (kind === "script" || kind === "image" || kind === "video" || kind === "audio") {
      const modelKey = source.generation?.modelKey ?? source.generation?.providerId;
      if (modelKey) data.model = modelKey;
    }
    if (source.uploaded) data.uploaded = true;
    if (source.uploadFailed) Object.assign(data, { status: "error", error: "上传失败，请重试" });
    if (source.mediaAspect !== undefined) data.mediaAspect = source.mediaAspect;
    if (source.assetId) data.assetHash = register(source.assetId)?.sha256;
    if (kind === "script") {
      data.text = source.text;
      if (source.textStatus) data.status = source.textStatus;
      if (source.textStatus === "error" && source.textError !== undefined)
        data.error = source.textError;
    } else if (kind === "image" || kind === "video" || kind === "audio") {
      const refs: Record<string, string[]> = {};
      const paramAssets: Record<string, unknown> = {};
      for (const id of source.manualReferenceIds ?? []) {
        const asset = register(id);
        if (!asset) continue;
        const category = `${asset.mediaType}s`;
        refs[category] ??= [];
        refs[category].push(asset.sha256);
        paramAssets[asset.sha256] = { fileName: asset.displayName, mediaType: asset.mediaType };
      }
      data.params = {
        prompt: source.text,
        ...refs,
        ...exportVideoCanvasParameters(source),
        ...((source.videoMode || source.imageMode) && { op: source.videoMode ?? source.imageMode }),
      };
      if (Object.keys(paramAssets).length) data.paramAssets = paramAssets;
    }
    if (role) {
      const { extraAssetIds, voice, ...details } = role;
      const voiceAsset = register(voice?.assetId);
      data.character = {
        ...details,
        extras: extraAssetIds.flatMap((id) => {
          const asset = register(id);
          return asset ? [{ assetHash: asset.sha256 }] : [];
        }),
        voice: voiceAsset
          ? { mode: "audio", assetHash: voiceAsset.sha256, origin: voice?.origin ?? "upload" }
          : null,
      };
    }
    if (source.director)
      data.scene = { ...source.director, thumbHash: register(source.directorThumbnailId)?.sha256 };
    if (source.storyboard)
      data.storyboard = {
        shots: source.storyboard.map(({ imageAssetId, imageNodeId, videoNodeId, ...shot }) => {
          const image = register(imageAssetId);
          const target = (kind: "image" | "video", explicit?: string) => {
            const id = explicit ?? legacyTargets.get(`${node.id}/${shot.id}/${kind}`);
            const media = id && byNode.get(id);
            return media && media.type === "creative" && media.data.kind === kind ? id : undefined;
          };
          return {
            ...shot,
            imageNodeId: target("image", imageNodeId),
            videoNodeId: target("video", videoNodeId),
            ...(image && { image: { assetHash: image.sha256 } }),
          };
        }),
      };
    const active =
      source.outputs?.find((item) => item.id === source.activeOutputId) ?? source.outputs?.at(-1);
    const output = register(active?.assetId);
    if (active && output)
      data.outputs = [
        {
          assetHash: output.sha256,
          mediaType: output.mediaType,
          model: active.model,
          createdAt: Date.parse(active.createdAt) || 0,
        },
      ];
    nodes.push({
      id: node.id,
      type: "canvas",
      position: node.position,
      parentId: node.parentId,
      data,
    });
  }
  const edges = canvas.edges
    .filter((edge) => !edge.readOnly && ids.has(edge.source) && ids.has(edge.target))
    .map(({ id, source, target }) => ({ id, source, target }));
  if (
    Object.keys(manifest).length > 200 ||
    Object.keys(manifest).reduce((sum, hash) => sum + Number(record(manifest[hash]).byteSize), 0) >
      2 ** 30
  )
    throw new Error("画布素材超出导出限制");
  const json = JSON.stringify(
    {
      format: "video-canvas/canvas",
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: "link-studio",
      canvas: { title, nodes, edges },
      assets: manifest,
    },
    null,
    2,
  );
  if (new TextEncoder().encode(json).byteLength > 10 * 1024 * 1024)
    throw new Error("文件过大，上限 10 MB");
  return { json, skippedAssets: skipped.size };
}

export function prepareVideoCanvasExchange(value: unknown, assets: readonly ProjectAsset[]) {
  const envelope = record(value);
  if (envelope.format !== "video-canvas/canvas") throw new Error("不是本系统导出的画布文件");
  if (envelope.version !== 1) throw new Error("画布文件版本不支持");
  const graph = record(envelope.canvas);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    throw new Error("画布节点或连线格式无效");
  if (graph.nodes.length > 1000 || graph.edges.length > 4000)
    throw new Error("画布节点或连线超过项目上限");
  const manifest = record(envelope.assets);
  const entries = Object.entries(manifest);
  if (entries.length > 200) throw new Error("素材数量超过 200 个上限");
  let totalBytes = 0;
  for (const [hash, info] of entries) {
    const bytes = record(info).byteSize;
    if (
      !/^[0-9a-f]{64}$/.test(hash) ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      throw new Error("素材清单格式无效");
    totalBytes += bytes;
    if (totalBytes > 2 ** 30) throw new Error("素材总大小超过 1 GB 上限");
  }
  const available = new Map(
    assets.filter((asset) => asset.availability === "ready").map((asset) => [asset.sha256, asset]),
  );
  const missing = new Set<string>();
  const lookup = (hash: string, kind: ProjectAsset["mediaType"]) => {
    if (!Object.hasOwn(manifest, hash)) throw new Error("节点引用的素材不在文件清单中");
    const info = record(manifest[hash]);
    const asset = available.get(hash);
    if (
      asset &&
      asset.mediaType === kind &&
      info.kind === kind &&
      asset.sizeBytes === info.byteSize
    )
      return asset.assetId;
    missing.add(hash);
    return undefined;
  };
  const nodes = graph.nodes.map((raw) => {
    const node = record(raw);
    const data = record(node.data);
    const character = record(data.character);
    const extras = Array.isArray(character.extras)
      ? character.extras.map((raw) => ({ assetId: record(raw).assetHash }))
      : [];
    const voice = record(character.voice);
    const shots = record(data.storyboard).shots;
    return {
      ...node,
      data: {
        ...data,
        assetId: data.assetHash,
        ...(data.kind === "director" && {
          scene: { ...record(data.scene), thumb: { assetId: record(data.scene).thumbHash } },
        }),
        ...(Array.isArray(shots) && {
          storyboard: {
            shots: shots.map((raw) => {
              const shot = record(raw);
              return { ...shot, image: { assetId: record(shot.image).assetHash } };
            }),
          },
        }),
        character: {
          ...character,
          extras,
          voice: {
            assetId: voice.mode === "audio" ? voice.assetHash : undefined,
            origin: voice.origin,
          },
        },
      },
    };
  });
  const originalData = new Map(
    graph.nodes.map((raw) => {
      const node = record(raw);
      return [node.id, record(node.data)] as const;
    }),
  );
  const mapped = mapVideoCanvas({ ...graph, nodes }, lookup);
  const editable = mapped.nodes.filter(
    (node) => Value.Check(CreativeCanvasNode, node) || Value.Check(CanvasGroup, node),
  );
  if (editable.length !== nodes.length) throw new Error("文件中含有无法导入的节点");
  const document = parseCanvasExchange({
    format: "link-studio.canvas",
    version: 1,
    title:
      typeof graph.title === "string"
        ? graph.title.trim().slice(0, 200) || "未命名画布"
        : "未命名画布",
    exportedAt: envelope.exportedAt ?? new Date().toISOString(),
    nodes: editable.map((node) => {
      if (node.type !== "creative" || !node.data.assetId || node.data.kind === "script")
        return node;
      const source = originalData.get(node.id);
      const output = Array.isArray(source?.outputs) ? record(source.outputs.at(-1)) : {};
      if (
        typeof output.assetHash !== "string" ||
        lookup(output.assetHash, node.data.kind) !== node.data.assetId
      )
        return node;
      const timestamp =
        typeof output.createdAt === "number" ? new Date(output.createdAt) : undefined;
      const active = {
        id: node.data.assetId,
        assetId: node.data.assetId,
        kind: node.data.kind,
        createdAt: timestamp && Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : "",
        ...(typeof output.model === "string" && { model: output.model.slice(0, 200) }),
      };
      return { ...node, data: { ...node.data, activeOutputId: active.id, outputs: [active] } };
    }),
    edges: mapped.edges,
    viewport: mapped.viewport,
  });
  return {
    document,
    report: {
      missingAssetIds: [...missing],
      droppedEdgeCount: graph.edges.length - mapped.edges.length,
    },
  };
}
