import { Value } from "@sinclair/typebox/value";
import {
  CanvasEdge,
  CanvasGroup,
  CanvasId,
  CanvasModelKey,
  CanvasPosition,
  CanvasShot,
  CanvasViewport,
  CreativeCanvasNode,
  groupHue,
  maxStoryboardShots,
} from "./canvas.ts";
import { canvasAnchorPosition } from "./canvas-layout.ts";
import { DirectorScene, validDirectorScene } from "./director.ts";
import type { JsonValue, ProjectState } from "./project.ts";
import { importVideoCanvasParameters } from "./video-canvas-parameters.ts";

type WebRecord = Record<string, unknown>;
type ResolveAsset = (upstreamId: string, kind: "image" | "video" | "audio") => string | undefined;
const mediaKinds = new Set(["image", "video", "audio"]);

function asRecord(value: unknown): WebRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as WebRecord) : {};
}

function safeLabel(value: unknown, fallback: string) {
  return typeof value === "string" ? value.slice(0, 255) : fallback;
}

export function mapVideoCanvas(input: unknown, resolveAsset: ResolveAsset): ProjectState["canvas"] {
  const { nodes: rawNodes, edges: rawEdges, viewport } = asRecord(input);
  const nodes: JsonValue[] = [];
  const ids = new Map<string, string>();
  const groups = new Set<string>();
  const entries: { upstream: WebRecord; id: string }[] = [];
  if (Array.isArray(rawNodes)) {
    for (const raw of rawNodes.slice(0, 1000)) {
      const upstream = asRecord(raw);
      if (
        typeof upstream.id !== "string" ||
        ids.has(upstream.id) ||
        !Value.Check(CanvasId, upstream.id)
      )
        continue;
      ids.set(upstream.id, upstream.id);
      entries.push({ upstream, id: upstream.id });
      if (upstream.type === "group") groups.add(upstream.id);
    }
  }
  for (const { upstream, id } of entries) {
    let position = { x: 0, y: 0 };
    if (Value.Check(CanvasPosition, upstream.position)) {
      position = upstream.position;
      const anchor = upstream.origin;
      if (
        upstream.type === "canvas" &&
        Array.isArray(anchor) &&
        anchor.length === 2 &&
        anchor.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        const topLeft = canvasAnchorPosition(position, anchor[0], anchor[1]);
        if (Value.Check(CanvasPosition, topLeft)) position = topLeft;
      }
    }
    const data = asRecord(upstream.data);
    const { kind } = data;
    const label = safeLabel(data.label, "未命名节点");
    const parentId =
      typeof upstream.parentId === "string" && groups.has(upstream.parentId)
        ? upstream.parentId
        : undefined;
    if (upstream.type === "group") {
      const group = {
        id,
        type: "group",
        position,
        data: {
          label,
          ...(Value.Check(groupHue, data.color) ? { color: data.color } : {}),
          ...(Value.Check(groupHue, data.labelColor) ? { labelColor: data.labelColor } : {}),
        },
        width:
          typeof upstream.width === "number" && Number.isFinite(upstream.width)
            ? Math.max(100, Math.min(upstream.width, 1e6))
            : 320,
        height:
          typeof upstream.height === "number" && Number.isFinite(upstream.height)
            ? Math.max(60, Math.min(upstream.height, 1e6))
            : 240,
      };
      if (Value.Check(CanvasGroup, group)) nodes.push(group);
      continue;
    }
    if (
      upstream.type === "canvas" &&
      typeof kind === "string" &&
      (kind === "script" ||
        kind === "character" ||
        kind === "storyboard" ||
        kind === "director" ||
        mediaKinds.has(kind))
    ) {
      const mediaKind =
        kind === "character"
          ? "image"
          : kind === "storyboard" || kind === "director"
            ? "script"
            : kind;
      const params = asRecord(data.params);
      const generationParams = mediaKinds.has(kind) ? importVideoCanvasParameters(params) : {};
      const modelKey =
        (kind === "script" || mediaKinds.has(kind)) && Value.Check(CanvasModelKey, data.model)
          ? data.model
          : undefined;
      const prompt = params.prompt ?? data.prompt;
      const manualReferenceIds = new Set<string>();
      for (const type of ["image", "video", "audio"] as const) {
        const values = params[`${type}s`];
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          if (typeof value !== "string" && !Number.isSafeInteger(value)) continue;
          const resolved = resolveAsset(String(value), type);
          if (resolved) manualReferenceIds.add(resolved);
        }
      }
      const content = kind === "script" ? data.text : prompt;
      const textStatus = data.status === "running" ? "idle" : data.status;
      const assetId =
        mediaKind !== "script" && typeof data.assetId === "string"
          ? resolveAsset(data.assetId, mediaKind as "image" | "video" | "audio")
          : undefined;
      const sourceCharacter = asRecord(data.character);
      const voice = asRecord(sourceCharacter.voice);
      const voiceId =
        typeof voice.assetId === "string" ? resolveAsset(voice.assetId, "audio") : undefined;
      const extraAssetIds = Array.isArray(sourceCharacter.extras)
        ? [
            ...new Set(
              sourceCharacter.extras.flatMap((extra) => {
                const { assetId: upstreamId } = asRecord(extra);
                const resolved =
                  typeof upstreamId === "string" ? resolveAsset(upstreamId, "image") : undefined;
                return resolved && resolved !== assetId ? [resolved] : [];
              }),
            ),
          ].slice(0, 4)
        : [];
      const character =
        kind === "character"
          ? {
              name: safeLabel(sourceCharacter.name, label).trim().slice(0, 64) || "未命名角色",
              look: [...safeLabel(sourceCharacter.look, "基础形象")].slice(0, 64).join(""),
              description:
                typeof sourceCharacter.description === "string"
                  ? sourceCharacter.description.slice(0, 500)
                  : "",
              extraAssetIds,
              ...(Value.Check(CanvasModelKey, sourceCharacter.voiceModel) && {
                voiceModel: sourceCharacter.voiceModel,
              }),
              ...(typeof sourceCharacter.voicePrompt === "string"
                ? { voicePrompt: [...sourceCharacter.voicePrompt].slice(0, 500).join("") }
                : {}),
              ...(voiceId
                ? {
                    voice: {
                      assetId: voiceId,
                      ...(typeof voice.name === "string" &&
                        voice.name.length <= 255 && { name: voice.name }),
                      ...(voice.origin === "library" ||
                      voice.origin === "generated" ||
                      voice.origin === "upload"
                        ? { origin: voice.origin as "library" | "generated" | "upload" }
                        : {}),
                    },
                  }
                : {}),
            }
          : undefined;
      const sourceShots = asRecord(data.storyboard).shots;
      const storyboard = kind === "storyboard" ? new Map<string, CanvasShot>() : undefined;
      if (storyboard && Array.isArray(sourceShots)) {
        for (const raw of sourceShots.slice(0, maxStoryboardShots)) {
          const {
            id,
            scene,
            shot,
            camera,
            action,
            dialogue,
            duration,
            imageNodeId,
            videoNodeId,
            image,
          } = asRecord(raw);
          const imageSource = asRecord(image).assetId;
          const imageAssetId =
            typeof imageSource === "string" ? resolveAsset(imageSource, "image") : undefined;
          const candidate = {
            id,
            scene,
            shot,
            camera,
            action,
            dialogue,
            duration,
            ...(imageAssetId && { imageAssetId }),
            ...(typeof imageNodeId === "string" && ids.has(imageNodeId) && { imageNodeId }),
            ...(typeof videoNodeId === "string" && ids.has(videoNodeId) && { videoNodeId }),
          };
          if (
            Value.Check(CanvasShot, candidate) &&
            Number(candidate.duration.toFixed(1)) === candidate.duration &&
            !storyboard.has(candidate.id)
          )
            storyboard.set(candidate.id, candidate);
        }
      }
      const { version, duration, activeCameraId, characters, props, cameras } = asRecord(
        data.scene,
      );
      const scene = { version, duration, activeCameraId, characters, props, cameras };
      const director =
        kind === "director" && Value.Check(DirectorScene, scene) && validDirectorScene(scene)
          ? scene
          : undefined;
      const thumbId = asRecord(asRecord(data.scene).thumb).assetId;
      const directorThumbnailId =
        director && typeof thumbId === "string" ? resolveAsset(thumbId, "image") : undefined;
      const node = {
        id,
        type: "creative",
        position,
        ...(parentId ? { parentId } : {}),
        data: {
          kind: mediaKind,
          label,
          ...(kind === "script" &&
            (textStatus === "idle" || textStatus === "done" || textStatus === "error") && {
              textStatus,
            }),
          ...(kind === "script" &&
            textStatus === "error" &&
            typeof data.error === "string" && { textError: data.error.slice(0, 32768) }),
          ...(kind === "script" &&
            textStatus === "error" &&
            typeof data.taskId === "string" &&
            data.taskId.length > 0 &&
            data.taskId.length <= 32768 &&
            typeof data.errorTaskRef === "string" &&
            data.errorTaskRef.length > 0 &&
            data.errorTaskRef.length <= 32768 && {
              textFailureTask: { id: data.taskId, reference: data.errorTaskRef },
            }),
          ...(data.uploaded === true && mediaKinds.has(kind) ? { uploaded: true } : {}),
          ...(data.uploaded === true &&
            mediaKinds.has(kind) &&
            data.status === "error" &&
            !assetId && { uploadFailed: true }),
          ...(typeof data.mediaAspect === "number" &&
            Number.isFinite(data.mediaAspect) &&
            data.mediaAspect > 0 &&
            (mediaKinds.has(kind) || kind === "character") && { mediaAspect: data.mediaAspect }),
          text: typeof content === "string" ? content.slice(0, 32768) : "",
          ...(assetId ? { assetId } : {}),
          ...(manualReferenceIds.size ? { manualReferenceIds: [...manualReferenceIds] } : {}),
          ...((modelKey || Object.keys(generationParams).length) && {
            generation: {
              ...(modelKey && { modelKey }),
              ...(Object.keys(generationParams).length && { params: generationParams }),
            },
          }),
          ...(kind === "video" &&
            typeof params.duration === "number" &&
            Number.isInteger(params.duration) &&
            params.duration >= 1 &&
            params.duration <= 60 && { videoDuration: params.duration }),
          ...(kind === "video" &&
            (params.op === "i2v" || params.op === "omni" || params.op === "t2v") && {
              videoMode: params.op,
            }),
          ...((kind === "image" || kind === "character") &&
            (params.op === "i2i" || params.op === "t2i") && { imageMode: params.op }),
          ...(character ? { character } : {}),
          ...(storyboard ? { storyboard: [...storyboard.values()] } : {}),
          ...(director ? { director } : {}),
          ...(directorThumbnailId && { directorThumbnailId }),
        },
      };
      if ((kind !== "director" || director) && Value.Check(CreativeCanvasNode, node)) {
        nodes.push(node);
        continue;
      }
    }
    nodes.push({
      id,
      type: "video-canvas-compat",
      position,
      ...(parentId ? { parentId } : {}),
      data: { label },
      extensions: {
        source: "video-canvas",
        kind: typeof kind === "string" && /^[a-z-]{1,48}$/.test(kind) ? kind : "unknown",
      },
    });
  }
  const edgeIds = new Set<string>();
  const endpoints = new Set<string>();
  const edges: JsonValue[] = [];
  if (Array.isArray(rawEdges))
    for (const raw of rawEdges.slice(0, 4000)) {
      const { id, source, target } = asRecord(raw);
      const edge = { id, source, target };
      if (
        !Value.Check(CanvasEdge, edge) ||
        !ids.has(edge.source) ||
        !ids.has(edge.target) ||
        edge.source === edge.target
      )
        continue;
      const pair = JSON.stringify([edge.source, edge.target]);
      if (edgeIds.has(edge.id) || endpoints.has(pair)) continue;
      edgeIds.add(edge.id);
      endpoints.add(pair);
      edges.push(edge);
    }
  return {
    schemaVersion: 1,
    revision: 2,
    nodes,
    edges,
    viewport: Value.Check(CanvasViewport, viewport) ? viewport : { x: 0, y: 0, zoom: 1 },
  };
}
