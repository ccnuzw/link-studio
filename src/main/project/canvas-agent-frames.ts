import type { Static } from "@sinclair/typebox";
import type {
  CanvasOperation,
  EditableCanvasNode,
  ProjectCanvasView,
} from "../../../packages/link-studio-core/src/canvas.ts";
import type { CanvasAgentCapture } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { canvasBounds } from "./canvas-agent-layout.ts";
import { ProjectError } from "./errors.ts";

export function planFrames(
  canvas: ProjectCanvasView,
  assets: ProjectState["assets"],
  input: Static<typeof CanvasAgentCapture>,
  makeId: (part: string) => string,
) {
  const nodes = new Map(
    canvas.nodes.filter((node) => node.type !== "unknown").map((node) => [node.id, node]),
  );
  const current = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new ProjectError("CANVAS_OPERATION_INVALID", "节点不存在或只读");
    return node;
  };
  const source = current(input.nodeId);
  const asset =
    source.type === "creative" && source.data.kind === "video" && source.data.assetId
      ? assets[source.data.assetId]
      : undefined;
  const duration = Number(asset?.metadata.durationMs) / 1000;
  if (asset?.availability !== "ready" || !Number.isFinite(duration) || duration <= 0)
    throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "节点没有可用视频");
  const rect = (node: EditableCanvasNode) => canvasBounds(node, current, assets);
  const bounds = rect(source);
  const occupied = [...nodes.values()].map(rect);
  const frames = new Map<
    number,
    { at: number; node_id: string; assetId: string; label: string; connected_to: string[] }
  >();
  const operations: CanvasOperation[] = [];
  for (const request of input.frames) {
    const end = duration <= 0.2 ? duration / 2 : duration - 0.1;
    const at = request.at === "first" ? 0 : request.at === "last" ? end : request.at;
    if (at > duration) throw new ProjectError("AGENT_MEDIA_UNAVAILABLE", "时间点超出视频时长");
    const timeMs = Math.round(at * 1000);
    for (const target of request.connectTo ?? []) {
      const destination = current(target);
      if (destination.type !== "creative" || destination.data.kind === "script")
        throw new ProjectError("CANVAS_OPERATION_INVALID", "参考目标必须是媒体节点");
    }
    const existing = frames.get(timeMs);
    if (existing) {
      existing.connected_to = [
        ...new Set([...existing.connected_to, ...(request.connectTo ?? [])]),
      ];
      continue;
    }
    const suffix =
      request.at === "first" ? "首帧" : request.at === "last" ? "尾帧" : `${at.toFixed(1)} 秒`;
    const label = Array.from(`${source.data.label} · ${suffix}`.trim().replace(/\s+/g, " "))
      .slice(0, 40)
      .join("");
    frames.set(timeMs, {
      at,
      node_id: makeId(`node:${timeMs}`),
      assetId: makeId(`asset:${timeMs}`),
      label,
      connected_to: [...new Set(request.connectTo)],
    });
  }
  for (const frame of frames.values()) {
    const position = { x: bounds.x + bounds.width + 80, y: bounds.y + (bounds.height - 324) / 2 };
    for (
      let tries = 0;
      tries < 60 &&
      occupied.some(
        (other) =>
          position.x - 40 < other.x + other.width &&
          position.x + 576 + 40 > other.x &&
          position.y - 40 < other.y + other.height &&
          position.y + 324 + 40 > other.y,
      );
      tries++
    )
      position.y += 364;
    occupied.push({ ...position, width: 576, height: 324 });
    operations.push({
      type: "putNode",
      node: {
        id: frame.node_id,
        type: "creative",
        position,
        data: {
          kind: "image",
          label: frame.label,
          text: "",
          uploaded: true,
          assetId: frame.assetId,
        },
      },
    });
    const edge = (source: string, target: string) =>
      operations.push({
        type: "putEdge",
        edge: { id: makeId(`edge:${JSON.stringify([source, target])}`), source, target },
      });
    edge(source.id, frame.node_id);
    for (const target of frame.connected_to) edge(frame.node_id, target);
  }
  return { asset, frames: [...frames.values()], operations };
}
