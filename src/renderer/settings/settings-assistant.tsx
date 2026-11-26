import type {
  ProviderView,
  SettingsApproval,
  SettingsEvent,
  SettingsInput,
  SettingsValues,
} from "@link-studio/core";
import { canvasAgentMediaModels } from "@link-studio/core";
import { Minus, SquarePen } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  historyPageContext,
  type SettingsPage,
  type SettingsRefId,
  settingsPaths,
  settingsRefs,
} from "../../../packages/link-studio-core/src/settings-page-context";
import { AssistantTimeline } from "../assistant/activity-timeline";
import { approvalTimeline } from "../assistant/approval-timeline";
import { AssistantContextChips as SettingsContextChips } from "../assistant/assistant-context-chips";
import { AssistantModelState } from "../assistant/assistant-model-state";
import {
  AssistantCompactionStatus,
  AssistantHeading,
  AssistantStatus,
  AssistantTranscript,
} from "../assistant/assistant-panel";
import {
  AssistantPreferences,
  AssistantReply,
  useAssistantModelPreference,
} from "../assistant/assistant-preferences";
import { ComposerTools } from "../assistant/composer-tools";
import { type CardJump, InfoCard } from "../assistant/info-card";
import { RunPlanStrip } from "../assistant/run-plan-strip";
import { RunStatusCard, showsContinue } from "../assistant/run-status-card";
import { MissedSteer, SteerTray, useSteers } from "../assistant/steer-queue";
import { useAssistantAction, useAssistantSession } from "../assistant/use-assistant-session";
import { AssistantEditor, type AssistantEditorHandle } from "../workspace/assistant-editor";
import { CanvasAssistantEmpty } from "../workspace/assistant-empty";
import { AssistantHistory } from "../workspace/assistant-history";
import { AssistantQuestionnaire, QuestionRecord } from "../workspace/assistant-questionnaire";
import { ChangeDisposition, SettingsActionResult } from "./settings-action-result";
import { ApprovalCard } from "./settings-change-card";
import { isChangeReceipt, SettingsChangeResult } from "./settings-change-result";
import { settingsError } from "./settings-page";

