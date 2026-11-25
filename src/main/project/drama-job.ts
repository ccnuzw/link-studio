import { randomBytes } from "node:crypto";
import { requirePresent } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import type { DramaDocument } from "../../../packages/link-studio-core/src/drama.ts";
import {
  type DramaJobRecord,
  DramaJobRequest,
} from "../../../packages/link-studio-core/src/drama.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { bumpSegmentVersion, dramaDocument } from "./drama.ts";
import { syncDramaBoards } from "./drama-boards.ts";
import { dramaKnownCast } from "./drama-cast.ts";
import { estimateDramaJob } from "./drama-estimate.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

export function storyboardClearHash(doc: DramaDocument, no: number) {
  return contentHash({
    no,
    order: doc.episode_order ?? 0,
    segments: doc.segments?.filter((segment) => segment.episode_no === no) ?? [],
  });
}

export function dramaJobReceipt(
  store: ProjectStore,
  runId: string,
  approvalId: string,
  payload: unknown,
) {
  const job = dramaDocument(store.snapshot)?.jobs?.find((item) => item.approval_id === approvalId);
  if (!job) return null;
  if (job.approval_hash !== contentHash({ runId, payload }))
    throw new ProjectError("AGENT_APPROVAL_STALE", "短剧审批内容已改变，请重新申请审批");
  return job;
}

const textSteps = new Set(["scripts", "breakdown", "asset_prompts"]);

export function progressBucket(value: number) {
  return Math.min(90, Math.floor(value / 10) * 10);
}

export async function recordDramaProgress(
  store: ProjectStore,
  id: string,
  value: number,
  signal: AbortSignal,
) {
  const progress = progressBucket(value);
  return store.updateGeneration((state) => {
    const task = dramaDocument(state)?.jobs?.find((entry) => entry.id === id);
    if (task?.status !== "running") throw new ProjectError("DRAMA_STEP_NOT_READY", "任务已结束");
    if (progress <= (task.progress ?? 0)) return { changed: false, result: null };
    task.progress = progress;
    return { changed: true, result: null };
  }, signal);
}

export async function submitApprovedDramaJob(
  store: ProjectStore,
  registry: SettingsRegistry,
  runId: string,
  approvalId: string,
  payload: {
    args: DramaJobRequest;
    estimate: number;
    episodeOrder?: number;
    clearHash?: string;
    batch?: boolean;
  },
  signal?: AbortSignal,
) {
  if (!approvalId || !runId || !Value.Check(DramaJobRequest, payload?.args))
    throw new ProjectError("VALIDATION_FAILED", "短剧审批内容格式不对");
  return store.updateGeneration(async (state) => {
    const doc = dramaDocument(state);
    if (!doc) throw new ProjectError("AGENT_SCOPE_DENIED", "未创建短剧");
    const previous = dramaJobReceipt(store, runId, approvalId, payload);
    if (previous) return { changed: false, result: previous };
    if ((payload.episodeOrder ?? 0) !== (doc.episode_order ?? 0))
      throw new ProjectError("AGENT_APPROVAL_STALE", "分集已变更，请重新选择并确认");
    const { step } = payload.args;
    const jobs = doc.jobs ?? [];
    const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
    const conflict = active.some((job) =>
      textSteps.has(step)
        ? textSteps.has(job.step)
        : !textSteps.has(job.step) &&
          payload.args.episodes.some((number) => job.episodes.includes(number)),
    );
    if (conflict) throw new ProjectError("DRAMA_JOB_CONFLICT", "已有进行中的短剧任务");
    if (payload.batch) {
      const episode = doc.episodes.find((item) => item.episode_no === payload.args.episodes[0]);
      if (
        runId !== "workspace" ||
        step !== "storyboard" ||
        payload.clearHash ||
        !episode ||
        ["ready", "generating"].includes(episode.storyboard_status ?? "empty")
      )
        throw new ProjectError("DRAMA_STEP_NOT_READY", "本集无法批量生成分镜，请重新选集");
    }
    if (payload.clearHash) {
      const no = payload.args.episodes[0];
      if (
        runId !== "workspace" ||
        step !== "storyboard" ||
        !no ||
        payload.clearHash !== storyboardClearHash(doc, no)
      )
        throw new ProjectError("AGENT_APPROVAL_STALE", "片段已经改变，请重新确认");
      doc.segments = doc.segments?.filter((segment) => segment.episode_no !== no) ?? [];
      syncDramaBoards(state, no, doc.segments);
      bumpSegmentVersion(doc, no);
    }
    const quote = await estimateDramaJob(doc, payload.args, registry, state);
    if (quote.estimate !== payload.estimate)
      throw new ProjectError("AGENT_APPROVAL_STALE", "短剧估价已改变，请重新申请审批");
    const stages =
      step === "scripts"
        ? (["scripts"] as const)
        : step === "breakdown"
          ? (["assets", "asset_prompts"] as const)
          : step === "storyboard"
            ? (["video"] as const)
            : step === "asset_prompts"
              ? (["asset_prompts"] as const)
              : [];
    const job: DramaJobRecord = {
      id: randomBytes(16).toString("hex"),
      status: "queued",
      progress: 0,
      step,
      episodes: quote.episodes,
      episode_order: doc.episode_order ?? 0,
      created_at: new Date().toISOString(),
      request: { ...payload.args, ...("storyboardLimits" in quote && quote.storyboardLimits) },
      ...("model" in quote && { model: quote.model }),
      frozen_credits: quote.estimate,
      approval_id: approvalId,
      approval_hash: contentHash({ runId, payload }),
      ...(quote.compose_input && { compose_input: quote.compose_input }),
      ...(textSteps.has(step) && { known_cast: dramaKnownCast(state, doc) }),
      ...(stages.length && {
        prompt_snapshots: Object.fromEntries(
          stages.flatMap((key) =>
            doc.prompt_snapshots?.[key] ? [[key, { ...doc.prompt_snapshots[key] }]] : [],
          ),
        ),
      }),
      ...("nodes" in quote && quote.nodes && { new_nodes: quote.nodes }),
    };
    doc.jobs = [...jobs, job];
    if (step === "scripts") {
      doc.status = "scripting";
      doc.overview_revision = (doc.overview_revision ?? doc.revision) + 1;
      doc.revision++;
    }
    if (step === "storyboard") {
      const episode = requirePresent(
        doc.episodes.find((entry) => entry.episode_no === quote.episodes[0]),
        "doc.episodes.find((entry) => entry.episode_no === quote.episodes[0])",
      );
      episode.storyboard_status = "generating";
      episode.revision = (episode.revision ?? 1) + 1;
      doc.overview_revision ??= doc.revision;
      doc.revision++;
    }
    return { changed: true, result: job };
  }, signal);
}
