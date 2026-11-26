import type { SettingsApproval } from "@link-studio/core";
import { Bell, Check, ChevronDown, CircleAlert, GitPullRequest, Trash2, X } from "lucide-react";
import { type ReactNode, useContext, useEffect, useId, useState } from "react";
import { keyedItems } from "../occurrence-keys";
import { AgentMarks } from "./agent-marks";
import { GenerationApprovalCard, GenerationRequestDetails } from "./generation-approval-card";
import "./canvas-request-cards.css";

function fields(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function RequestHeading({
  id,
  icon: Icon,
  title,
  meta,
}: {
  id: string;
  icon: typeof Trash2;
  title: string;
  meta?: string;
}) {
  return (
    <header className="canvas-request-heading">
      <span className="canvas-request-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <h3 id={id}>{title}</h3>
      {meta && <span className="canvas-request-meta">{meta}</span>}
    </header>
  );
}

export function CanvasRequestDetails({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="canvas-request-detail">
      <summary>
        <ChevronDown size={14} aria-hidden />
        {label}
      </summary>
      <div className="canvas-request-detail-body">{children}</div>
    </details>
  );
}

function DeleteRequest({
  payload,
  items,
  busy,
  decide,
}: {
  payload: Record<string, unknown>;
  items: Record<string, unknown>[];
  busy: boolean;
  decide: (indices: number[]) => void;
}) {
  const title = useId();
  const marks = useContext(AgentMarks);
  const [selected, setSelected] = useState(() => items.map((_, index) => index));
  const edgeCount = Array.isArray(payload.edgeIds) ? payload.edgeIds.length : 0;
  const count = selected.length + (edgeCount ? edgeCount - 1 : 0);
  const highlight = () =>
    marks.danger(items.flatMap((item) => (typeof item.node_id === "string" ? [item.node_id] : [])));
  useEffect(() => () => marks.danger([]), [marks]);
  return (
    <section
      className="canvas-request-card"
      data-tone="danger"
      aria-labelledby={title}
      onFocus={highlight}
      onBlur={() => marks.danger([])}
      onMouseEnter={highlight}
      onMouseLeave={() => marks.danger([])}
    >
      <RequestHeading id={title} icon={Trash2} title="申请删除" meta="需确认" />
      {typeof payload.reason === "string" && payload.reason && (
        <p className="canvas-request-copy">{payload.reason}</p>
      )}
      <ul className="canvas-request-list">
        {items.map((item, index) => (
          <li key={item.edges ? "edges" : `node-${item.node_id}`}>
            {item.edges ? (
              <p className="canvas-request-edge">同时删除 {edgeCount} 条指定连线</p>
            ) : (
              <label className="canvas-request-choice">
                <input
                  type="checkbox"
                  aria-label={`删除「${item.label}」`}
                  checked={selected.includes(index)}
                  disabled={busy}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((current) =>
                      checked ? [...current, index] : current.filter((entry) => entry !== index),
                    );
                  }}
                />
                <span>{String(item.label)}</span>
                {item.hasOutput ? <small>含产物</small> : null}
              </label>
            )}
          </li>
        ))}
      </ul>
      <div className="canvas-request-actions">
        <button type="button" disabled={busy} onClick={() => decide([])}>
          保留
        </button>
        <button
          type="button"
          data-primary
          disabled={busy || !count}
          onClick={() => decide(selected)}
        >
          删除 {count} 项
        </button>
      </div>
    </section>
  );
}

const operationLabels: Record<string, string> = {
  putNode: "写入节点",
  removeNode: "删除节点",
  putEdge: "写入连线",
  removeEdge: "删除连线",
  setViewport: "调整视图",
};

