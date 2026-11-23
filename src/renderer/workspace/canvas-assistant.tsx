import type {
  CanvasAgentAction,
  CanvasAgentValues,
  GenerationJob,
  PluginView,
  ProjectAsset,
  ProjectCanvasView,
  ProviderView,
  SettingsApproval,
} from "@link-studio/core";
import { canvasAgentMediaModels, maxAgentImages } from "@link-studio/core";
import { Download, SquarePen } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { approvedQuoteHasMissing } from "../../../packages/link-studio-core/src/agent-generation-quote";
import { AssistantTimeline } from "../assistant/activity-timeline";
import { approvalTimeline } from "../assistant/approval-timeline";
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
import { AgentMarks } from "./agent-marks";
import { DocumentPreview, DocumentTray, useAssistantDocuments } from "./assistant-documents";
import { AssistantEditor, type AssistantEditorHandle } from "./assistant-editor";
import { CanvasAssistantEmpty } from "./assistant-empty";
import { AssistantFrame } from "./assistant-frame";
import { AssistantHistory } from "./assistant-history";
import { AssistantImageTray, useAssistantImages } from "./assistant-images";
import { MessageAttachments } from "./assistant-message-attachments";
import { type ModelMention, rebaseMentions, serializeModels } from "./assistant-model-mentions";
import { AssistantModelMenu } from "./assistant-model-menu";
import { AssistantQuestionnaire, QuestionRecord } from "./assistant-questionnaire";
import { AssistantSelection } from "./assistant-selection";
import { AssistantSkillMenu, useCanvasSkills } from "./assistant-skill-menu";
import { AssistantUserBubble } from "./assistant-user-bubble";
import { AssistantWatchStrip } from "./assistant-watch";
import { canvasTitleLabel, summarizeWatches } from "./assistant-watch-state";
import { CanvasChangesFooter, canvasRunChanges } from "./canvas-run-changes";
import { GenerationApprovalCard, GenerationRequestDetails } from "./generation-approval-card";
import { GenerationDecisionRow } from "./generation-decision-row";
import { linkKind } from "./link-rules";
import { CanvasPet } from "./pet/canvas-pet";
import type { PetBounds } from "./pet/placement";
import { SettledDivider } from "./settled-divider";

