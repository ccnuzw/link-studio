import {
  type CreativeData,
  type GenerationJob,
  isPlainGeneratedMedia,
  jobIsTerminal,
} from "@link-studio/core";
import { mediaNodeJob } from "./media-node-job";

type Target =
  | {
      id: string;
      type: "creative";
      data: CreativeData & { uploadProgress?: number; uploadInterrupted?: boolean };
    }
  | { id: string; type: "group" | "unknown" };

export function runningEdgeTargets(nodes: readonly Target[], jobs: readonly GenerationJob[]) {
  const byNode = new Map<string, GenerationJob[]>();
  for (const job of jobs) {
    const matching = byNode.get(job.nodeId);
    if (matching) matching.push(job);
    else byNode.set(job.nodeId, [job]);
  }
  const running = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "creative") continue;
    const data = node.data;
    if (data.uploadProgress !== undefined) {
      if (!data.uploadInterrupted) running.add(node.id);
      continue;
    }
    const matching = byNode.get(node.id);
    if (!matching) continue;
    if (isPlainGeneratedMedia(data)) {
      const displayed = mediaNodeJob(matching, node.id, data);
      if (displayed && !jobIsTerminal(displayed.status)) running.add(node.id);
    } else if (matching.some((job) => !jobIsTerminal(job.status))) running.add(node.id);
  }
  return running;
}