function EditRequest({
  operations,
  busy,
  decide,
}: {
  operations: Record<string, unknown>[];
  busy: boolean;
  decide: (indices: number[]) => void;
}) {
  const title = useId();
  return (
    <section className="canvas-request-card" aria-labelledby={title}>
      <RequestHeading
        id={title}
        icon={GitPullRequest}
        title="画布变更审批"
        meta={`${operations.length} 项`}
      />
      <ol className="canvas-request-list canvas-request-operations">
        {keyedItems(operations, (operation) =>
          JSON.stringify([
            operation.type,
            operation.id ?? fields(operation.node ?? operation.edge).id,
          ]),
        ).map(({ item: operation, key }) => {
          const item = fields(operation.node ?? operation.edge);
          const data = fields(item.data);
          const shots = Array.isArray(data.storyboard) ? data.storyboard.map(fields) : [];
          const kind = shots.length
            ? "分镜表"
            : (operationLabels[String(operation.type)] ?? "变更");
          const label = String(data.label ?? operation.id ?? item.id ?? kind);
          return (
            <li key={key}>
              <div className="canvas-request-operation-title">
                <span>{kind}</span>
                <strong title={label}>{label}</strong>
              </div>
              {shots.length > 0 && (
                <CanvasRequestDetails label={`预览 ${shots.length} 个镜头`}>
                  <ol className="canvas-request-shots">
                    {keyedItems(shots, (shot) => String(shot.id)).map(({ item: shot, key }) => (
                      <li key={key}>
                        <strong>
                          {[
                            shot.shot,
                            shot.camera,
                            typeof shot.duration === "number" && `${shot.duration} 秒`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </strong>
                        {shot.scene ? <p>{String(shot.scene)}</p> : null}
                        {shot.action ? <p>动作 · {String(shot.action)}</p> : null}
                        {shot.dialogue ? <p>对白 · {String(shot.dialogue)}</p> : null}
                      </li>
                    ))}
                  </ol>
                </CanvasRequestDetails>
              )}
              <CanvasRequestDetails label="查看操作">
                <pre>{JSON.stringify(operation, null, 2)}</pre>
              </CanvasRequestDetails>
            </li>
          );
        })}
      </ol>
      <div className="canvas-request-actions">
        <button type="button" disabled={busy} onClick={() => decide([])}>
          拒绝
        </button>
        <button
          type="button"
          data-primary
          disabled={busy || !operations.length}
          onClick={() => decide(operations.map((_, index) => index))}
        >
          应用画布变更
        </button>
      </div>
    </section>
  );
}

export function CanvasApprovalRequest({
  approval,
  busy,
  decide,
}: {
  approval: SettingsApproval;
  busy: boolean;
  decide: (indices: number[], answer?: string) => void;
}) {
  const payload = fields(approval.payload);
  const items = Array.isArray(payload.items) ? payload.items.map(fields) : [];
  if (approval.kind === "generate")
    return (
      <div className="canvas-request-stack">
        <GenerationApprovalCard items={items} reason={payload.reason} busy={busy} decide={decide} />
        <CanvasRequestDetails label="查看端点和出站内容">
          <GenerationRequestDetails items={items} />
        </CanvasRequestDetails>
      </div>
    );
  if (approval.kind === "delete" && payload.action === "delete")
    return <DeleteRequest payload={payload} items={items} busy={busy} decide={decide} />;
  const operations = Array.isArray(payload.operations) ? payload.operations.map(fields) : [];
  return <EditRequest operations={operations} busy={busy} decide={decide} />;
}

export function CanvasRequestReceipt({
  deletion,
  status,
  error,
}: {
  deletion: boolean;
  status: unknown;
  error?: string;
}) {
  const failed = status === "failed";
  const label = deletion ? "删除请求" : "画布变更";
  const text = failed
    ? `${label}执行失败`
    : status === "expired"
      ? `${label}已失效`
      : status === "rejected"
        ? deletion
          ? "已保留，未执行删除"
          : "已拒绝画布变更"
        : deletion
          ? status === "partially_approved"
            ? "已删除选中项"
            : "已执行删除"
          : "已应用画布变更";
  return (
    <AssistantRequestReceipt status={status} text={text} detail={failed ? error : undefined} />
  );
}

export function AssistantRequestReceipt({
  status,
  text,
  detail,
  open,
}: {
  status: unknown;
  text: string;
  detail?: string;
  open?: () => void;
}) {
  const failed = status === "failed";
  const closed = status === "rejected" || status === "expired" || status === "canceled";
  const pending = status === "queued" || status === "running" || status === "approved";
  const Icon = failed ? CircleAlert : closed ? X : pending ? Bell : Check;
  return (
    <div
      className="canvas-request-receipt"
      data-tone={failed ? "danger" : undefined}
      aria-live="polite"
    >
      <Icon size={14} aria-hidden />
      <span>
        {text}
        {detail ? ` · ${detail}` : ""}
      </span>
      {open && (
        <button type="button" onClick={open}>
          查看工序
        </button>
      )}
    </div>
  );
}

export function CanvasNotificationRequest({ choose }: { choose: (allowed: boolean) => void }) {
  const title = useId();
  return (
    <section className="canvas-request-card canvas-notification-request" aria-labelledby={title}>
      <span className="canvas-request-icon" aria-hidden="true">
        <Bell size={16} />
      </span>
      <div className="canvas-notification-copy">
        <h3 id={title}>允许小灵发送系统通知？</h3>
        <p className="canvas-request-copy">切到后台后，生成待批准或小灵开始验收时提醒你。</p>
      </div>
      <div className="canvas-request-actions">
        <button type="button" onClick={() => choose(false)}>
          不允许
        </button>
        <button type="button" data-primary onClick={() => choose(true)}>
          允许通知
        </button>
      </div>
    </section>
  );
}
