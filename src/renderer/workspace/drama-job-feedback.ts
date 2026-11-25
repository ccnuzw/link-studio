import type { DramaJobRecord } from "@link-studio/core";

export function dramaJobFeedback(job: DramaJobRecord) {
  const progress = job.progress || null;
  if (job.status !== "running") return { progress, detail: job.error_message };
  if (job.step === "storyboard") {
    return { progress, detail: progress ? "分镜初稿已返回，正在整理镜头" : "正在生成分镜初稿" };
  }
  const written = job.prompted_nodes?.length ?? 0;
  const assets = job.new_nodes?.length ?? 0;
  const episodes = job.done_episodes?.length ?? 0;
  const deferred = job.deferred_nodes?.length;
  if (job.step === "breakdown") {
    const detail = episodes
      ? `已拆解 ${episodes}/${job.episodes.length} 集 · 已补 ${written}/${assets} 个提示词`
      : progress
        ? "正在整理拆解结果"
        : "正在提取剧本资产";
    return { progress, detail: deferred ? `${detail} · ${deferred} 个待补词` : detail };
  }
  if (job.step === "asset_prompts" && assets)
    return {
      progress: Math.round((100 * written) / assets),
      detail: `${written}/${assets} 个提示词`,
    };
  if (episodes && job.episodes.length)
    return {
      progress: Math.max(progress ?? 0, Math.round((100 * episodes) / job.episodes.length)),
      detail: `已完成 ${episodes}/${job.episodes.length} 集`,
    };
  return { progress, detail: undefined };
}
