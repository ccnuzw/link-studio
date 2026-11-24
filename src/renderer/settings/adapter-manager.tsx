import { type PluginView, providerPluginSourceLimit, type SettingsValues } from "@link-studio/core";
import {
  ArrowLeft,
  Boxes,
  CircleAlert,
  CircleArrowUp,
  Fingerprint,
  GitCommitHorizontal,
  History,
  Info,
  Loader2,
  Lock,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AdapterCatalog,
  adapterKinds,
  adapterOrigins,
  Capability,
  capabilityKinds,
} from "./adapter-catalog";
import { copySettingsText } from "./copy-settings-text";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";
import "./adapter-manager.css";
import { groupAdapters, olderCatalogVersions } from "./catalog-version-order";
import { ModelModal } from "./model-editor";
import { PLUGIN_AUTHORING_PROMPT } from "./plugin-authoring-prompt";
import { PluginCopy } from "./plugin-copy";
import { PluginDelete } from "./plugin-delete";
import { PluginNotice, reportPluginAction } from "./plugin-notice";
import { PluginUpgrade, upgradeSnapshot } from "./plugin-upgrade";
import { PluginUpload } from "./plugin-upload";

import { protocolAuth } from "./protocol-settings";

function shortRegistrationTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function AdapterOverview({ plugin, builtin }: { plugin: PluginView; builtin: boolean }) {
  const path = plugin.endpoint?.path?.trim();
  const endpoint = path
    ? `${plugin.endpoint?.method?.trim().toUpperCase() || "POST"} ${path}`
    : "—";
  const info: [string, ReactNode][] = [
    ["厂商", plugin.vendor?.trim() || <span className="adapter-muted">—</span>],
    ["插件标识", <code key="key">{plugin.key}</code>],
    ["最新版本", <code key="version">v{plugin.version}</code>],
    ["契约版本", `v${plugin.apiVersion}`],
    ["来源", builtin ? "内置（随系统发布）" : `上传 · ${adapterOrigins[plugin.origin]}`],
    ["鉴权方式", protocolAuth(plugin)],
    [
      "异步任务查询",
      plugin.mode === "async" ? (
        `提交 ${plugin.poll?.firstDelay ?? 10} 秒后开始，每 ${plugin.poll?.interval ?? 5} 秒一次，最长间隔 ${plugin.poll?.maxInterval ?? 15} 秒`
      ) : (
        <span key="poll" className="adapter-muted">
          无需查询
        </span>
      ),
    ],
  ];
  return (
    <>
      {plugin.description && <p className="adapter-description">{plugin.description}</p>}
      <section className="adapter-section">
        <h3>能力与请求</h3>
        <div className="adapter-capability-grid">
          {Object.entries(adapterKinds).map(([kind, { label }]) => (
            <div
              className="adapter-capability-card"
              data-supported={plugin.kind === kind}
              key={kind}
            >
              <Capability kind={kind} iconOnly />
              <div>
                <strong>{label}</strong>
                <small>
                  {plugin.kind !== kind
                    ? "不支持"
                    : plugin.mode === "async"
                      ? "异步 · 提交后查询"
                      : "同步 · 直接返回"}
                </small>
                {plugin.kind === kind && endpoint && (
                  <code className="adapter-endpoint" title={endpoint}>
                    {endpoint}
                  </code>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="adapter-section">
        <h3>插件信息</h3>
        <dl className="adapter-info">
          {info.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="adapter-section">
        <h3>协议设置项</h3>
        {Object.keys(plugin.fields).length === 0 && (
          <p className="adapter-muted">这个协议没有声明设置项</p>
        )}
        {Object.keys(plugin.fields).length > 0 && (
          <ul className="adapter-field-list">
            {Object.entries(plugin.fields).map(([key, field]) => (
              <li className="adapter-field" key={key}>
                <div>
                  <strong>{field.label || key}</strong>
                  <code>{key}</code>
                  <span className="adapter-badge">
                    {{ enum: "选项", string: "文本", number: "数字", boolean: "开关" }[
                      field.type
                    ] ?? field.type}
                  </span>
                  {field.required && <span className="adapter-badge adapter-required">必填</span>}
                </div>
                {field.description && <p>{field.description}</p>}
                {(!!field.options?.length || (field.default != null && field.default !== "")) && (
                  <p>
                    {field.options?.length ? `可选：${field.options.join(" / ")}` : ""}
                    {field.options?.length && field.default != null && field.default !== ""
                      ? " · "
                      : ""}
                    {field.default == null || field.default === ""
                      ? ""
                      : `默认：${String(field.default)}`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function AdapterManager({
  catalogState,
  data,
  initialHash,
  refresh,
  openModel,
  onSelection,
}: {
  catalogState: "loading" | "error" | "ready";
  data: SettingsValues["list"];
  initialHash: string;
  openModel: (id: string, link?: HTMLAnchorElement) => void;
  onSelection?: (hash: string | undefined) => void;
  refresh: () => Promise<SettingsValues["list"] | undefined>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [disabling, setDisabling] = useState<{
    plugin: PluginView;
    count: number;
    online: number;
  }>();
  const [toggleError, setToggleError] = useState("");
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());
  const body = useRef<HTMLDivElement>(null);
  const fileRead = useRef(0);
  const [hash, setHash] = useState("");
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState<"overview" | "history">("overview");
  const [source, setSource] = useState("");
  const [sample, setSample] = useState("");
  const [check, setCheck] = useState<SettingsValues["pluginCheck"]>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const [remove, setRemove] = useState<PluginView>();
  const [removeError, setRemoveError] = useState("");
  const [deleting, setDeleting] = useState<PluginView>();
  const [plan, setPlan] = useState<ReturnType<typeof upgradeSnapshot>>();
  const previewRead = useRef(0);
  useEffect(
    () => () => {
      previewRead.current++;
    },
    [],
  );
  const groups = groupAdapters(data.plugins);
  const [detail, setDetail] = useState<SettingsValues["pluginDetail"]>();
  const [pins, setPins] = useState<{ key: string; models: SettingsValues["pluginPinnedModels"] }>();
  const plugin = data.plugins.find((entry) => entry.hash === hash);
  const detailKey = editing ? undefined : plugin?.key;
  const loaded = detailKey && detail?.[0]?.key === detailKey ? detail : undefined;
  useEffect(() => {
    if (!detailKey) return;
    let current = true;
    void settingsRequests
      .pluginDetail({ key: detailKey })
      .then((result) => {
        if (!current) return;
        if (result.ok) setDetail(result.value);
        else {
          setHash("");
          setDetail(undefined);
          setFeedback({
            text:
              result.code === "PLUGIN_VERSION_MISSING"
                ? `插件 ${detailKey} 不存在`
                : settingsError(result.code),
            error: true,
          });
        }
      })
      .catch(() => {
        if (current) {
          setHash("");
          setDetail(undefined);
          setFeedback({ text: "无法读取插件详情。", error: true });
        }
      });
    return () => {
      current = false;
    };
  }, [detailKey, data.plugins]);
  useEffect(() => {
    if (!loaded || !detailKey || tab !== "history") return;
    let current = true;
    void settingsRequests
      .pluginPinnedModels({ key: detailKey })
      .then((result) => {
        if (!current) return;
        if (result.ok) setPins({ key: detailKey, models: result.value });
        else reportPluginAction(settingsError(result.code), "error");
      })
      .catch(() => {
        if (current) reportPluginAction("没能读取固定的模型", "error");
      });
    return () => {
      current = false;
    };
  }, [loaded, detailKey, tab]);
  const selectedHash = plugin?.hash;
  useEffect(() => onSelection?.(selectedHash), [selectedHash, onSelection]);
  const versions = loaded
    ? groupAdapters(loaded)[0]!
    : (groups.find(([entry]) => entry?.key === plugin?.key) ?? []);
  const latest = versions[0];
  const history = loaded ? [...loaded].reverse() : [];
  const headerPlugin = editing ? plugin : latest;
  const builtin = versions.some((entry) => entry.origin === "builtin");
  const olderHashes = new Set(olderCatalogVersions(versions).map(({ hash }) => hash));
  const outdated = history.reduce(
    (sum, entry) => sum + (olderHashes.has(entry.hash) ? entry.modelCount : 0),
    0,
  );
  const modalOpen = editing || Boolean(plugin);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (modalOpen && !element.open) element.showModal();
    if (!modalOpen && element.open) element.close();
  }, [modalOpen]);

  function showTab(next: typeof tab) {
    setTab(next);
    setRemove(undefined);
  }

  async function previewUpgrade(latest: PluginView) {
    const read = ++previewRead.current;
    setFeedback(undefined);
    const result = await settingsRequests
      .pluginUpgradeOptions({ key: latest.key })
      .catch(() => ({ ok: false as const, code: "SETTINGS_ACTION_FAILED" }));
    if (read !== previewRead.current) return;
    if (!result.ok) {
      reportPluginAction(settingsError(result.code), "error");
      return;
    }
    const next = upgradeSnapshot(latest, result.value);
    if (next) setPlan(next);
    else reportPluginAction("没有固定在旧版本上的模型", "info");
  }

  function open(selected: PluginView, showUpgrade = false) {
    previewRead.current++;
    if (showUpgrade) {
      void previewUpgrade(selected);
      return;
    }
    setHash(selected.hash);
    setEditing(false);
    setFeedback(undefined);
    showTab("overview");
  }

  function edit(selected?: PluginView) {
    previewRead.current++;
    fileRead.current++;
    setHash(selected?.hash ?? "");
    setSource(selected?.source ?? "");
    setSample("");
    setCheck(undefined);
    setFeedback(undefined);
    setEditing(true);
    if (body.current) body.current.scrollTop = 0;
  }

  function closeDialog() {
    setPins(undefined);
    previewRead.current++;
    fileRead.current++;
    setHash("");
    setEditing(false);
    setFeedback(undefined);
    setRemove(undefined);
  }

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setFeedback(undefined);
    try {
      await action();
    } catch {
      setFeedback({ text: "操作失败，请重试。", error: true });
    } finally {
      setBusy(false);
    }
  }

  const fail = (code: string) => setFeedback({ text: settingsError(code), error: true });
  async function changeEnabled(entry: PluginView) {
    setToggling((previous) => new Set(previous).add(entry.key));
    setToggleError("");
    try {
      const result = await settingsRequests.pluginToggle({
        key: entry.key,
        enabled: entry.disabled,
      });
      if (!result.ok)
        throw new Error(
          result.code === "PLUGIN_VERSION_MISSING" ? "插件不存在" : settingsError(result.code),
        );
      reportPluginAction(`插件「${entry.name}」已${entry.disabled ? "启用" : "停用"}`);
      await refresh();
      if (!entry.disabled) setDisabling(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "操作失败";
      if (!entry.disabled) setToggleError(message);
      reportPluginAction(message, "error");
    } finally {
      setToggling((previous) => {
        const next = new Set(previous);
        next.delete(entry.key);
        return next;
      });
    }
  }
  function toggle(entry: PluginView) {
    previewRead.current++;
    if (entry.disabled) {
      void changeEnabled(entry);
      return;
    }
    const hashes = new Set(
      data.plugins.filter((plugin) => plugin.key === entry.key).map((plugin) => plugin.hash),
    );
    const refs = data.providers.filter((profile) => hashes.has(profile.pluginHash));
    setToggleError("");
    setDisabling({
      plugin: entry,
      count: refs.length,
      online: refs.filter((profile) => profile.enabled).length,
    });
  }
  const confirmRemoval = (selected: PluginView) => {
    setRemoveError("");
    setRemove(selected);
  };
  const removeVersion = (selected: PluginView) =>
    perform(async () => {
      setRemoveError("");
      const result = await settingsRequests
        .pluginRemove({
          key: selected.key,
          version: selected.version,
          allVersions: false,
        })
        .catch(() => ({ ok: false as const, code: "SETTINGS_ACTION_FAILED" }));
      if (!result.ok) {
        const message =
          ("issues" in result && result.issues?.[0]?.message) ||
          (result.code === "PLUGIN_BUILTIN_LOCKED"
            ? "内置插件不能被删除或覆盖"
            : settingsError(result.code));
        setRemoveError(message);
        reportPluginAction(message, "error");
        return;
      }
      const current = await refresh();
      const next =
        current &&
        groupAdapters(current.plugins).find(([entry]) => entry?.key === plugin?.key)?.[0];
      if (next) {
        open(next);
        showTab("history");
      } else closeDialog();
    });
  const draft = () =>
    perform(async () => {
      const result = await settingsRequests.draft({ source });
      if (!result.ok) return fail(result.code);
      await refresh();
      open(result.value);
      showTab("history");
      setFeedback({
        text:
          result.value.kind === "agent"
            ? "已校验并保存版本。Agent 走原生网关，不作为模型调用协议。"
            : "已校验并保存版本，可在模型的调用协议中选择。",
      });
    });
  const checkSample = () =>
    perform(async () => {
      setCheck(undefined);
      const result = await settingsRequests.pluginCheck({
        source,
        sample: sample.trim() || undefined,
      });
      if (!result.ok) return fail(result.code);
      setCheck(result.value);
    });
  async function readPlugin(file?: File) {
    if (!file || busy) return;
    const read = ++fileRead.current;
    if (!/\.c?js$/i.test(file.name) || file.size > providerPluginSourceLimit) {
      setFeedback({ text: "请选择不超过 512 KiB 的 JavaScript 文件。", error: true });
      return;
    }
    try {
      const text = await file.text();
      if (read !== fileRead.current) return;
      setSource(text);
      setCheck(undefined);
      setFeedback(undefined);
    } catch {
      if (read === fileRead.current) setFeedback({ text: "无法读取文件。", error: true });
    }
  }
  const message = feedback && (
    <p
      className="adapter-message"
      data-error={feedback.error}
      role={feedback.error ? "alert" : "status"}
    >
      {feedback.text}
    </p>
  );
  return (
    <div className="adapter-workspace">
      <PluginNotice
        detailOpen={modalOpen}
        actionOpen={Boolean(plan || disabling || deleting || remove)}
      />
      {disabling && (
        <ModelModal
          variant="destructive-confirm"
          title={`停用插件「${disabling.plugin.name}」？`}
          subtitle={
            <>
              <b>
                {disabling.count} 个模型
                {disabling.online > 0 && `（其中 ${disabling.online} 个在线）`}
              </b>{" "}
              在用此插件，停用后不可用，进行中的任务不受影响。
            </>
          }
          close={() => {
            if (!toggling.has(disabling.plugin.key)) setDisabling(undefined);
          }}
        >
          {toggleError && (
            <div className="upload-error-heading" role="alert">
              <CircleAlert size={16} />
              <span>{toggleError}</span>
            </div>
          )}
          <footer className="model-dialog-footer">
            <button
              type="button"
              disabled={toggling.has(disabling.plugin.key)}
              onClick={() => setDisabling(undefined)}
            >
              取消
            </button>
            <button
              type="button"
              data-plugin-disable=""
              className="adapter-danger"
              disabled={toggling.has(disabling.plugin.key)}
              onClick={() => void changeEnabled(disabling.plugin)}
            >
              {toggling.has(disabling.plugin.key) && (
                <Loader2 size={16} className="settings-spin" />
              )}
              停用
            </button>
          </footer>
        </ModelModal>
      )}
      {remove && (
        <ModelModal
          variant="destructive-confirm"
          title="删除插件版本？"
          subtitle={
            <>
              将永久删除{" "}
              <b>
                {remove.name} v{remove.version}
              </b>
              ，不能撤销。若仍有非终态任务在使用这个版本，后端会拒绝删除。
            </>
          }
          close={() => {
            if (!busy) setRemove(undefined);
          }}
        >
          {removeError && (
            <div className="upload-error-heading" role="alert">
              <CircleAlert size={16} />
              <span>{removeError}</span>
            </div>
          )}
          <footer className="model-dialog-footer">
            <button type="button" disabled={busy} onClick={() => setRemove(undefined)}>
              取消
            </button>
            <button
              type="button"
              data-plugin-version-remove=""
              className="adapter-danger"
              disabled={busy}
              onClick={() => void removeVersion(remove)}
            >
              {busy && <Loader2 size={16} className="settings-spin" />}删除
            </button>
          </footer>
        </ModelModal>
      )}
      {deleting && (
        <PluginDelete
          key={deleting.key}
          plugin={deleting}
          openModel={openModel}
          close={() => setDeleting(undefined)}
          deleted={() => {
            setDeleting(undefined);
            closeDialog();
            reportPluginAction(`已删除插件「${deleting.name}」`);
            void refresh();
          }}
        />
      )}
      {plan && <PluginUpgrade plan={plan} refresh={refresh} close={() => setPlan(undefined)} />}
      <div className="adapter-heading">
        <div>
          <h2>插件</h2>
        </div>
        <div className="adapter-heading-actions">
          <button
            type="button"
            title="编写插件源码，校验后保存版本"
            disabled={busy || catalogState !== "ready"}
            onClick={() => edit()}
          >
            <Plus size={16} /> 插件草稿
          </button>
          <button
            type="button"
            className="settings-primary"
            disabled={busy}
            onClick={() => setUploading(true)}
          >
            <Upload size={16} /> 上传插件
          </button>
        </div>
      </div>
      {!modalOpen && message}
      {uploading && (
        <PluginUpload
          close={() => setUploading(false)}
          uploaded={refresh}
          next={() => openModel("")}
        />
      )}
      <AdapterCatalog
        state={catalogState}
        reload={() => void refresh()}
        groups={groups}
        providers={data.providers}
        initialHash={initialHash}
        busy={busy}
        toggling={toggling}
        open={open}
        toggle={(entry) => void toggle(entry)}
        remove={setDeleting}
      />
      <dialog
        ref={dialog}
        className="adapter-dialog"
        closedby="any"
        aria-labelledby="adapter-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) closeDialog();
        }}
      >
        {modalOpen && (
          <div className="adapter-dialog-shell">
            <header className="adapter-dialog-header">
              {headerPlugin ? (
                <span
                  className="adapter-avatar"
                  aria-hidden="true"
                  data-tone={
                    [...headerPlugin.key].reduce(
                      (sum, character) => sum + character.charCodeAt(0),
                      0,
                    ) % 5
                  }
                >
                  {headerPlugin.name
                    .replace(/[（(].*$/, "")
                    .trim()
                    .slice(0, 1)
                    .toUpperCase() || "?"}
                </span>
              ) : (
                <span className="adapter-import-icon">
                  <Upload size={20} />
                </span>
              )}
              <div>
                <h2 id="adapter-dialog-title">
                  {editing ? (plugin ? "编辑适配器版本" : "插件草稿") : headerPlugin?.name}
                  {headerPlugin && (
                    <span aria-hidden="true" className="adapter-badge">
                      {editing ? adapterOrigins[headerPlugin.origin] : builtin ? "内置" : "已上传"}
                    </span>
                  )}
                </h2>
                <p>
                  {headerPlugin ? (
                    <>
                      <code>{headerPlugin.key}</code> · v{headerPlugin.version}
                    </>
                  ) : (
                    "打开 JavaScript 文件，或粘贴源代码。"
                  )}
                </p>
              </div>
              <button
                type="button"
                className="adapter-icon-button"
                aria-label="关闭适配器详情"
                disabled={busy}
                onClick={closeDialog}
              >
                <X size={19} />
              </button>
            </header>
            {!editing && (
              <div role="tablist" className="adapter-tabs" aria-label="插件详情视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "overview"}
                  onClick={() => showTab("overview")}
                >
                  <Info size={16} /> 概览
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "history"}
                  onClick={() => showTab("history")}
                >
                  <History size={16} /> 版本历史 <span>{versions.length}</span>
                </button>
              </div>
            )}
            {message}
            <div
              ref={body}
              className="adapter-dialog-body"
              aria-busy={Boolean(detailKey && !loaded) || undefined}
            >
              {editing ? (
                <form
                  id="adapter-import-form"
                  className="adapter-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void draft();
                  }}
                >
                  {!plugin && !source && (
                    <label>
                      基于已上传版本编辑
                      <select
                        value=""
                        onChange={(event) => {
                          const selected = data.plugins.find(
                            (entry) => entry.hash === event.target.value,
                          );
                          if (selected) edit(selected);
                        }}
                      >
                        <option value="">选择版本，或直接编写新插件</option>
                        {groups
                          .filter((group) => !group.some((entry) => entry.origin === "builtin"))
                          .flat()
                          .map((entry) => (
                            <option key={entry.hash} value={entry.hash}>
                              {entry.key} · v{entry.version}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {plugin && (
                    <details className="adapter-disclosure">
                      <summary>审阅原版本源码</summary>
                      <p className="adapter-muted">静态校验通过 · {plugin.hooks.join(" · ")}</p>
                      {!!plugin.unknownHooks?.length && (
                        <p className="adapter-muted">
                          未知钩子 · {plugin.unknownHooks.join(" · ")}
                        </p>
                      )}
                      <pre>{plugin.source}</pre>
                    </details>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void perform(async () => {
                        await copySettingsText(PLUGIN_AUTHORING_PROMPT);
                        setFeedback({ text: "已复制插件编写提示词。" });
                      })
                    }
                  >
                    复制插件编写提示词
                  </button>
                  <label
                    className="adapter-dropzone"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      void readPlugin(event.dataTransfer.files[0]);
                    }}
                  >
                    拖入或打开 JavaScript 文件
                    <input
                      type="file"
                      accept=".js,.cjs"
                      disabled={busy}
                      onChange={({ target }) => void readPlugin(target.files?.[0])}
                    />
                  </label>
                  <label>
                    适配器源码
                    <textarea
                      value={source}
                      rows={10}
                      maxLength={providerPluginSourceLimit}
                      required
                      disabled={busy}
                      onChange={({ target }) => {
                        fileRead.current++;
                        setSource(target.value);
                        setCheck(undefined);
                      }}
                    />
                  </label>
                  <details className="adapter-disclosure">
                    <summary>离线样例检查</summary>
                    <label>
                      样例 JSON（可选）
                      <textarea
                        rows={4}
                        value={sample}
                        maxLength={65536}
                        disabled={busy}
                        onChange={({ target }) => {
                          setSample(target.value);
                          setCheck(undefined);
                        }}
                        placeholder={
                          '{"model":{"upstreamModel":"sample"},"input":{"prompt":"测试"}}'
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !source.trim()}
                      onClick={() => void checkSample()}
                    >
                      运行离线检查
                    </button>
                    {check && (
                      <div role="status">
                        <p>{check.ok ? "样例检查通过" : "样例检查未通过"}</p>
                        {check.checkedHooks.length > 0 && (
                          <p>已检查 {check.checkedHooks.join(" · ")}</p>
                        )}
                        {Array.from(
                          new Set([
                            ...check.issues,
                            ...check.unknownHooks.map((hook) => `未知钩子 ${hook}`),
                          ]),
                        ).map((issue) => (
                          <p key={issue}>{issue}</p>
                        ))}
                        {check.logs.length > 0 && <pre>{check.logs.join("\n")}</pre>}
                      </div>
                    )}
                  </details>
                </form>
              ) : !loaded ? (
                <div className="adapter-detail-skeleton" aria-label="插件详情加载中" role="status">
                  <span />
                  <div>
                    {[0, 1, 2, 3].map((index) => (
                      <span key={index} />
                    ))}
                  </div>
                  <div>
                    {[0, 1, 2, 3, 4, 5].map((index) => (
                      <span key={index} />
                    ))}
                  </div>
                </div>
              ) : (
                plugin && (
                  <>
                    {tab === "overview" && (
                      <AdapterOverview plugin={latest ?? plugin} builtin={builtin} />
                    )}
                    {tab === "history" && outdated > 0 && latest && (
                      <div className="adapter-history-upgrade">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (latest) void previewUpgrade(latest);
                          }}
                        >
                          <CircleArrowUp size={16} /> 升级全部 {outdated} 个模型到 v{latest.version}
                        </button>
                      </div>
                    )}
                    {tab === "history" && (
                      <ol className="adapter-history" aria-label="适配器版本">
                        {history.map((entry, index) => {
                          const pinned =
                            pins?.key === entry.key
                              ? pins.models.filter((model) => model.hash === entry.hash)
                              : [];
                          const count = entry.modelCount;
                          const blocked = builtin
                            ? "内置版本不能删除"
                            : count
                              ? `${count} 个模型固定在此版本，先把它们升级或改用别的协议`
                              : "";
                          const isLatest = entry.hash === latest?.hash;
                          return (
                            <li key={entry.hash}>
                              <span
                                className="adapter-history-indicator"
                                aria-hidden="true"
                                data-latest={isLatest}
                              >
                                {isLatest ? (
                                  <Sparkles size={12} />
                                ) : (
                                  <GitCommitHorizontal size={12} />
                                )}
                              </span>
                              <div className="adapter-history-title">
                                <code className="adapter-release-version">v{entry.version}</code>
                                {isLatest && <span className="adapter-badge">最新</span>}
                                <small>
                                  {count ? `${count} 个模型固定在此版本` : "无模型使用"}
                                </small>
                                <small className="adapter-uploader">
                                  <time dateTime={entry.registeredAt}>
                                    {shortRegistrationTime(entry.registeredAt)}
                                  </time>{" "}
                                  · {adapterOrigins[entry.origin]}
                                </small>
                              </div>
                              <div className="adapter-history-card">
                                <Capability kind={entry.kind} iconOnly />
                                {history[index + 1] && history[index + 1]?.kind !== entry.kind && (
                                  <small>
                                    <Plus size={12} /> 新增{" "}
                                    {capabilityKinds[entry.kind as keyof typeof capabilityKinds]
                                      ?.label ?? entry.kind}
                                  </small>
                                )}
                                <div>
                                  <code title={entry.hash}>
                                    <Fingerprint size={12} /> {entry.hash.slice(0, 8)}
                                  </code>
                                  <PluginCopy
                                    className="adapter-icon-button"
                                    iconOnly
                                    text={entry.hash}
                                    label="复制完整 sha256"
                                  />
                                </div>
                                {count > 0 && (
                                  <div className="adapter-pin-list">
                                    <span>固定的模型</span>
                                    {pinned.slice(0, 8).map((model) =>
                                      model.channelId ? (
                                        <a
                                          href={`#model=${encodeURIComponent(model.modelKey ?? model.id)}`}
                                          key={model.id}
                                          onClick={(event) => {
                                            event.preventDefault();
                                            openModel(model.id, event.currentTarget);
                                          }}
                                        >
                                          <Boxes size={12} /> {model.name}
                                        </a>
                                      ) : (
                                        <span key={model.id}>{model.name}</span>
                                      ),
                                    )}
                                    {pinned.length > 8 && <span>等 {count} 个</span>}
                                    {!isLatest && latest && (
                                      <small>
                                        <CircleArrowUp size={14} /> 可升级到 v{latest.version}
                                      </small>
                                    )}
                                  </div>
                                )}
                              </div>
                              {blocked ? (
                                <small className="adapter-history-note">
                                  <Lock size={12} /> {blocked}
                                </small>
                              ) : (
                                <button
                                  type="button"
                                  className="adapter-danger"
                                  disabled={busy}
                                  aria-label={`删除 ${entry.version}`}
                                  onClick={() => confirmRemoval(entry)}
                                >
                                  <Trash2 size={14} /> 删除这个版本
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </>
                )
              )}
            </div>
            {editing && (
              <footer className="adapter-dialog-footer">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (plugin) {
                      open(plugin);
                      showTab("history");
                    } else closeDialog();
                  }}
                >
                  <ArrowLeft size={15} /> 返回
                </button>
                <button
                  type="submit"
                  form="adapter-import-form"
                  className="settings-primary"
                  disabled={busy || !source.trim()}
                >
                  {busy ? "处理中…" : "校验并保存版本"}
                </button>
              </footer>
            )}
          </div>
        )}
      </dialog>
    </div>
  );
}
