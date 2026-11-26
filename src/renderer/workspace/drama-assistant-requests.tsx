import type { DramaDocument, DramaJobRecord, SettingsApproval } from "@link-studio/core";
import { Clapperboard, GitPullRequest } from "lucide-react";
import { useId, useState } from "react";
import { focusOnMount } from "../focus-on-mount";
import { settingsError } from "../settings/settings-page";
import {
  AssistantRequestReceipt,
  CanvasRequestDetails,
  RequestHeading,
} from "./canvas-request-cards";
import { dramaJobFeedback } from "./drama-job-feedback";
import { episodeScope } from "./drama-task-recovery";
import type { Stage } from "./drama-workspace-nav";

const steps = {
  scripts: ["分集剧本", "script"],
  breakdown: ["资产拆解", "assets"],
  asset_prompts: ["资产提示词", "assets"],
  storyboard: ["分镜脚本", "studio"],
  compose: ["合成整集", "final"],
} as const;

const statuses: Record<DramaJobRecord["status"], string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};

const labels: Record<string, string> = {
  title: "标题",
  script_md: "剧本",
  synopsis: "梗概",
  outline_md: "大纲",
  characters_md: "人物传记",
  prompt: "提示词",
  seconds: "秒数",
};

export function DramaAssistantRequest({
  approval,
  busy,
  decide,
}: {
  approval: SettingsApproval;
  busy: boolean;
  decide: (approved: boolean, answer?: string) => void;
}) {
  const id = useId();
  const [explanation, setExplanation] = useState<string>();
  const payload = approval.payload as {
    title: string;
    reason?: string;
    args?: DramaJobRecord["request"];
    episodes?: number[];
    before?: Record<string, string | number> | string;
    after?: Record<string, string | number> | string;
    estimate?: number;
  };
  const job = approval.kind === "drama_run_job" ? payload.args : undefined;
  const before = typeof payload.before === "object" ? payload.before : {};
  const after = typeof payload.after === "object" ? payload.after : undefined;
  return (
    <section className="canvas-request-card" aria-labelledby={id}>
      <RequestHeading
        id={id}
        icon={job ? Clapperboard : GitPullRequest}
        title={payload.title}
        meta="需确认"
      />
      {payload.reason && <p className="canvas-request-copy">{payload.reason}</p>}
      {job && (
        <p className="canvas-request-copy">
          {[episodeScope(payload.episodes ?? job.episodes), `预估 ${payload.estimate ?? 0} 积分`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {job && (job.ratio || job.max_seconds || job.max_audios !== undefined) ? (
        <CanvasRequestDetails label="查看请求详情">
          {job.ratio && <p>画幅 {job.ratio}</p>}
          {job.max_seconds && <p>片段最长 {job.max_seconds} 秒</p>}
          {job.max_audios !== undefined && <p>最多 {job.max_audios} 个音频参考</p>}
        </CanvasRequestDetails>
      ) : after ? (
        <ul className="canvas-request-list canvas-request-operations">
          {Object.entries(after).map(([field, value]) => (
            <li key={field}>
              <strong>{labels[field] ?? field}</strong>
              <del className="canvas-request-copy">{before[field] || "空"}</del>
              <ins className="canvas-request-copy">{value || "空"}</ins>
            </li>
          ))}
        </ul>
      ) : null}
      {explanation !== undefined && (
        <input
          aria-label="拒绝说明"
          ref={focusOnMount}
          maxLength={2000}
          value={explanation}
          placeholder="说明希望怎么调整"
          onChange={(event) => setExplanation(event.target.value)}
        />
      )}
      <div className="canvas-request-actions">
        <button type="button" disabled={busy} onClick={() => decide(false)}>
          {job ? "不用了" : "保留原文"}
        </button>
        {job && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              explanation === undefined
                ? setExplanation("")
                : decide(false, explanation.trim() || undefined)
            }
          >
            {explanation === undefined ? "不用了，并告诉小灵怎么改…" : "提交说明"}
          </button>
        )}
        <button type="button" data-primary disabled={busy} onClick={() => decide(true)}>
          {job ? "批准并运行" : "批准修改"}
          {!!payload.estimate && ` ✦ ${payload.estimate}`}
        </button>
      </div>
    </section>
  );
}

export function DramaAssistantReceipt({
  data,
  document,
  go,
}: {
  data: Record<string, unknown>;
  document: DramaDocument;
  go: (stage: Stage, episode?: number) => void;
}) {
  const result = data.result as { id?: string; code?: string } | null;
  const job = data.kind === "drama_run_job" && document.jobs?.find(({ id }) => id === result?.id);
  if (job) {
    const [name, stage] = steps[job.step];
    const { progress, detail } = dramaJobFeedback(job);
    const current = (job.episode_order ?? 0) === (document.episode_order ?? 0);
    return (
      <AssistantRequestReceipt
        status={job.status}
        text={[
          name,
          episodeScope(job.episodes),
          statuses[job.status],
          job.status === "running" && progress !== null ? `${progress}%` : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
        detail={detail ?? job.prompt_error}
        open={current ? () => go(stage, job.episodes[0]) : undefined}
      />
    );
  }
  const status = data.status;
  const title = (data.payload as { title?: string } | null)?.title || "短剧请求";
  const labels: Record<string, string> = {
    failed: `${title}失败`,
    expired: `${title}已失效`,
    rejected: data.kind === "drama_run_job" ? "已拒绝任务" : "已保留原内容",
    executed: data.kind === "drama_run_job" ? "已提交短剧任务" : "已写入短剧",
    approved: "已批准，等待执行结果",
  };
  const text = labels[String(status)] ?? "短剧请求不可操作";
  return (
    <AssistantRequestReceipt
      status={status}
      text={text}
      detail={status === "failed" && result?.code ? settingsError(result.code) : undefined}
    />
  );
}
