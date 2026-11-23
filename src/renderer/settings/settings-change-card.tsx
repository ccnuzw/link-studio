import type { SettingsApproval } from "@link-studio/core";
import { Check, ChevronDown, ClipboardList } from "lucide-react";
import { useState } from "react";
import { ChoiceButton } from "../choice-button";
import { ChangeDecisionOptions } from "./change-decision-options";
import { isPluginReview, PluginReviewDetail } from "./settings-plugin-review";

function details(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function ApprovalCard({
  approval,
  decide,
  disabled,
}: {
  approval: SettingsApproval;
  decide: (selected: number[], reason?: string) => Promise<void>;
  disabled: boolean;
}) {
  const payload = details(approval.payload);
  const candidate = details(payload.review);
  const review = payload.kind === "plugin" && isPluginReview(candidate) ? candidate : null;
  const revert = typeof payload.revertOf === "string" ? payload.revertOf : "";
  const title = revert ? `回滚变更单 ${revert}` : "配置变更单";
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const items = Array.isArray(payload.items) ? payload.items.map(details) : [];
  const [selected, setSelected] = useState<number[]>(() =>
    items.flatMap((item, index) =>
      JSON.stringify(item.before ?? null) !== JSON.stringify(item.after ?? null) ? [index] : [],
    ),
  );
  const submit = async (apply: boolean, reason?: string) => {
    setBusy(true);
    try {
      await decide(apply ? selected : [], reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-change-card" aria-label={title}>
      <h3>
        <ClipboardList size={16} aria-hidden />
        <span>{title}</span>
      </h3>
      {revert ? (
        <p className="change-reason">恢复该单已应用条目的改前值</p>
      ) : (
        typeof payload.expectedRevision === "number" && (
          <p className="change-reason">基线修订 {payload.expectedRevision}</p>
        )
      )}
      <div className="change-items">
        <p>
          {typeof payload.orderNo === "string" && (
            <span className="change-order-number">{payload.orderNo} · </span>
          )}
          {items.length} 项{revert && ` · 回滚 ${revert}`}
        </p>
        <ul>
          {items.slice(0, expanded ? items.length : 3).map((item, index) => {
            const field = String(item.field),
              before = String(item.before ?? "—"),
              after = String(item.after ?? "—");
            return (
              <li key={field}>
                <div className="change-item-heading">
                  <ChoiceButton
                    type="button"
                    role="checkbox"
                    aria-checked={selected.includes(index)}
                    aria-label={review ? `选择 ${review.label}` : `选择 ${field}：${after}`}
                    disabled={disabled || busy}
                    onClick={() =>
                      setSelected((current) =>
                        current.includes(index)
                          ? current.filter((entry) => entry !== index)
                          : [...current, index],
                      )
                    }
                  >
                    {selected.includes(index) && <Check size={14} aria-hidden />}
                  </ChoiceButton>
                  <strong>{review?.label ?? field}</strong>
                  <code>{review?.key ?? field}</code>
                  <small>
                    <i aria-hidden />
                    可应用
                  </small>
                </div>
                {review ? (
                  <PluginReviewDetail review={review} />
                ) : (
                  <section className="change-diff" aria-label="当前到变更后">
                    <span title={field}>{field}</span>
                    <span data-old={item.before != null} title={before}>
                      {before}
                    </span>
                    <span aria-hidden>→</span>
                    <span title={after}>{after}</span>
                  </section>
                )}
              </li>
            );
          })}
        </ul>
        {!expanded && items.length > 3 && (
          <button type="button" className="change-more" onClick={() => setExpanded(true)}>
            <ChevronDown size={14} aria-hidden />
            还有 {items.length - 3} 项
          </button>
        )}
      </div>
      {payload.kind === "plugin" && !review && (
        <>
          <p>
            预计登记：{String(details(payload.plugin).key)} @{" "}
            {String(details(payload.plugin).version)}（以批准时为准）
          </p>
          <details>
            <summary>审阅草稿源码</summary>
            <pre>{String(details(payload.plugin).source ?? "")}</pre>
          </details>
        </>
      )}
      <ChangeDecisionOptions count={selected.length} disabled={disabled || busy} submit={submit} />
    </section>
  );
}
