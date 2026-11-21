import type {
  CanvasAgentAction,
  CanvasAgentValues,
  GenerationJob,
  PluginView,
  ProjectAsset,
  ProjectCanvasView,
  ProviderView,
  SettingsApproval,
  SkillItem,
} from "@link-studio/core";
import { canvasAgentMediaModels } from "@link-studio/core";
import { useCallback, useEffect, useState } from "react";
import {
  AssistantHeading,
  AssistantStatus,
  AssistantTranscript,
  submitShortcut,
} from "../assistant/assistant-panel";
import { ComposerTools } from "../assistant/composer-tools";
import { useAssistantAction, useAssistantSession } from "../assistant/use-assistant-session";
import { Activity } from "../settings/settings-assistant";
import { settingsError } from "../settings/settings-page";
import { AssistantQuestionnaire } from "./assistant-questionnaire";

function fields(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

type CanvasDraft = {
  message?: string;
  referenceURL?: string;
  allowWebResearch?: boolean;
  referencePreview?: CanvasAgentValues["previewReference"];
  excluded?: string[];
  pins?: { id: string; label: string }[];
  mediaId?: string;
  skills?: string[];
  attachmentAssetIds?: string[];
};

function Proposal({
  approval,
  decide,
  busy,
}: {
  approval: SettingsApproval;
  decide: (selected: number[]) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const payload = fields(approval.payload);
  const items = Array.isArray(payload.items) ? payload.items.map(fields) : [];
  const generation = approval.kind === "generate";
  return (
    <section className="settings-confirm">
      <h3>{generation ? "生成审批" : "画布变更审批"}</h3>
      {generation ? (
        <>
          <p>确认所选任务的端点和出站内容。供应商可能计费。</p>
          {items.map((item, index) => {
            const request = fields(item.request);
            const references = Array.isArray(request.referenceAssetIds)
              ? request.referenceAssetIds
              : [];
            return (
              <label key={String(item.node_id)} className="generation-choice">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.includes(index)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, index]
                        : selected.filter((entry) => entry !== index),
                    )
                  }
                />
                <span>
                  <strong>{String(item.label)}</strong> · {String(item.model)}
                  <small>{String(item.endpoint)}</small>
                  <small>
                    {String(request.prompt)}
                    {references.length ? ` · 参考素材 ${references.join("、")}` : ""}
                  </small>
                </span>
              </label>
            );
          })}
        </>
      ) : (
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
      )}
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => decide([])}>
          拒绝
        </button>
        <button
          type="button"
          disabled={busy || (generation && !selected.length)}
          onClick={() => decide(generation ? selected : items.map((_, index) => index))}
        >
          {generation ? "批准所选生成" : "应用画布变更"}
        </button>
      </div>
    </section>
  );
}

