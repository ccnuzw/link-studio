import { type DramaDocument, dramaBusyReason, requirePresent } from "@link-studio/core";
import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackdropDialog } from "./backdrop-dialog";
import { DramaEpisodePicker } from "./drama-episode-picker";

function choicesFor(doc: DramaDocument) {
  const done = new Set(
    doc.segments?.filter((segment) => segment.chosen_task_id).map((segment) => segment.episode_no),
  );
  const jobs =
    doc.jobs?.filter(
      (job) =>
        ["queued", "running"].includes(job.status) && ["storyboard", "compose"].includes(job.step),
    ) ?? [];
  return doc.episodes
    .filter((episode) => episode.title.trim())
    .map((episode) => {
      const no = episode.episode_no;
      const reason = !episode.locked
        ? "还没拆解"
        : episode.storyboard_status === "generating"
          ? "生成中"
          : episode.storyboard_status === "ready"
            ? "已有分镜"
            : done.has(no)
              ? "已有视频"
              : dramaBusyReason({
                  ...doc,
                  jobs: jobs.filter((job) => !job.episodes.length || job.episodes.includes(no)),
                });
      return { no, title: episode.title, reason };
    });
}

export function DramaStoryboardBatch({
  doc,
  current,
  maxSeconds,
  videoModel,
  projectHandle,
  close,
  started,
}: {
  doc: DramaDocument;
  current: number;
  maxSeconds: number;
  videoModel?: string;
  projectHandle: string;
  close: () => void;
  started: (message: string) => void;
}) {
  const choices = choicesFor(doc),
    available = new Set(choices.filter((item) => !item.reason).map((item) => item.no));
  const [selected, setSelected] = useState(() => (available.has(current) ? [current] : []));
  const selection = selected.filter((no) => available.has(no)).sort((left, right) => left - right),
    count = selection.length,
    valid = count > 0 && count <= 50;
  const [quote, setQuote] = useState<{ key: string; credits?: number; error?: string }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const quotes = useRef(new Map<number, Promise<number>>()),
    operations = useRef(new Map<number, string>()),
    dialog = useRef<HTMLDialogElement>(null),
    locked = useRef(false);
  const key = valid ? selection.join(",") : "";
  const [quoteRevision, refreshQuote] = useState(0);
  const estimate = useCallback(
    (no: number) => {
      const previous = quotes.current.get(no);
      if (previous) return previous;
      const pending = window.desktop.projects
        .estimateDramaStoryboard({ projectHandle, episodeNo: no, maxSeconds, videoModel })
        .then((result) => {
          if (!result.ok) throw Error(result.error.message ?? result.error.code);
          return result.value.credits;
        })
        .catch((issue) => {
          quotes.current.delete(no);
          throw issue;
        });
      quotes.current.set(no, pending);
      return pending;
    },
    [maxSeconds, videoModel, projectHandle],
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (!key) return;
    let active = true;
    const queue = key.split(",").map(Number);
    const timer = setTimeout(async () => {
      let credits = 0;
      try {
        await Promise.all(
          Array.from({ length: Math.min(6, queue.length) }, async () => {
            while (active && queue.length) {
              const no = requirePresent(queue.shift(), "queue.shift()");
              try {
                const price = await estimate(no);
                credits += price;
              } catch (issue) {
                throw Error(`第 ${no} 集：${issue instanceof Error ? issue.message : "估算失败"}`);
              }
            }
          }),
        );
        if (active) setQuote({ key, credits });
      } catch (issue) {
        if (active) setQuote({ key, error: issue instanceof Error ? issue.message : "估算失败" });
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, estimate, quoteRevision]);
  async function submit() {
    if (!valid || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const queue = [...selection],
      failures = new Map<number, string>();
    let submitted = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, count) }, async () => {
        while (queue.length && dialog.current?.open) {
          const no = requirePresent(queue.shift(), "queue.shift()");
          try {
            const price = await estimate(no);
            if (!dialog.current?.open) return;
            const operationId = operations.current.get(no) ?? crypto.randomUUID();
            operations.current.set(no, operationId);
            const result = await window.desktop.projects.drama({
              projectHandle,
              storyboard: {
                batch: true,
                episodeNo: no,
                episodeOrder: doc.episode_order ?? 0,
                maxSeconds,
                videoModel,
                operationId,
                estimate: price,
              },
            });
            if (!result.ok) {
              if (result.error.code === "AGENT_APPROVAL_STALE") {
                quotes.current.delete(no);
                operations.current.delete(no);
              }
              throw Error(result.error.message ?? result.error.code);
            }
            submitted++;
          } catch (issue) {
            failures.set(
              no,
              `第 ${no} 集：${issue instanceof Error ? issue.message : "提交失败，请稍后重试"}`,
            );
          }
        }
      }),
    );
    if (!dialog.current?.open) return;
    const details = selection.flatMap((no) =>
      failures.has(no) ? [requirePresent(failures.get(no), "failures.get(no)")] : [],
    );
    if (submitted) {
      started(details.length ? `有 ${details.length} 集没能提交：${details[0]}` : "");
      return;
    }
    locked.current = false;
    setBusy(false);
    setError(details.join("；"));
    setQuote(undefined);
    refreshQuote((revision) => revision + 1);
  }
  const shown = quote?.key === key ? quote : undefined;
  return (
    <BackdropDialog
      ref={dialog}
      aria-label="批量生成分镜脚本"
      className="drama-scripts-dialog"
      data-breakdown
      data-storyboard-batch
      onClose={close}
      onCancel={(event) => {
        if (locked.current) event.preventDefault();
      }}
      dismiss={() => {
        if (!locked.current) close();
      }}
    >
      <h2>批量生成分镜脚本</h2>
      <DramaEpisodePicker
        mode="storyboard"
        choices={choices}
        selection={selection}
        setSelected={setSelected}
        busy={busy}
      />
      <div className="script-estimate">
        <span>
          生成 <b>{count}</b> 集，同时开始
        </span>
        <small>
          {shown?.error ? (
            <span data-error>{shown.error}</span>
          ) : shown?.credits !== undefined ? (
            <>
              约 <b>{shown.credits}</b> 积分
            </>
          ) : valid ? (
            <span>估算中…</span>
          ) : null}
        </small>
      </div>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button type="button" disabled={!valid || busy} onClick={() => void submit()}>
          {busy && <Loader2 size={16} />}{" "}
          {!count ? "至少选一集" : count > 50 ? "一次最多 50 集" : `生成 ${count} 集脚本`}
        </button>
      </footer>
      <button
        type="button"
        className="script-close"
        aria-label="关闭"
        disabled={busy}
        onClick={close}
      >
        <X size={16} />
      </button>
    </BackdropDialog>
  );
}
