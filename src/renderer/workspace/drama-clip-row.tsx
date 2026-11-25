import {
  type DramaDocument,
  dramaBoardMeta,
  jobIsTerminal,
  requirePresent,
} from "@link-studio/core";
import { CircleX, Film, Loader2, Plus } from "lucide-react";
import { Reorder } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DramaAssetEditor } from "./drama-asset-browser";
import { clipWidth, playableClips, useDramaPlayback } from "./drama-playback";
import { segmentAttempt } from "./drama-segment-status";
import { MediaThumbnail } from "./media-thumbnail";
import "./drama-clip-row.css";

type Segment = NonNullable<DramaDocument["segments"]>[number];
export async function appendStudioClip(
  handle: string,
  episodeNo: number,
  revision: number,
  modelLimit: number,
) {
  return window.desktop.projects.drama({
    projectHandle: handle,
    addSegment: {
      episode_no: episodeNo,
      revision,
      seconds: Math.min(10, modelLimit),
    },
  });
}
export function DramaClipRow({
  segments,
  selected,
  select,
  save,
  add,
  busy,
  editor,
  handle,
  previewHost,
  ratio,
  fresh,
  batchHost,
}: {
  segments: Segment[];
  selected?: string;
  select: (id: string) => void;
  save: (previous: string[], ids: string[]) => Promise<void>;
  add: () => void;
  busy?: boolean;
  editor: DramaAssetEditor;
  handle: string;
  previewHost: HTMLElement | null;
  ratio?: string;
  fresh?: Set<string>;
  batchHost?: (host: HTMLSpanElement | null) => void;
}) {
  const playhead = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () => playableClips(segments, editor.jobs, editor.assets),
    [segments, editor.jobs, editor.assets],
  );
  const playback = useDramaPlayback(items, select, previewHost, handle, playhead, ratio, batchHost);
  const ids = segments.map((segment) => segment.id);
  const orderKey = ids.join(",");
  const [local, setLocal] = useState<{ base: string; ids: string[] }>();
  const pending = useRef(false);
  const dragged = useRef(false);
  const [limit, setLimit] = useState(8);
  useEffect(() => {
    if (limit >= segments.length) return;
    const frame = requestAnimationFrame(() => setLimit(limit + 6));
    return () => cancelAnimationFrame(frame);
  }, [limit, segments.length]);
  const shown = local?.base === orderKey ? local.ids : ids;
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const boards = new Map(
    editor.graph.nodes.flatMap((node) => {
      const board = node.type === "creative" && dramaBoardMeta(node.data);
      return board && node.type === "creative" ? [[board.segmentId, node] as const] : [];
    }),
  );
  async function commit() {
    if (pending.current || !local || local.base !== orderKey || shown.join(",") === orderKey)
      return;
    pending.current = true;
    try {
      await save(ids, shown);
    } finally {
      pending.current = false;
      setLocal(undefined);
    }
  }
  return (
    <>
      {playback.controls}
      {playback.stage}
      <div className="drama-clip-scroll">
        <div className="drama-clip-content">
          <Reorder.Group
            as="div"
            role="group"
            aria-label="分镜时间线"
            axis="x"
            values={shown.slice(0, limit)}
            onReorder={(next) => {
              if (!pending.current && limit >= ids.length) setLocal({ base: orderKey, ids: next });
            }}
            onPointerUp={() => void commit()}
            onPointerCancel={() => setLocal(undefined)}
          >
            {shown.slice(0, limit).map((id, index) => {
              const segment = requirePresent(byId.get(id), "byId.get(id)");
              const board = boards.get(id);
              const boardJob = board && editor.jobs.get(board.id)?.[0];
              const boardState =
                boardJob && !jobIsTerminal(boardJob.status)
                  ? "running"
                  : board?.data.assetId
                    ? fresh?.has(id)
                      ? "ready"
                      : "stale"
                    : boardJob?.status === "failed"
                      ? "failed"
                      : "empty";
              const jobs = editor.jobs.get(`seg:${id}`) ?? [];
              const take = jobs
                .find((job) => job.id === segment.chosen_task_id && job.status === "succeeded")
                ?.outputs.find((output) => output.kind === "video");
              const attempt = segmentAttempt(segment, jobs);
              const running = attempt.state === "running";
              const video = take?.kind === "video" ? take.assetId : undefined;
              const thumbnail = video ?? (!running && board?.data.assetId);
              const Icon = running ? Loader2 : attempt.state === "failed" ? CircleX : Film;
              return (
                <Reorder.Item
                  key={id}
                  as="div"
                  value={id}
                  role="button"
                  tabIndex={0}
                  aria-current={id === selected}
                  aria-label={`片段 ${index + 1}，${segment.seconds} 秒`}
                  title={segment.prompt}
                  style={{ width: clipWidth(segment.seconds) }}
                  whileDrag={{ scale: 1.03, zIndex: 2 }}
                  onPointerDown={() => {
                    dragged.current = false;
                  }}
                  onDragStart={() => {
                    dragged.current = true;
                  }}
                  onClick={() => {
                    if (!dragged.current) playback.jump(segment);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      playback.jump(segment);
                    }
                  }}
                >
                  {thumbnail ? (
                    <div className="drama-clip-thumb" data-board={!video}>
                      <MediaThumbnail
                        key={thumbnail}
                        handle={handle}
                        assetId={thumbnail}
                        video={!!video}
                      />
                    </div>
                  ) : (
                    <Icon size={16} />
                  )}
                  <div className="drama-clip-label" data-video={!!video}>
                    <span>
                      {String(index + 1).padStart(2, "0")}
                      <i data-state={boardState} />
                      <i data-state={running ? "running" : video ? "ready" : "empty"} />
                    </span>
                    {segment.seconds}s
                  </div>
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
          {playback.active && (
            <div ref={playhead} className="drama-clip-playhead" aria-hidden="true" />
          )}
        </div>
        <button
          className="drama-add-clip"
          type="button"
          aria-label="新增片段"
          title="新增片段"
          disabled={busy}
          onClick={add}
        >
          <Plus size={16} />
        </button>
      </div>
    </>
  );
}
