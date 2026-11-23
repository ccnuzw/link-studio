import {
  type CreativeData,
  type CreativeOutput,
  type GenerationJob,
  jobIsTerminal,
} from "@link-studio/core";
import type { Rect } from "./alignment";

export function versionJobs(jobs: GenerationJob[], id: string, kind: CreativeData["kind"]) {
  return jobs.filter((job) => job.nodeId === id && job.kind === kind && !job.purpose);
}

export function pendingVersionJobs(jobs: GenerationJob[]) {
  const latest = jobs[0];
  if (!latest) return [];
  const batchId = latest.batchId ?? latest.id;
  return jobs.filter((job) => (job.batchId ?? job.id) === batchId && !jobIsTerminal(job.status));
}

export function versionOutputs(data: CreativeData): CreativeOutput[] {
  if (data.kind === "script") return [];
  if (data.outputs?.length) return data.outputs;
  return data.assetId
    ? [{ id: data.assetId, kind: data.kind, assetId: data.assetId, createdAt: "" }]
    : [];
}

export function versionBadge(data: CreativeData, jobs: GenerationJob[]) {
  if (data.kind === "script") return;
  const pending = pendingVersionJobs(jobs).length;
  const count = versionOutputs(data).length + pending;
  return count >= 2 ? { count, generating: pending > 0 } : undefined;
}

export function versionNodes(
  data: CreativeData,
  versions: CreativeOutput[],
  origin: Rect,
  occupied: Rect[],
) {
  const taken = [...occupied];
  const outputs = versionOutputs(data);
  return versions.flatMap((output) => {
    if (output.kind === "text" || !output.assetId) return [];
    const index = outputs.findIndex((item) => item.id === output.id);
    if (index < 0) return [];
    const suffix = ` · 版本${index + 1}`;
    for (let step = 0; ; step++) {
      const box = {
        ...origin,
        x: origin.x + ((step % 4) + 1) * (origin.width + 40),
        y: origin.y + Math.floor(step / 4) * (origin.height + 40),
      };
      if (
        step < 200 &&
        taken.some(
          (other) =>
            box.x < other.x + other.width + 40 &&
            other.x < box.x + box.width + 40 &&
            box.y < other.y + other.height + 40 &&
            other.y < box.y + box.height + 40,
        )
      )
        continue;
      taken.push(box);
      return [
        {
          id: crypto.randomUUID(),
          type: "creative" as const,
          position: { x: box.x, y: box.y },
          selected: true,
          data: {
            kind: output.kind,
            label: [...data.label].slice(0, 255 - suffix.length).join("") + suffix,
            text: "",
            assetId: output.assetId,
            outputs: [output],
            activeOutputId: output.id,
          },
        },
      ];
    }
  });
}
