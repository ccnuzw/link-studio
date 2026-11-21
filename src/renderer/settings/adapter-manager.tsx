import {
  type PluginView,
  providerPluginSourceLimit,
  providerVendorLabel,
  type SettingsValues,
} from "@link-studio/core";
import {
  ArrowLeft,
  ArrowUpCircle,
  Check,
  Copy,
  Fingerprint,
  History,
  Info,
  LockKeyhole,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AdapterCatalog,
  adapterKinds,
  adapterOrigins,
  adapterUpgradeTargets,
  Capability,
  groupAdapters,
} from "./adapter-catalog";
import { settingsError } from "./settings-page";
import "./adapter-manager.css";

const authLabels: Record<string, string> = {
  none: "无需鉴权",
  bearer: "Bearer · 宿主注入 Authorization",
  header: "请求头 · 宿主注入",
  query: "查询参数 · 宿主注入",
  custom: "插件自定义",
};

function AdapterOverview({ plugin }: { plugin: PluginView }) {
  const endpoint = [plugin.endpoint?.method, plugin.endpoint?.path].filter(Boolean).join(" ");
  const interval = plugin.poll?.interval || 5;
  const info: [string, ReactNode][] = [
    ["厂商", providerVendorLabel(plugin.vendor)],
    ["插件标识", <code key="key">{plugin.key}</code>],
    ["当前版本", <code key="version">v{plugin.version}</code>],
    ["契约版本", `v${plugin.apiVersion}`],
    ["来源", adapterOrigins[plugin.origin]],
    [
      "鉴权方式",
      [authLabels[plugin.auth] ?? plugin.auth, plugin.authName].filter(Boolean).join(" · "),
    ],
    [
      "异步任务查询",
      plugin.mode === "async"
        ? `提交 ${plugin.poll?.firstDelay || 10} 秒后开始，初始间隔 ${interval} 秒，最长 ${Math.max(interval, plugin.poll?.maxInterval || 15)} 秒`
        : "无需查询",
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
              </div>
            </div>
          ))}
        </div>
        {endpoint && <code className="adapter-endpoint">{endpoint}</code>}
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
          <p className="adapter-muted">此版本没有额外设置项。</p>
        )}
        {Object.entries(plugin.fields).map(([key, field]) => (
          <div className="adapter-field" key={key}>
            <div>
              <strong>{field.label}</strong> <code>{key}</code>{" "}
              <span className="adapter-badge">
                {{ enum: "选项", string: "文本", number: "数字", boolean: "开关" }[field.type] ??
                  field.type}
              </span>{" "}
              {field.required && <span className="adapter-badge adapter-required">必填</span>}
            </div>
            {field.description && <p>{field.description}</p>}
            {(field.options?.length || field.default !== undefined) && (
              <p>
                {field.options?.length ? `可选 ${field.options.join(" / ")}` : ""}
                {field.options?.length && field.default !== undefined ? " · " : ""}
                {field.default === undefined ? "" : `默认 ${String(field.default)}`}
              </p>
            )}
          </div>
        ))}
      </section>
      <details className="adapter-disclosure">
        <summary>审阅源码</summary>
        <p className="adapter-muted">静态校验通过 · {plugin.hooks.join(" · ")}</p>
        {!!plugin.unknownHooks?.length && (
          <p className="adapter-muted">未知钩子 · {plugin.unknownHooks.join(" · ")}</p>
        )}
        <pre>{plugin.source}</pre>
      </details>
    </>
  );
}

