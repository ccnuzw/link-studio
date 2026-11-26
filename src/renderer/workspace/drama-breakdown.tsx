import { type DramaDocument, dramaBusyReason, requirePresent } from "@link-studio/core";
import { motion } from "motion/react";
import { useState } from "react";
import { EpisodeProgress } from "./drama-episode-rail";
import { dramaJobFeedback } from "./drama-job-feedback";
import { DramaNotice } from "./drama-studio-status";

type Job = NonNullable<DramaDocument["jobs"]>[number];
const active = (job: Job) => job.status === "queued" || job.status === "running";
function rangeLabel(numbers: number[]) {
  const sorted = [...numbers].sort((left, right) => left - right);
  if (sorted.length === 1) return `第 ${sorted[0]} 集`;
  if (
    sorted.every(
      (number, index) =>
        !index || number === requirePresent(sorted[index - 1], "sorted[index - 1]") + 1,
    )
  )
    return `第 ${sorted[0]}–${sorted.at(-1)} 集`;
  return `第 ${sorted.slice(0, 4).join("、")}${sorted.length > 4 ? ` 等 ${sorted.length}` : ""} 集`;
}
export function breakdownBlocked(doc: DramaDocument) {
  const busy = dramaBusyReason(doc);
  if (busy) return busy;
  return doc.episodes.some(
    (ep) =>
      !ep.locked && (ep.script_status ?? (ep.script_md.trim() ? "ready" : "empty")) === "ready",
  )
    ? null
    : "没有可拆解的集：先写好剧本";
}
function BreakdownRow({ job, cancel }: { job: Job; cancel: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const queued = job.status === "queued",
    { progress, detail } = dramaJobFeedback(job);
  return (
    <>
      <div role="status" className="drama-breakdown-row">
        <EpisodeProgress size={16} queued={queued} progress={progress ?? 0} />
        <span>拆解{rangeLabel(job.episodes)}</span>
        {!queued && (
          <div className="drama-breakdown-track">
            <motion.i
              initial={false}
              animate={{ scaleX: Math.max(0.03, (progress ?? 0) / 100) }}
              transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
            />
          </div>
        )}
        <small>{queued ? "排队中" : progress === null ? "进行中" : `${progress}%`}</small>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await cancel(job.id);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "取消失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          取消
        </button>
      </div>
      {!queued && detail && <small>{detail}</small>}
      {error && <DramaNotice tone="error">{error}</DramaNotice>}
    </>
  );
}
export function BreakdownProgress({
  doc,
  cancel,
}: {
  doc: DramaDocument;
  cancel: (id: string) => Promise<void>;
}) {
  const jobs = doc.jobs?.filter((job) => job.step === "breakdown" && active(job));
  return jobs?.length ? (
    <div className="drama-breakdown-progress">
      {jobs.map((job) => (
        <BreakdownRow key={job.id} job={job} cancel={cancel} />
      ))}
    </div>
  ) : null;
}
