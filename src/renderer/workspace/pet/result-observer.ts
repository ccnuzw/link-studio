import { type GenerationJob, jobIsTerminal } from "@link-studio/core";

export function canvasPetJobs(jobs: GenerationJob[], nodes: readonly { id: string }[]) {
  const targets = new Set(nodes.map((node) => node.id));
  return jobs.filter((job) => job.purpose !== "drama-segment" && targets.has(job.nodeId));
}

export class CanvasResultObserver {
  private readonly running = new Set<string>();
  private readonly consumed = new Set<string>();

  constructor(private readonly openedAt: number) {}

  collect<Job extends Pick<GenerationJob, "id" | "status" | "updatedAt">>(jobs: readonly Job[]) {
    return jobs.filter((job) => {
      if (!jobIsTerminal(job.status)) {
        this.running.add(job.id);
        return false;
      }
      const seenRunning = this.running.delete(job.id);
      if (job.status !== "succeeded" && job.status !== "failed") return false;
      if (this.consumed.has(job.id)) return false;
      this.consumed.add(job.id);
      return seenRunning || Date.parse(job.updatedAt) >= this.openedAt;
    });
  }
}
