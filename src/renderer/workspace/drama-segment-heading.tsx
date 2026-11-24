import type { DramaDocument } from "@link-studio/core";
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { DramaDeleteDialog } from "./drama-episode-delete";
import type { editorAttempt } from "./drama-segment-status";

type Segment = NonNullable<DramaDocument["segments"]>[number];

export function DramaSegmentHeading({
  handle,
  segment,
  order,
  saved,
  attempt,
}: {
  handle: string;
  segment: Segment;
  order: number;
  saved: (doc: DramaDocument) => void;
  attempt: ReturnType<typeof editorAttempt>;
}) {
  const [target, setTarget] = useState<Segment>();
  return (
    <div className="studio-segment-heading">
      <h2>
        第 {segment.episode_no} 集 · 第 {segment.seq + 1} 段
      </h2>
      {attempt.state !== "idle" && (
        <span role="status" className="studio-segment-status" data-state={attempt.state}>
          {attempt.state === "running" && <Loader2 aria-hidden size={12} />}
          {attempt.state === "running"
            ? "生成中"
            : attempt.state === "failed"
              ? "生成失败"
              : "已出视频"}
        </span>
      )}
      <button
        type="button"
        aria-label="删除这个片段"
        title="删除这个片段"
        onClick={() => setTarget(segment)}
      >
        <Trash2 size={16} />
      </button>
      {target && (
        <DramaDeleteDialog
          title={`删除片段 ${String(target.seq + 1).padStart(2, "0")}？`}
          description="只删除这个片段和它的提示词；已经生成的视频和素材不会被删除。"
          close={() => setTarget(undefined)}
          remove={async () => {
            const result = await window.desktop.projects.drama({
              projectHandle: handle,
              deleteSegment: {
                segmentId: target.id,
                episodeNo: target.episode_no,
                episodeOrder: order,
              },
            });
            if (!result.ok) throw Error(result.error.message);
            if (!result.value) throw Error("删除失败，请稍后重试");
            saved(result.value);
          }}
        />
      )}
    </div>
  );
}
