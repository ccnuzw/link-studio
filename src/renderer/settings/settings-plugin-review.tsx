import type { SettingsPluginReview } from "@link-studio/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { keyedItems } from "../occurrence-keys";

export function isPluginReview(value: Record<string, unknown>): value is SettingsPluginReview {
  const request = value.request;
  return (
    ["label", "key", "versionAfter", "meta", "codeDiff"].every(
      (key) => typeof value[key] === "string",
    ) &&
    (value.versionBefore === null || typeof value.versionBefore === "string") &&
    Number.isInteger(value.lines) &&
    (request === undefined ||
      (request !== null &&
        typeof request === "object" &&
        "method" in request &&
        typeof request.method === "string" &&
        "url" in request &&
        typeof request.url === "string")) &&
    Array.isArray(value.diff) &&
    value.diff.every(
      (entry) =>
        entry &&
        typeof entry.field === "string" &&
        [entry.before, entry.after].every(
          (part) => part === null || ["string", "number", "boolean"].includes(typeof part),
        ),
    )
  );
}

export function PluginReviewDetail({ review }: { review: SettingsPluginReview }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <div className="plugin-review-summary">
        <p>
          {review.versionBefore === null
            ? `新插件 · ${review.lines} 行`
            : `${review.versionBefore} → ${review.versionAfter}`}
        </p>
        <p>{review.meta}</p>
        <p>静态验证通过</p>
        {review.request && (
          <p>
            {review.request.method} {review.request.url}
          </p>
        )}
        {review.codeDiff && (
          <div>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
            >
              <Chevron size={14} aria-hidden />
              代码差异
            </button>
            {open && (
              <section aria-label="插件代码差异">
                <pre>
                  {keyedItems(review.codeDiff.split("\n"), (line) => line).map(
                    ({ item: line, key }) => (
                      <span key={key} data-prefix={line[0]}>
                        {line || " "}
                      </span>
                    ),
                  )}
                </pre>
              </section>
            )}
          </div>
        )}
      </div>
      <section className="change-diff plugin-review-diffs" aria-label="当前到变更后">
        {review.diff.map((entry) => {
          const before = String(entry.before ?? "—"),
            after = String(entry.after ?? "—");
          return (
            <div key={entry.field}>
              <span title={entry.field}>{entry.field}</span>
              <span data-old={entry.before !== null} title={before}>
                {before}
              </span>
              <span aria-hidden>→</span>
              <span title={after}>{after}</span>
            </div>
          );
        })}
      </section>
    </div>
  );
}
