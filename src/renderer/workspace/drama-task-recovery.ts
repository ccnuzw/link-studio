import {
  type DramaDocument,
  type DramaJobRecord,
  pendingDramaPromptIds,
  requirePresent,
} from "@link-studio/core";

export function failureRecovery(
  doc: DramaDocument,
  job: DramaJobRecord,
  blank?: ReadonlySet<string>,
) {
  const jobs = (doc.jobs ?? []).filter(
    (other) => (other.episode_order ?? 0) === (job.episode_order ?? 0),
  );
  const sameOrder = (job.episode_order ?? 0) === (doc.episode_order ?? 0);
  const later = jobs.slice(jobs.findIndex((other) => other.id === job.id) + 1);
  const covered =
    sameOrder &&
    job.episodes.length > 0 &&
    job.episodes.every((no) =>
      later.some(
        (other) =>
          other.step === job.step && other.status === "succeeded" && other.episodes.includes(no),
      ),
    );
  const prompts = job.step === "asset_prompts" || job.step === "breakdown";
  const remaining = doc.episodes.filter(
    (ep) =>
      job.episodes.includes(ep.episode_no) &&
      !ep.locked &&
      !job.done_episodes?.includes(ep.episode_no),
  );
  const missing =
    sameOrder && prompts && blank ? pendingDramaPromptIds(jobs, job.episodes, blank) : [];
  const repaired =
    sameOrder &&
    prompts &&
    blank !== undefined &&
    !missing.length &&
    (job.step === "asset_prompts" ||
      (!remaining.length &&
        job.episodes.every((no) => doc.episodes.some((ep) => ep.episode_no === no && ep.locked))));
  const kept =
    sameOrder && job.step === "storyboard" && job.episodes.length === 1
      ? (doc.segments?.filter((segment) => segment.episode_no === job.episodes[0]).length ?? 0)
      : 0;
  return {
    resolved: repaired || (covered && (!prompts || (blank !== undefined && !missing.length))),
    missing,
    remaining,
    kept,
  };
}

export function episodeScope(episodes: number[]) {
  if (!episodes.length) return;
  const consecutive = episodes.every(
    (no, index) => !index || no === requirePresent(episodes[index - 1], "episodes[index - 1]") + 1,
  );
  return `第 ${consecutive && episodes.length > 1 ? `${episodes[0]}–${episodes.at(-1)}` : episodes.join("、")} 集`;
}
