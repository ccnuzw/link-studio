import type { DramaDocument } from "@link-studio/core";
import { Clapperboard, Lock, ScrollText, Users } from "lucide-react";
import "./drama-studio-gate.css";

export function studioPrerequisite(
  doc: DramaDocument,
  episode?: DramaDocument["episodes"][number],
) {
  if (!episode) return "empty";
  if (
    episode.storyboard_status === "ready" ||
    episode.storyboard_status === "generating" ||
    episode.locked
  )
    return null;
  if (
    doc.jobs?.some(
      (job) =>
        job.step === "breakdown" &&
        ["queued", "running"].includes(job.status) &&
        job.episodes.includes(episode.episode_no),
    )
  )
    return "breaking";
  if (
    (!episode.storyboard_status || episode.storyboard_status === "empty") &&
    doc.segments?.some((segment) => segment.episode_no === episode.episode_no)
  )
    return null;
  return (episode.script_status ?? (episode.script_md.trim() ? "ready" : "empty")) === "ready"
    ? "ready"
    : "missing";
}

export function DramaStudioGate({
  kind,
  no,
  go,
  openBreakdown,
}: {
  kind: NonNullable<ReturnType<typeof studioPrerequisite>>;
  no: number;
  go: (stage: "assets" | "script", no: number) => void;
  openBreakdown: () => void;
}) {
  const empty = kind === "empty",
    breaking = kind === "breaking",
    ready = kind === "ready",
    Icon = empty ? Clapperboard : Lock,
    Action = breaking ? Users : ScrollText;
  const title = empty
    ? "还没有分集"
    : breaking
      ? `第 ${no} 集的资产还在拆解`
      : `先拆解第 ${no} 集的资产`;
  const text = empty
    ? "研读完成后分集会出现在左侧，也可以在剧本页手动新增一集。"
    : breaking
      ? "拆解完成后才能生成分镜。"
      : `分镜需要知道这一集出场的角色、场景和道具。${ready ? "拆解后这一集的剧本会锁定。" : "这一集的剧本也还没写好。"}`;
  return (
    <section className="drama-studio-gate" aria-label="片场引导">
      <span>
        <Icon />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {!empty && (
        <button
          type="button"
          data-outline={breaking || undefined}
          onClick={ready ? openBreakdown : () => go(breaking ? "assets" : "script", no)}
        >
          <Action />
          {breaking ? "去资产管理" : ready ? "去拆解" : "去写剧本"}
        </button>
      )}
    </section>
  );
}