export function CanvasAssistant({
  projectHandle,
  providers,
  plugins,
  selection,
  nodes,
  assets,
  visible,
  openSettings,
  locateNode,
  beforeWrite,
  jobs,
  openJobs,
}: {
  projectHandle: string;
  providers: ProviderView[];
  plugins: PluginView[];
  selection: { id: string; label: string }[];
  nodes: ProjectCanvasView["nodes"];
  assets: ProjectAsset[];
  visible: boolean;
  openSettings: () => void;
  locateNode: (id: string) => void;
  beforeWrite: () => Promise<boolean>;
  jobs: GenerationJob[];
  openJobs: () => void;
}) {
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<CanvasAgentValues["list"]>([]);
  const [providerId, setProviderId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, CanvasDraft>>({});
  const [agentSkills, setAgentSkills] = useState<SkillItem[]>([]);
  const {
    message = "",
    referenceURL = "",
    allowWebResearch = false,
    referencePreview,
    excluded = [],
    pins = [],
    mediaId = "",
    skills = [],
    attachmentAssetIds = [],
  } = drafts[sessionId] ?? {};
  const changeDraft = (next: CanvasDraft) =>
    setDrafts((previous) => ({ ...previous, [sessionId]: { ...previous[sessionId], ...next } }));
  const [error, setError] = useState("");
  const { busy, run } = useAssistantAction(setError);
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState("");
  const models = providers.filter(
    ({ enabled, channelEnabled, agentEnabled, hasSecret }) =>
      enabled && channelEnabled !== false && agentEnabled && hasSecret,
  );
  const model = models.find(({ id }) => id === providerId) ?? models[0];
  const mediaModels = canvasAgentMediaModels({ providers, plugins });
  const mediaModel = mediaModels.find(({ provider }) => provider.id === mediaId);
  const canvasNodes = new Map(nodes.map((node) => [node.id, node]));
  const referenceLabel = (id: string, fallback: string) => {
    const node = canvasNodes.get(id);
    if (!node) return `${fallback}（已缺失）`;
    if (node.type === "unknown") return `${node.data.label}（不支持）`;
    if (node.type === "group") return `${node.data.label}（分组）`;
    return node.data.label;
  };
  const references = [
    ...new Map(
      [...selection, ...pins]
        .filter(({ id }) => !excluded.includes(id))
        .map((entry) => [entry.id, entry]),
    ).values(),
  ].slice(0, 20);
  const scriptReferences = references.filter(({ id }) => {
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
        setError(response.error.code);
        return;
      }
      return response.value as CanvasAgentValues[Action["method"]];
    },
    [projectHandle],
  );
  useEffect(() => {
    if (!visible || listState !== "loading") return;
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
  }, [projectHandle, visible, listState]);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    void window.desktop.skills.list({}).then((result) => {
      if (!current || !result.ok) return;
      setAgentSkills(
        result.value.filter(
          (skill) => skill.enabled && skill.scopes.includes("agent") && skill.activeVersion > 0,
        ),
      );
    });
    return () => {
      current = false;
    };
  }, [visible]);
  const readCanvasSession = useCallback(
    async (sessionId: string, after: number) => {
      const result = await window.desktop.projects.canvasAgent({
        projectHandle,
        action: { method: "state", sessionId, after },
      });
      return result.ok
        ? { ok: true as const, value: result.value as CanvasAgentValues["state"] }
        : { ok: false as const, code: result.error.code };
    },
    [projectHandle],
  );
  const { events, state, readError, refreshSession } = useAssistantSession(
    sessionId,
    readCanvasSession,
    visible,
  );
  const title = state?.title;
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
  const canSend =
    !blocked &&
    !state?.otherActiveSession &&
    (!attachmentAssetIds.length || model?.agentVision === true) &&
    (state?.activeRun
      ? ["running", "waiting_approval"].includes(state.activeStatus ?? "")
      : !!model);
  const canvasSkills = agentSkills.map((skill) => ({
    id: `${skill.name}@${skill.activeVersion}`,
    title: skill.title,
    summary:
      skill.versions.find(({ version }) => version === skill.activeVersion)?.description ?? "",
  }));
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
    const preferences = state?.activeRun
      ? []
      : [
          ...(mediaModel
            ? [
                `生成偏好：${mediaModel.kind === "image" ? "图片" : "视频"}模型 ${mediaModel.provider.model} · ${mediaModel.provider.label}（绑定 ${mediaModel.provider.id}）。需要生成时使用此绑定并先申请审批。`,
              ]
            : []),
          ...skills
            .filter((id) => canvasSkills.some((skill) => skill.id === id))
            .map((id) => `使用内置技能 ${id}，先通过 skill_read 读取。`),
        ];
    const prompt = [...preferences, message.trim()].join("\n\n");
    if (prompt.length > 24000) {
      setError("AGENT_ARGUMENT_INVALID");
      return;
    }
    return withWrite(async () => {
      const target = sessionId || (await create());
      if (!target) return;
      const result = await invoke({
        method: "send",
        sessionId: target,
        providerId: model?.id ?? "active-run",
        message: prompt,
        selection: references.map(({ id }) => id),
        ...(!state?.activeRun && referenceURL.trim() && { referenceURL: referenceURL.trim() }),
        ...(!state?.activeRun && allowWebResearch && { allowWebResearch: true }),
        ...(!state?.activeRun &&
          referencePreview && { referenceFingerprint: referencePreview.fingerprint }),
        ...(!state?.activeRun && attachmentAssetIds.length && { attachmentAssetIds }),
        ...(state?.activeRun ? { runId: state.activeRun } : {}),
      });
      if (result) {
        changeDraft({
          message: "",
          ...(!state?.activeRun && { referenceURL: "", referencePreview: undefined }),
          ...(!state?.activeRun && { allowWebResearch: false }),
          ...(!state?.activeRun && { attachmentAssetIds: [] }),
        });
      }
    }, !state?.activeRun);
  };
  const resumable = events.findLast(({ type }) => type === "run.status");
  return (
    <section className="assistant-surface canvas-assistant" aria-label="画布小灵" hidden={!visible}>
      <AssistantHeading title="画布小灵">
        <button
          type="button"
          disabled={busy || listState !== "ready"}
          onClick={() =>
            void withWrite(async () => {
              await create();
            }, false)
          }
        >
          新对话
        </button>
      </AssistantHeading>
      <div className="assistant-controls">
        <label>
          画布会话
          <select
            value={sessionId}
            disabled={busy || listState !== "ready"}
            onChange={(event) => selectSession(event.target.value)}
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
      </div>
      <AssistantStatus
        state={state}
        busy={busy}
        stale={!!readError || listState === "failed"}
        loading={loading}
      />
      {resumable && (
        <div className="assistant-context-bar">
          <button
            type="button"
            disabled={blocked}
            onClick={() =>
              void withWrite(async () => {
                const result = await invoke({
                  method: "exportDiagnostics",
                  sessionId,
                  runId: resumable.runId,
                });
                if (result?.exported) setNotice("已导出运行诊断。");
              }, false)
            }
          >
            导出运行诊断
          </button>
        </div>
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
      {!state?.activeRun && !!references.length && (
        <section className="canvas-references" aria-label="将随消息发送的节点">
          {references.map(({ id, label }) => (
            <button
              key={id}
              className="context-chip"
              type="button"
              disabled={busy}
              aria-label={`移除节点引用 ${label}`}
              onClick={() => changeDraft({ excluded: [...excluded, id] })}
            >
              @{referenceLabel(id, label)} ×
            </button>
          ))}
        </section>
      )}
      {!state?.activeRun && selection.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            changeDraft({
              pins: [
                ...new Map([...pins, ...selection].map((entry) => [entry.id, entry])).values(),
              ].slice(0, 20),
              excluded: excluded.filter((id) => !selection.some((node) => node.id === id)),
            });
          }}
        >
          @ 引用选中节点
        </button>
      )}
      <AssistantTranscript
        sessionId={sessionId}
        label="画布对话与活动"
        empty={
          !events.length && !loading && !readError
            ? model
              ? "想创作什么？可以从整理画布、写脚本或生成画面开始。"
              : "启用一个对话模型，就可以和小灵一起创作。"
            : undefined
        }
      >
        {events.map((event) => {
          const payload = fields(event.payload);
          const result = fields(payload.result);
          if (
            event.type === "message.user" &&
            ((Array.isArray(payload.selection) && payload.selection.length) ||
              (Array.isArray(payload.attachments) && payload.attachments.length))
          )
            return (
              <article key={event.seq} className="assistant-message user-message">
                <strong>你</strong>
                <p>{String(payload.text ?? "")}</p>
                <small>
                  {(Array.isArray(payload.selection) ? payload.selection : [])
                    .map((id) => `@${referenceLabel(String(id), String(id))}`)
                    .join(" · ")}
                </small>
                {Array.isArray(payload.attachments) &&
                  payload.attachments
                    .map(fields)
                    .map((item) => (
                      <small key={String(item.asset_id)}>资料 {String(item.name)}</small>
                    ))}
              </article>
            );
          if (event.type === "tasks.settled" && Array.isArray(payload.tasks))
            return (
              <section key={event.seq} className="assistant-message">
                <strong>生成任务已返回</strong>
                {payload.tasks.map(fields).map((task) => {
                  const job = jobs.find(({ id }) => id === task.task_id);
                  const nodeId = String(task.node_id ?? "");
                  return (
                    <p key={String(task.task_id)}>
                      {String(task.label)} ·{" "}
                      {job?.status === "outcome_unknown" || task.task_status === "outcome_unknown"
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
              </section>
            );
          if (event.type === "approval.decided" && payload.kind === "ask") {
            const answers = fields(payload.decision).answers;
            const labels = fields(payload.payload).questions;
            const questions = new Map(
              (Array.isArray(labels) ? labels : [])
                .map(fields)
                .map((question) => [question.id, question]),
            );
            return (
              <section
                key={event.seq}
                className="assistant-message user-message"
                aria-label="小灵提问记录"
              >
                <strong>{payload.status === "rejected" ? "已跳过提问" : "已提交回答"}</strong>
                {Array.isArray(answers) &&
                  answers.map(fields).map(({ id, value }) => {
                    const question = questions.get(id);
                    const chosen =
                      question?.kind === "model"
                        ? providers.find((provider) => provider.id === value)
                        : undefined;
                    return (
                      <p key={String(id)}>
                        {String(question?.label ?? id)}：
                        {chosen
                          ? (chosen.config?.name ?? chosen.model)
                          : Array.isArray(value)
                            ? value.join("、")
                            : String(value)}
                      </p>
                    );
                  })}
              </section>
            );
          }
          if (
            event.type === "approval.decided" &&
            payload.kind === "delete" &&
            payload.status === "executed"
          )
            return (
              <section key={event.seq} className="assistant-activity">
                画布已更新{" "}
                {Array.isArray(result.nodeIds) &&
                  result.nodeIds
                    .map(String)
                    .filter((id) => canvasNodes.has(id))
                    .map((id) => (
                      <button key={id} type="button" onClick={() => locateNode(id)}>
                        定位 {canvasNodes.get(id)?.data.label}
                      </button>
                    ))}
                <button
                  type="button"
                  disabled={busy || Boolean(state?.activeRun)}
                  onClick={() =>
                    void withWrite(async () => {
                      const undo = await invoke({ method: "undo", sessionId, runId: event.runId });
                      if (undo)
                        setNotice(`已撤销 ${undo.reverted} 项，跳过 ${undo.skipped.length} 项。`);
                    })
                  }
                >
                  撤销本轮画布修改
                </button>
              </section>
            );
          if (event.type === "approval.decided" && Array.isArray(result.tasks))
            return (
              <p key={event.seq} className="assistant-activity">
                已提交 {result.tasks.length} 项生成任务。
              </p>
            );
          return <Activity key={event.seq} event={event} />;
        })}
        {state?.partial?.text && (
          <article className="assistant-message" aria-live="off">
            <strong>小灵</strong>
            <p>{state.partial.text}</p>
          </article>
        )}
      </AssistantTranscript>
      {!!state?.approvals.length && (
        <section className="assistant-approvals" aria-label="待处理请求">
          {state.approvals.map((approval) =>
            approval.kind === "ask" ? (
              <AssistantQuestionnaire
                key={approval.id}
                payload={approval.payload}
                busy={blocked}
                models={mediaModels}
                onAnswer={(answers) =>
                  void withWrite(async () => {
                    await invoke({
                      method: "answer",
                      sessionId,
                      approvalId: approval.id,
                      ...(answers ? { answers } : {}),
                    });
                  }, false)
                }
              />
            ) : (
              <Proposal
                key={approval.id}
                approval={approval}
                busy={blocked}
                decide={(selected) =>
                  void withWrite(async () => {
                    await invoke({
                      method: "decide",
                      sessionId,
                      approvalId: approval.id,
                      selected,
                    });
                  }, selected.length > 0)
                }
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
        {!state?.activeRun && !message.trim() && scriptReferences.length > 0 && (
          <button
            type="button"
            disabled={blocked}
            onClick={() =>
              changeDraft({
                message:
                  "请读取我引用的剧本，按叙事顺序拆成镜头，写出画面、景别、运镜、动作、对白和预计时长。新建一张分镜表，通过画布变更审批让我检查。保留原剧本和已有分镜表。",
              })
            }
          >
            从引用剧本拆分镜
          </button>
        )}
        <label>
          画布消息
          <textarea
            value={message}
            maxLength={24000}
            readOnly={busy}
            aria-describedby="canvas-assistant-shortcut"
            onKeyDown={submitShortcut}
            onChange={(event) => changeDraft({ message: event.target.value })}
            rows={3}
            placeholder="描述要排布的节点或要生成的画面"
          />
        </label>
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
        {!state?.activeRun && (mediaModel || skills.length > 0) && (
          <section className="settings-actions" aria-label="已选生成模型和技能">
            {mediaModel && (
              <button
                type="button"
                disabled={busy}
                aria-label={`取消生成模型 ${mediaModel.provider.model}`}
                onClick={() => changeDraft({ mediaId: "" })}
              >
                {mediaModel.provider.model} ×
              </button>
            )}
            {canvasSkills
              .filter(({ id }) => skills.includes(id))
              .map(({ id, title }) => (
                <button
                  type="button"
                  key={id}
                  disabled={busy}
                  aria-label={`移除技能 ${title}`}
                  onClick={() => changeDraft({ skills: skills.filter((skill) => skill !== id) })}
                >
                  {title} ×
                </button>
              ))}
          </section>
        )}
        <ComposerTools
          models={models}
          modelId={model?.id}
          onModel={setProviderId}
          openSettings={openSettings}
          events={events}
          locked={blocked || Boolean(state?.activeRun)}
          canSend={canSend && !!message.trim()}
          active={Boolean(state?.activeRun)}
          attachments={
            <>
              <fieldset className="assistant-asset-picker">
                <legend>项目素材</legend>
                {assets.filter(({ mediaType }) => mediaType === "image" || mediaType === "video")
                  .length ? (
                  assets
                    .filter(({ mediaType }) => mediaType === "image" || mediaType === "video")
                    .map((asset) => (
                      <label key={asset.assetId}>
                        <input
                          type="checkbox"
                          checked={attachmentAssetIds.includes(asset.assetId)}
                          disabled={
                            busy || state?.activeRun !== undefined || asset.availability !== "ready"
                          }
                          onChange={({ target }) =>
                            changeDraft({
                              attachmentAssetIds: target.checked
                                ? [...attachmentAssetIds, asset.assetId].slice(0, 4)
                                : attachmentAssetIds.filter((id) => id !== asset.assetId),
                            })
                          }
                        />
                        {asset.mediaType === "image" ? "图片" : "视频首帧"} · {asset.displayName}
                      </label>
                    ))
                ) : (
                  <small>先将图片或视频导入当前项目，才能作为附件发送。</small>
                )}
                {!!attachmentAssetIds.length && (
                  <small>
                    已选择 {attachmentAssetIds.length}/4 个附件。
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
                  disabled={busy}
                  onChange={({ target }) => changeDraft({ allowWebResearch: target.checked })}
                  aria-describedby="canvas-web-hint"
                />
                允许本轮联网检索
              </label>
              <small id="canvas-web-hint">小灵可向维基百科发送公开关键词，并读取公开网页。</small>
              <label>
                公开文本链接
                <input
                  type="url"
                  value={referenceURL}
                  maxLength={2048}
                  readOnly={busy}
                  onChange={(event) =>
                    changeDraft({ referenceURL: event.target.value, referencePreview: undefined })
                  }
                  placeholder="https://…"
                  aria-describedby="canvas-reference-hint"
                />
              </label>
              <button
                type="button"
                disabled={!referenceURL.trim() || busy}
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
            <>
              {mediaModels.length ? (
                <select
                  aria-label="默认生成模型"
                  value={mediaModel?.provider.id ?? ""}
                  onChange={({ target }) => changeDraft({ mediaId: target.value })}
                >
                  <option value="">自动选择</option>
                  {mediaModels.map(({ provider, kind }) => (
                    <option key={provider.id} value={provider.id}>
                      {kind === "image" ? "图片" : "视频"} · {provider.model} · {provider.label}
                    </option>
                  ))}
                </select>
              ) : (
                <button type="button" onClick={openSettings}>
                  配置图片或视频模型
                </button>
              )}
              <small>用于本次会话的生成偏好，提交任务前仍需审批。</small>
            </>
          }
          skills={
            canvasSkills.length ? (
              canvasSkills.map(({ id, title, summary }) => (
                <label key={id} className="settings-check">
                  <input
                    type="checkbox"
                    checked={skills.includes(id)}
                    onChange={({ target }) =>
                      changeDraft({
                        skills: target.checked
                          ? [...skills, id]
                          : skills.filter((skill) => skill !== id),
                      })
                    }
                  />
                  <span>
                    {title}
                    <small>{summary}</small>
                  </span>
                </label>
              ))
            ) : (
              <small>暂无已启用的画布技能，请先在技能库中启用 Agent 技能。</small>
            )
          }
        />
        <div className="settings-actions">
          {state?.activeRun && (
            <button
              type="button"
              disabled={blocked}
              onClick={() =>
                void withWrite(async () => {
                  if (state.activeRun)
                    await invoke({ method: "stop", sessionId, runId: state.activeRun });
                }, false)
              }
            >
              停止
            </button>
          )}
          {!state?.activeRun &&
            resumable &&
            ["interrupted", "step_limit"].includes(String(fields(resumable.payload).status)) && (
              <button
                type="button"
                disabled={blocked || !!state?.otherActiveSession}
                onClick={() =>
                  void withWrite(async () => {
                    await invoke({ method: "continue", sessionId, runId: resumable.runId });
                  })
                }
              >
                继续运行
              </button>
            )}
          <small className="assistant-shortcut" id="canvas-assistant-shortcut">
            回车发送 · Shift＋回车换行
          </small>
        </div>
      </form>
    </section>
  );
}
