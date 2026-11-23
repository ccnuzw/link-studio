import { type CreativeData, type GenerationJob, jobIsTerminal } from "@link-studio/core";

export function mediaNodeJob(jobs: GenerationJob[], nodeId: string, data: CreativeData) {
  if (data.kind === "script" || data.character || data.uploaded || data.uploadFailed) return;
  const matching = jobs.filter(
    (job) => job.nodeId === nodeId && job.kind === data.kind && !job.purpose,
  );
  const latest = matching[0];
  if (!latest) return;
  const batch = latest.batchId
    ? matching.filter((job) => job.batchId === latest.batchId)
    : [latest];
  if (
    data.assetId &&
    batch.some(
      (job) =>
        job.status === "succeeded" &&
        (job.outputs.some((output) => output.kind !== "text" && output.assetId === data.assetId) ||
          (job.bound && data.outputs?.some((output) => output.id === `${job.id}:0`))),
    )
  )
    return;
  const active = batch.find((job) => !jobIsTerminal(job.status));
  if (active) return active;
  if (
    !data.assetId &&
    (!data.outputs?.length ||
      data.pendingMediaVersion?.batchId === (latest.batchId ?? latest.id)) &&
    batch.every((job) => job.status === "failed" || job.status === "cancelled")
  ) {
    const last = [...batch].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return last?.status === "failed" ? last : undefined;
  }
}
