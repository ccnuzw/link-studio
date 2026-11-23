import {
  configuredGenerationInput,
  type ModelKind,
  mediaReferenceBytes,
  modelGenerationOptions,
  type PluginView,
  type ProviderView,
  quoteModel,
  quoteQuantity,
  type SettingsValues,
} from "@link-studio/core";
import { CircleAlert, CircleCheck, FlaskConical, Loader2, Sparkles } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ModelModal } from "./model-editor";
import {
  type ReferenceKind,
  referenceLabels,
  TrialInputCard,
  trialCapabilities,
  trialPromptError,
  useTrialInputs,
} from "./model-trial-input";
import { ModelTrialLog } from "./model-trial-log";
import {
  restoreTrialSession,
  startTrialSession,
  subscribeTrialSessions,
  trialSession,
} from "./model-trial-session";
import { ModelTrialTrace, trialStepFailed, useTrialTrace } from "./model-trial-trace";
import { PluginCopy } from "./plugin-copy";
import { PluginNotice, reportTrialError } from "./plugin-notice";
import { composeRepairReport } from "./repair-report";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";
import { TrialRequestPreview } from "./trial-request-preview";

const tabs = { result: "结果", request: "请求描述", trace: "追踪", logs: "日志" } as const;
export function ModelTrial({
  model,
  plugin,
  close,
  inputs,
}: {
  model: ProviderView;
  plugin: PluginView;
  close: () => void;
  inputs?: ReturnType<typeof useTrialInputs>;
}) {
  const [tab, setTab] = useState<keyof typeof tabs>("result");
  const tabId = useId();
  const localInputs = useTrialInputs();
  const values = inputs ?? localInputs;
  const { prompt, params, size, duration, attachments } = values;
  const [attempted, setAttempted] = useState(false);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const [preparing, setPreparing] = useState<"request" | "run" | undefined>();
  const sessionKey = `${model.id}:${model.revision}`;
  const session = useSyncExternalStore(subscribeTrialSessions, () => trialSession(sessionKey));
  useEffect(() => {
    if (session) return;
    let active = true;
    void window.desktop.settings
      .modelTrialResult({ id: model.id, expectedRevision: model.revision })
      .then((response) => {
        if (!active || !response.ok || !response.value) return;
        if (response.value.result) {
          restoreTrialSession(
            sessionKey,
            response.value.runId,
            {
              ok: true,
              value: response.value.result,
            },
            response.value.expiresAt,
          );
        } else {
          restoreTrialSession(sessionKey, response.value.runId);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [model.id, model.revision, session, sessionKey]);
  const taskId = session?.id;
  const runId = session?.outcome ? undefined : taskId;
  const busy = Boolean(preparing || runId);
  const previousRun = useRef(runId);
  useEffect(() => {
    if (previousRun.current && session?.outcome?.ok && session.outcome.value.status !== "unknown")
      setTab("trace");
    previousRun.current = runId;
  }, [runId, session]);
  const [progress, setProgress] = useState<SettingsValues["modelTrialProgress"]>(null);
  useEffect(() => {
    if (!runId) {
      setProgress(null);
      return;
    }
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const response = await window.desktop.settings.modelTrialProgress({ runId });
        if (active && response.ok) setProgress(response.value);
        if (
          active &&
          response.ok &&
          !response.value &&
          trialSession(sessionKey)?.id === runId &&
          !trialSession(sessionKey)?.outcome
        ) {
          const latest = await window.desktop.settings.modelTrialResult({
            id: model.id,
            expectedRevision: model.revision,
            runId,
          });
          if (active && latest.ok && latest.value?.runId === runId && latest.value.result)
            restoreTrialSession(
              sessionKey,
              runId,
              { ok: true, value: latest.value.result },
              latest.value.expiresAt,
            );
          else if (active && latest.ok && !latest.value)
            restoreTrialSession(sessionKey, runId, { ok: false, code: "MODEL_TRIAL_TIMEOUT" });
        }
      } finally {
        if (active) timer = window.setTimeout(() => void refresh().catch(() => {}), 3000);
      }
    };
    void refresh().catch(() => {});
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [runId, sessionKey, model.id, model.revision]);
  const [runError, setRunError] = useState("");
  const [copyError, setCopyError] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const runResult = session?.outcome?.ok ? session.outcome.value : undefined;
  const trace = useTrialTrace(
    taskId ? { id: model.id, expectedRevision: model.revision, runId: taskId } : undefined,
    runResult?.trace ?? progress?.trace,
  );
  const [preview, setPreview] = useState<{ time: number; result: SettingsValues["modelTrial"] }>();
  const previewResult = preview?.result;
  const requestFailure =
    previewError || (previewResult?.error && settingsError(previewResult.error));
  const result = tab === "request" ? previewResult : runResult;
  const error =
    tab === "request"
      ? previewError
      : runError || (session?.outcome?.ok === false ? settingsError(session.outcome.code) : "");
  const name = model.config?.name ?? model.model;
  const kind = model.config?.kind ?? (plugin.kind as ModelKind);
  const repairReport =
    runResult?.status === "failed"
      ? composeRepairReport(
          [
            `插件：${plugin.key} v${plugin.version}`,
            `阶段：试跑（${kind} · ${model.model}）`,
            `错误：${runResult.error || "PROVIDER_TEST_FAILED"} · ${runResult.errorMessage || settingsError(runResult.error || "PROVIDER_TEST_FAILED")}`,
            ...trace.steps
              .filter(trialStepFailed)
              .map(
                (step) =>
                  `失败步骤：${step.phase} · ${step.hook ?? step.method} · ${step.status ?? step.error ?? "未收到响应"}`,
              ),
          ].join("\n"),
        )
      : undefined;
  const options = modelGenerationOptions(
    plugin.kind,
    plugin.origin === "builtin" ? plugin.key : undefined,
    model.model,
    model.channel,
    model.config,
  );
  const { selectedMode, op, refKinds, urls, refCount, referenceErrors } = trialCapabilities(
    kind,
    options,
    values,
  );
  const pricing = model.config?.pricing;
  const quoteParams = configuredGenerationInput(model.config, {
    ...params,
    ...(size && { size }),
    ...(duration && { duration: Number(duration) }),
  });
  const credits =
    pricing && (pricing.unit !== "second" || Number(quoteParams.duration) > 0)
      ? quoteModel(
          pricing,
          {
            params: { ...quoteParams, ...quoteParams.customParams },
            op: selectedMode,
            refVideo: refKinds.includes("video") && refCount("video") > 0,
            promptChars: Array.from(prompt).length,
            outputTokens: model.config?.maxOutputTokens,
          },
          quoteQuantity(model.config, { ...quoteParams, ...quoteParams.customParams }),
        )
      : undefined;
  const run = async (dry: boolean) => {
    if (busy) return;
    setAttempted(true);
    if (trialPromptError(prompt, options.promptLimit)) {
      promptInput.current?.focus();
      return;
    }
    if (Object.keys(referenceErrors).length) return;
    setPreparing(dry ? "request" : "run");
    setCopyError(false);
    const setError = (message: string, code?: string) => {
      if (dry && (code === "PLUGIN_RUNNER_CRASHED" || code === "SANDBOX_UNAVAILABLE")) {
        setPreview(undefined);
        setPreviewError("插件运行器暂时不可用，稍后重试。测试参数已保留。");
        setTab("request");
      } else if (dry) reportTrialError(message);
      else setRunError(message);
    };
    if (!dry) setRunError("");
    if (!dry) setTab("result");
    try {
      const { videoAction: _videoAction, ...values } = params;
      const picked = refKinds.flatMap((kind) =>
        (attachments[kind] ?? []).map((item) => ({ kind, item })),
      );
      const files = picked.flatMap(({ kind, item }) =>
        "file" in item ? [{ kind, file: item.file }] : [],
      );
      if (
        files.reduce((sum, { file }) => sum + file.size, 0) > mediaReferenceBytes ||
        files.some(
          ({ kind, file }) =>
            !file.size || file.size > (options.referenceBytes[kind] ?? mediaReferenceBytes),
        )
      ) {
        setError("参考文件超出模型的大小限制，试跑总计最多 10 MB。");
        return;
      }
      const selected = await Promise.all(
        picked.map(async ({ kind, item }) =>
          "voice" in item
            ? { kind, url: item.voice.url }
            : {
                kind,
                file: { mime: item.file.type, base64: await readTrialFile(item.file) },
              },
        ),
      );
      const runId = dry ? undefined : crypto.randomUUID();
      const submit = () =>
        settingsRequests.modelTrial({
          runId,
          id: model.id,
          expectedRevision: model.revision,
          dry,
          prompt: prompt.trim(),
          params: {
            ...values,
            ...(size && { size }),
            ...(duration && { duration: Number(duration) }),
          },
          references: [
            ...selected,
            ...refKinds.flatMap((kind) => urls(kind).map((url) => ({ kind, url }))),
          ],
          op,
        });
      if (runId) {
        setPreparing(undefined);
        await startTrialSession(sessionKey, runId, submit);
      } else {
        const response = await submit();
        if (response.ok && !response.value.error && response.value.request) {
          setPreview({ time: Date.now(), result: response.value });
          setPreviewError("");
          setTab("request");
        } else {
          const code = response.ok ? response.value.error || "PROVIDER_TEST_FAILED" : response.code;
          setError(settingsError(code), code);
        }
      }
    } catch {
      setError(settingsError("PROVIDER_TEST_FAILED"));
    } finally {
      setPreparing(undefined);
    }
  };
  return (
    <ModelModal
      title={`测试 ${name}`}
      avatar={name}
      avatarSeed={model.modelKey ?? model.id}
      logo={model.config?.logo}
      wide
      variant="trial"
      close={() => {
        if (!preparing) close();
      }}
    >
      <div className="model-trial-grid">
        <aside className="model-dialog-body model-trial-input">
          <TrialInputCard
            name={name}
            seed={model.modelKey ?? model.id}
            logo={model.config?.logo}
            kind={kind}
            options={options}
            inputs={values}
            busy={busy}
            attempted={attempted}
            promptInput={promptInput}
          >
            <footer>
              <button
                type="button"
                className="settings-primary"
                disabled={busy}
                title="试跑会发送请求，上游可能计费。"
                onClick={() => void run(false)}
              >
                {preparing === "run" || runId ? (
                  <Loader2 size={16} className="settings-spin" />
                ) : (
                  <Sparkles size={16} />
                )}{" "}
                开始测试
                {credits !== undefined &&
                  ` · ${pricing?.unit === "token" ? "≤" : ""}${credits} 积分`}
              </button>
            </footer>
          </TrialInputCard>
          <button type="button" disabled={busy} onClick={() => void run(true)}>
            <FlaskConical size={15} /> 只看请求（不发送）
          </button>
        </aside>
        <section className="model-dialog-body model-trial-result">
          <div role="tablist" aria-label="测试详情" className="model-trial-tabs">
            {(Object.keys(tabs) as (keyof typeof tabs)[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-label={tabs[key]}
                id={`${tabId}-${key}`}
                aria-controls={`${tabId}-panel`}
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                onKeyDown={(event) => {
                  const keys = Object.keys(tabs) as (keyof typeof tabs)[];
                  const index = keys.indexOf(key);
                  const next = {
                    ArrowRight: (index + 1) % keys.length,
                    ArrowLeft: (index + keys.length - 1) % keys.length,
                    Home: 0,
                    End: keys.length - 1,
                  }[event.key];
                  if (next === undefined) return;
                  event.preventDefault();
                  const target = keys[next];
                  if (!target) return;
                  setTab(target);
                  document.getElementById(`${tabId}-${target}`)?.focus();
                }}
                onClick={() => setTab(key)}
              >
                {tabs[key]}
                {key === "result" && runResult && <small aria-hidden="true">1</small>}
                {key === "request" && (previewResult || previewError) && (
                  <small aria-hidden="true">1</small>
                )}
                {key === "trace" && (runResult || progress) && !trace.reading && !trace.failed && (
                  <small aria-hidden="true">{trace.steps.length}</small>
                )}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`${tabId}-panel`}
            aria-labelledby={`${tabId}-${tab}`}
            tabIndex={0}
          >
            {busy && tab === "result" && preparing !== "request" && (
              <p role="status">
                {progress?.phase === "finalizing"
                  ? "正在读取试跑产物…"
                  : progress?.phase === "query"
                    ? "已提交，等待供应商返回结果…"
                    : "测试进行中…"}
              </p>
            )}
            {busy && tab === "result" && progress?.percent !== undefined && (
              <progress
                className="model-trial-progress"
                aria-label="试跑进度"
                max={100}
                value={progress.percent}
              />
            )}
            {tab === "request" && requestFailure && (
              <div className="trial-run-notice" data-tone="danger" role="alert">
                <CircleAlert size={16} />
                <div>
                  <strong>没有拿到请求描述</strong>
                  <span>{requestFailure}</span>
                </div>
              </div>
            )}
            {error && tab !== "request" && <p role="alert">{error}</p>}
            {!busy && !error && !result && tab !== "logs" && !(tab === "trace" && taskId) && (
              <p>
                {
                  {
                    result: "还没有试跑",
                    request: "还没有请求描述",
                    trace: "还没有追踪",
                  }[tab]
                }
              </p>
            )}
            {tab === "result" && result && ["failed", "succeeded"].includes(result.status) && (
              <div className="trial-run-heading" role="status">
                <h3>试跑任务 #{taskId}</h3>
                <span className="trial-run-status" data-status={result.status}>
                  {result.status}
                </span>
              </div>
            )}
            {result?.error &&
              tab !== "logs" &&
              tab !== "request" &&
              !(tab === "result" && result.status === "failed") && (
                <p role="alert">
                  {result.status === "unknown"
                    ? `结果未知，请核对上游状态。${settingsError(result.error)}`
                    : settingsError(result.error)}
                </p>
              )}
            {repairReport && tab === "result" && (
              <div className="trial-run-notice" role="alert">
                <CircleAlert size={16} />
                <div>
                  <strong>测试失败</strong>
                  <span>
                    {runResult?.errorMessage ||
                      settingsError(runResult?.error || "PROVIDER_TEST_FAILED")}
                  </span>
                </div>
                <PluginCopy
                  key={`${tab}-${taskId}`}
                  text={repairReport}
                  label="复制修复信息"
                  className="trial-repair-copy"
                  onError={() => setCopyError(true)}
                  onCopied={() => setCopyError(false)}
                />
                {copyError && (
                  <div role="status" className="trial-repair-fallback">
                    <span>复制失败，可选中下面的修复信息手动复制。</span>
                    <pre>{repairReport}</pre>
                  </div>
                )}
              </div>
            )}
            {result &&
              tab === "result" &&
              (result.status === "preview" ? (
                <p>只生成了请求描述。</p>
              ) : (
                result.status === "succeeded" && (
                  <div className="trial-run-view">
                    {!result.outputs.length && (
                      <div role="status" className="trial-run-notice" data-success>
                        <CircleCheck size={16} />
                        <div>
                          <strong>测试成功</strong>
                          <span>没有产出文件。</span>
                        </div>
                      </div>
                    )}
                    {result.outputs.map((output) =>
                      output.image || (output.previewUrl && output.mediaType === "image") ? (
                        <img
                          key={output.id}
                          className="trial-output-media"
                          src={output.image ?? output.previewUrl}
                          alt="试跑产物"
                        />
                      ) : output.previewUrl && output.mediaType === "video" ? (
                        <video
                          key={output.id}
                          className="trial-output-media"
                          controls
                          src={output.previewUrl}
                          aria-label="试跑视频"
                        />
                      ) : output.previewUrl && output.mediaType === "audio" ? (
                        <audio
                          key={output.id}
                          className="trial-output-audio"
                          controls
                          src={output.previewUrl}
                          aria-label="试跑音频"
                        />
                      ) : output.text !== undefined ? (
                        <p className="trial-output-text" key={output.id}>
                          {output.text}
                        </p>
                      ) : (
                        <p key={output.id}>
                          已收到{output.mediaType && modelKind(output.mediaType)}结果
                        </p>
                      ),
                    )}
                  </div>
                )
              ))}
            {result &&
              tab === "request" &&
              (result.request && preview ? (
                <TrialRequestPreview request={result.request} time={preview.time} />
              ) : (
                !result.error && <p>没有生成请求描述</p>
              ))}
            {taskId && tab === "trace" && (
              <ModelTrialTrace
                key={`${sessionKey}:${taskId}`}
                trace={trace}
                taskId={taskId}
                actions={
                  repairReport && (
                    <PluginCopy
                      text={repairReport}
                      label="复制修复信息"
                      className="trial-repair-copy"
                      onError={() => setCopyError(true)}
                      onCopied={() => setCopyError(false)}
                    />
                  )
                }
              />
            )}
            {tab === "trace" && repairReport && copyError && (
              <div role="status" className="trial-repair-fallback">
                <span>复制失败，可选中下面的修复信息手动复制。</span>
                <pre>{repairReport}</pre>
              </div>
            )}
            {tab === "logs" && <ModelTrialLog modelId={model.id} />}
            {result && tab === "trace" && result.logs.length > 0 && (
              <details>
                <summary>运行日志</summary>
                <pre>{result.logs.join("\n")}</pre>
              </details>
            )}
          </div>
        </section>
      </div>
      <footer className="model-dialog-footer">
        <button type="button" disabled={Boolean(preparing)} onClick={close}>
          关闭
        </button>
      </footer>
      <PluginNotice trial detailOpen={false} actionOpen={false} />
    </ModelModal>
  );
}

function modelKind(value: string) {
  return Object.hasOwn(referenceLabels, value) ? referenceLabels[value as ReferenceKind] : value;
}

function readTrialFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
