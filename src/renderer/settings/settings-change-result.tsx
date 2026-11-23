import type { ChangeValue, SettingsChangeReceipt } from "@link-studio/core";
import { ArrowUpRight, ChevronDown, CircleCheck, CircleX, Minus, Undo2 } from "lucide-react";
import { useState } from "react";
import type { CardJump } from "../assistant/info-card";

function changeValue(value: unknown): value is ChangeValue {
  return value === null || ["string", "boolean", "number"].includes(typeof value);
}

export function isChangeReceipt(value: Record<string, unknown>): value is SettingsChangeReceipt {
  return (
    typeof value.order === "string" &&
    typeof value.appliedAt === "string" &&
    Number.isFinite(Date.parse(value.appliedAt)) &&
    typeof value.key === "string" &&
    (value.target === "model" || value.target === "plugin") &&
    typeof value.reversible === "boolean" &&
    typeof value.navigable === "boolean" &&
    typeof value.applied === "number" &&
    typeof value.skipped === "number" &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        item &&
        typeof item.field === "string" &&
        changeValue(item.before) &&
        changeValue(item.after) &&
        (item.status === "applied" || item.status === "rejected") &&
        (item.label === undefined || typeof item.label === "string") &&
        (item.diff === undefined ||
          (Array.isArray(item.diff) &&
            item.diff.every(
              (entry: Record<string, unknown> | null) =>
                entry &&
                typeof entry.field === "string" &&
                changeValue(entry.before) &&
                changeValue(entry.after),
            ))),
    )
  );
}

export function SettingsChangeResult({
  receipt,
  resolveJump,
  rollback,
}: {
  receipt: SettingsChangeReceipt;
  resolveJump?: CardJump;
  rollback?: (order: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const applied = receipt.items.filter((item) => item.status === "applied");
  const rejected = receipt.items.filter((item) => item.status === "rejected");
  const page = receipt.target === "model" ? "模型配置" : "插件";
  const jump = receipt.navigable && resolveJump?.({ type: receipt.target, key: receipt.key });
  const date = new Date(receipt.appliedAt);
  const time = [date.getHours(), date.getMinutes()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  const Icon = applied.length ? CircleCheck : CircleX;
  return (
    <div
      className="settings-change-card change-result"
      role="group"
      aria-label={`变更单 ${receipt.order} 结果`}
    >
      <div className="change-result-header">
        <Icon size={16} aria-hidden />
        <strong>
          变更单 {receipt.order} · {`已应用 ${applied.length} 项 · ${time}`}
        </strong>
        {(receipt.reversible || (receipt.target === "plugin" && applied.length > 0)) && (
          <button
            type="button"
            disabled={!rollback}
            title={rollback ? undefined : "运行中不能回滚"}
            onClick={() => rollback?.(receipt.order)}
          >
            <Undo2 size={14} aria-hidden />
            回滚
          </button>
        )}
      </div>
      {!!applied.length && (
        <section aria-label={page}>
          <h4>{page}</h4>
          <ul>
            {applied.slice(0, expanded ? undefined : 3).map((item) => (
              <li key={item.field}>
                {jump ? (
                  <button className="change-result-target" type="button" onClick={jump}>
                    <span>{item.label ?? item.field}</span>
                    <ArrowUpRight size={12} aria-hidden />
                  </button>
                ) : (
                  <span className="change-result-title">{item.label ?? item.field}</span>
                )}
                <dl aria-label="改前到改后">
                  {(item.diff ?? [item]).map(({ field, before, after }) => (
                    <div key={field}>
                      <dt title={field}>{field}</dt>
                      <dd>
                        {before != null && <del data-removed={after == null}>{String(before)}</del>}
                        {before != null && after != null && <span aria-hidden>→</span>}
                        {after != null && <b>{String(after)}</b>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!expanded && applied.length > 3 && (
        <button type="button" className="change-more" onClick={() => setExpanded(true)}>
          <ChevronDown size={14} aria-hidden />
          还有 {applied.length - 3} 项
        </button>
      )}
      {!!rejected.length && (
        <ul aria-label="未应用的条目">
          {rejected.map((item) => (
            <li key={item.field}>
              <Minus size={12} aria-hidden />
              <span>未应用：{item.field}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
