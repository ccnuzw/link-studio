import type { GenerationJob } from "@link-studio/core";

export type HistoryNode = {
  id: string;
  data: {
    label: string;
    outputs?: readonly { id: string }[];
    pendingMediaVersion?: { batchId: string };
  };
};

export function historyJobScope(
  nodes: readonly HistoryNode[],
  jobs: readonly GenerationJob[],
  inventoryReady: boolean,
) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const outputJobs = new Set<string>();
  const pendingBatches = new Set<string>();
  for (const { data } of nodes) {
    for (const output of data.outputs ?? []) {
      const match = /^(.+):\d+$/.exec(output.id);
      if (match?.[1]) outputJobs.add(match[1]);
    }
    if (data.pendingMediaVersion) pendingBatches.add(data.pendingMediaVersion.batchId);
  }
  const references = (job: GenerationJob) =>
    outputJobs.has(job.id) || pendingBatches.has(job.batchId ?? job.id);
  const initial = jobs.filter((job) => nodeIds.has(job.nodeId) || references(job));
  const knownIds = new Set(initial.map((job) => job.id));
  const includes = (job: GenerationJob) => knownIds.has(job.id) || references(job);
  return {
    initial,
    includes,
    fetch:
      nodes.length > 0 &&
      (!inventoryReady || knownIds.size > 0 || outputJobs.size > 0 || pendingBatches.size > 0),
    acceptsSnapshot: (job: GenerationJob) =>
      includes(job) || (!inventoryReady && nodeIds.has(job.nodeId)),
  };
}

export function historyJobRows(
  snapshot: GenerationJob[],
  live: GenerationJob[],
  includes?: (job: GenerationJob) => boolean,
) {
  const current = new Map<string, GenerationJob>();
  const upsert = (job: GenerationJob) => {
    const prev = current.get(job.id);
    if (!prev || job.updatedAt >= prev.updatedAt) current.set(job.id, job);
  };
  snapshot.forEach(upsert);
  live.forEach((job) => {
    if (current.has(job.id) || includes?.(job)) upsert(job);
  });
  return [...current.values()].sort((first, second) =>
    second.createdAt.localeCompare(first.createdAt),
  );
}
