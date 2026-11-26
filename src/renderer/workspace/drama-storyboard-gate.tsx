import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  type DramaDocument,
  type DramaJobRecord,
  dramaBusyReason,
  dramaVideoModelIssue,
  modelGenerationOptions,
  type PluginView,
  type ProviderView,
  requirePresent,
} from "@link-studio/core";
import { Clapperboard, Loader2, RotateCw } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dramaJobFeedback } from "./drama-job-feedback";
import { DramaNotice } from "./drama-studio-status";

export function studioVideoSelection(
  local: string,
  preferred: string | undefined,
  models: ProviderView[],
  plugins: PluginView[],
) {
  const usable = models.filter((model) => !dramaVideoModelIssue(model, plugins)),
    model =
      usable.find((entry) => entry.id === local) ??
      usable.find((entry) => entry.id === preferred) ??
      usable[0];
  if (!model) return {};
  const plugin = plugins.find((entry) => entry.hash === model.pluginHash),
    options = modelGenerationOptions(
      "video",
      plugin?.origin === "builtin" ? plugin.key : undefined,
      model.model,
      model.channel,
      model.config,
    );
  return { model, options };
}

export function StoryboardGateContent({
  no,
  generating,
  failed,
  job,
  credits,
  problem,
  blocked,
  busy,
  start,
  cancel,
}: {
  no: number;
  generating: boolean;
  failed: boolean;
  job?: DramaJobRecord;
  credits?: number;
  problem?: string;
  blocked: string;
  busy: boolean;
  start: () => void;
  cancel: () => void;
}) {
  return (
    <section className="drama-studio-gate" aria-label="分镜脚本">
      <span>
        <Clapperboard className={generating ? "drama-storyboard-pulse" : undefined} />
      </span>
      <h3>{generating ? `正在生成第 ${no} 集的分镜脚本…` : `第 ${no} 集还没有分镜`}</h3>
      {generating ? (
        job && (
          <div role="status" className="drama-storyboard-progress">
            <div>
              <motion.i
                initial={false}
                animate={{ scaleX: Math.max(0.03, (job.progress ?? 0) / 100) }}
                transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
              />
            </div>
            <small>
              <span>
                {job.status === "queued"
                  ? "排队中"
                  : `${dramaJobFeedback(job).detail ?? "进行中"}${job.progress ? ` · ${job.progress}%` : ""}`}
              </span>
              <button type="button" disabled={busy} onClick={cancel}>
                取消
              </button>
            </small>
          </div>
        )
      ) : (
        <button
          type="button"
          data-outline
          data-storyboard
          disabled={!!blocked || busy}
          title={blocked || problem}
          onClick={start}
        >
          {busy && <Loader2 size={16} />} {failed ? "重新生成脚本" : "生成脚本"}
          {credits !== undefined && (
            <>
              <span aria-hidden>·</span>
              <b>{credits}</b>
            </>
          )}
        </button>
      )}
    </section>
  );
}

