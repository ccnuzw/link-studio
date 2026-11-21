import type {
  ProviderView,
  SettingsApproval,
  SettingsEvent,
  SettingsInput,
  SettingsValues,
} from "@link-studio/core";
import { useEffect, useRef, useState } from "react";
import {
  AssistantHeading,
  AssistantStatus,
  AssistantTranscript,
  submitShortcut,
} from "../assistant/assistant-panel";
import { ComposerTools } from "../assistant/composer-tools";
import { useAssistantAction, useAssistantSession } from "../assistant/use-assistant-session";
import { settingsError } from "./settings-page";

function details(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function ApprovalCard({
  approval,
  decide,
  disabled,
}: {
  approval: SettingsApproval;
  decide: (selected: number[]) => Promise<void>;
  disabled: boolean;
}) {
  const payload = details(approval.payload);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const items = Array.isArray(payload.items) ? payload.items.map(details) : [];
  const submit = async (indices: number[]) => {
    setBusy(true);
    try {
      await decide(indices);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-confirm" aria-label="配置变更单">
      <h3>配置变更单</h3>
      {typeof payload.expectedRevision === "number" && (
        <p className="muted">基线修订 {payload.expectedRevision}</p>
      )}
      {items.map((item, index) => (
        <label className="settings-check" key={String(item.field)}>
          <input
            type="checkbox"
            disabled={disabled || busy}
            checked={selected.includes(index)}
            onChange={({ target }) =>
              setSelected(
                target.checked ? [...selected, index] : selected.filter((entry) => entry !== index),
              )
            }
          />{" "}
          <span>
            {String(item.field)}：{String(item.before ?? "空")} → {String(item.after ?? "空")}
          </span>
        </label>
      ))}
      {payload.kind === "plugin" && (
        <details>
          <summary>审阅草稿源码</summary>
          <pre>{String(details(payload.plugin).source ?? "")}</pre>
        </details>
      )}
      <div className="settings-actions">
        <button
          type="button"
          disabled={disabled || busy || !selected.length}
          onClick={() => void submit(selected)}
        >
          应用所选
        </button>
        <button type="button" disabled={disabled || busy} onClick={() => void submit([])}>
          拒绝变更
        </button>
      </div>
    </section>
  );
}

function ActionCard({
  approval,
  decide,
  configure,
  disabled,
}: {
  approval: SettingsApproval;
  decide: (confirmed: boolean) => Promise<void>;
  configure: (secret: string) => Promise<boolean>;
  disabled: boolean;
}) {
  const target = details(approval.payload);
  const secret = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const isSecret = approval.kind === "admin_secret";
  const title = isSecret ? "填写服务凭证" : "确认文本试跑";
  const act = async (confirmed: boolean) => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      if (!confirmed || !isSecret) await decide(confirmed);
      else if (secret.current?.value) {
        const value = secret.current.value;
        secret.current.value = "";
        await configure(value);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="settings-confirm"
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        void act(true);
      }}
    >
      <h3>{title}</h3>
      <p>
        {String(target.label)} · {String(target.model)}
      </p>
      <p className="muted">
        {String(target.endpoint)} · 修订 {String(target.expectedRevision)}
      </p>
      {isSecret ? (
        <label>
          新凭证（不会发送给小灵）
          <input
            type="password"
            ref={secret}
            autoComplete="new-password"
            maxLength={8192}
            disabled={disabled || busy}
            required
          />
        </label>
      ) : (
        <p>将向上述已保存的端点发送一条短提示词。供应商可能计费，结果未知时不会自动重试。</p>
      )}
      <div className="settings-actions">
        <button type="submit" disabled={disabled || busy}>
          {isSecret ? "保存凭证" : "同意试跑"}
        </button>
        <button type="button" disabled={disabled || busy} onClick={() => void act(false)}>
          拒绝
        </button>
      </div>
    </form>
  );
}

