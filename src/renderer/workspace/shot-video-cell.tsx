import { type GenerationJob, jobFailureReason, jobIsTerminal } from "@link-studio/core";
import { Crosshair, Video } from "lucide-react";

export function ShotVideoCell({
  nodeId,
  assetId,
  job,
  prepare,
  locate,
}: {
  nodeId?: string;
  assetId?: string;
  job?: GenerationJob;
  prepare: () => void;
  locate: (id: string) => void;
}) {
  if (!nodeId)
    return (
      <div className="shot-video-cell">
        <button type="button" onClick={prepare}>
          <Video size={16} />
          生成视频
        </button>
      </div>
    );
  const running = job && !jobIsTerminal(job.status);
  const failed =
    job?.status === "failed" || job?.status === "cancelled" || job?.status === "outcome_unknown";
  const done = !running && !failed && !!assetId;
  const progress = job?.status === "running" && job.progress > 0 ? ` ${job.progress}%` : "";
  const go = () => locate(nodeId);
  return (
    <div
      className="shot-video-cell"
      data-state={running ? "running" : failed ? "failed" : done ? "done" : "idle"}
      title={failed ? jobFailureReason(job) : undefined}
    >
      {!failed && <i aria-hidden="true" />}
      {running ? (
        <span role="status">生成中{progress}</span>
      ) : done ? (
        <button type="button" onClick={go}>
          已完成
        </button>
      ) : failed ? (
        <span className="shot-video-failure" title={jobFailureReason(job)}>
          <i aria-hidden="true" />
          <span>失败 ·</span>
          <button type="button" onClick={go}>
            去处理
          </button>
        </span>
      ) : (
        <>
          <span>未生成 ·</span>
          <button type="button" onClick={go}>
            去生成
          </button>
        </>
      )}
      {(running || done) && (
        <button
          className="shot-video-locate"
          type="button"
          title="在画布中定位"
          aria-label="在画布中定位"
          onClick={go}
        >
          <Crosshair size={14} />
        </button>
      )}
    </div>
  );
}
