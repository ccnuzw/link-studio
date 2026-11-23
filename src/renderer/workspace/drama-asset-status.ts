import {
  type CreativeData,
  type GenerationJob,
  jobFailureReason,
  jobIsTerminal,
} from "@link-studio/core";
import { mediaNodeJob } from "./media-node-job";

export function dramaAssetStatus(
  id: string,
  data: CreativeData,
  jobs: GenerationJob[],
  analyzing: boolean,
  progress?: number | "interrupted",
) {
  if (typeof progress === "number") return { state: "uploading", progress } as const;
  if (progress === "interrupted" || data.uploadFailed)
    return { state: "error", upload: true } as const;
  const kind = data.kind === "script" ? "text" : data.kind;
  const job =
    data.character || kind === "text"
      ? jobs.find((item) => item.kind === kind && !item.purpose)
      : mediaNodeJob(jobs, id, data);
  if (job && !jobIsTerminal(job.status)) return { state: "running" } as const;
  if (
    data.textStatus === "error" ||
    (job?.status === "failed" && kind !== "text" && (!data.character || !data.assetId))
  )
    return {
      state: "error",
      message: kind === "text" ? data.textError : jobFailureReason(job),
    } as const;
  if (data.kind === "script" ? data.text.trim() : data.assetId) return { state: "done" } as const;
  return { state: analyzing && !data.text.trim() ? "analyzing" : "idle" } as const;
}

export function assetPoster(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const tint = `var(--asset-tint-${hash % 6})`,
    amount = 28 + (hash % 4) * 6;
  return `linear-gradient(${140 + (hash % 5) * 12}deg,color-mix(in oklch,${tint} ${amount}%,var(--asset-muted)),color-mix(in oklch,${tint} ${amount / 3}%,var(--asset-muted)))`;
}