export function Activity({ event }: { event: SettingsEvent }) {
  const data = details(event.payload);
  if (event.type === "message.user" || event.type === "message.done")
    return (
      <article
        className={
          event.type === "message.user" ? "assistant-message user-message" : "assistant-message"
        }
      >
        <strong>{event.type === "message.user" ? "你" : "小灵"}</strong>
        <p>{String(data.text ?? "")}</p>
      </article>
    );
  if (event.type === "approval.decided") {
    const result = details(data.result);
    return (
      <p className="assistant-activity">
        {result.code
          ? settingsError(String(result.code))
          : typeof result.applied === "number"
            ? `已应用 ${result.applied} 项，跳过 ${result.skipped} 项`
            : result.tested
              ? "助手试跑成功"
              : result.configured
                ? "凭证已保存"
                : data.status === "rejected"
                  ? "已拒绝"
                  : "决定已记录"}
      </p>
    );
  }
  if (event.type === "tool.start")
    return (
      <p className="assistant-activity">{String(data.label ?? data.verb ?? "正在检查设置")}</p>
    );
  if (event.type === "tool.end" && typeof data.summary === "string")
    return <p className="assistant-activity">{data.summary}</p>;
  if (event.type === "steer.read" || event.type === "steer.dropped")
    return (
      <p className="assistant-activity">
        {event.type === "steer.read" ? "小灵已读取插话" : "尚未读取的插话已撤回"}
      </p>
    );
  if (event.type === "plan.updated" && Array.isArray(data.steps))
    return (
      <section className="assistant-message">
        <strong>计划</strong>
        <ol>
          {[
            ...new Map(data.steps.map(details).map((step) => [String(step.title), step])).values(),
          ].map((step) => (
            <li key={String(step.title)}>
              {step.status === "done" ? "已完成" : step.status === "doing" ? "进行中" : "待处理"} ·{" "}
              {String(step.title)}
            </li>
          ))}
        </ol>
      </section>
    );
  if (event.type === "card.shown") {
    const card = details(data.card);
    return (
      <section className="assistant-message">
        <strong>{String(card.title ?? "设置摘要")}</strong>
        <dl>
          {Array.isArray(card.rows) &&
            [
              ...new Map(card.rows.map(details).map((row) => [JSON.stringify(row), row])).entries(),
            ].map(([key, row]) => (
              <div key={key}>
                <dt>{String(row.label)}</dt>
                <dd>{String(row.value)}</dd>
              </div>
            ))}
        </dl>
      </section>
    );
  }
  if (event.type === "run.status") {
    const statuses: Record<string, string> = {
      failed: "运行失败。请检查模型连接，再发送一条消息。",
      interrupted: "运行已中断，可继续或发送新消息。若模型配置已变化，请发起新一轮。",
      canceled: "已停止",
      recovering: "正在恢复运行",
      timeout: "运行超时，可以发送新消息。",
      step_limit: "已达到本轮步数上限，可以继续运行。",
      expired: "等待操作超时，本轮已结束。",
    };
    if (typeof data.status === "string" && statuses[data.status])
      return <p className="assistant-activity">{statuses[data.status]}</p>;
  }
  return null;
}

const readSettingsSession = (sessionId: string, after: number) =>
  window.desktop.settings.agentState({ sessionId, after });