function details(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
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

export function Activity({
  event,
  resolveJump,
  request,
  rollback,
  copyInFooter,
  providers = [],
}: {
  event: SettingsEvent;
  resolveJump?: CardJump;
  request?: SettingsEvent;
  rollback?: (order: string) => void;
  copyInFooter?: boolean;
  providers?: ProviderView[];
}) {
  const data = details(event.payload);
  if (event.type === "message.done")
    return (
      <AssistantReply
        copyInFooter={copyInFooter}
        text={String(data.text ?? "")}
        thinking={typeof data.thinking === "string" ? data.thinking : undefined}
      />
    );
  if (event.type === "message.user") {
    const snapshot = historyPageContext(data.page_context);
    return (
      <article className="settings-user-message user-message">
        {snapshot && <SettingsContextChips refs={settingsRefs(snapshot)} />}
        <div>{String(data.text ?? "")}</div>
      </article>
    );
  }
  if (event.type === "approval.decided") {
    if (data.kind === "ask")
      return (
        <QuestionRecord
          payload={{ ...data, payload: data.payload ?? details(request?.payload).payload }}
          providers={providers}
        />
      );
    const result = details(data.result);
    if (data.kind === "admin_change" && data.status === "executed" && isChangeReceipt(result))
      return (
        <SettingsChangeResult receipt={result} resolveJump={resolveJump} rollback={rollback} />
      );
    if (
      data.kind === "admin_change" &&
      (data.status === "rejected" || data.status === "failed" || data.status === "expired")
    ) {
      return (
        <ChangeDisposition
          status={data.status}
          answer={details(data.decision).answer}
          revertOf={
            details(data.payload).revertOf ?? details(details(request?.payload).payload).revertOf
          }
          error={typeof result.code === "string" ? settingsError(result.code) : undefined}
        />
      );
    }
    if (data.kind === "admin_secret" || data.kind === "admin_test_run") {
      const label = details(data.payload ?? details(request?.payload).payload).label;
      return (
        <SettingsActionResult
          kind={data.kind}
          status={data.status}
          result={result}
          label={typeof label === "string" ? label : undefined}
          error={result.code ? settingsError(String(result.code)) : undefined}
        />
      );
    }
    return (
      <p className="assistant-activity">
        {result.code
          ? settingsError(String(result.code))
          : result.applied === true && String(data.kind).startsWith("drama_update_")
            ? "已写入短剧"
            : typeof result.applied === "number"
              ? `已应用 ${result.applied} 项，跳过 ${result.skipped} 项`
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
  if (event.type === "card.shown") return <InfoCard raw={data.card} resolveJump={resolveJump} />;
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

const readSettingsSession = (sessionId: string, after: number, before?: number) =>
  window.desktop.settings.agentState({ sessionId, after, before });

export function SettingsAssistant({
  loadingModels,
  route,
  close,
  resolveJump,
  resource,
  providers,
  plugins,
  context,
  refresh,
}: {
  loadingModels: boolean;
  resolveJump: CardJump;
  close: () => void;
  route?: SettingsPage;
  resource?: { id: string; key?: string };
  providers: ProviderView[];
  plugins: SettingsValues["list"]["plugins"];
  context?: ProviderView;
  refresh: () => Promise<unknown>;
}) {
  const [sessions, setSessions] = useState<SettingsValues["agentList"]>([]);
  const editor = useRef<AssistantEditorHandle>(null);
  const [removed, setRemoved] = useState<{ route?: SettingsPage; ids: Set<SettingsRefId> }>();
  const refs = route
    ? settingsRefs({
        route: settingsPaths[route],
        model_key: context?.modelKey ?? context?.id,
        ...(route === "adapters" ? { plugin_key: resource?.key } : { channel_key: resource?.id }),
      }).filter((ref) => removed?.route !== route || !removed.ids.has(ref.id))
    : [];
  const hasRef = (id: SettingsRefId) => refs.some((ref) => ref.id === id);
  const [session, setSession] = useState("");
  const [model, setModel] = useAssistantModelPreference();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const { busy, run } = useAssistantAction(setError);
  const { events, state, readError, refreshSession, history, recordFeedback } = useAssistantSession(
    session,
    readSettingsSession,
  );
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const message = drafts[session] ?? "";
  const steers = useSteers(events);
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
  const pendingQuestion = state?.approvals.find((approval) => approval.kind === "ask");
  const canSend =
    !blocked &&
    !state?.otherActiveSession &&
    (state?.activeRun
      ? ["running", "waiting_approval"].includes(state.activeStatus ?? "") ||
        (state.activeStatus === "waiting_input" && !!pendingQuestion)
      : !!provider);
  const lastRunStatus = events.findLast(({ type }) => type === "run.status");

  const decide = (input: Omit<SettingsInput<"agentDecide">, "sessionId">) =>
    run(async () => {
      const result = await window.desktop.settings.agentDecide({ sessionId: session, ...input });
      await refreshSession();
      if (!result.ok) setError(result.code);
    });

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

  const send = (explicit?: string) => {
    const text = (explicit ?? message).trim();
    if (!canSend || !text || (explicit !== undefined && state?.activeRun)) return;
    return run(async () => {
      const sessionId = session || (await create());
      if (!sessionId) return;
      if (state?.activeRun && pendingQuestion) {
        const skipped = await window.desktop.settings.agentDecide({
          sessionId,
          approvalId: pendingQuestion.id,
          selected: [],
        });
        if (!skipped.ok) {
          setError(skipped.code);
          await refreshSession();
          return;
        }
      }
      const result = await window.desktop.settings.agentSend({
        sessionId,
        providerId: provider?.id ?? "active-run",
        message: text,
        ...(!state?.activeRun &&
          refs.length > 0 && {
            route,
            ...(hasRef("model") && { contextId: context?.id }),
            ...(hasRef("plugin") && { pluginHash: resource?.id }),
            ...(hasRef("channel") && { channelId: resource?.id }),
          }),
        ...(state?.activeRun ? { runId: state.activeRun } : {}),
      });
      if (!result.ok) setError(result.code);
      else if (explicit === undefined) setMessage("");
      await refreshSession();
    });
  };

  const rollback =
    canSend && !state?.activeRun ? (order: string) => void send(`回滚变更单 ${order}`) : undefined;
  const stop =
    state?.activeRun && !message.trim()
      ? () =>
          void run(async () => {
            if (blocked || !state.activeRun) return;
            const result = await window.desktop.settings.agentStop({
              sessionId: session,
              runId: state.activeRun,
            });
            await refreshSession();
            if (!result.ok) setError(result.code);
          })
      : undefined;

  if (loadingModels || !provider) return <AssistantModelState loading={loadingModels} settings />;
  const approvals = approvalTimeline(events, state?.approvals ?? []);
  const status = (
    <AssistantStatus
      state={state}
      events={events}
      showStop={!!stop && !blocked && !state?.approvals.length}
      busy={busy}
      stale={!!readError || listState === "failed"}
      opening={
        listState === "loading" || history.phase === "latest" || history.phase === "latest-error"
      }
    />
  );
  const renderPending = (approval: SettingsApproval) => (
    <Fragment key={approval.id}>
      {approval.kind === "ask" ? (
        <AssistantQuestionnaire
          quickChoices
          payload={approval.payload}
          busy={blocked}
          models={canvasAgentMediaModels({ providers, plugins })}
          onAnswer={(answers) =>
            void decide({ approvalId: approval.id, selected: [], ...(answers && { answers }) })
          }
        />
      ) : approval.kind === "admin_change" ? (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          disabled={blocked}
          decide={(selected, answer) =>
            decide({ approvalId: approval.id, selected, ...(answer && { answer }) })
          }
        />
      ) : (
        <ActionCard
          key={approval.id}
          approval={approval}
          disabled={blocked}
          decide={(confirmTest) => decide({ approvalId: approval.id, selected: [], confirmTest })}
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
      )}
    </Fragment>
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape bubbles from whichever child has focus to cancel the current assistant run.
    <section
      className="assistant-surface settings-assistant"
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.currentTarget.querySelector(":popover-open,select:open") ||
          (event.target instanceof Element &&
            event.target.closest("[popover],dialog,[role=dialog],[role=menu]"))
        )
          return;
        if (state?.approvals.length) {
          event.preventDefault();
          return;
        }
        if (!stop || blocked) return;
        event.preventDefault();
        stop();
      }}
    >
      <AssistantHeading
        title={
          <AssistantHistory
            key={session}
            current={session}
            sessions={sessions}
            title={title ?? sessions.find((entry) => entry.id === session)?.title ?? "新对话"}
            locked={blocked || !!state?.activeRun}
            select={selectSession}
            rename={(next) =>
              void run(async () => {
                const result = await window.desktop.settings.agentRename({
                  sessionId: session,
                  title: next,
                });
                if (!result.ok) return setError(result.code);
                setSessions((current) =>
                  current.map((entry) =>
                    entry.id === session ? { ...entry, title: result.value.title } : entry,
                  ),
                );
                await refreshSession();
              })
            }
            remove={(id) =>
              void run(async () => {
                const result = await window.desktop.settings.agentRemove({ sessionId: id });
                if (!result.ok) return setError(result.code);
                if (!result.value.removed) return;
                const remaining = sessions.filter((entry) => entry.id !== id);
                setSessions(remaining);
                setDrafts((current) => {
                  const next = { ...current };
                  delete next[id];
                  return next;
                });
                if (id === session) selectSession(remaining[0]?.id ?? "");
              })
            }
          />
        }
      >
        <div className="settings-assistant-actions">
          <button
            type="button"
            disabled={blocked || !!state?.activeRun}
            onClick={() => selectSession("")}
            aria-label="新对话"
            title="新对话"
          >
            <SquarePen size={16} />
          </button>
          <AssistantPreferences />
          <button type="button" aria-label="关闭设置小灵" title="收起设置小灵" onClick={close}>
            <Minus size={16} />
          </button>
        </div>
      </AssistantHeading>
      {state?.otherActiveSession && (
        <button
          type="button"
          disabled={busy}
          onClick={() => selectSession(state.otherActiveSession ?? "")}
        >
          返回运行中的会话
        </button>
      )}
      <AssistantTranscript
        history={history}
        loadingSessions={listState === "loading"}
        sessionId={session}
        label="对话与活动"
        empty={
          !events.length && !loading && !readError && provider ? (
            <CanvasAssistantEmpty
              settings
              hasModel
              onStarter={(text) => {
                setMessage(text);
                editor.current?.focus();
              }}
            />
          ) : undefined
        }
      >
        <AssistantTimeline
          composerPlan
          partial={state?.partial}
          model={provider}
          saveFeedback={async (runId, value) => {
            const result = await window.desktop.settings.agentFeedback({
              sessionId: session,
              runId,
              value,
            });
            if (result.ok) recordFeedback(runId, value);
            return result.ok;
          }}
          events={steers.transcript}
          render={(event, copyInFooter) => {
            if (event.type === "run.status") {
              const data = details(event.payload);
              const resumable =
                canSend &&
                !state?.activeRun &&
                event.seq === lastRunStatus?.seq &&
                showsContinue(data.status);
              return (
                <RunStatusCard
                  key={event.seq}
                  data={data}
                  resume={
                    resumable
                      ? () =>
                          void run(async () => {
                            const result = await window.desktop.settings.agentContinue({
                              sessionId: session,
                              runId: event.runId,
                            });
                            await refreshSession();
                            if (!result.ok) setError(result.code);
                          })
                      : undefined
                  }
                />
              );
            }
            if (event.type === "steer.read" || event.type === "steer.dropped") return null;
            const dropped = steers.missed.get(event.seq);
            if (dropped !== undefined)
              return (
                <div key={event.seq} className="agent-missed-turn">
                  <MissedSteer
                    resend={
                      canSend && !state?.activeRun && dropped >= steers.lastUser
                        ? () => void send(String(details(event.payload).text))
                        : undefined
                    }
                  />
                  <Activity event={event} />
                </div>
              );
            const id = event.approvalId;
            if (id && event.type === "approval.created") {
              if (approvals.anchors.get(id) !== event.seq) return null;
              const outcome = approvals.decisions.get(id);
              if (outcome)
                return (
                  <Activity
                    key={event.seq}
                    event={outcome}
                    request={event}
                    resolveJump={resolveJump}
                    rollback={rollback}
                    providers={providers}
                  />
                );
              const pending = approvals.active.get(id);
              if (pending) return renderPending(pending);
              const data = details(event.payload);
              const kind = data.kind;
              if (approvals.closedRuns.has(event.runId) && kind === "admin_change")
                return (
                  <ChangeDisposition
                    key={event.seq}
                    status="expired"
                    revertOf={details(data.payload).revertOf}
                  />
                );
              if (
                approvals.closedRuns.has(event.runId) &&
                (kind === "admin_secret" || kind === "admin_test_run")
              ) {
                const label = details(data.payload).label;
                return (
                  <SettingsActionResult
                    key={event.seq}
                    kind={kind}
                    status="expired"
                    result={{}}
                    label={typeof label === "string" ? label : undefined}
                  />
                );
              }
              return (
                <p key={event.seq} className="assistant-activity">
                  {kind === "ask"
                    ? "提问"
                    : kind === "admin_change"
                      ? "配置变更单"
                      : kind === "admin_secret"
                        ? "凭证请求"
                        : "试跑请求"}
                  （不可操作）
                </p>
              );
            }
            if (
              id &&
              event.type === "approval.decided" &&
              (approvals.anchors.has(id) || approvals.decisions.get(id) !== event)
            )
              return null;
            return (
              <Activity
                event={event}
                key={event.seq}
                resolveJump={resolveJump}
                rollback={rollback}
                copyInFooter={copyInFooter}
                providers={providers}
              />
            );
          }}
        />
        {approvals.unplaced.map(renderPending)}
        <AssistantCompactionStatus state={state} events={events} />
        {status}
      </AssistantTranscript>
      {(error || (readError && history.phase !== "latest-error")) && (
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
      {readError && history.phase !== "latest-error" && (
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
        <RunPlanStrip key={`plan-${session}`} events={events} activeRun={state?.activeRun} />
        {steers.waiting.length > 0 && (
          <SteerTray key={`steers-${session}`} waiting={steers.waiting} />
        )}
        <SettingsContextChips
          refs={refs}
          remove={(id) =>
            setRemoved((previous) => ({
              route,
              ids: new Set(previous && previous.route === route ? previous.ids : []).add(id),
            }))
          }
        />
        <AssistantEditor
          key={session}
          editor={editor}
          settings
          message={message}
          busy={busy}
          running={Boolean(state?.activeRun)}
          onText={setMessage}
        />
        <ComposerTools
          models={models}
          modelId={provider?.id}
          onModel={setModel}
          events={events}
          locked={blocked || Boolean(state?.activeRun)}
          canSend={canSend && !!message.trim()}
          active={Boolean(state?.activeRun)}
          stop={stop}
          stopDisabled={blocked}
        />
        <div className="settings-actions">
          <small className="sr-only" id="settings-assistant-shortcut">
            回车发送 · Shift＋回车换行
          </small>
        </div>
      </form>
    </section>
  );
}
