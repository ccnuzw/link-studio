import { type PluginView, providerPluginSourceLimit } from "@link-studio/core";
import { CircleAlert, CircleCheck, FileCode2, Loader2, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PLUGIN_AUTHORING_PROMPT } from "./plugin-authoring-prompt";
import { PluginCopy } from "./plugin-copy";
import { normalizeUploadIssues, uploadRepairReport } from "./repair-report";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";

export function PluginUpload({
  close,
  uploaded,
  next,
}: {
  close: () => void;
  uploaded: () => Promise<unknown>;
  next: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [file, setFile] = useState<File>();
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const duplicate =
    issues.length > 0 &&
    issues.every((issue) => issue.path === "meta" && issue.message.includes("完全相同"));
  const [saved, setSaved] = useState<PluginView>();
  const [requestedVersion, setRequestedVersion] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [sourceTooLarge, setSourceTooLarge] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    element?.showModal();
    return () => {
      mounted.current = false;
      element?.close();
    };
  }, []);
  function select(value?: File) {
    if (busy) return;
    setFile(value);
    setIssues([]);
    setCopyError(false);
    setSourceTooLarge(false);
    setError(
      !value
        ? ""
        : !/\.js$/i.test(value.name)
          ? "插件必须是 .js 文件"
          : !value.size
            ? "文件是空的"
            : value.size > providerPluginSourceLimit
              ? `文件 ${(value.size / 1024).toFixed(1)}KB，超过 512KB 上限`
              : "",
    );
  }
  const invalid =
    sourceTooLarge ||
    !file?.size ||
    file.size > providerPluginSourceLimit ||
    !/\.js$/i.test(file.name);
  async function submit() {
    if (!file || invalid || busy) return;
    setBusy(true);
    setCopyError(false);
    setError("");
    setIssues([]);
    try {
      const source = await file.text();
      const result = await settingsRequests.pluginUpload({ source });
      if (!mounted.current) {
        if (result.ok) await uploaded();
        return;
      }
      if (!result.ok) {
        if (
          [
            "PLUGIN_BUILTIN_KEY_RESERVED",
            "PLUGIN_VERSION_DUPLICATE",
            "PLUGIN_VERSION_LIMIT",
            "PLUGIN_MANIFEST_INVALID",
            "PLUGIN_HOOKS_INVALID",
            "PLUGIN_OUTPUT_INVALID",
            "PLUGIN_SCRIPT_ERROR",
          ].includes(result.code)
        ) {
          const normalized = normalizeUploadIssues(result.issues);
          setError(normalized.length ? `预检未通过：${normalized.length} 个问题` : "预检未通过");
          setIssues(normalized);
        } else if (result.code === "PLUGIN_SOURCE_LIMIT") {
          setSourceTooLarge(true);
          setError(`文件超过 ${providerPluginSourceLimit / 1024}KB 上限`);
        } else if (["SANDBOX_UNAVAILABLE", "PLUGIN_RUNNER_CRASHED"].includes(result.code)) {
          setError("插件运行器暂时不可用");
        } else setError(settingsError(result.code));
        return;
      }
      setSaved(result.value.plugin);
      setRequestedVersion(result.value.requestedVersion);
      await uploaded();
    } catch {
      if (mounted.current) setError("无法完成插件预检，请重试。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <dialog
      className="adapter-dialog plugin-upload"
      ref={dialog}
      aria-labelledby="upload-title"
      onClose={(event) => {
        if (!event.currentTarget.open && mounted.current) close();
      }}
      closedby="any"
    >
      <h2 id="upload-title">上传插件</h2>
      {!saved && (
        <>
          <label
            className="upload-drop"
            data-dragging={dragging}
            data-selected={!!file}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              select(event.dataTransfer.files[0]);
            }}
          >
            <FileCode2 size={20} />
            {file ? (
              <span>
                已选：<code>{file.name}</code> · {(file.size / 1024).toFixed(1)}KB
              </span>
            ) : (
              <span>选择 .js 文件 · ≤512KB</span>
            )}
            <input
              type="file"
              aria-label="选择插件文件"
              accept=".js,text/javascript"
              disabled={busy}
              onChange={(event) => {
                select(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
          <section className="upload-prompt" aria-label="用 AI 生成插件">
            <div>
              <strong>用 AI 生成插件</strong>
              <PluginCopy text={PLUGIN_AUTHORING_PROMPT} label="复制提示词" />
            </div>
            <details>
              <summary>预览提示词</summary>
              <pre>{PLUGIN_AUTHORING_PROMPT}</pre>
            </details>
          </section>
        </>
      )}
      {busy && !saved && (
        <p className="upload-pending" role="status">
          <Loader2 size={12} />
          预检中…
        </p>
      )}
      {error && (
        <section className="upload-error" role="alert" aria-label="预检结果">
          <div className="upload-error-heading">
            <CircleAlert size={16} />
            {error === "插件运行器暂时不可用" ? (
              <div className="upload-error-message">
                <strong>{error}</strong>
                <span>稍后重试</span>
              </div>
            ) : issues.length ? (
              <strong>{error}</strong>
            ) : (
              <span className="upload-error-message">{error}</span>
            )}
            {!!issues.length && !duplicate && (
              <PluginCopy
                text={uploadRepairReport(issues)}
                label="复制修复信息"
                onError={() => setCopyError(true)}
                onCopied={() => setCopyError(false)}
              />
            )}
          </div>
          {issues.length > 0 && (
            <>
              <ul>
                {issues.map((issue) => (
                  <li key={`${issue.path}-${issue.message}`}>
                    <div>
                      <code>{issue.path || "（整个文件）"}</code>
                      <p>{issue.message}</p>
                    </div>
                    {issue.path && <PluginCopy iconOnly label="复制路径" text={issue.path} />}
                  </li>
                ))}
              </ul>
            </>
          )}
          {copyError && <p role="status">复制失败：无法写入剪贴板，请检查剪贴板权限后重试。</p>}
        </section>
      )}
      {saved && (
        <>
          <section role="status" className="upload-outcome">
            <CircleCheck size={16} />
            <div>
              <strong>
                预检通过，已登记 {saved.key}@{saved.version}
              </strong>
              <dl>
                <dt>版本</dt>
                <dd>{saved.version}</dd>
                <dt>sha256</dt>
                <dd title={saved.hash}>{saved.hash.slice(0, 8)}…</dd>
              </dl>
            </div>
          </section>
          {requestedVersion !== undefined && (
            <section role="status" aria-label="版本调整" className="upload-outcome upload-adjusted">
              <TriangleAlert size={16} />
              <div>
                <strong>
                  {requestedVersion
                    ? `代码里写的是 v${requestedVersion}`
                    : "代码里没有写合法的版本号"}
                  ，已自动登记为 v{saved.version}
                </strong>
                <p>模型不会自动切换版本，请到插件页“升级模型”里切过去。</p>
              </div>
            </section>
          )}
        </>
      )}
      <footer>
        <button type="button" onClick={() => dialog.current?.close()}>
          {saved ? "完成" : "取消"}
        </button>
        {saved ? (
          <button type="button" className="settings-primary" onClick={next}>
            下一步：去模型渠道
          </button>
        ) : (
          <button
            type="button"
            className="settings-primary"
            disabled={invalid || busy}
            onClick={() => void submit()}
          >
            {busy && <Loader2 size={16} aria-hidden="true" />}
            {busy ? "预检中…" : "上传"}
          </button>
        )}
      </footer>
      <button
        type="button"
        className="upload-close"
        aria-label="关闭"
        onClick={() => dialog.current?.close()}
      >
        <X size={16} />
      </button>
    </dialog>
  );
}