export function SettingsAssistant({
  providers,
  context,
  refresh,
}: {
  providers: ProviderView[];
  context?: ProviderView;
  refresh: () => Promise<unknown>;
}) {
  const [sessions, setSessions] = useState<SettingsValues["agentList"]>([]);
  const [session, setSession] = useState("");
  const [model, setModel] = useState("");
  const [contextId, setContextId] = useState(context?.id);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const { busy, run } = useAssistantAction(setError);
  const { events, state, readError, refreshSession } = useAssistantSession(
    session,
    readSettingsSession,
  );
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const message = drafts[session] ?? "";
  const setMessage = (text: string) => setDrafts((previous) => ({ ...previous, [session]: text }));
  const loading = listState === "loading" || (!!session && !state && !readError);
  const blocked = busy || loading || !!readError || listState !== "ready";
  const models = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.channelEnabled !== false &&
      provider.agentEnabled &&
      provider.hasSecret,
  );
  const provider = models.find(({ id }) => id === model) ?? models[0];
  const canSend =
    !blocked &&
    !state?.otherActiveSession &&
    (state?.activeRun
      ? ["running", "waiting_approval"].includes(state.activeStatus ?? "")
      : !!provider);
  const lastRunStatus = events.findLast(({ type }) => type === "run.status");
  const resumable =
    !state?.activeRun &&
    lastRunStatus &&
    ["interrupted", "step_limit"].includes(String(details(lastRunStatus.payload).status));

  const decide = (input: Omit<SettingsInput<"agentDecide">, "sessionId">) =>
    run(async () => {
      const result = await window.desktop.settings.agentDecide({ sessionId: session, ...input });
      await refreshSession();
      if (!result.ok) setError(result.code);
    });

  useEffect(() => {
    setContextId(context?.id);
  }, [context?.id]);
  useEffect(() => {
    if (listState !== "loading") return;
    let current = true;
    const failed = (code: string) => {
      if (!current) return;
      setListState("failed");
      setError(code);
    };
    void window.desktop.settings.agentList({}).then(
      (result) => {
        if (!current) return;
        if (result.ok) {
          setSessions(result.value);
          setSession(result.value[0]?.id ?? "");
          setListState("ready");
        } else failed(result.code);
      },
      () => failed("AGENT_STATE_UNAVAILABLE"),
    );
    return () => {
      current = false;
    };
  }, [listState]);
  const lastDecision = events.findLast(({ type }) => type === "approval.decided");
  useEffect(() => {
    if (lastDecision !== undefined) void refresh().catch(() => {});
  }, [lastDecision, refresh]);
  const title = state?.title;
  useEffect(() => {
    if (title)
      setSessions((current) =>
        current.map((entry) =>
          entry.id === session && entry.title !== title ? { ...entry, title } : entry,
        ),
      );
  }, [session, title]);
  const selectSession = (id: string) => {
    setError("");
    setSession(id);
  };

  const create = async () => {
    const result = await window.desktop.settings.agentCreate({});
    if (!result.ok) {
      setError(result.code);
      return "";
    }
    const id = result.value.sessionId;
    setSessions((current) => [{ id, title: "新对话" }, ...current]);
    setSession(id);
    return id;
  };

  const send = () => {
    if (!canSend || !message.trim()) return;
    return run(async () => {
      const sessionId = session || (await create());
      if (!sessionId) return;
      const result = await window.desktop.settings.agentSend({
        sessionId,
        providerId: provider?.id ?? "active-run",
        message: message.trim(),
        ...(contextId ? { contextId } : {}),
        ...(state?.activeRun ? { runId: state.activeRun } : {}),
      });
      if (result.ok) setMessage("");
      else setError(result.code);
      await refreshSession();
    });
  };

  return (
    <aside className="assistant-surface settings-assistant" aria-label="小灵设置助手">
      <AssistantHeading title="设置小灵">
        <button
          type="button"
          disabled={busy || listState !== "ready"}
          onClick={() =>
            void run(async () => {
              await create();
            })
          }
        >
          新对话
        </button>
      </AssistantHeading>
      <div className="assistant-controls">
        <label>
          会话
          <select
            value={session}
            disabled={busy || listState !== "ready"}
            onChange={({ target }) => selectSession(target.value)}
          >
            <option value="" disabled>
              新会话
            </option>
            {sessions.map(({ id, title }) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
        {!provider && (
          <p className="assistant-empty">请保存文本模型和凭证，并勾选「允许小灵使用此模型」。</p>
        )}
      </div>
      <AssistantStatus
        state={state}
        busy={busy}
        stale={!!readError || listState === "failed"}
        loading={loading}
      />
      {state?.otherActiveSession && (
        <button
          type="button"
          disabled={busy}
          onClick={() => selectSession(state.otherActiveSession ?? "")}
        >
          返回运行中的会话
        </button>
      )}
      {!state?.activeRun && context?.id === contextId && context && (
        <button
          type="button"
          className="context-chip"
          disabled={busy}
          onClick={() => setContextId(undefined)}
          aria-label={`移除${context.label}上下文`}
        >
          {context.label} ×
        </button>
      )}
      <AssistantTranscript
        sessionId={session}
        label="对话与活动"
        empty={
          !events.length && !loading && !readError && provider
            ? "问小灵如何配置模型，或请它检查当前设置。"
            : undefined
        }
      >
        {events.map((event) => (
          <Activity event={event} key={event.seq} />
        ))}
        {state?.partial?.text && (
          <article className="assistant-message" aria-live="off">
            <strong>小灵</strong>
            <p>{state.partial.text}</p>
          </article>
        )}
      </AssistantTranscript>
      {!!state?.approvals.length && (
        <section className="assistant-approvals" aria-label="待审批操作">
          {state.approvals.map((approval) =>
            approval.kind === "admin_change" ? (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                disabled={blocked}
                decide={(selected) => decide({ approvalId: approval.id, selected })}
              />
            ) : (
              <ActionCard
                key={approval.id}
                approval={approval}
                disabled={blocked}
                decide={(confirmTest) =>
                  decide({ approvalId: approval.id, selected: [], confirmTest })
                }
                configure={async (secret) => {
                  let configured = false;
                  await run(async () => {
                    const result = await window.desktop.settings.agentConfigureSecret({
                      sessionId: session,
                      approvalId: approval.id,
                      secret,
                    });
                    configured = result.ok;
                    await refreshSession();
                    if (!result.ok) setError(result.code);
                  });
                  return configured;
                }}
              />
            ),
          )}
        </section>
      )}
      {(error || readError) && (
        <p role="alert" className="error">
          {settingsError(error || readError || "")}
        </p>
      )}
      {listState === "failed" && (
        <button
          type="button"
          onClick={() => {
            setError("");
            setListState("loading");
          }}
        >
          重试读取会话
        </button>
      )}
      {readError && (
        <button type="button" disabled={busy} onClick={() => void refreshSession()}>
          刷新会话状态
        </button>
      )}
      <form
        className="assistant-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label>
          消息
          <textarea
            value={message}
            rows={3}
            maxLength={24000}
            readOnly={busy}
            aria-describedby="settings-assistant-shortcut"
            onKeyDown={submitShortcut}
            onChange={({ target }) => setMessage(target.value)}
            placeholder="例如：检查当前模型设置。密钥请填在配置页。"
          />
        </label>
        <ComposerTools
          models={models}
          modelId={provider?.id}
          onModel={setModel}
          events={events}
          locked={blocked || Boolean(state?.activeRun)}
          canSend={canSend && !!message.trim()}
          active={Boolean(state?.activeRun)}
        />
        <div className="settings-actions">
          {resumable && (
            <button
              type="button"
              disabled={blocked || !!state?.otherActiveSession}
              onClick={() =>
                void run(async () => {
                  const result = await window.desktop.settings.agentContinue({
                    sessionId: session,
                    runId: lastRunStatus.runId,
                  });
                  await refreshSession();
                  if (!result.ok) setError(result.code);
                })
              }
            >
              继续运行
            </button>
          )}
          {state?.activeRun && (
            <button
              type="button"
              disabled={blocked}
              onClick={() =>
                void run(async () => {
                  if (!state.activeRun) return;
                  const result = await window.desktop.settings.agentStop({
                    sessionId: session,
                    runId: state.activeRun,
                  });
                  await refreshSession();
                  if (!result.ok) setError(result.code);
                })
              }
            >
              停止
            </button>
          )}
          <small className="assistant-shortcut" id="settings-assistant-shortcut">
            回车发送 · Shift＋回车换行
          </small>
        </div>
      </form>
    </aside>
  );
}
