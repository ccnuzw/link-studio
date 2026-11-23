import { Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  feedbackReasons,
  type RunRating,
} from "../../../packages/link-studio-core/src/agent-feedback";
import { copySettingsText } from "../settings/copy-settings-text";

export type SaveFeedback = (runId: string, value: RunRating | null) => Promise<boolean>;
export function RunFeedbackBar({
  runId,
  value,
  text,
  quiet,
  save,
  leading,
}: {
  runId: string;
  value?: RunRating;
  text?: string;
  quiet: boolean;
  save: SaveFeedback;
  leading?: ReactNode;
}) {
  const [draft, setDraft] = useState<RunRating | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const commit = async (next: RunRating | null) => {
    setSaving(true);
    setStatus("");
    try {
      if (!(await save(runId, next))) throw Error();
      setDraft(null);
    } catch {
      setStatus("评价没保存，稍后再试");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="run-feedback" data-quiet={quiet && !value && !draft}>
      <div className="run-feedback-line">
        {leading}
        <div className="run-feedback-actions">
          {value && !draft && (
            <span>
              {value.rating === 1
                ? "感谢反馈"
                : `已记录：${value.reasons.map((key) => feedbackReasons[key]).join("、") || "未选原因"}`}
            </span>
          )}
          {text && (
            <button
              type="button"
              aria-label="复制"
              title="复制"
              onClick={async () => {
                try {
                  await copySettingsText(text);
                  setStatus("已复制");
                } catch {
                  setStatus("复制失败");
                }
              }}
            >
              <Copy size={14} />
            </button>
          )}
          <button
            type="button"
            aria-label="有帮助"
            title="有帮助"
            aria-pressed={value?.rating === 1}
            disabled={saving}
            onClick={() =>
              void commit(value?.rating === 1 ? null : { rating: 1, reasons: [], comment: "" })
            }
          >
            <ThumbsUp size={14} />
          </button>
          <button
            type="button"
            aria-label="没帮上忙"
            title="没帮上忙"
            aria-pressed={value?.rating === -1}
            disabled={saving}
            onClick={() =>
              value?.rating === -1
                ? void commit(null)
                : setDraft(draft ? null : { rating: -1, reasons: [], comment: "" })
            }
          >
            <ThumbsDown size={14} />
          </button>
        </div>
      </div>
      {draft && (
        <fieldset disabled={saving} className="run-feedback-form" aria-label="评价原因">
          <div>
            {(Object.keys(feedbackReasons) as (keyof typeof feedbackReasons)[]).map((key) => (
              <button
                type="button"
                key={key}
                aria-pressed={draft.reasons.includes(key)}
                onClick={() =>
                  setDraft({
                    ...draft,
                    reasons: draft.reasons.includes(key)
                      ? draft.reasons.filter((reason) => reason !== key)
                      : [...draft.reasons, key],
                  })
                }
              >
                {feedbackReasons[key]}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            maxLength={500}
            aria-label="补充说明"
            placeholder="哪里不对？（可选，≤500 字）"
            value={draft.comment}
            onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
          />
          <div>
            <span>原因可以不选</span>
            <button type="button" onClick={() => setDraft(null)}>
              取消
            </button>
            <button type="button" onClick={() => void commit(draft)}>
              提交
            </button>
          </div>
        </fieldset>
      )}
      {status && <small role="status">{status}</small>}
    </div>
  );
}
