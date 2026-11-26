import type {
  CanvasAgentAction,
  CanvasAgentValues,
  DramaAgentContext,
  DramaAgentSnapshot,
  DramaDocument,
  PluginView,
  ProviderView,
  SettingsApproval,
} from "@link-studio/core";
import { canvasAgentMediaModels, dramaStages as stages } from "@link-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantTimeline } from "../assistant/activity-timeline";
import { approvalTimeline } from "../assistant/approval-timeline";
import { AssistantContextChips } from "../assistant/assistant-context-chips";
import { AssistantModelState } from "../assistant/assistant-model-state";
import {
  AssistantCompactionStatus,
  AssistantStatus,
  AssistantTranscript,
} from "../assistant/assistant-panel";
import { useAssistantModelPreference } from "../assistant/assistant-preferences";
import { ComposerTools } from "../assistant/composer-tools";
import { RunPlanStrip } from "../assistant/run-plan-strip";
import { RunStatusCard, showsContinue } from "../assistant/run-status-card";
import { MissedSteer, SteerTray, useSteers } from "../assistant/steer-queue";
import { useAssistantAction, useAssistantSession } from "../assistant/use-assistant-session";
import { Activity } from "../settings/settings-assistant";
import { settingsError } from "../settings/settings-page";
import { AssistantEditor, type AssistantEditorHandle } from "./assistant-editor";
import { CanvasAssistantEmpty } from "./assistant-empty";
import { AssistantHistory } from "./assistant-history";
import { type ModelMention, serializeModels } from "./assistant-model-mentions";
import { AssistantQuestionnaire, QuestionRecord } from "./assistant-questionnaire";
import { AssistantSkillMenu, useCanvasSkills } from "./assistant-skill-menu";
import { AssistantUserBubble } from "./assistant-user-bubble";
import {
  WorkspaceAssistant,
  WorkspaceAssistantComposer,
  WorkspaceAssistantHeading,
} from "./assistant-workspace";
import { DramaAssistantReceipt, DramaAssistantRequest } from "./drama-assistant-requests";
import type { Stage } from "./drama-workspace-nav";

function dramaContextRefs(context: DramaAgentSnapshot) {
  return [
    ...(context.stage && Object.hasOwn(stages, context.stage)
      ? [{ id: "stage" as const, label: stages[context.stage] }]
      : []),
    ...(context.episodeNo
      ? [{ id: "episodeNo" as const, label: `第 ${context.episodeNo} 集` }]
      : []),
    ...(context.segmentId
      ? [{ id: "segmentId" as const, label: `片段 ${context.segmentNumber ?? ""}`.trim() }]
      : []),
    ...(context.assetId
      ? [{ id: "assetId" as const, label: context.assetName || "当前资产" }]
      : []),
  ];
}

class DramaAssistantError extends Error {}

