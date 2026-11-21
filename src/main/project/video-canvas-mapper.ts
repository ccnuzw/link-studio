import { Value } from "@sinclair/typebox/value";
import {
  CanvasEdge,
  CanvasGroup,
  CanvasId,
  CanvasPosition,
  CanvasShot,
  CanvasViewport,
  CreativeCanvasNode,
} from "../../../packages/link-studio-core/src/canvas.ts";
import {
  DirectorScene,
  validDirectorScene,
} from "../../../packages/link-studio-core/src/director.ts";
import type { JsonValue, ProjectState } from "../../../packages/link-studio-core/src/project.ts";

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
    const position = Value.Check(CanvasPosition, upstream.position)
      ? upstream.position
      : { x: 0, y: 0 };
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
        data: { label },
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
      const prompt = asRecord(data.params).prompt ?? data.prompt;
      const content = kind === "script" && typeof data.text === "string" ? data.text : prompt;
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
              look: safeLabel(sourceCharacter.look, "基础形象").trim().slice(0, 64) || "基础形象",
              description:
                typeof sourceCharacter.description === "string"
                  ? sourceCharacter.description.slice(0, 500)
                  : "",
              extraAssetIds,
              ...(voiceId ? { voice: { assetId: voiceId } } : {}),
            }
          : undefined;
      const sourceShots = asRecord(data.storyboard).shots;
      const storyboard =
        kind === "storyboard"
          ? new Map<string, import("../../../packages/link-studio-core/src/canvas.ts").CanvasShot>()
          : undefined;
      if (storyboard && Array.isArray(sourceShots)) {
        for (const raw of sourceShots.slice(0, 100)) {
          const { id, scene, shot, camera, action, dialogue, duration } = asRecord(raw);
          const candidate = { id, scene, shot, camera, action, dialogue, duration };
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
      const node = {
        id,
        type: "creative",
        position,
        ...(parentId ? { parentId } : {}),
        data: {
          kind: mediaKind,
          label,
          text: typeof content === "string" ? content.slice(0, 32768) : "",
          ...(assetId ? { assetId } : {}),
          ...(character ? { character } : {}),
          ...(storyboard ? { storyboard: [...storyboard.values()] } : {}),
          ...(director ? { director } : {}),
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
