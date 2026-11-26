import type { DramaDocument } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import { Link2Off, Loader2, Lock, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackdropDialog } from "./backdrop-dialog";
import { DramaEpisodePicker } from "./drama-episode-picker";
import { DramaNotice } from "./drama-studio-status";

export function DramaScriptsDialog({
  projectHandle,
  doc,
  initial,
  close,
  saved,
  mode = "scripts",
}: {
  projectHandle: string;
  doc: DramaDocument;
  initial: number[];
  mode?: "scripts" | "breakdown";
  close: () => void;
  saved: (doc: DramaDocument) => void;
}) {
  const breakdown = mode === "breakdown",
    title = breakdown ? "资产拆解" : "生成分集剧本";
  const dialog = useRef<HTMLDialogElement>(null);
  const active = (doc.jobs ?? []).filter(
    (job) => job.status === "queued" || job.status === "running",
  );
  const options = doc.episodes
    .filter((ep) => ep.title.trim())
    .map((ep) => ({
      no: ep.episode_no,
      title: ep.title,
      ready: (ep.script_status ?? (ep.script_md.trim() ? "ready" : "empty")) === "ready",
      reason: ep.locked
        ? "已拆解"
        : active.some((job) => job.step === "breakdown" && job.episodes.includes(ep.episode_no))
          ? "拆解中"
          : active.some((job) => job.step === "scripts" && job.episodes.includes(ep.episode_no))
            ? "生成中"
            : "",
    }));
  const choices = options.map((item) =>
    breakdown
      ? {
          ...item,
          reason:
            item.reason === "生成中" || (!item.ready && !item.reason) ? "还没有剧本" : item.reason,
        }
      : item,
  );
  const available = choices.filter((item) => !item.reason);
  const availableNos = new Set(available.map((item) => item.no));
  const unscripted = available
    .filter((item) => !item.ready)
    .slice(0, 200)
    .map((item) => item.no);
  const [selected, setSelected] = useState(() => {
    const usable = initial.filter((no) => availableNos.has(no));
    return usable.length
      ? usable
      : breakdown
        ? available.slice(0, 1).map((item) => item.no)
        : unscripted;
  });
  const selection = selected
    .filter((no) => availableNos.has(no))
    .sort((left, right) => left - right);
  const chosen = new Set(selection);
  const ready = new Set(
    options.filter((item) => item.ready || item.reason === "已拆解").map((item) => item.no),
  );
  const [quote, setQuote] = useState<{ key: string; estimate?: number; error?: string }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const operation = useRef(""),
    episodeOrder = doc.episode_order ?? 0;
  const pendingQuote = useRef<{ key: string; promise: Promise<number> } | null>(null);
  const tooMany = selection.length > 200;
  const numbersKey = tooMany ? "" : JSON.stringify(selection),
    key = `${projectHandle}:${mode}:${episodeOrder}:${numbersKey}`;
  const loadQuote = useCallback(() => {
    if (pendingQuote.current?.key === key) return pendingQuote.current.promise;
    const request = {
      key,
      promise: window.desktop.projects[
        breakdown ? "estimateDramaBreakdown" : "estimateDramaScripts"
      ]({ projectHandle, episodes: JSON.parse(numbersKey) }).then((result) => {
        if (!result.ok) throw Error(result.error.message ?? result.error.code);
        return result.value;
      }),
    };
    pendingQuote.current = request;
    return request.promise;
  }, [key, numbersKey, projectHandle, breakdown]);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    operation.current = crypto.randomUUID();
    setError("");
    if (!numbersKey || numbersKey === "[]") return;
    let live = true;
    const timer = window.setTimeout(async () => {
      try {
        const price = await loadQuote();
        if (live) setQuote({ key, estimate: price });
      } catch (failure) {
        if (live)
          setQuote({ key, error: failure instanceof Error ? failure.message : "估算失败，请重试" });
      }
    }, 250);
    return () => {
      live = false;
      pendingQuote.current = null;
      window.clearTimeout(timer);
    };
  }, [key, numbersKey, loadQuote]);
  const estimate = quote?.key === key ? quote : undefined;
  const gaps = selection.filter((no) => no > 1 && !chosen.has(no - 1) && !ready.has(no - 1));
  const overwrite = available.filter((item) => item.ready && chosen.has(item.no)).length;
  async function submit() {
    if (busy || tooMany || !selection.length || !estimate) return;
    setBusy(true);
    setError("");
    const operationId = operation.current;
    try {
      if (estimate.estimate === undefined) {
        pendingQuote.current = null;
        setQuote({ key, estimate: await loadQuote() });
        setBusy(false);
        return;
      }
      const price = estimate.estimate;
      if (!dialog.current?.open || operation.current !== operationId)
        throw Error("分集已变更，请重新选择并确认");
      setQuote({ key, estimate: price });
      const result = await window.desktop.projects.drama({
        projectHandle,
        [breakdown ? "breakdown" : "writeScripts"]: {
          episodes: selection,
          episodeOrder,
          estimate: price,
          operationId,
        },
      });
      if (!result.ok) {
        if (breakdown && result.error.code === "AGENT_APPROVAL_STALE") {
          pendingQuote.current = null;
          try {
            setQuote({ key, estimate: await loadQuote() });
          } catch {
            setQuote({ key, error: "估算失败，请重试" });
          }
        }
        throw Error(result.error.message ?? result.error.code);
      }
      if (!result.value) throw Error("短剧不存在");
      saved(result.value);
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "提交失败，请稍后重试");
      setBusy(false);
    }
  }
  return (
    <BackdropDialog
      className="drama-scripts-dialog"
      aria-label={title}
      data-breakdown={breakdown || undefined}
      ref={dialog}
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      dismiss={busy ? undefined : close}
    >
      <h2>{title}</h2>
      <DramaEpisodePicker
        choices={choices}
        selection={selection}
        setSelected={setSelected}
        busy={busy}
        mode={mode}
      />
      {!breakdown && !!gaps.length && (
        <div role="note">
          <Link2Off size={16} />
          {gaps.length === 1
            ? `第 ${requirePresent(gaps[0], "gaps[0]") - 1} 集还没有剧本，第 ${gaps[0]} 集会按它的梗概和结尾悬念衔接`
            : `第 ${gaps.slice(0, 6).join("、")}${gaps.length > 6 ? " 等" : ""} 集的上一集还没有剧本，会按上一集的梗概和结尾悬念衔接`}
        </div>
      )}
      <div className="script-estimate" data-overwrite={breakdown || !!overwrite}>
        {breakdown && <Lock size={16} />}
        <span>
          {breakdown ? (
            <>
              拆解后这 <b>{selection.length}</b> 集的剧本会<b>锁定</b>，不能再修改。
            </>
          ) : overwrite ? (
            <>
              其中 <b>{overwrite}</b> 集会<b>覆盖</b>现有剧本
            </>
          ) : (
            <>
              生成 <b>{selection.length}</b> 集
            </>
          )}
        </span>
        <small>
          {estimate?.error ? (
            <span data-error="true">{estimate.error}</span>
          ) : estimate?.estimate !== undefined ? (
            <>
              约 <b>{estimate.estimate}</b> 积分
            </>
          ) : selection.length && !tooMany ? (
            <span>估算中…</span>
          ) : null}
        </small>
      </div>
      {breakdown && estimate?.estimate !== undefined && (
        <div role="note">
          模型输出过长时会分批重试，实际用量可能变化。未写成的提示词可另行估价补写。
        </div>
      )}
      {error && <DramaNotice tone="error">{error}</DramaNotice>}
      <footer>
        <button type="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          type="button"
          disabled={busy || tooMany || !selection.length || !estimate}
          onClick={() => void submit()}
        >
          {breakdown && busy && <Loader2 size={16} />}
          {tooMany
            ? "一次最多 200 集"
            : selection.length
              ? estimate?.error
                ? "重新估价"
                : breakdown
                  ? "开始拆解"
                  : `生成 ${selection.length} 集剧本`
              : "至少选一集"}
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