export function AdapterManager({
  data,
  initialHash,
  refresh,
}: {
  data: SettingsValues["list"];
  initialHash: string;
  refresh: () => Promise<SettingsValues["list"] | undefined>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const fileRead = useRef(0);
  const [hash, setHash] = useState("");
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"overview" | "history" | "models">("overview");
  const [source, setSource] = useState("");
  const [sample, setSample] = useState("");
  const [check, setCheck] = useState<SettingsValues["pluginCheck"]>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const [remove, setRemove] = useState(false);
  const [copied, setCopied] = useState("");
  const [upgradeHash, setUpgradeHash] = useState("");
  const [upgradeReport, setUpgradeReport] = useState<SettingsValues["pluginUpgrade"]>();
  const groups = groupAdapters(data.plugins);
  const plugin = data.plugins.find((entry) => entry.hash === hash);
  const versions = groups.find(([entry]) => entry?.key === plugin?.key) ?? [];
  const references = data.providers.filter((provider) => provider.pluginHash === hash);
  const upgradeTargets = plugin ? adapterUpgradeTargets(plugin, versions) : [];
  const locked = references.some(({ enabled }) => enabled);
  const modalOpen = editing || Boolean(plugin);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (modalOpen && !element.open) element.showModal();
    if (!modalOpen && element.open) element.close();
  }, [modalOpen]);

  function showTab(next: typeof tab) {
    setTab(next);
    setRemove(false);
    if (body.current) body.current.scrollTop = 0;
  }

  function open(selected: PluginView, showUpgrade = false) {
    setHash(selected.hash);
    setEditing(false);
    setFeedback(undefined);
    setCopied("");
    setUpgradeReport(undefined);
    setUpgradeHash(
      showUpgrade ? (adapterUpgradeTargets(selected, data.plugins)[0]?.hash ?? "") : "",
    );
    showTab(showUpgrade ? "models" : "overview");
  }

  function edit(selected?: PluginView) {
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
    fileRead.current++;
    setHash("");
    setEditing(false);
    setFeedback(undefined);
    setRemove(false);
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
  const toggle = (entry: PluginView) =>
    perform(async () => {
      const result = await window.desktop.settings.pluginToggle({
        hash: entry.hash,
        enabled: entry.disabled,
      });
      if (!result.ok) return fail(result.code);
      await refresh();
      setFeedback({
        text: `已${entry.disabled ? "启用" : "停用"} ${entry.name} v${entry.version}`,
      });
    });
  const upgrade = () =>
    perform(async () => {
      setUpgradeReport(undefined);
      const result = await window.desktop.settings.pluginUpgrade({
        fromHash: hash,
        toHash: upgradeHash,
        approve: true,
      });
      if (!result.ok) return fail(result.code);
      setUpgradeReport(result.value);
      setUpgradeHash("");
      await refresh();
    });
  const removeVersion = () =>
    perform(async () => {
      const result = await window.desktop.settings.pluginRemove({ hash });
      if (!result.ok) return fail(result.code);
      const current = await refresh();
      const next =
        current &&
        groupAdapters(current.plugins).find(([entry]) => entry?.key === plugin?.key)?.[0];
      if (next) open(next);
      else closeDialog();
      setFeedback({ text: "已移除版本" });
    });
  const draft = () =>
    perform(async () => {
      const result = await window.desktop.settings.draft({ source });
      if (!result.ok) return fail(result.code);
      await refresh();
      open(result.value);
      showTab("history");
      setFeedback({ text: "已校验并保存版本，可在模型的调用协议中选择。" });
    });
  const checkSample = () =>
    perform(async () => {
      setCheck(undefined);
      const result = await window.desktop.settings.pluginCheck({
        source,
        sample: sample.trim() || undefined,
      });
      if (!result.ok) return fail(result.code);
      setCheck(result.value);
    });
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
      <div className="adapter-heading">
        <div>
          <h2>Provider 插件</h2>
          <p>
            {groups.length} 个插件 · {data.plugins.length} 个版本
          </p>
        </div>
        <button type="button" className="settings-primary" disabled={busy} onClick={() => edit()}>
          <Upload size={16} /> 导入适配器
        </button>
      </div>
      {!modalOpen && message}
      <AdapterCatalog
        groups={groups}
        providers={data.providers}
        initialHash={initialHash}
        busy={busy}
        open={open}
        toggle={(entry) => void toggle(entry)}
      />
      <dialog
        ref={dialog}
        className="adapter-dialog"
        aria-labelledby="adapter-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) closeDialog();
        }}
      >
        {modalOpen && (
          <div className="adapter-dialog-shell">
            <header className="adapter-dialog-header">
              {plugin ? (
                <Capability kind={plugin.kind} iconOnly />
              ) : (
                <span className="adapter-import-icon">
                  <Upload size={20} />
                </span>
              )}
              <div>
                <h2 id="adapter-dialog-title">
                  {editing ? (plugin ? "编辑适配器版本" : "导入适配器") : plugin?.name}
                </h2>
                <p>
                  {plugin ? (
                    <>
                      <code>{plugin.key}</code> · <code>v{plugin.version}</code>{" "}
                      <span className="adapter-badge">{adapterOrigins[plugin.origin]}</span>
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
              <nav className="adapter-tabs" aria-label="插件详情视图">
                <button
                  type="button"
                  aria-pressed={tab === "overview"}
                  onClick={() => showTab("overview")}
                >
                  <Info size={16} /> 概览
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "history"}
                  onClick={() => showTab("history")}
                >
                  <History size={16} /> 版本历史 <span>{versions.length}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "models"}
                  onClick={() => showTab("models")}
                >
                  <ArrowUpCircle size={16} /> 引用与升级 <span>{references.length}</span>
                </button>
              </nav>
            )}
            {message}
            <div ref={body} className="adapter-dialog-body">
              {editing ? (
                <form
                  id="adapter-import-form"
                  className="adapter-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void draft();
                  }}
                >
                  <label>
                    打开 JavaScript 文件
                    <input
                      type="file"
                      accept=".js,.cjs"
                      disabled={busy}
                      onChange={async ({ target }) => {
                        const file = target.files?.[0];
                        if (!file) return;
                        const read = ++fileRead.current;
                        if (file.size > providerPluginSourceLimit) {
                          setFeedback({ text: "文件超过 512 KiB。", error: true });
                          return;
                        }
                        try {
                          const text = await file.text();
                          if (read !== fileRead.current) return;
                          setSource(text);
                          setCheck(undefined);
                          setFeedback(undefined);
                        } catch {
                          if (read === fileRead.current)
                            setFeedback({ text: "无法读取文件。", error: true });
                        }
                      }}
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
              ) : (
                plugin && (
                  <>
                    {tab === "overview" && <AdapterOverview plugin={plugin} />}
                    {tab === "history" && (
                      <ol className="adapter-history" aria-label="适配器版本">
                        {versions.map((entry, index) => {
                          const count = data.providers.filter(
                            ({ pluginHash }) => pluginHash === entry.hash,
                          ).length;
                          return (
                            <li key={entry.hash} data-current={entry.hash === hash}>
                              <div className="adapter-history-title">
                                <button
                                  type="button"
                                  aria-pressed={entry.hash === hash}
                                  aria-label={`选择版本 v${entry.version}`}
                                  onClick={() => {
                                    open(entry);
                                    showTab("history");
                                  }}
                                >
                                  <code>v{entry.version}</code>
                                </button>
                                {index === 0 && <span className="adapter-badge">最新</span>}
                                <small>
                                  {adapterOrigins[entry.origin]} ·{" "}
                                  {count ? `${count} 个模型引用` : "无模型引用"} ·{" "}
                                  {entry.disabled ? "已停用" : "已启用"}
                                </small>
                              </div>
                              <div className="adapter-history-card">
                                <Capability kind={entry.kind} />
                                <div>
                                  <code title={entry.hash}>
                                    <Fingerprint size={15} /> {entry.hash.slice(0, 12)}
                                  </code>
                                  <button
                                    type="button"
                                    className="adapter-icon-button"
                                    aria-label={`复制 v${entry.version} 指纹`}
                                    onClick={async () => {
                                      try {
                                        await navigator.clipboard.writeText(entry.hash);
                                        setCopied(entry.hash);
                                      } catch {
                                        setFeedback({ text: "无法复制指纹。", error: true });
                                      }
                                    }}
                                  >
                                    {copied === entry.hash ? (
                                      <Check size={15} />
                                    ) : (
                                      <Copy size={15} />
                                    )}
                                  </button>
                                </div>
                              </div>
                              {entry.origin === "builtin" && (
                                <small className="adapter-history-note">
                                  <LockKeyhole size={13} /> 内置版本不可移除
                                </small>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                    {tab === "models" && (
                      <section className="adapter-section">
                        <h3>引用模型（{references.length}）</h3>
                        {references.length ? (
                          <ul className="adapter-references">
                            {references.map((reference) => (
                              <li key={reference.id}>
                                <strong>{reference.model}</strong>
                                <small>
                                  {reference.label} · {reference.enabled ? "已启用" : "已停用"}
                                </small>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="adapter-muted">暂无模型引用此版本。</p>
                        )}
                        {references.length > 0 && upgradeTargets.length > 0 && (
                          <div className="adapter-upgrade-form">
                            <label>
                              批量升级至
                              <select
                                value={upgradeHash}
                                disabled={busy}
                                onChange={({ target }) => setUpgradeHash(target.value)}
                              >
                                <option value="">请选择目标版本</option>
                                {upgradeTargets.map((entry) => (
                                  <option value={entry.hash} key={entry.hash}>
                                    v{entry.version} · {adapterOrigins[entry.origin]} ·{" "}
                                    {entry.hash.slice(0, 8)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="settings-primary"
                              disabled={busy || !upgradeHash}
                              onClick={() => void upgrade()}
                            >
                              确认升级 {references.length} 个模型
                            </button>
                          </div>
                        )}
                        {references.length > 0 && !upgradeTargets.length && (
                          <p className="adapter-muted">当前没有可切换的兼容版本。</p>
                        )}
                        {upgradeReport && (
                          <div role="status" className="adapter-field">
                            <p>
                              已升级 {upgradeReport.upgraded} 个模型，失败{" "}
                              {upgradeReport.failed.length} 个。
                            </p>
                            {upgradeReport.failed.map((entry) => (
                              <p key={entry.id}>
                                {entry.model} · {settingsError(entry.code)}
                              </p>
                            ))}
                          </div>
                        )}
                      </section>
                    )}
                  </>
                )
              )}
            </div>
            <footer className="adapter-dialog-footer">
              {editing ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => (plugin ? open(plugin) : closeDialog())}
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
                </>
              ) : (
                plugin &&
                (remove ? (
                  <>
                    <p>
                      移除 <code>v{plugin.version}</code>？
                    </p>
                    <button type="button" disabled={busy} onClick={() => setRemove(false)}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="adapter-danger"
                      disabled={busy || references.length > 0}
                      onClick={() => void removeVersion()}
                    >
                      确认移除
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy || (!plugin.disabled && locked)}
                      title={locked && !plugin.disabled ? "先停用引用此版本的模型" : undefined}
                      onClick={() => void toggle(plugin)}
                    >
                      {plugin.disabled ? "启用适配器" : "停用适配器"}
                    </button>
                    {plugin.origin !== "builtin" && (
                      <button
                        type="button"
                        className="adapter-danger"
                        disabled={busy || references.length > 0}
                        title={references.length ? "此版本仍被模型引用" : undefined}
                        onClick={() => setRemove(true)}
                      >
                        移除版本
                      </button>
                    )}
                    <button
                      type="button"
                      className="adapter-edit-button"
                      disabled={busy}
                      onClick={() => edit(plugin)}
                    >
                      基于此版本编辑
                    </button>
                  </>
                ))
              )}
            </footer>
          </div>
        )}
      </dialog>
    </div>
  );
}