export function DramaAssistant({
  visible,
  close,
  loadingModels,
  projectHandle,
  models,
  providers,
  plugins,
  refresh,
  beforeWrite,
  document,
  go,
  context,
  assetSelection,
}: {
  visible: boolean;
  close: () => void;
  loadingModels: boolean;
  projectHandle: string;
  models: ProviderView[];
  providers: ProviderView[];
  plugins: PluginView[];
  refresh: () => Promise<void>;
  beforeWrite: () => Promise<boolean>;
  document: DramaDocument;
  go: (stage: Stage, episode?: number) => void;
  context: DramaAgentSnapshot;
  assetSelection?: number;
}) {
  const [modelId, setModel] = useAssistantModelPreference();
  const model = models.find((item) => item.id === modelId) ?? models[0];
  const [sessions, setSessions] = useState<CanvasAgentValues["list"]>();
  const [listAttempt, setListAttempt] = useState(0);
  const [session, setSession] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { text: string; mentions: ModelMention[] }>>(
    {},
  );
  const [removedRefs, setRemovedRefs] = useState<Record<string, { key: string; ids: string[] }>>(
    {},
  );
  const contextKey = JSON.stringify([
    context.stage,
    context.episodeOrder,
    context.episodeNo,
    context.segmentId,
    context.assetId,
    assetSelection,
  ]);
  const excluded = removedRefs[session];
  const ignored = excluded?.key === contextKey ? excluded.ids : [];
  const updateExcluded = (ids: string[]) =>
    setRemovedRefs((previous) => ({ ...previous, [session]: { key: contextKey, ids } }));
  const contextRefs = dramaContextRefs(context).filter((ref) => !ignored.includes(ref.id));
  const { text: message = "", mentions } = drafts[session] ?? {};
  const setMessage = (text: string, mentions: ModelMention[] = []) =>
    setDrafts((previous) => ({ ...previous, [session]: { text, mentions } }));
  const editor = useRef<AssistantEditorHandle>(null);
  const skillCatalog = useCanvasSkills(visible);
  const [error, setError] = useState("");
  const { busy, run } = useAssistantAction(setError, (cause) =>
    cause instanceof DramaAssistantError ? cause.message : "AGENT_REQUEST_UNCERTAIN",
  );
  const invoke = useCallback(
    async <Action extends CanvasAgentAction>(action: Action) => {
      const result = await window.desktop.projects.canvasAgent({
        projectHandle,
        mode: "drama",
        action,
      });
      if (!result.ok) throw new DramaAssistantError(result.error.code);
      return result.value as CanvasAgentValues[Action["method"]];
    },
    [projectHandle],
  );
  useEffect(() => {
    if (!visible || sessions) return;
    let live = true;
    if (listAttempt) setError("");
    void invoke({ method: "list" }).then(
      (list) => {
        if (live) {
          setSessions(list);
          setSession(list[0]?.id ?? "");
        }
      },
      (cause) => {
        if (live) setError(cause instanceof Error ? cause.message : "AGENT_STATE_UNAVAILABLE");
      },
    );
    return () => {
      live = false;
    };
  }, [invoke, listAttempt, sessions, visible]);
  const read = useCallback(
    async (sessionId: string, after: number, before?: number) => {
      try {
        return {
          ok: true as const,
          value: await invoke({ method: "state", sessionId, after, before }),
        };
      } catch (cause) {
        return {
          ok: false as const,
          code: cause instanceof DramaAssistantError ? cause.message : "AGENT_STATE_UNAVAILABLE",
        };
      }
    },
    [invoke],
  );
  const { events, state, readError, refreshSession, history } = useAssistantSession(
    session,
    read,
    visible,
  );
  const title = state?.title;
  useEffect(() => {
    if (title)
      setSessions((current) =>
        current?.map((entry) => (entry.id === session ? { ...entry, title } : entry)),
      );
  }, [session, title]);
  const decided = events.findLast((event) => event.type === "approval.decided");
  const lastRun = events.findLast((event) => event.type === "run.status");
  const approvals = approvalTimeline(events, state?.approvals ?? []);
  const steers = useSteers(events);
  useEffect(() => {
    if (decided) void refresh();
  }, [decided, refresh]);
  const locked = busy || !sessions || (!!session && !state) || !!readError;
  const pendingQuestion = state?.approvals.some((approval) => approval.kind === "ask");
  const showComposer = !!state?.activeRun || (!loadingModels && !!model);
  const canSend =
    !locked &&
    !state?.otherActiveSession &&
    (state?.activeRun
      ? ["running", "waiting_approval"].includes(state.activeStatus ?? "") ||
        (state.activeStatus === "waiting_input" && pendingQuestion)
      : !!model);
  const stop = () =>
    void run(async () => {
      if (!state?.activeRun) return;
      await invoke({ method: "stop", sessionId: session, runId: state.activeRun });
      await refreshSession();
    });
  const send = () =>
    run(async () => {
      if (!canSend || !message.trim()) return;
      const dramaContext: DramaAgentContext | undefined =
        !state?.activeRun && contextRefs.length
          ? {
              ...Object.fromEntries(contextRefs.map(({ id }) => [id, context[id]])),
              ...(contextRefs.some(({ id }) => id === "episodeNo" || id === "segmentId") && {
                episodeOrder: context.episodeOrder,
              }),
            }
          : undefined;
      if (!state?.activeRun && !(await beforeWrite())) return;
      let sessionId = session;
      if (!sessionId) {
        ({ sessionId } = await invoke({ method: "create" }));
        setSessions((current) => [{ id: sessionId, title: "新对话" }, ...(current ?? [])]);
        setDrafts((current) => ({
          ...current,
          [sessionId]: { text: message, mentions: mentions ?? [] },
        }));
        if (excluded) setRemovedRefs((current) => ({ ...current, [sessionId]: excluded }));
        setSession(sessionId);
      }
      await invoke({
        method: "send",
        providerId: model?.id ?? "active-run",
        sessionId,
        message: serializeModels(message, mentions ?? []).trim(),
        selection: [],
        runId: state?.activeRun,
        ...(dramaContext && { dramaContext }),
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[sessionId];
        if (!session) delete next[session];
        return next;
      });
      await refreshSession();
    });
  const resume = (runId: string) =>
    void run(async () => {
      if (!(await beforeWrite())) return;
      await invoke({ method: "continue", runId, sessionId: session });
      await refreshSession();
    });
  const renderPending = (approval: SettingsApproval) =>
    approval.kind === "ask" ? (
      <AssistantQuestionnaire
        key={approval.id}
        payload={approval.payload}
        busy={locked}
        models={canvasAgentMediaModels({ providers, plugins })}
        onAnswer={(answers) =>
          void run(async () => {
            await invoke({
              method: "answer",
              sessionId: session,
              approvalId: approval.id,
              ...(answers ? { answers } : {}),
            });
            await refreshSession();
          })
        }
      />
    ) : (
      <DramaAssistantRequest
        key={approval.id}
        approval={approval}
        busy={locked}
        decide={(approved, answer) =>
          void run(async () => {
            if (approved && !(await beforeWrite())) return;
            await invoke({
              method: "decide",
              sessionId: session,
              approvalId: approval.id,
              selected: approved ? [0] : [],
              ...(answer && { answer }),
            });
            await refreshSession();
            await refresh();
          })
        }
      />
    );
  return (
    <WorkspaceAssistant
      visible={visible}
      close={close}
      closeLabel="收起小灵"
      label="短剧小灵"
      complementary
      onStop={
        !locked && state?.activeRun && !state.approvals.length && !message.trim() ? stop : undefined
      }
    >
      {(controls) => (
        <>
          <WorkspaceAssistantHeading
            disabled={locked || !!state?.activeRun}
            newConversation={() => {
              setError("");
              setSession("");
            }}
            title={
              <AssistantHistory
                key={session}
                current={session}
                sessions={sessions ?? []}
                title={title ?? sessions?.find((entry) => entry.id === session)?.title ?? "新对话"}
                locked={locked || !!state?.activeRun}
                select={setSession}
                rename={(next) =>
                  void run(async () => {
                    const result = await invoke({
                      method: "rename",
                      sessionId: session,
                      title: next,
                    });
                    setSessions((current) =>
                      current?.map((entry) =>
                        entry.id === session ? { ...entry, title: result.title } : entry,
                      ),
                    );
                    await refreshSession();
                  })
                }
                remove={(id) =>
                  void run(async () => {
                    const result = await invoke({ method: "remove", sessionId: id });
                    if (!result.removed) return;
                    const remaining = sessions?.filter((entry) => entry.id !== id) ?? [];
                    setSessions(remaining);
                    setDrafts((current) => {
                      const next = { ...current };
                      delete next[id];
                      return next;
                    });
                    if (id === session) setSession(remaining[0]?.id ?? "");
                  })
                }
              />
            }
          >
            {controls}
          </WorkspaceAssistantHeading>
          <AssistantStatus
            state={state}
            stale={!!readError || (!sessions && !!error)}
            busy={busy}
            events={events}
            opening={
              (!sessions && !error) ||
              history.phase === "latest" ||
              history.phase === "latest-error"
            }
          />
          {state?.otherActiveSession && (
            <button type="button" onClick={() => setSession(state.otherActiveSession ?? "")}>
              返回运行中的会话
            </button>
          )}
          <AssistantTranscript
            history={history}
            loadingSessions={!sessions && !error}
            label="短剧对话与活动"
            sessionId={session}
            empty={
              !events.length && !showComposer ? (
                <AssistantModelState loading={loadingModels} />
              ) : !events.length && !locked ? (
                <CanvasAssistantEmpty
                  drama
                  hasModel={!!model}
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
              model={model}
              events={steers.transcript}
              render={(anchor, copyInFooter) => {
                const id = anchor.approvalId;
                let event = anchor;
                if (id && anchor.type === "approval.created") {
                  if (approvals.anchors.get(id) !== anchor.seq) return null;
                  const outcome = approvals.decisions.get(id);
                  if (outcome) event = outcome;
                  else {
                    const pending = approvals.active.get(id);
                    if (pending) return renderPending(pending);
                    const data = anchor.payload as Record<string, unknown>;
                    if (data.kind === "ask") return null;
                    return (
                      <DramaAssistantReceipt
                        key={anchor.seq}
                        data={{
                          ...data,
                          status: approvals.closedRuns.has(anchor.runId) ? "expired" : data.status,
                        }}
                        document={document}
                        go={go}
                      />
                    );
                  }
                }
                if (
                  id &&
                  anchor.type === "approval.decided" &&
                  (approvals.anchors.has(id) || approvals.decisions.get(id) !== anchor)
                )
                  return null;
                const payload = event.payload as Record<string, unknown> | null;
                const dropped = steers.missed.get(event.seq);
                if (event.type === "message.user")
                  return (
                    <article
                      key={event.seq}
                      className={
                        dropped === undefined
                          ? "agent-user-turn"
                          : "agent-user-turn agent-missed-turn"
                      }
                      aria-label="你的消息"
                    >
                      {dropped !== undefined && <MissedSteer />}
                      {!!payload?.page_context && (
                        <AssistantContextChips
                          label="发送时的短剧引用"
                          refs={dramaContextRefs(payload.page_context as DramaAgentSnapshot)}
                        />
                      )}
                      <AssistantUserBubble text={String(payload?.text ?? "")} />
                    </article>
                  );
                if (event.type === "approval.decided" && payload)
                  return payload.kind === "ask" ? (
                    <QuestionRecord key={event.seq} payload={payload} providers={providers} />
                  ) : (
                    <DramaAssistantReceipt
                      key={event.seq}
                      data={payload}
                      document={document}
                      go={go}
                    />
                  );
                if (event.type === "run.status" && payload) {
                  const canResume =
                    !locked &&
                    !state?.activeRun &&
                    !state?.otherActiveSession &&
                    event.seq === lastRun?.seq;
                  return (
                    <RunStatusCard
                      key={event.seq}
                      data={payload}
                      resume={
                        canResume &&
                        payload.status !== "budget_exhausted" &&
                        showsContinue(payload.status)
                          ? () => resume(event.runId)
                          : undefined
                      }
                    />
                  );
                }
                if (event.type === "steer.read" || event.type === "steer.dropped") return null;
                return <Activity key={event.seq} event={event} copyInFooter={copyInFooter} />;
              }}
            />
            {approvals.unplaced.map(renderPending)}
            <AssistantCompactionStatus state={state} events={events} />
          </AssistantTranscript>
          {(error || (readError && history.phase !== "latest-error")) && (
            <p className="error" role="alert">
              {settingsError(error || readError || "AGENT_STATE_UNAVAILABLE")}
            </p>
          )}
          {!sessions && error && (
            <button type="button" onClick={() => setListAttempt((attempt) => attempt + 1)}>
              重试读取会话
            </button>
          )}
          {!!events.length && !showComposer && (
            <div role="status">
              <AssistantModelState loading={loadingModels} />
            </div>
          )}
          {showComposer && (
            <WorkspaceAssistantComposer send={() => void send()}>
              <RunPlanStrip key={`plan-${session}`} events={events} activeRun={state?.activeRun} />
              {!!steers.waiting.length && (
                <SteerTray key={`steers-${session}`} waiting={steers.waiting} />
              )}
              {!state?.activeRun && (
                <>
                  <AssistantContextChips
                    label="随消息发送的短剧引用"
                    refs={contextRefs}
                    remove={(id) => updateExcluded([...ignored, id])}
                  />
                  {!!ignored.length && (
                    <button type="button" onClick={() => updateExcluded([])}>
                      恢复当前短剧引用
                    </button>
                  )}
                </>
              )}
              <AssistantEditor
                key={session}
                label="短剧消息"
                placeholder="描述短剧需求，/ 插入技能"
                editor={editor}
                message={message}
                mentions={mentions}
                busy={busy}
                running={!!state?.activeRun}
                skills={state?.activeRun ? [] : skillCatalog.skills}
                onText={setMessage}
              />
              <ComposerTools
                models={models}
                modelId={model?.id}
                onModel={setModel}
                events={events}
                locked={locked || !!state?.activeRun}
                canSend={!!canSend && !!message.trim()}
                active={!!state?.activeRun}
                stop={
                  state?.activeRun && !state.approvals.length && !message.trim() ? stop : undefined
                }
                stopDisabled={locked}
                skills={
                  <AssistantSkillMenu
                    catalog={skillCatalog}
                    editor={editor}
                    disabled={locked || !!state?.activeRun}
                    pick={(skill) => editor.current?.insert("skill", skill.id, skill.title)}
                  />
                }
              />
            </WorkspaceAssistantComposer>
          )}
        </>
      )}
    </WorkspaceAssistant>
  );
}
