import {
  type ModelKind,
  mediaReferenceBytes,
  modelGenerationModes,
  modelGenerationOptions,
  modelModeLabels,
  type PluginView,
  type ProviderView,
  type SettingsInput,
  type SettingsValues,
} from "@link-studio/core";
import { FlaskConical, Sparkles } from "lucide-react";
import { useState } from "react";
import { MediaParameterPicker, type MediaParameters } from "../workspace/media-pickers";
import { KindMark, ModelModal } from "./model-editor";
import { settingsError } from "./settings-page";

const tabs = { result: "结果", request: "请求描述", trace: "追踪", logs: "日志" } as const;
const referenceLabels = { image: "图片", audio: "音频", video: "视频" } as const;
type Trial = SettingsInput<"modelTrial">;
type ReferenceKind = keyof typeof referenceLabels;

export function ModelTrial({
  model,
  plugin,
  close,
}: {
  model: ProviderView;
  plugin: PluginView;
  close: () => void;
}) {
  const [tab, setTab] = useState<keyof typeof tabs>("result");
  const [prompt, setPrompt] = useState("");
  const [params, setParams] = useState<MediaParameters>({});
  const [size, setSize] = useState("");
  const [duration, setDuration] = useState("");
  const [mode, setMode] = useState<Trial["op"]>();
  const [references, setReferences] = useState<Partial<Record<ReferenceKind, string>>>({});
  const [files, setFiles] = useState<Partial<Record<ReferenceKind, File[]>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SettingsValues["modelTrial"]>();
  const name = model.config?.name ?? model.model;
  const kind = model.config?.kind ?? (plugin.kind as ModelKind);
  const options = modelGenerationOptions(
    plugin.kind,
    plugin.origin === "builtin" ? plugin.key : undefined,
    model.model,
    model.channel,
    model.config,
  );
  const modes = modelGenerationModes(plugin.kind, options).filter(
    (entry) => options.modes?.includes(entry) ?? true,
  );
  const videoModes = modes.filter(
    (entry) => entry === "t2v" || entry === "i2v" || entry === "omni",
  );
  const op = mode ?? videoModes[0];
  const refKinds = (Object.keys(referenceLabels) as ReferenceKind[]).filter(
    (entry) =>
      (options.references[entry] ?? 0) > 0 && op !== "t2v" && (op !== "i2v" || entry === "image"),
  );
  const run = async (dry: boolean) => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(undefined);
    setTab(dry ? "request" : "result");
    try {
      const { videoAction: _videoAction, ...values } = params;
      const picked = refKinds.flatMap((kind) =>
        (files[kind] ?? []).map((file) => ({ kind, file })),
      );
      if (
        picked.reduce((sum, { file }) => sum + file.size, 0) > mediaReferenceBytes ||
        picked.some(
          ({ kind, file }) =>
            !file.size || file.size > (options.referenceBytes[kind] ?? mediaReferenceBytes),
        )
      ) {
        setError("参考文件超出模型的大小限制，试跑总计最多 10 MB。");
        return;
      }
      const local = await Promise.all(
        picked.map(async ({ kind, file }) => ({
          kind,
          file: { mime: file.type, base64: await readTrialFile(file) },
        })),
      );
      const response = await window.desktop.settings.modelTrial({
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
          ...local,
          ...refKinds.flatMap((kind) =>
            (references[kind] ?? "")
              .split("\n")
              .map((url) => url.trim())
              .filter(Boolean)
              .map((url) => ({ kind, url })),
          ),
        ],
        op,
      });
      if (response.ok) setResult(response.value);
      else setError(settingsError(response.code));
    } catch {
      setError(settingsError("PROVIDER_TEST_FAILED"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModelModal
      title={`测试 ${name}`}
      avatar={name}
      logo={model.config?.logo}
      wide
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="model-trial-grid">
        <aside className="model-dialog-body model-trial-input">
          <section className="model-trial-card">
            <header>
              <strong>{name}</strong>
              <KindMark kind={kind} />
            </header>
            <label className="model-trial-prompt">
              <textarea
                aria-label="测试提示词"
                placeholder="描述你想生成的内容…"
                rows={5}
                maxLength={options.promptLimit}
                value={prompt}
                disabled={busy}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <small>
                {Array.from(prompt).length} / {options.promptLimit}
              </small>
            </label>
            {videoModes.length > 0 && (
              <label>
                生成方式
                <select
                  value={op}
                  disabled={busy}
                  onChange={(event) => setMode(event.target.value as Trial["op"])}
                >
                  {videoModes.map((entry) => (
                    <option key={entry} value={entry}>
                      {modelModeLabels[entry]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {refKinds.map((kind) => (
              <fieldset className="model-trial-params" key={kind}>
                <legend>参考{referenceLabels[kind]}</legend>
                <label>
                  选择本地文件
                  <input
                    type="file"
                    accept={`${kind}/*`}
                    multiple
                    disabled={busy}
                    onChange={(event) =>
                      setFiles({ ...files, [kind]: Array.from(event.target.files ?? []) })
                    }
                  />
                </label>
                {!!files[kind]?.length && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(event) => {
                      const field =
                        event.currentTarget.parentElement?.querySelector<HTMLInputElement>(
                          'input[type="file"]',
                        );
                      if (field) field.value = "";
                      setFiles({ ...files, [kind]: [] });
                    }}
                  >
                    移除已选文件
                  </button>
                )}
                <label>
                  参考{referenceLabels[kind]}链接
                  <textarea
                    rows={2}
                    placeholder="公开 HTTPS 链接，每行一个"
                    value={references[kind] ?? ""}
                    disabled={busy}
                    onChange={(event) =>
                      setReferences({ ...references, [kind]: event.target.value })
                    }
                  />
                </label>
              </fieldset>
            ))}
            {kind !== "text" && kind !== "agent" && (
              <fieldset disabled={busy} className="model-trial-params">
                <legend>生成参数</legend>
                <MediaParameterPicker
                  options={{ ...options, videoAction: false }}
                  value={params}
                  size={size}
                  duration={duration}
                  setSize={setSize}
                  setDuration={setDuration}
                  change={(values) => setParams((previous) => ({ ...previous, ...values }))}
                />
              </fieldset>
            )}
            <footer>
              <button
                type="button"
                className="settings-primary"
                disabled={busy || !prompt.trim()}
                onClick={() => void run(false)}
              >
                <Sparkles size={15} /> 开始测试
              </button>
              <small>试跑会发送请求，上游可能计费。</small>
            </footer>
          </section>
          <button type="button" disabled={busy || !prompt.trim()} onClick={() => void run(true)}>
            <FlaskConical size={15} /> 只看请求（不发送）
          </button>
        </aside>
        <section className="model-dialog-body model-trial-result">
          <nav aria-label="测试详情" className="model-trial-tabs">
            {(Object.keys(tabs) as (keyof typeof tabs)[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
              >
                {tabs[key]}
              </button>
            ))}
          </nav>
          {busy && <p role="status">{tab === "request" ? "正在处理…" : "测试进行中…"}</p>}
          {error && <p role="alert">{error}</p>}
          {!busy && !error && !result && <p>还没有试跑</p>}
          {result?.error && (
            <p role="alert">
              {result.status === "unknown"
                ? `结果未知，请核对上游状态。${settingsError(result.error)}`
                : settingsError(result.error)}
            </p>
          )}
          {result &&
            tab === "result" &&
            (result.status === "preview" ? (
              <p>只生成了请求描述。</p>
            ) : (
              result.status === "succeeded" && (
                <>
                  <p role="status">模型测试成功。</p>
                  {result.outputs.map((output) =>
                    output.image ? (
                      <img key={output.id} src={output.image} alt="模型试跑输出" />
                    ) : output.text ? (
                      <pre key={output.id}>{output.text}</pre>
                    ) : (
                      <p key={output.id}>
                        已收到{output.mediaType && modelKind(output.mediaType)}结果
                      </p>
                    ),
                  )}
                </>
              )
            ))}
          {result &&
            tab === "request" &&
            (result.request ? (
              <>
                <code>
                  {result.request.method} {result.request.endpoint}
                </code>
                {result.request.body && <pre>{result.request.body}</pre>}
                <small>响应类型 {result.request.responseType}</small>
              </>
            ) : (
              <p>没有生成请求描述</p>
            ))}
          {result &&
            tab === "trace" &&
            (result.trace.length ? (
              <ol>
                {result.trace.map(({ id, phase, method, endpoint, status }) => (
                  <li key={id}>
                    <code>
                      {phase} · {method} {endpoint} {status ?? "未收到响应"}
                    </code>
                  </li>
                ))}
              </ol>
            ) : (
              <p>没有网络请求</p>
            ))}
          {result && tab === "logs" && <pre>{result.logs.join("\n") || "没有日志"}</pre>}
        </section>
      </div>
      <footer className="model-dialog-footer">
        <button type="button" disabled={busy} onClick={close}>
          关闭
        </button>
      </footer>
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
