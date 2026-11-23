import { createHash, randomUUID } from "node:crypto";
import {
  type CanvasOperation,
  dramaAssetMeta,
  dramaBoardMeta,
  type EditableCanvasNode,
} from "../../../packages/link-studio-core/src/canvas.ts";
import type { DramaDocument } from "../../../packages/link-studio-core/src/drama.ts";
import {
  boardLayout,
  boardPrompt,
  shotLines,
} from "../../../packages/link-studio-core/src/drama-board.ts";
import type { GenerationInput } from "../../../packages/link-studio-core/src/generation.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";
import { dramaDocument } from "./drama.ts";
import { ProjectError } from "./errors.ts";

type Segment = NonNullable<DramaDocument["segments"]>[number];
function newBoardNode(
  graph: ReturnType<typeof projectCanvas>,
  segment: Segment,
  id: string,
): Extract<EditableCanvasNode, { type: "creative" }> {
  const other = graph.nodes.filter(
    (node) => node.type !== "creative" || !dramaBoardMeta(node.data),
  );
  const right = other.reduce(
    (edge, node) => Math.max(edge, node.position.x + (node.type === "group" ? node.width : 0)),
    -400,
  );
  const top = other.length ? Math.min(...other.map((node) => node.position.y)) : 0;
  const shotCount = shotLines(segment.prompt).length;
  return {
    type: "creative" as const,
    id,
    position: { x: right + 400 + segment.seq * 624, y: top + (segment.episode_no - 1) * 420 },
    data: {
      kind: "image" as const,
      text: "",
      label: `故事板 · 第 ${segment.episode_no} 集 · ${String(segment.seq + 1).padStart(2, "0")}`,
      drama: {
        episodes: [segment.episode_no],
        board: {
          segmentId: segment.id,
          sourceHash: createHash("sha256").update(segment.prompt).digest("hex"),
          layout: boardLayout(shotCount).layout,
          shotCount,
        },
      },
    },
  };
}
export function syncDramaBoards(
  state: ProjectState,
  episode: number,
  segments: NonNullable<DramaDocument["segments"]>,
) {
  const graph = projectCanvas(state.canvas);
  const selected = segments.filter((segment) => segment.episode_no === episode);
  const wanted = new Set(selected.map((segment) => segment.id));
  const existing = new Set<string>();
  const removed = new Set<string>();
  const operations: CanvasOperation[] = [];
  for (const node of graph.nodes) {
    const board = node.type === "creative" && dramaBoardMeta(node.data);
    if (board && node.type === "creative") {
      if (node.data.drama?.episodes?.includes(episode) && !wanted.has(board.segmentId)) {
        removed.add(node.id);
        operations.push({ type: "removeNode", id: node.id });
      } else existing.add(board.segmentId);
    }
  }
  for (const edge of graph.edges) {
    if (removed.has(edge.source) || removed.has(edge.target))
      operations.push({ type: "removeEdge", id: edge.id });
  }
  for (const segment of selected) {
    if (existing.has(segment.id)) continue;
    operations.push({ type: "putNode", node: newBoardNode(graph, segment, randomUUID()) });
  }
  if (operations.length) state.canvas = applyCanvas(state, operations);
}

export function stageDramaBoard(state: ProjectState, input: GenerationInput) {
  const request = input.board;
  if (!request || input.expectedCanvasRevision !== state.canvas.revision)
    throw new ProjectError("CANVAS_REVISION_CONFLICT", "画布已经变化");
  const doc = dramaDocument(state);
  const segment = doc?.segments?.find((entry) => entry.id === request.segmentId);
  if (!segment || !doc?.episodes.find((entry) => entry.episode_no === segment.episode_no)?.locked)
    throw new ProjectError("DRAMA_STEP_NOT_READY", "生成故事板需要先锁定本集");
  if (
    doc.jobs?.some(
      (job) =>
        ["queued", "running"].includes(job.status) &&
        ["storyboard", "compose"].includes(job.step) &&
        job.episodes.includes(segment.episode_no),
    )
  )
    throw new ProjectError("DRAMA_JOB_CONFLICT", "已有进行中的短剧任务");
  if (createHash("sha256").update(segment.prompt).digest("hex") !== request.sourceHash)
    throw new ProjectError("DRAMA_STEP_NOT_READY", "原稿已更改，请刷新");
  const graph = projectCanvas(state.canvas);
  const current = graph.nodes.findLast(
    (node) => node.type === "creative" && dramaBoardMeta(node.data)?.segmentId === segment.id,
  );
  if (
    (current && current.id !== input.nodeId) ||
    (!current && graph.nodes.some((node) => node.id === input.nodeId))
  )
    throw new ProjectError("CANVAS_REVISION_CONFLICT", "故事板节点已更改");
  if ((request.settingsRevision ?? 1) !== (doc.board_settings_revision ?? 1))
    throw new ProjectError("DRAMA_STEP_NOT_READY", "故事板设置已更改，请刷新");
  const built = boardPrompt(segment.prompt, doc.board_settings?.template);
  const base = current?.type === "creative" ? current : newBoardNode(graph, segment, input.nodeId);
  const data = {
    ...base.data,
    text: built.text,
    drama: {
      episodes: [segment.episode_no],
      board: {
        segmentId: segment.id,
        sourceHash: request.sourceHash,
        layout: built.layout,
        shotCount: built.shotCount,
      },
    },
    generation: {
      ...base.data.generation,
      providerId: input.providerId,
      params: {
        ...base.data.generation?.params,
        ...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
      },
    },
  };
  delete data.uploaded;
  if (data.assetId && !data.outputs?.some((output) => output.assetId === data.assetId)) {
    data.outputs = [
      ...(data.outputs ?? []),
      {
        id: data.assetId,
        kind: "image" as const,
        assetId: data.assetId,
        createdAt: state.assets[data.assetId]?.createdAt ?? "",
      },
    ].slice(-50);
  }
  const previousOutput =
    data.activeOutputId ?? data.outputs?.find((output) => output.assetId === data.assetId)?.id;
  delete data.assetId;
  delete data.activeOutputId;
  const changes: CanvasOperation[] = [{ type: "putNode", node: { ...base, data } }];
  for (const id of request.refs) {
    const source = graph.nodes.find((node) => node.id === id);
    if (source?.type !== "creative" || !dramaAssetMeta(source.data))
      throw new ProjectError("JOB_INPUT_INVALID", "故事板参考素材已变更");
    if (!graph.edges.some((edge) => edge.source === id && edge.target === base.id))
      changes.push({ type: "putEdge", edge: { id: randomUUID(), source: id, target: base.id } });
  }
  state.canvas = applyCanvas(state, changes);
  return previousOutput;
}