function fields(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

type CanvasDraft = {
  message?: string;
  referenceURL?: string;
  allowWebResearch?: boolean;
  referencePreview?: CanvasAgentValues["previewReference"];
  mentions?: ModelMention[];
  attachmentAssetIds?: string[];
};

function Proposal({
  approval,
  decide,
  busy,
}: {
  approval: SettingsApproval;
  decide: (selected: number[], reason?: string) => void;
  busy: boolean;
}) {
  const payload = fields(approval.payload);
  const items = Array.isArray(payload.items) ? payload.items.map(fields) : [];
  const deletion = approval.kind === "delete" && payload.action === "delete";
  const marks = useContext(AgentMarks);
  useEffect(
    () => () => {
      if (deletion) marks.danger([]);
    },
    [deletion, marks],
  );
  const [selected, setSelected] = useState<number[]>(() =>
    deletion || approval.kind === "generate" ? items.map((_, index) => index) : [],
  );
  if (approval.kind === "generate")
    return (
      <>
        <GenerationApprovalCard items={items} reason={payload.reason} busy={busy} decide={decide} />
        <GenerationRequestDetails items={items} />
      </>
    );
  if (deletion) {
    const edgeCount = Array.isArray(payload.edgeIds) ? payload.edgeIds.length : 0;
    const count = selected.length + (edgeCount ? edgeCount - 1 : 0);
    return (
      <section
        className="settings-confirm"
        onMouseEnter={() =>
          marks.danger(
            items.flatMap((item) => (typeof item.node_id === "string" ? [item.node_id] : [])),
          )
        }
        onMouseLeave={() => marks.danger([])}
      >
        <h3>申请删除</h3>
        <p>{String(payload.reason)}</p>
        {items.map((item, index) =>
          item.edges ? (
            <p key="edges">同时删除 {edgeCount} 条指定连线</p>
          ) : (
            <label key={String(item.node_id)} className="generation-choice">
              <input
                type="checkbox"
                aria-label={`删除「${item.label}」`}
                checked={selected.includes(index)}
                disabled={busy}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, index]
                      : selected.filter((entry) => entry !== index),
                  )
                }
              />
              <span>
                {String(item.label)}
                {item.hasOutput ? <small>含产物</small> : null}
              </span>
            </label>
          ),
        )}
        <div className="settings-actions">
          <button type="button" disabled={busy || !count} onClick={() => decide(selected)}>
            删除 {count} 项
          </button>
          <button type="button" disabled={busy} onClick={() => decide([])}>
            保留
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="settings-confirm">
      <h3>画布变更审批</h3>
      <ol>
        {(Array.isArray(payload.operations) ? payload.operations.map(fields) : []).map(
          (operation) => {
            const item = fields(operation.node ?? operation.edge);
            const data = fields(item.data);
            const shots = Array.isArray(data.storyboard) ? data.storyboard.map(fields) : [];
            return (
              <li key={String(operation.id ?? item.id)}>
                {shots.length ? "分镜表" : String(operation.type)} ·{" "}
                {String(data.label ?? operation.id ?? item.id)}
                {shots.length > 0 && (
                  <details>
                    <summary>预览 {shots.length} 个镜头</summary>
                    <ol>
                      {shots.map((shot) => (
                        <li key={String(shot.id)}>
                          <strong>
                            {[shot.shot, shot.camera, `${shot.duration} 秒`]
                              .filter(Boolean)
                              .join(" · ")}
                          </strong>
                          {shot.scene ? <p>{String(shot.scene)}</p> : null}
                          {shot.action ? <p>动作 · {String(shot.action)}</p> : null}
                          {shot.dialogue ? <p>对白 · {String(shot.dialogue)}</p> : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                <details>
                  <summary>查看操作</summary>
                  <pre>{JSON.stringify(operation, null, 2)}</pre>
                </details>
              </li>
            );
          },
        )}
      </ol>
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => decide([])}>
          拒绝
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(items.map((_, index) => index))}
        >
          应用画布变更
        </button>
      </div>
    </section>
  );
}

export function CanvasAssistant({
  petStage,
  toggle,
  projectHandle,
  canvasName,
  providers,
  plugins,
  selection,
  nodes,
  assets,
  visible,
  close,
  openSettings,
  locateNode,
  locateResults,
  canvasRevision,
  beforeWrite,
  jobs,
  openJobs,
}: {
  projectHandle: string;
  canvasName: string | null;
  petStage: HTMLElement | null;
  toggle: () => void;
  providers: ProviderView[];
  plugins: PluginView[];
  selection: { id: string; label: string }[];
  nodes: ProjectCanvasView["nodes"];
  assets: ProjectAsset[];
  visible: boolean;
  close: () => void;
  openSettings: () => void;
  locateNode: (id: string) => void;
  locateResults: (ids: string[]) => void;
  canvasRevision?: number;
  beforeWrite: () => Promise<boolean>;
  jobs: GenerationJob[];
  openJobs: () => void;
}) {
  const [sessionId, setSessionId] = useState("");
  const marks = useContext(AgentMarks);
  useEffect(() => {
    if (!visible) marks.danger([]);
  }, [marks, visible]);
  const [peek, setPeek] = useState<HTMLSpanElement | null>(null);
  const [petBounds, setPetBounds] = useState<PetBounds>();
  const editor = useRef<AssistantEditorHandle>(null);
  const [sessions, setSessions] = useState<CanvasAgentValues["list"]>([]);
  const [providerId, setProviderId] = useAssistantModelPreference();
  const [drafts, setDrafts] = useState<Record<string, CanvasDraft>>({});
  const skillCatalog = useCanvasSkills(visible);
  const canvasSkills = skillCatalog.skills;
  const {
    message = "",
    referenceURL = "",
    allowWebResearch = false,
    referencePreview,
    mentions = [],
    attachmentAssetIds = [],
  } = drafts[sessionId] ?? {};
  const changeDraft = (next: CanvasDraft, caret?: number) =>
    setDrafts((previous) => {
      const draft = previous[sessionId] ?? {};
      const rebased =
        next.message !== undefined && !next.mentions
          ? {
              mentions: rebaseMentions(
                draft.mentions ?? [],
                draft.message ?? "",
                next.message,
                caret,
              ),
            }
          : {};
      return { ...previous, [sessionId]: { ...draft, ...rebased, ...next } };
    });
  const [error, setError] = useState("");
  const [referenceError, setReferenceError] = useState("");
  const { busy, run } = useAssistantAction(setError);
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState("");
  const [offerNotifications, setOfferNotifications] = useState(false);
  const permissionRequest = useRef(0);
  useEffect(() => {
    setOfferNotifications(false);
    const sync = () =>
      window.desktop.canvasWindow.setNoticeCanvas(
        canvasName !== null ? projectHandle : null,
        document.hidden,
      );
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      permissionRequest.current++;
      document.removeEventListener("visibilitychange", sync);
      window.desktop.canvasWindow.setNoticeCanvas(null, false);
    };
  }, [projectHandle, canvasName]);
  const notificationChoice = async (allow?: boolean) => {
    const request = ++permissionRequest.current;
    try {
      const result = await window.desktop.settings.agentNoticePermission(
        allow === undefined ? {} : { allow },
      );
      if (permissionRequest.current === request)
        setOfferNotifications(result.ok && result.value.permission === "default");
    } catch {
      if (permissionRequest.current === request) setOfferNotifications(false);
    }
  };
  const images = useAssistantImages(projectHandle, sessionId, attachmentAssetIds.length, setNotice);
  const documents = useAssistantDocuments(projectHandle, sessionId, setNotice);
  const [openDocument, setOpenDocument] = useState<CanvasAgentValues["readDocument"]>();
  const imageIds = [...new Set([...attachmentAssetIds, ...images.items.map((item) => item.id)])];
  const models = providers.filter(
    ({ enabled, channelEnabled, agentEnabled, hasSecret }) =>
      enabled && channelEnabled !== false && agentEnabled && hasSecret,
  );
  const model = models.find(({ id }) => id === providerId) ?? models[0];
  const mediaModels = canvasAgentMediaModels({ providers, plugins });
  const canvasNodes = new Map(nodes.map((node) => [node.id, node]));
  const selectedReferences = selection.flatMap(({ id }) => {
    const node = canvasNodes.get(id);
    if (!node || node.type === "unknown") return [];
    const kind = node.type === "group" ? "group" : linkKind(node.data);
    if (kind === "director") return [];
    const labels = {
      group: "节点组",
      script: "文本节点",
      image: "图片节点",
      video: "视频节点",
      audio: "音频节点",
      character: "角色卡节点",
      storyboard: "分镜表节点",
    };
    return [{ id, label: node.data.label.trim() || labels[kind], kind }];
  });
  const scriptReferences = selectedReferences.filter(({ id }) => {
    const node = canvasNodes.get(id);
    return (
      node?.type === "creative" &&
      node.data.kind === "script" &&
      !node.data.storyboard &&
      !node.data.director &&
      !!node.data.text.trim()
    );
  });
  const invoke = useCallback(
    async <Action extends CanvasAgentAction>(action: Action) => {
      const response = await window.desktop.projects.canvasAgent({ projectHandle, action });
      if (!response.ok) {
        if (response.error.code === "AGENT_MESSAGE_REFERENCE_INVALID") {
          setReferenceError(response.error.message ?? "消息中的引用已不可用");
        }
        setError(response.error.code);
        return;
      }
      return response.value as CanvasAgentValues[Action["method"]];
    },
    [projectHandle],
  );
  useEffect(() => {
    if (listState !== "loading") return;
    let current = true;
    const failed = (code: string) => {
      if (!current) return;
      setListState("failed");
      setError(code);
    };
    void window.desktop.projects.canvasAgent({ projectHandle, action: { method: "list" } }).then(
      (result) => {
        if (!current) return;
        if (!result.ok) return failed(result.error.code);
        const list = result.value as CanvasAgentValues["list"];
        setSessions(list);
        setSessionId(list[0]?.id ?? "");
        setListState("ready");
      },
      () => failed("AGENT_STATE_UNAVAILABLE"),
    );
    return () => {
      current = false;
    };
  }, [projectHandle, listState]);
  const readCanvasSession = useCallback(
    async (sessionId: string, after: number, before?: number) => {
      const result = await window.desktop.projects.canvasAgent({
        projectHandle,
        action: { method: "state", sessionId, after, before },
      });
      return result.ok
        ? { ok: true as const, value: result.value as CanvasAgentValues["state"] }
        : { ok: false as const, code: result.error.code };
    },
    [projectHandle],
  );
  const { events, state, readError, refreshSession, history, recordFeedback } = useAssistantSession(
    sessionId,
    readCanvasSession,
  );
  const title = state?.title;
  const steers = useSteers(events);
  const approvals = approvalTimeline(events, state?.approvals ?? []);
  const changesByRun = useMemo(() => canvasRunChanges(events), [events]);
  const watch = summarizeWatches(state?.watches ?? []);
  const titleLabel =
    canvasName === null ? null : canvasTitleLabel(canvasName, !!state?.approvals.length, watch);
  useEffect(() => {
    if (titleLabel === null) return;
    const previousTitle = document.title;
    const windowTitle = `${titleLabel} - ${previousTitle}`;
    document.title = windowTitle;
    return () => {
      if (document.title === windowTitle) document.title = previousTitle;
    };
  }, [titleLabel]);
  const receipts = useRef({
    sessionId: "",
    since: Date.now(),
    seq: 0,
    pending: new Map<string, number>(),
  });
  useEffect(() => {
    if (receipts.current.sessionId !== sessionId)
      receipts.current = { sessionId, since: Date.now(), seq: 0, pending: new Map() };
    const cursor = receipts.current;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (!event || event.seq <= cursor.seq) break;
      if (!event.createdAt || event.createdAt < cursor.since) continue;
      const payload = fields(event.payload),
        result = fields(payload.result);
      const wrote =
        event.type === "tool.end" &&
        payload.is_error === false &&
        ["canvas_apply_ops", "canvas_arrange", "canvas_capture_frame"].includes(
          String(payload.name),
        );
      const approved =
        event.type === "approval.decided" &&
        ["executed", "partially_approved"].includes(String(payload.status));
      if (
        !(wrote || approved) ||
        !Array.isArray(result.nodeIds) ||
        typeof result.revision !== "number"
      )
        continue;
      for (const id of result.nodeIds)
        if (typeof id === "string")
          cursor.pending.set(id, Math.max(cursor.pending.get(id) ?? 0, result.revision));
    }
    cursor.seq = Math.max(cursor.seq, events.at(-1)?.seq ?? 0);
    const ready: string[] = [];
    for (const [id, revision] of cursor.pending)
      if (canvasRevision !== undefined && canvasRevision >= revision) {
        cursor.pending.delete(id);
        if (nodes.some((node) => node.id === id)) ready.push(id);
      }
    if (ready.length) marks.touch(ready);
  }, [sessionId, events, nodes, canvasRevision, marks]);
  useEffect(() => {
    if (title)
      setSessions((current) =>
        current.map((entry) =>
          entry.id === sessionId && entry.title !== title ? { ...entry, title } : entry,
        ),
      );
  }, [sessionId, title]);
  const selectSession = (id: string) => {
    setError("");
    setNotice("");
    setSessionId(id);
  };
  const loading = listState === "loading" || (!!sessionId && !state && !readError);
  const blocked = busy || loading || !!readError || listState !== "ready";
  const pendingQuestion = state?.approvals.find((approval) => approval.kind === "ask");
  const canSend =
    !blocked &&
    !state?.otherActiveSession &&
    (!imageIds.length || model?.agentVision === true) &&
    images.items.every((item) => item.status === "done") &&
    documents.items.every((item) => item.documentId) &&
    (state?.activeRun
      ? ["running", "waiting_approval"].includes(state.activeStatus ?? "") ||
        (state.activeStatus === "waiting_input" && !!pendingQuestion)
      : !!model);
  const create = async () => {
    const response = await invoke({ method: "create" });
    if (response) {
      setSessionId(response.sessionId);
      setSessions((previous) => [{ id: response.sessionId, title: "新对话" }, ...previous]);
      return response.sessionId;
    }
  };
  const withWrite = (action: () => Promise<void>, save = true) =>
    run(async () => {
      setNotice("");
      if (!save || (await beforeWrite())) {
        await action();
        await refreshSession();
      } else {
        setError("AGENT_CANVAS_SAVE_REQUIRED");
      }
    });
  const send = () => {
    if (!canSend || !message.trim()) return;
    const prompt = serializeModels(message, mentions).trim();
    if (prompt.length > 24000) {
      setError("AGENT_ARGUMENT_INVALID");
      return;
    }
    return withWrite(async () => {
      const target = sessionId || (await create());
      if (!target) return;
      if (state?.activeRun && pendingQuestion) {
        const skipped = await invoke({
          method: "answer",
          sessionId: target,
          approvalId: pendingQuestion.id,
        });
        if (!skipped?.decided) return;
      }
      const result = await invoke({
        method: "send",
        sessionId: target,
        providerId: model?.id ?? "active-run",
        message: prompt,
        selection: [],
        ...(!state?.activeRun && referenceURL.trim() && { referenceURL: referenceURL.trim() }),
        ...(!state?.activeRun && allowWebResearch && { allowWebResearch: true }),
        ...(!state?.activeRun &&
          referencePreview && { referenceFingerprint: referencePreview.fingerprint }),
        ...(imageIds.length && { attachmentAssetIds: imageIds }),
        ...(!state?.activeRun &&
          documents.items.length && {
            documentIds: documents.items.flatMap((item) => item.documentId ?? []),
          }),
        ...(state?.activeRun ? { runId: state.activeRun } : {}),
      });
      if (result) {
        images.clear(sessionId);
        if (!state?.activeRun) documents.clear(sessionId);
        changeDraft({
          message: "",
          ...(!state?.activeRun && { referenceURL: "", referencePreview: undefined }),
          ...(!state?.activeRun && { allowWebResearch: false }),
          attachmentAssetIds: [],
        });
      }
    }, !state?.activeRun);
  };
  const resumable = events.findLast(({ type }) => type === "run.status");
  const stop = () => {
    const runId = state?.activeRun;
    if (blocked || !runId) return;
    void withWrite(async () => {
      await invoke({ method: "stop", sessionId, runId });
    }, false);
  };
  const exportDiagnostics = (runId: string) =>
    void withWrite(async () => {
      const result = await invoke({ method: "exportDiagnostics", sessionId, runId });
      if (result?.exported) setNotice("已导出运行诊断。");
    }, false);
  const renderPending = (approval: SettingsApproval) => (
    <section key={approval.id} className="assistant-approvals" aria-label="待处理请求">
      {approval.kind === "ask" ? (
        <AssistantQuestionnaire
          quickChoices
          payload={approval.payload}
          busy={blocked}
          models={mediaModels}
          onAnswer={(answers) =>
            void withWrite(async () => {
              await invoke({
                method: "answer",
                sessionId,
                approvalId: approval.id,
                ...(answers && { answers }),
              });
            }, false)
          }
        />
      ) : (
        <Proposal
          approval={approval}
          busy={blocked}
          decide={(selected, answer) => {
            if (approval.kind === "generate" && selected.length) void notificationChoice();
            void withWrite(async () => {
              await invoke({
                method: "decide",
                sessionId,
                approvalId: approval.id,
                selected,
                ...(answer && { answer }),
              });
            }, selected.length > 0);
          }}
        />
      )}
    </section>
  );
  const panel = (
    <AssistantFrame
      visible={visible}
      close={close}
      bounds={petBounds}
      preferences={
        state?.activeRun && (
          <button
            type="button"
            disabled={blocked}
            onClick={() => exportDiagnostics(state.activeRun!)}
          >
            导出运行诊断
          </button>
        )
      }
    >
      {(controls) => (
        <section
          className="assistant-surface canvas-assistant"
          aria-label="画布小灵"
          hidden={!visible}
          onKeyDown={(event) => {
            if (
              event.key !== "Escape" ||
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.repeat ||
              blocked ||
              !state?.activeRun ||
              state.approvals.length ||
              message.trim()
            )
              return;
            if (
              !event.currentTarget.contains(event.target as Node) ||
              document.querySelector(":popover-open,dialog[open],select:open")
            )
              return;
            event.preventDefault();
            stop();
          }}
        >
          <header className="assistant-heading">
            <span className="assistant-header-orb" aria-hidden="true" />
            <AssistantHistory
              key={sessionId}
              rename={(next) =>
                void run(async () => {
                  const result = await invoke({ method: "rename", sessionId, title: next });
                  if (result) {
                    setSessions((current) =>
                      current.map((entry) =>
                        entry.id === sessionId ? { ...entry, title: result.title } : entry,
                      ),
                    );
                    await refreshSession();
                  }
                })
              }
              remove={(id) =>
                void run(async () => {
                  const result = await invoke({ method: "remove", sessionId: id });
                  if (!result?.removed) return;
                  images.clear(id);
                  documents.clear(id);
                  const rest = sessions.filter((entry) => entry.id !== id);
                  setSessions(rest);
                  setDrafts((current) => {
                    const remaining = { ...current };
                    delete remaining[id];
                    return remaining;
                  });
                  if (id === sessionId) selectSession(rest[0]?.id ?? "");
                })
              }
              title={
                title ?? sessions.find((session) => session.id === sessionId)?.title ?? "新对话"
              }
              sessions={sessions}
              current={sessionId}
              locked={busy || !!state?.activeRun}
              select={selectSession}
            />
            <button
              type="button"
              aria-label="新对话"
              title="新对话"
              disabled={busy || !!state?.activeRun || listState !== "ready"}
              onClick={() => selectSession("")}
            >
              <SquarePen size={16} />
            </button>
            {controls}
          </header>
          {offerNotifications && (
            <section className="assistant-notice-consent" aria-label="后台生成通知">
              <strong>允许小灵发送系统通知？</strong>
              <p>画布在后台时，有生成待批准或小灵开始验收时提醒你。</p>
              <button type="button" onClick={() => void notificationChoice(true)}>
                允许通知
              </button>
              <button type="button" onClick={() => void notificationChoice(false)}>
                不允许
              </button>
            </section>
          )}
          {watch && (
            <AssistantWatchStrip
              key={sessionId}
              summary={watch}
              busy={busy}
              locate={locateNode}
              cancel={() =>
                void withWrite(async () => {
                  await invoke({ method: "cancelWatches", sessionId });
                }, false)
              }
            />
          )}
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
            sessionId={sessionId}
            label="画布对话与活动"
            empty={
              !events.length &&
              !blocked && (
                <CanvasAssistantEmpty
                  hasModel={!!model}
                  onStarter={(text) => {
                    changeDraft({ message: text });
                    editor.current?.focus();
                  }}
                />
              )
            }
          >
            <AssistantTimeline
              composerPlan
              partial={state?.partial}
              model={model}
              locate={(ids) => {
                const existing = ids.filter((id) => canvasNodes.has(id));
                if (existing[0]) {
                  locateNode(existing[0]);
                  marks.touch(existing);
                }
              }}
              saveFeedback={async (runId, value) => {
                const result = await invoke({ method: "feedback", sessionId, runId, value });
                if (result?.saved) recordFeedback(runId, value);
                return !!result?.saved;
              }}
              renderDiagnostics={(event) =>
                event.seq === resumable?.seq && (
                  <button
                    type="button"
                    title="导出运行诊断"
                    aria-label="导出运行诊断"
                    disabled={blocked}
                    onClick={() => exportDiagnostics(event.runId)}
                  >
                    <Download size={14} />
                  </button>
                )
              }
              renderFooter={(feedback) => {
                const changes = changesByRun.get(feedback.runId);
                if (!changes) return null;
                return (
                  <CanvasChangesFooter
                    changes={changes}
                    feedback={feedback}
                    locked={blocked || !!state?.activeRun}
                    labelOf={(id) => canvasNodes.get(id)?.data.label}
                    locate={locateNode}
                    locateAll={locateResults}
                    undo={async () => {
                      let skipped: number | undefined;
                      await withWrite(async () => {
                        const result = await invoke({
                          method: "undo",
                          sessionId,
                          runId: feedback.runId,
                        });
                        if (result) {
                          skipped = result.skipped.length;
                          setNotice(`已撤销 ${result.reverted} 项，跳过 ${skipped} 项。`);
                        }
                      });
                      return skipped;
                    }}
                  />
                );
              }}
              events={steers.transcript}
              render={(anchor, copyInFooter) => {
                let event = anchor;
                const id = anchor.approvalId;
                if (id && anchor.type === "approval.created") {
                  if (approvals.anchors.get(id) !== anchor.seq) return null;
                  const outcome = approvals.decisions.get(id);
                  if (outcome) event = outcome;
                  else {
                    const pending = approvals.active.get(id);
                    if (pending) return renderPending(pending);
                    const data = fields(anchor.payload);
                    const request = fields(data.payload);
                    if (
                      data.kind === "generate" &&
                      Array.isArray(request.items) &&
                      approvals.closedRuns.has(anchor.runId)
                    )
                      return (
                        <GenerationDecisionRow
                          key={anchor.seq}
                          status="expired"
                          count={request.items.length}
                        />
                      );
                    const label =
                      data.kind === "ask"
                        ? "提问"
                        : data.kind === "delete"
                          ? "删除请求"
                          : "画布请求";
                    return (
                      <p key={anchor.seq} className="assistant-activity">
                        {label}（不可操作）
                      </p>
                    );
                  }
                }
                if (
                  id &&
                  anchor.type === "approval.decided" &&
                  (approvals.anchors.has(id) || approvals.decisions.get(id) !== anchor)
                )
                  return null;
                const payload = fields(event.payload);
                if (event.type === "run.status") {
                  const canResume =
                    !blocked &&
                    !state?.activeRun &&
                    !state?.otherActiveSession &&
                    event.seq === resumable?.seq;
                  const resume = (addBudget?: number) =>
                    void withWrite(async () => {
                      await invoke({
                        method: "continue",
                        sessionId,
                        runId: event.runId,
                        ...(addBudget && { addBudget }),
                      });
                    });
                  return (
                    <RunStatusCard
                      key={event.seq}
                      data={payload}
                      resume={
                        canResume && showsContinue(payload.status) ? () => resume() : undefined
                      }
                      addBudget={
                        canResume && payload.status === "budget_exhausted"
                          ? () => resume(20)
                          : undefined
                      }
                    />
                  );
                }
                if (event.type === "steer.read" || event.type === "steer.dropped") return null;
                const dropped = steers.missed.get(event.seq);
                const result = fields(payload.result);
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
                      {dropped !== undefined && (
                        <MissedSteer
                          resend={
                            canSend && !state?.activeRun && model && dropped >= steers.lastUser
                              ? () =>
                                  void withWrite(async () => {
                                    const ids = Array.isArray(payload.attachments)
                                      ? payload.attachments
                                          .map(fields)
                                          .map((item) => String(item.asset_id))
                                      : [];
                                    await invoke({
                                      method: "send",
                                      sessionId,
                                      message: String(payload.text),
                                      providerId: model.id,
                                      selection: [],
                                      ...(ids.length && { attachmentAssetIds: ids }),
                                    });
                                  })
                              : undefined
                          }
                        />
                      )}
                      {Array.isArray(payload.selection) && (
                        <AssistantSelection
                          ids={payload.selection.filter(
                            (id): id is string => typeof id === "string",
                          )}
                          nodes={canvasNodes}
                          locate={locateNode}
                        />
                      )}
                      {Array.isArray(payload.attachments) && (
                        <MessageAttachments
                          items={payload.attachments.map(fields)}
                          projectHandle={projectHandle}
                          openDocument={async (documentId) => {
                            const document = await invoke({ method: "readDocument", documentId });
                            if (document) setOpenDocument(document);
                          }}
                        />
                      )}
                      <AssistantUserBubble text={String(payload.text ?? "")} />
                    </article>
                  );
                if (event.type === "tasks.settled")
                  return (
                    <SettledDivider
                      key={event.seq}
                      steer={payload.steer === true}
                      receiptOnly={payload.receipt_only === true}
                    >
                      {Array.isArray(payload.tasks) &&
                        payload.tasks.map(fields).map((task) => {
                          const job = jobs.find(({ id }) => id === task.task_id);
                          const nodeId = String(task.node_id ?? "");
                          return (
                            <p key={String(task.task_id)}>
                              {String(task.label)} ·{" "}
                              {job?.status === "outcome_unknown" ||
                              task.task_status === "outcome_unknown"
                                ? "结果未知"
                                : task.task_status === "succeeded"
                                  ? "已完成"
                                  : "未成功"}
                              {canvasNodes.has(nodeId) && (
                                <button type="button" onClick={() => locateNode(nodeId)}>
                                  定位节点
                                </button>
                              )}
                            </p>
                          );
                        })}
                      <button type="button" onClick={openJobs}>
                        查看任务结果
                      </button>
                    </SettledDivider>
                  );
                if (event.type === "approval.decided" && payload.kind === "ask")
                  return <QuestionRecord key={event.seq} payload={payload} providers={providers} />;
                if (event.type === "approval.decided" && payload.kind === "generate") {
                  const items = fields(payload.payload).items,
                    decision = fields(payload.decision);
                  if (Array.isArray(items))
                    return (
                      <GenerationDecisionRow
                        key={event.seq}
                        status={payload.status}
                        count={items.length}
                        credits={payload.quote_credits}
                        partialQuote={approvedQuoteHasMissing(items, decision.items)}
                        answer={typeof decision.answer === "string" ? decision.answer : undefined}
                      />
                    );
                }
                if (event.type === "approval.decided" && Array.isArray(result.tasks))
                  return (
                    <p key={event.seq} className="assistant-activity">
                      已提交 {result.tasks.length} 项生成任务。
                    </p>
                  );
                return (
                  <Activity
                    key={event.seq}
                    event={event}
                    copyInFooter={copyInFooter}
                    resolveJump={({ type, key }) =>
                      type === "node" && key && canvasNodes.has(key)
                        ? () => locateNode(key)
                        : undefined
                    }
                  />
                );
              }}
            />
            {approvals.unplaced.map(renderPending)}
            <AssistantCompactionStatus state={state} events={events} />
            <AssistantStatus
              state={state}
              events={events}
              showStop={!blocked && !message.trim() && !state?.approvals.length}
              busy={busy}
              stale={!!readError || listState === "failed"}
              opening={
                listState === "loading" ||
                history.phase === "latest" ||
                history.phase === "latest-error"
              }
            />
          </AssistantTranscript>
          {(error || (readError && history.phase !== "latest-error")) && (
            <p role="alert" className="error">
              {error === "AGENT_MESSAGE_REFERENCE_INVALID"
                ? referenceError
                : settingsError(error || readError || "")}
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
          {notice && (
            <p className="assistant-notice" role="status">
              {notice}
            </p>
          )}
          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <span ref={setPeek} className="pet-peek" aria-hidden="true" />
            <RunPlanStrip key={`plan-${sessionId}`} events={events} activeRun={state?.activeRun} />
            {steers.waiting.length > 0 && (
              <SteerTray key={`steers-${sessionId}`} waiting={steers.waiting} />
            )}
            {!state?.activeRun && !message.trim() && scriptReferences.length > 0 && (
              <button
                type="button"
                disabled={blocked}
                onClick={() => {
                  let prefix = "";
                  const mentions = scriptReferences.map(({ id, label, kind }) => {
                    const start = prefix.length;
                    prefix += `@${label} `;
                    return {
                      start,
                      end: prefix.length - 1,
                      id,
                      name: label,
                      kind: "node" as const,
                      nodeKind: kind,
                    };
                  });
                  changeDraft({
                    message:
                      prefix +
                      "请读取我引用的剧本，按叙事顺序拆成镜头，写出画面、景别、运镜、动作、对白和预计时长。新建一张分镜表，从原剧本连线到分镜表，保留原剧本和已有分镜表。",
                    mentions,
                  });
                }}
              >
                从引用剧本拆分镜
              </button>
            )}
            <AssistantImageTray images={images} vision={model?.agentVision === true} />
            <DocumentTray documents={documents} />
            {openDocument && (
              <DocumentPreview document={openDocument} close={() => setOpenDocument(undefined)} />
            )}
            <AssistantEditor
              key={sessionId}
              editor={editor}
              message={message}
              mentions={mentions}
              busy={busy}
              running={Boolean(state?.activeRun)}
              onImages={blocked ? undefined : images.add}
              selection={selectedReferences}
              nodes={nodes
                .filter((node) => node.type === "creative" && !node.data.director)
                .map((node) => ({
                  id: node.id,
                  title: node.data.label,
                  nodeKind: node.type === "creative" ? linkKind(node.data) : undefined,
                }))}
              skills={state?.activeRun ? [] : canvasSkills}
              onText={(message, mentions) => changeDraft({ message, mentions })}
            />
            {referenceURL && !state?.activeRun && (
              <div className="composer-attachment">
                <span title={referenceURL}>{referenceURL}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => changeDraft({ referenceURL: "", referencePreview: undefined })}
                >
                  移除链接
                </button>
              </div>
            )}
            {allowWebResearch && !state?.activeRun && (
              <div className="composer-attachment">
                <span>本轮联网检索</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => changeDraft({ allowWebResearch: false })}
                >
                  移除联网授权
                </button>
              </div>
            )}
            <ComposerTools
              models={models}
              modelId={model?.id}
              onModel={setProviderId}
              openSettings={openSettings}
              events={events}
              locked={blocked || Boolean(state?.activeRun)}
              attachmentsLocked={blocked}
              canSend={canSend && !!message.trim()}
              active={Boolean(state?.activeRun)}
              stop={state?.activeRun && !message.trim() ? stop : undefined}
              stopDisabled={blocked}
              attachments={
                <>
                  <fieldset className="assistant-asset-picker">
                    <legend>项目素材</legend>
                    <label>
                      上传故事或剧本
                      <input
                        type="file"
                        accept=".txt,.md,.markdown"
                        disabled={!!state?.activeRun}
                        multiple
                        onChange={({ currentTarget }) => {
                          if (currentTarget.files) documents.add(currentTarget.files);
                          currentTarget.value = "";
                        }}
                      />
                    </label>
                    <label>
                      上传图片
                      <input
                        type="file"
                        multiple
                        accept="image/png,image/jpeg,image/webp"
                        onChange={({ currentTarget }) => {
                          if (currentTarget.files) images.add(currentTarget.files);
                          currentTarget.value = "";
                        }}
                      />
                    </label>
                    {assets.filter(
                      ({ mediaType }) => mediaType === "image" || mediaType === "video",
                    ).length ? (
                      assets
                        .filter(({ mediaType }) => mediaType === "image" || mediaType === "video")
                        .map((asset) => (
                          <label key={asset.assetId}>
                            <input
                              type="checkbox"
                              checked={imageIds.includes(asset.assetId)}
                              disabled={
                                busy ||
                                images.items.some((item) => item.id === asset.assetId) ||
                                (!attachmentAssetIds.includes(asset.assetId) &&
                                  imageIds.length >= maxAgentImages) ||
                                asset.availability !== "ready"
                              }
                              onChange={({ target }) =>
                                changeDraft({
                                  attachmentAssetIds: target.checked
                                    ? [...attachmentAssetIds, asset.assetId]
                                    : attachmentAssetIds.filter((id) => id !== asset.assetId),
                                })
                              }
                            />
                            {asset.mediaType === "image" ? "图片" : "视频首帧"} ·{" "}
                            {asset.displayName}
                          </label>
                        ))
                    ) : (
                      <small>先将图片或视频导入当前项目，才能作为附件发送。</small>
                    )}
                    {!!attachmentAssetIds.length && (
                      <small>
                        已选择 {imageIds.length}/{maxAgentImages} 个附件。
                        {model?.agentVision === true
                          ? "当前模型支持视觉输入。"
                          : "当前模型未开启视觉输入，需切换模型后发送。"}
                      </small>
                    )}
                  </fieldset>
                  <label>
                    <input
                      type="checkbox"
                      checked={allowWebResearch}
                      disabled={busy || !!state?.activeRun}
                      onChange={({ target }) => changeDraft({ allowWebResearch: target.checked })}
                      aria-describedby="canvas-web-hint"
                    />
                    允许本轮联网检索
                  </label>
                  <small id="canvas-web-hint">
                    小灵可向维基百科发送公开关键词，并读取公开网页。
                  </small>
                  <label>
                    公开文本链接
                    <input
                      type="url"
                      value={referenceURL}
                      maxLength={2048}
                      readOnly={busy || !!state?.activeRun}
                      onChange={(event) =>
                        changeDraft({
                          referenceURL: event.target.value,
                          referencePreview: undefined,
                        })
                      }
                      placeholder="https://…"
                      aria-describedby="canvas-reference-hint"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!referenceURL.trim() || busy || !!state?.activeRun}
                    onClick={() =>
                      void run(async () => {
                        changeDraft({ referencePreview: undefined });
                        const result = await invoke({
                          method: "previewReference",
                          url: referenceURL.trim(),
                        });
                        if (result) changeDraft({ referencePreview: result });
                      })
                    }
                  >
                    预览链接内容
                  </button>
                  {referencePreview && <pre>{referencePreview.text || "（空文档）"}</pre>}
                  <small id="canvas-reference-hint" className="muted">
                    支持公开的 HTTPS 纯文本或 Markdown
                    链接。发送消息时，小灵会读取链接内容并随消息发给所选模型。
                  </small>
                </>
              }
              media={
                visible && (
                  <AssistantModelMenu
                    models={mediaModels.map((entry) => ({
                      ...entry,
                      vendor: plugins.find((plugin) => plugin.hash === entry.provider.pluginHash)
                        ?.vendor,
                    }))}
                    pick={(provider) =>
                      editor.current?.insert(
                        "model",
                        provider.id,
                        provider.config?.name || provider.model,
                      )
                    }
                    disabled={blocked || !!state?.activeRun}
                  />
                )
              }
              skills={
                visible && (
                  <AssistantSkillMenu
                    catalog={skillCatalog}
                    editor={editor}
                    disabled={blocked || !!state?.activeRun}
                    pick={(skill) => editor.current?.insert("skill", skill.id, skill.title)}
                  />
                )
              }
            />
            <div className="settings-actions">
              <small className="sr-only" id="canvas-assistant-shortcut">
                回车发送 · Shift＋回车换行
              </small>
            </div>
          </form>
        </section>
      )}
    </AssistantFrame>
  );
  return (
    <>
      {panel}
      {petStage && (
        <CanvasPet
          stage={petStage}
          onBounds={setPetBounds}
          peek={peek}
          toggle={toggle}
          open={visible}
          runId={state?.activeRun}
          pending={state?.approvals[0]}
          available={!!model}
          jobs={jobs}
          locateResults={locateResults}
          ended={
            resumable && {
              runId: resumable.runId,
              status: String(fields(resumable.payload).status),
            }
          }
        />
      )}
    </>
  );
}
