import { Checkbox } from "@base-ui/react/checkbox";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import { generationQuoteSummary } from "../../../packages/link-studio-core/src/agent-generation-quote";
import { ChangeDecisionOptions } from "../settings/change-decision-options";
import "./generation-approval-card.css";

type Item = Record<string, unknown>;

export function GenerationApprovalCard({
  items,
  reason,
  busy,
  decide,
}: {
  items: Item[];
  reason: unknown;
  busy: boolean;
  decide: (indices: number[], answer?: string) => void;
}) {
  const [selected, setSelected] = useState(() => items.map((_, index) => index));
  const [expanded, setExpanded] = useState(false);
  const { known, missing } = generationQuoteSummary(selected.map((index) => items[index]));
  const total = missing ? (known ? `✦ ${known} + 未定价` : "未定价") : `✦ ${known}`;
  const title = `申请生成 ${items.length} 个节点`;
  return (
    <fieldset data-ui-group aria-label={title} className="generation-approval settings-change-card">
      <h3>
        <Sparkles size={16} aria-hidden />
        <span>{title}</span>
        <span className="generation-credits">{total}</span>
      </h3>
      {typeof reason === "string" && reason && <p className="change-reason">{reason}</p>}
      <div className="generation-items">
        <ul>
          {items.slice(0, expanded ? undefined : 3).map((item, index) => {
            const label = String(item.label),
              checked = selected.includes(index);
            return (
              <li key={String(item.node_id)}>
                <Checkbox.Root
                  aria-label={`生成「${label}」`}
                  checked={checked}
                  disabled={busy}
                  onCheckedChange={(on) =>
                    setSelected((current) =>
                      on ? [...current, index] : current.filter((value) => value !== index),
                    )
                  }
                >
                  <Checkbox.Indicator>
                    <Check size={14} aria-hidden />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span className="generation-label">{label}</span>
                <small>{String(item.model_name ?? item.model)}</small>
                <span className="generation-credits">
                  {typeof item.price === "number" ? `✦ ${item.price}` : "未定价"}
                </span>
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
      <ChangeDecisionOptions
        generation
        meta={total}
        count={selected.length}
        disabled={busy}
        submit={(approve, answer) => decide(approve ? selected : [], answer)}
      />
    </fieldset>
  );
}

export function GenerationRequestDetails({ items }: { items: Item[] }) {
  return (
    <>
      <p>供应商可能计费。</p>
      {items.map((item) => {
        const request = item.request as
          | { prompt?: string; referenceAssetIds?: string[] }
          | undefined;
        return (
          <section key={String(item.node_id)} className="generation-request-entry">
            <strong>{String(item.label)}</strong>
            <p>{[item.model, item.endpoint].filter(Boolean).join(" · ")}</p>
            {request?.prompt && <p>{request.prompt}</p>}
            {!!request?.referenceAssetIds?.length && (
              <p>参考素材 {request.referenceAssetIds.join("、")}</p>
            )}
          </section>
        );
      })}
    </>
  );
}
