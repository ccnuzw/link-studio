import type { CreativeData, GenerationJob, ProjectCanvasView } from "@link-studio/core";
import { jobIsTerminal, restoreMediaVersion } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";

const equal = (left: unknown, right: unknown): boolean => Value.Equal(left, right);

export function restoreTaskMedia(
  snapshot: CreativeData,
  current: CreativeData,
  jobs: GenerationJob[],
  nodeId: string,
) {
  const marker = current.pendingMediaVersion ?? snapshot.pendingMediaVersion;
  if (!marker) return snapshot;
  const batch = jobs.filter(
    (job) => job.nodeId === nodeId && (job.batchId ?? job.id) === marker.batchId,
  );
  if (
    (current.pendingMediaVersion && batch.some((job) => !jobIsTerminal(job.status))) ||
    (snapshot.pendingMediaVersion &&
      !current.pendingMediaVersion &&
      batch.some((job) => job.status === "succeeded" || job.status === "cancelled"))
  ) {
    const next = { ...snapshot, outputs: current.outputs };
    delete next.assetId;
    delete next.activeOutputId;
    delete next.pendingMediaVersion;
    if (current.assetId) next.assetId = current.assetId;
    if (current.activeOutputId) next.activeOutputId = current.activeOutputId;
    if (current.pendingMediaVersion) next.pendingMediaVersion = current.pendingMediaVersion;
    return next;
  }
  return snapshot;
}

function versionTransition(before: CreativeData, after: CreativeData, jobs: GenerationJob[]) {
  const prior = before.pendingMediaVersion,
    next = after.pendingMediaVersion;
  if (
    next &&
    next.batchId !== prior?.batchId &&
    jobs.some((job) => (job.batchId ?? job.id) === next.batchId)
  ) {
    const outputs = before.outputs ?? [];
    const legacy = after.outputs?.find((output) => output.id === next.outputId);
    if (
      next.outputId !==
      (prior?.outputId ??
        before.activeOutputId ??
        outputs.find((output) => output.assetId === before.assetId)?.id ??
        before.assetId)
    )
      return false;
    if (!legacy?.assetId || (before.assetId && legacy.assetId !== before.assetId)) return false;
    const expected = {
      ...before,
      outputs: outputs.some((output) => output.id === next.outputId)
        ? outputs
        : [...outputs, legacy].slice(-50),
      pendingMediaVersion: next,
    };
    delete expected.assetId;
    delete expected.activeOutputId;
    return equal(expected, after);
  }
  return (
    !!prior &&
    !next &&
    jobs.some((job) => (job.batchId ?? job.id) === prior.batchId && job.status === "cancelled") &&
    equal(restoreMediaVersion(before), after)
  );
}

export function generatedFields(data: CreativeData, result: CreativeData) {
  const outputs = result.outputs ?? [];
  const selected =
    outputs.find((output) => output.id === data.activeOutputId) ??
    outputs.find((output) => output.id === result.activeOutputId);
  const next = { ...data, outputs };
  if (selected) {
    delete next.pendingMediaVersion;
    next.activeOutputId = selected.id;
    if (selected.kind === "text") {
      next.text = selected.text ?? "";
      delete next.assetId;
    } else next.assetId = selected.assetId;
  } else if (next.activeOutputId) delete next.activeOutputId;
  return next;
}

export function generatedHistoryUpdate(
  before: ProjectCanvasView,
  after: ProjectCanvasView,
  jobs: GenerationJob[],
) {
  if (before.nodes.length !== after.nodes.length || !Value.Equal(before.edges, after.edges))
    return null;
  const changed = new Map<string, { current: string[]; added: Set<string> }>();
  for (const [index, node] of after.nodes.entries()) {
    const old = before.nodes[index];
    if (equal(old, node)) continue;
    if (old?.type !== "creative" || node.type !== "creative") return null;
    if (
      equal({ ...old, data: node.data }, node) &&
      versionTransition(
        old.data,
        node.data,
        jobs.filter((job) => job.nodeId === node.id),
      )
    )
      continue;
    const history = old.data.outputs ?? [];
    const outputs = node.data.outputs ?? [];
    const additions = outputs.filter((output) => !history.some((saved) => saved.id === output.id));
    if (!additions.length || !Value.Equal(outputs, [...history, ...additions].slice(-50)))
      return null;
    const known = new Map<string, GenerationJob["outputs"][number]>(
      jobs
        .filter((job) => job.nodeId === node.id && job.status === "succeeded")
        .flatMap((job) =>
          job.outputs.map((output, index) => [`${job.id}:${index}`, output] as const),
        ),
    );
    if (
      !additions.every((output) => {
        const source = known.get(output.id);
        return (
          source &&
          source.kind === output.kind &&
          (source.kind === "text" ? source.text === output.text : source.assetId === output.assetId)
        );
      })
    )
      return null;
    if (
      old.data.activeOutputId !== node.data.activeOutputId &&
      !additions.some((output) => output.id === node.data.activeOutputId)
    )
      return null;
    const expected = generatedFields(
      { ...old.data, activeOutputId: node.data.activeOutputId },
      node.data,
    );
    if (!node.data.activeOutputId) delete expected.activeOutputId;
    if (!Value.Equal({ ...old, data: expected }, node)) return null;
    changed.set(node.id, {
      current: outputs.map((output) => output.id),
      added: new Set(additions.map((output) => output.id)),
    });
  }
  return changed;
}
