import type { SettingsEvent } from "@link-studio/core";
import { ChevronDown, GitCommitHorizontal, LocateFixed, Undo2 } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { RunFeedbackBar } from "../assistant/run-feedback";

type Change = { id: string; kind: "created" | "updated" | "deleted"; label?: string };
const signs = { created: "+", updated: "~", deleted: "−" };
const words = { created: "新建", updated: "已修改", deleted: "已删除" };
const writes = new Set(["canvas_apply_ops", "canvas_arrange", "canvas_capture_frame"]);

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function canvasRunChanges(events: SettingsEvent[]) {
  const runs = new Map<string, Map<string, Change>>();
  for (const event of events) {
    const data = fields(event.payload);
    const tool =
      event.type === "tool.end" && data.is_error === false && writes.has(String(data.name));
    const approved =
      event.type === "approval.decided" &&
      data.kind === "delete" &&
      ["executed", "partially_approved"].includes(String(data.status));
    if (!tool && !approved) continue;
    const result = fields(data.result);
    const rows = runs.get(event.runId) ?? new Map<string, Change>();
    runs.set(event.runId, rows);
    const created = new Set(Object.values(fields(result.created)));
    const deletion = approved && fields(data.payload).action === "delete";
    const items = fields(data.payload).items;
    const labels = new Map(
      (Array.isArray(items) ? items : []).map(fields).map((item) => [item.node_id, item.label]),
    );
    for (const id of Array.isArray(result.nodeIds) ? result.nodeIds : []) {
      if (typeof id !== "string") continue;
      const label = labels.get(id);
      const kind = deletion
        ? "deleted"
        : created.has(id) ||
            data.name === "canvas_capture_frame" ||
            rows.get(id)?.kind === "created"
          ? "created"
          : "updated";
      rows.set(id, { id, kind, label: typeof label === "string" ? label : undefined });
    }
  }
  return runs;
}

export function CanvasChangesFooter({
  changes,
  feedback,
  labelOf,
  locate,
  locateAll,
  undo,
  locked,
}: {
  changes: Map<string, Change>;
  feedback: ComponentProps<typeof RunFeedbackBar>;
  labelOf: (id: string) => string | undefined;
  locate: (id: string) => void;
  locateAll: (ids: string[]) => void;
  undo: () => Promise<number | undefined>;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [skipped, setSkipped] = useState<number>();
  const undone = skipped !== undefined;
  const rows = [...changes.values()];
  const surviving = rows.filter((row) => row.kind !== "deleted" && labelOf(row.id));
  const toggle = (
    <button
      type="button"
      className="agent-changes-toggle"
      aria-expanded={open}
      data-undone={undone}
      onClick={() => setOpen(!open)}
    >
      {undone ? <Undo2 size={14} /> : <GitCommitHorizontal size={14} />}
      {undone ? "已撤销本轮" : "画布改动"}
      {!undone &&
        (Object.keys(signs) as Change["kind"][]).map((kind) => {
          const count = rows.filter((row) => row.kind === kind).length;
          return (
            count > 0 && (
              <span key={kind} data-change={kind}>
                {signs[kind]}
                {count}
              </span>
            )
          );
        })}
      <ChevronDown size={14} />
    </button>
  );
  return (
    <div className="agent-changes-footer">
      <RunFeedbackBar
        {...feedback}
        leading={
          <>
            {toggle}
            {feedback.leading}
          </>
        }
      />
      {!!skipped && <small>{skipped} 项你之后改过，保持不动</small>}
      {open && (
        <section className="agent-changes-panel" aria-label="本轮画布改动">
          <ul>
            {rows.map((row) => {
              const current = labelOf(row.id);
              const label = current ?? row.label ?? "已删除的节点";
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-label={`定位 ${label}`}
                    disabled={undone || row.kind === "deleted" || !current}
                    onClick={() => locate(row.id)}
                  >
                    <b data-change={row.kind}>{signs[row.kind]}</b>
                    <span>{label}</span>
                    <small>{words[row.kind]}</small>
                  </button>
                </li>
              );
            })}
          </ul>
          {!undone && (
            <div>
              {!!surviving.length && (
                <button type="button" onClick={() => locateAll(surviving.map((row) => row.id))}>
                  <LocateFixed size={14} />
                  全部定位
                </button>
              )}
              <button
                type="button"
                disabled={locked}
                onClick={async () => {
                  const count = await undo();
                  if (count !== undefined) {
                    setSkipped(count);
                    setOpen(false);
                  }
                }}
              >
                <Undo2 size={14} />
                撤销本轮
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
