import type { DramaDocument } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BackdropDialog } from "./backdrop-dialog";
import { DramaNotice } from "./drama-studio-status";

export function DramaContinueDialog({
  doc,
  projectHandle,
  close,
  saved,
}: {
  doc: DramaDocument;
  projectHandle: string;
  close: () => void;
  saved: (doc: DramaDocument) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { end: previousEnd } = requirePresent(doc.planning, "doc.planning");
  const { total, chars, kind } = requirePresent(doc.source, "doc.source");
  const word =
    ({ chapter: "章", episode: "集", scene: "场" } as Record<string, string>)[kind] ?? "段";
  const from = previousEnd + 1;
  const [all, setAll] = useState(true);
  const [draft, setDraft] = useState(String(Math.min(total, previousEnd + 120)));
  const end = all ? total : Math.min(total, Math.max(from, Math.floor(Number(draft)) || from));
  const rangeEnd = all ? 0 : end;
  const [quote, setQuote] = useState<{
    rangeEnd: number;
    value?: { minutes: number; credits: number; episodeMin: number; episodeMax: number };
    error?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.desktop.projects.estimateDramaContinuation({
          projectHandle,
          rangeEnd,
        });
        if (active)
          setQuote(
            result.ok
              ? { rangeEnd, value: result.value }
              : { rangeEnd, error: result.error.message ?? result.error.code },
          );
      } catch {
        if (active) setQuote({ rangeEnd, error: "估算失败" });
      }
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [projectHandle, rangeEnd]);
  const current = quote?.rangeEnd === rangeEnd ? quote : undefined;
  const estimate = current?.value;
  const size = Math.round((chars / total) * (end - previousEnd));
  const digits = (value: number) => value.toLocaleString("en-US");
  const episodeLabel =
    estimate &&
    (estimate.episodeMax === estimate.episodeMin
      ? digits(estimate.episodeMin)
      : `${digits(estimate.episodeMin)}–${digits(estimate.episodeMax)}`);
  const durationLabel =
    estimate &&
    (estimate.minutes < 60
      ? `${Math.max(1, Math.round(estimate.minutes))} 分钟`
      : `${(estimate.minutes / 60).toFixed(1).replace(/\.0$/, "")} 小时`);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.desktop.projects.drama({
        projectHandle,
        extendPlanning: { rangeEnd, previousEnd },
      });
      if (!result.ok || !result.value)
        throw Error(result.ok ? "未创建短剧" : (result.error.message ?? result.error.code));
      saved(result.value);
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "开始失败，请稍后重试");
      setBusy(false);
    }
  }
  return (
    <BackdropDialog
      ref={dialog}
      className="drama-scripts-dialog drama-continue-dialog"
      aria-label="继续规划"
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      dismiss={busy ? undefined : close}
    >
      <h2>继续规划</h2>
      <div role="tablist" aria-label="规划范围">
        <button type="button" role="tab" aria-selected={all} onClick={() => setAll(true)}>
          全部剩余
        </button>
        <button type="button" role="tab" aria-selected={!all} onClick={() => setAll(false)}>
          规划到第 N {word}
        </button>
      </div>
      {!all && (
        <div className="continue-end">
          规划到第{" "}
          <input
            type="number"
            aria-label={`规划到第几${word}`}
            min={from}
            max={total}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />{" "}
          {word}
        </div>
      )}
      <div className="script-estimate continue-estimate">
        <span>
          第 {digits(from)}–{digits(end)} {word} · 约{" "}
          {size >= 10000
            ? `${(size / 10000).toFixed(1).replace(/\.0$/, "")} 万字`
            : `${digits(size)} 字`}
          {estimate && (
            <>
              {" "}
              · 预计约 {episodeLabel} 集 · 约 {durationLabel}
            </>
          )}
        </span>
        <small>
          {estimate ? (
            <>
              约 <b>{digits(estimate.credits)}</b> 积分
            </>
          ) : (
            <span data-error={!!current?.error}>{current?.error || "估算中…"}</span>
          )}
        </small>
      </div>
      {error && <DramaNotice tone="error">{error}</DramaNotice>}
      <footer>
        <button type="button" onClick={close} disabled={busy}>
          取消
        </button>
        <button type="button" disabled={busy} onClick={() => void submit()}>
          {busy && <Loader2 size={16} />}开始规划
        </button>
      </footer>
      <button
        type="button"
        className="script-close"
        aria-label="关闭"
        onClick={close}
        disabled={busy}
      >
        <X size={16} />
      </button>
    </BackdropDialog>
  );
}
