import {
  type DramaDocument,
  type GenerationJob,
  jobFailureReason,
  jobIsTerminal,
  type ProjectAsset,
} from "@link-studio/core";

type Segment = NonNullable<DramaDocument["segments"]>[number];

export function batchVideoTargets(
  segments: readonly Segment[],
  episodeNo: number,
  jobs: readonly GenerationJob[],
  assets: readonly ProjectAsset[],
) {
  const readyVideos = new Set(
    assets
      .filter((asset) => asset.mediaType === "video" && asset.availability === "ready")
      .map((asset) => asset.assetId),
  );
  const active = new Set<string>();
  const playable = new Map<string, string>();
  for (const job of jobs) {
    if (job.purpose !== "drama-segment") continue;
    if (!jobIsTerminal(job.status)) active.add(job.nodeId);
    if (
      job.status === "succeeded" &&
      job.outputs.some((output) => output.kind === "video" && readyVideos.has(output.assetId))
    )
      playable.set(job.id, job.nodeId);
  }
  return segments.filter((segment) => {
    const nodeId = `seg:${segment.id}`;
    return (
      segment.episode_no === episodeNo &&
      segment.prompt.trim() &&
      !active.has(nodeId) &&
      (!segment.chosen_task_id || playable.get(segment.chosen_task_id) !== nodeId)
    );
  });
}

export function segmentAttempt(segment: Segment, newestFirst: readonly GenerationJob[]) {
  const latest = newestFirst[0];
  if (!latest) return { state: "idle" } as const;
  const latestTime = latest.createdAt;
  const tied =
    newestFirst[1]?.createdAt === latestTime
      ? new Map(
          newestFirst.filter((job) => job.createdAt === latestTime).map((job) => [job.id, job]),
        )
      : undefined;
  const lastId = tied && segment.take_ids?.findLast((id) => tied.has(id));
  const attempt = (lastId && tied?.get(lastId)) || latest;
  if (!jobIsTerminal(attempt.status)) return { state: "running" } as const;
  if (attempt.status === "failed" || attempt.status === "outcome_unknown")
    return { state: "failed", message: jobFailureReason(attempt) || "生成失败" } as const;
  return { state: "idle" } as const;
}

export function editorAttempt(
  segment: Segment,
  jobs: readonly GenerationJob[],
  assets: readonly ProjectAsset[],
) {
  const attempt = segmentAttempt(segment, jobs);
  if (attempt.state !== "idle") return attempt;
  const chosen = jobs.find(
    (job) => job.id === segment.chosen_task_id && job.status === "succeeded",
  );
  const output = chosen?.outputs.find((entry) => entry.kind === "video");
  return output?.kind === "video" &&
    assets.some(
      (asset) =>
        asset.assetId === output.assetId &&
        asset.mediaType === "video" &&
        asset.availability === "ready",
    )
    ? ({ state: "ready" } as const)
    : attempt;
}