export function DramaStoryboardGate({
  doc,
  episode,
  projectHandle,
  maxSeconds,
  videoModel,
  saved,
  toolbar = false,
}: {
  doc: DramaDocument;
  episode: DramaDocument["episodes"][number];
  projectHandle: string;
  maxSeconds: number;
  videoModel?: string;
  saved: (doc: DramaDocument) => void;
  toolbar?: boolean;
}) {
  const no = episode.episode_no,
    generating = episode.storyboard_status === "generating",
    order = doc.episode_order ?? 0;
  const active =
      doc.jobs?.filter(
        (job) =>
          ["queued", "running"].includes(job.status) &&
          ["storyboard", "compose"].includes(job.step) &&
          (!job.episodes.length || job.episodes.includes(no)),
      ) ?? [],
    job = active.find((entry) => entry.step === "storyboard");
  const blocked = dramaBusyReason({ ...doc, jobs: active });
  const [quote, setQuote] = useState<{ credits?: number; problem?: string }>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    pending = useRef<Promise<number> | null>(null),
    live = useRef(true),
    operation = useRef(crypto.randomUUID());
  const [preview, setPreview] = useState<{ credits: number; clearHash: string } | null>(null);
  const load = useCallback(
    () =>
      (pending.current ??= window.desktop.projects
        .estimateDramaStoryboard({ projectHandle, episodeNo: no, maxSeconds, videoModel })
        .then((result) => {
          if (!result.ok)
            throw Object.assign(Error(result.error.message ?? result.error.code), {
              code: result.error.code,
            });
          return result.value.credits;
        })),
    [projectHandle, no, maxSeconds, videoModel],
  );
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (generating || toolbar) return;
    let showing = true;
    pending.current = null;
    operation.current = crypto.randomUUID();
    setQuote({});
    setError("");
    const timer = setTimeout(() => {
      void load().then(
        (credits) => {
          if (showing) setQuote({ credits });
        },
        (issue) => {
          if (showing) setQuote({ problem: String(issue.message ?? issue) });
        },
      );
    }, 250);
    return () => {
      showing = false;
      clearTimeout(timer);
    };
  }, [load, generating, toolbar]);
  async function askClear() {
    const result = await window.desktop.projects.estimateDramaStoryboard({
      projectHandle,
      episodeNo: no,
      maxSeconds,
      videoModel,
      previewClear: true,
    });
    if (!live.current) return;
    if (!result.ok) throw Error(result.error.message ?? result.error.code);
    if (!result.value.clearHash) throw Error("请重新获取片段确认信息");
    setPreview({ credits: result.value.credits, clearHash: result.value.clearHash });
  }
  async function submit(cancel: boolean, confirm = false) {
    if (
      lock.current ||
      (cancel && !job) ||
      (!cancel && (blocked || generating)) ||
      (confirm && !preview)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (
        !cancel &&
        !confirm &&
        doc.segments?.some((segment) => segment.episode_no === no && segment.take_ids?.length)
      ) {
        await askClear();
        return;
      }
      if (quote.problem) pending.current = null;
      const request = cancel
        ? { cancelStoryboard: requirePresent(job, "job").id }
        : {
            storyboard: {
              episodeNo: no,
              maxSeconds,
              videoModel,
              episodeOrder: order,
              estimate: confirm
                ? requirePresent(preview, "preview").credits
                : (quote.credits ?? (await load())),
              operationId: operation.current,
              ...(confirm && { clearHash: requirePresent(preview, "preview").clearHash }),
            },
          };
      if (!live.current) return;
      const result = await window.desktop.projects.drama({ projectHandle, ...request });
      if (!live.current) return;
      if (!result.ok) {
        if (result.error.code === "AGENT_APPROVAL_STALE" && !cancel) {
          pending.current = null;
          operation.current = crypto.randomUUID();
          setPreview(null);
          setQuote({});
          if (!toolbar && !confirm) {
            try {
              const credits = await load();
              if (live.current) setQuote({ credits });
            } catch {
              if (live.current) setQuote({ problem: "估算失败" });
            }
          }
        }
        throw Object.assign(Error(result.error.message ?? result.error.code), {
          code: result.error.code,
        });
      }
      setPreview(null);
      if (result.value) saved(result.value);
    } catch (issue) {
      if (live.current) {
        pending.current = null;
        if (
          !confirm &&
          !cancel &&
          issue instanceof Error &&
          "code" in issue &&
          issue.code === "DRAMA_STORYBOARD_HAS_TAKES"
        ) {
          try {
            await askClear();
          } catch (failure) {
            if (live.current)
              setError(failure instanceof Error ? failure.message : String(failure));
          }
        } else setError(issue instanceof Error ? issue.message : String(issue));
      }
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <>
      {toolbar ? (
        <button
          type="button"
          className="drama-storyboard-redo"
          aria-label="重新生成分镜脚本"
          title={blocked || "重新生成分镜脚本（已有出视频的片段会先确认）"}
          disabled={!!blocked || busy || generating}
          onClick={() => void submit(false)}
        >
          {busy ? <Loader2 size={16} /> : <RotateCw size={16} />}
        </button>
      ) : (
        <StoryboardGateContent
          no={no}
          generating={generating}
          failed={episode.storyboard_status === "failed"}
          job={job}
          credits={quote.credits}
          problem={quote.problem}
          blocked={blocked}
          busy={busy}
          start={() => void submit(false)}
          cancel={() => void submit(true)}
        />
      )}
      {error && !preview && <DramaNotice tone="error">{error}</DramaNotice>}
      {preview && (
        <AlertDialog.Root
          open
          onOpenChange={(open) => {
            if (!open && !lock.current) setPreview(null);
          }}
        >
          <AlertDialog.Portal className="storyboard-layer drama-delete-layer">
            <AlertDialog.Backdrop className="shot-confirm-backdrop" />
            <AlertDialog.Popup className="shot-confirm drama-delete-confirm">
              <AlertDialog.Title render={(props) => <h3 {...props}>{props.children}</h3>}>
                重新生成第 {no} 集的分镜脚本？
              </AlertDialog.Title>
              <AlertDialog.Description>
                这一集已经有生成结果，重新生成会清空已有片段（片段提示词和采用状态）。已生成的视频文件不会被删除。
              </AlertDialog.Description>
              {error && <DramaNotice tone="error">{error}</DramaNotice>}
              <div>
                <AlertDialog.Close disabled={busy}>取消</AlertDialog.Close>
                <button
                  type="button"
                  data-destructive
                  disabled={!!blocked || busy}
                  onClick={() => void submit(false, true)}
                >
                  清空并重新生成
                </button>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      )}
    </>
  );
}
