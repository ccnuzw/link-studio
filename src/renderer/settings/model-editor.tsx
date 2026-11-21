import {
  type ChannelView,
  type ModelConfig,
  type ModelKind,
  type ModelParameter,
  mediaGenerationOptions,
  modelGenerationModes,
  modelKindLabels,
  modelKinds,
  modelModeLabels,
  modelParameterChoices,
  modelParameterLabels,
  type PluginView,
  type ProviderFields,
  type ProviderView,
  validModelCapabilities,
} from "@link-studio/core";
import {
  Activity,
  Bot,
  Clapperboard,
  Eye,
  FlaskConical,
  Image,
  Info,
  Save,
  Search,
  SlidersHorizontal,
  Type,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ModelAvatar, ModelLogoPicker } from "./model-logo";
import { ModelTrial } from "./model-trial";
import { settingsError } from "./settings-page";
import { SettingsSwitch } from "./settings-switch";

const icons = { text: Type, image: Image, video: Clapperboard, audio: Activity, agent: Bot };
export function KindMark({ kind }: { kind: ModelKind }) {
  const Icon = icons[kind];
  return (
    <span className="model-kind" data-kind={kind}>
      <Icon size={15} /> {modelKindLabels[kind]}
    </span>
  );
}

export function ModelModal({
  title,
  subtitle,
  close,
  children,
  wide,
  avatar,
  logo,
  status,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  avatar?: string;
  logo?: string;
  status?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const label = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`model-dialog${wide ? " model-dialog-wide" : ""}`}
      aria-labelledby={label}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="model-dialog-head">
        <div className="model-dialog-identity">
          {avatar && <ModelAvatar name={avatar} logo={logo} />}
          <div>
            <div className="model-dialog-title">
              <h2 id={label}>{title}</h2>
              {status}
            </div>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        <button type="button" aria-label="关闭弹窗" onClick={close}>
          <X size={17} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function kindOf(profile: ProviderView, plugins: PluginView[]): ModelKind {
  const kind =
    profile.config?.kind ??
    (profile.agentEnabled
      ? "agent"
      : plugins.find(({ hash }) => hash === profile.pluginHash)?.kind);
  return modelKinds.find((item) => item === kind) ?? "text";
}

export function protocolDefaults(plugin?: PluginView): ProviderFields["channel"] {
  return Object.fromEntries(
    Object.entries(plugin?.fields ?? {}).flatMap(([key, field]) =>
      field.default === undefined ? [] : [[key, field.default]],
    ),
  );
}

export function ProtocolFields({
  plugin,
  settings,
  change,
}: {
  plugin?: PluginView;
  settings: ProviderFields["channel"];
  change: (settings: ProviderFields["channel"]) => void;
}) {
  const prefix = useId();
  return (
    <div className="model-fields">
      {Object.entries(plugin?.fields ?? {}).map(([key, field]) => {
        const value = settings[key] ?? field.default;
        const update = (next: string | number | boolean) => change({ ...settings, [key]: next });
        return (
          <label key={key} htmlFor={`${prefix}-${key}`}>
            {field.label}
            {field.type === "enum" ? (
              <select
                id={`${prefix}-${key}`}
                required={field.required}
                value={String(value ?? "")}
                onChange={(event) => update(event.target.value)}
              >
                {value === undefined && <option value="">请选择</option>}
                {field.options?.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : field.type === "boolean" ? (
              <input
                id={`${prefix}-${key}`}
                type="checkbox"
                checked={value === true}
                onChange={(event) => update(event.target.checked)}
              />
            ) : (
              <input
                id={`${prefix}-${key}`}
                type={field.type === "number" ? "number" : "text"}
                required={field.required}
                value={String(value ?? "")}
                onChange={(event) =>
                  update(field.type === "number" ? Number(event.target.value) : event.target.value)
                }
              />
            )}
            {field.description && <small>{field.description}</small>}
          </label>
        );
      })}
    </div>
  );
}

const defaults: ModelConfig = { kind: "text", name: "", description: "", sort: 100 };
type Tab = "basic" | "params" | "price";

function gatewaySettings(settings?: ProviderFields["channel"]): ProviderFields["channel"] {
  return {
    api: settings?.api === "responses" ? "responses" : "chat_completions",
    pathPrefix: typeof settings?.pathPrefix === "string" ? settings.pathPrefix : "/v1",
  };
}

export function ModelEditor({
  channel,
  model: initialModel,
  nextSort,
  plugins,
  close,
  saved,
}: {
  channel: ChannelView;
  model?: ProviderView;
  nextSort: number;
  plugins: PluginView[];
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [model, setModel] = useState(initialModel);
  const [trial, setTrial] = useState<ProviderView>();
  const [kindSelected, setKindSelected] = useState(Boolean(initialModel && !initialModel.pending));
  const [config, setConfig] = useState<ModelConfig>(
    model?.config ?? {
      ...defaults,
      sort: model ? (model.pendingSort ?? defaults.sort) : nextSort,
      ...(model && {
        kind: kindOf(model, plugins),
        name: model.model,
        ...(model.agentEnabled && { vision: model.agentVision }),
      }),
    },
  );
  const [upstreamModel, setUpstream] = useState(model?.model ?? "");
  const [pluginHash, setPlugin] = useState(
    config.kind === "agent" ? "" : (model?.pluginHash ?? ""),
  );
  const [settings, setSettings] = useState(
    config.kind === "agent" ? gatewaySettings(model?.channel) : (model?.channel ?? {}),
  );
  const [enabled, setEnabled] = useState(model?.enabled ?? false);
  const [tab, setTab] = useState<Tab>("basic");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const descriptionId = useId();
  const isAgent = config.kind === "agent";
  const gateways = plugins.filter(
    ({ key, origin, kind }) => key === "openai" && origin === "builtin" && kind === "text",
  );
  const plugin = isAgent
    ? ((model?.agentEnabled ? gateways.find(({ hash }) => hash === model.pluginHash) : undefined) ??
      gateways.findLast(({ disabled }) => !disabled) ??
      gateways.at(-1))
    : plugins.find(({ hash }) => hash === pluginHash);
  const eligible = plugins.filter(
    (item) => (!item.disabled || item.hash === pluginHash) && item.kind === config.kind,
  );
  const sorted = [...eligible].sort((left, right) =>
    right.version.localeCompare(left.version, undefined, { numeric: true }),
  );
  const versions = sorted.filter((item) => item.key === plugin?.key && item.kind === plugin?.kind);
  const results = sorted
    .filter((item) =>
      `${item.name} ${item.vendor} ${item.endpoint?.path} ${item.key} ${item.version}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .filter(
      (item, index, items) => items.findIndex((candidate) => candidate.key === item.key) === index,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const options = mediaGenerationOptions(
    config.kind,
    plugin?.origin === "builtin" ? plugin.key : undefined,
    upstreamModel,
    settings,
  );
  const patch = (values: Partial<ModelConfig>) =>
    setConfig((current) => ({ ...current, ...values }));
  const isLanguage = isAgent || config.kind === "text";
  const dirty =
    !model?.config ||
    upstreamModel !== model.model ||
    enabled !== model.enabled ||
    (!isAgent && pluginHash !== model.pluginHash) ||
    JSON.stringify(settings) !==
      JSON.stringify(isAgent ? gatewaySettings(model.channel) : model.channel) ||
    JSON.stringify(config) !== JSON.stringify(model.config);
  const params = modelParameterChoices(options);
  const modes = modelGenerationModes(config.kind, options);
  const displayName = config.name.trim() || upstreamModel.trim() || "新模型";
  const trialPlugin = plugins.find(({ hash }) => hash === trial?.pluginHash);
  const selectPlugin = (next?: PluginView) => {
    setPlugin(next?.hash ?? "");
    setSettings(protocolDefaults(next));
    patch({ params: undefined, refs: undefined, modes: undefined });
  };
  const chooseKind = (kind: ModelKind) => {
    setKindSelected(true);
    setConfig({
      ...defaults,
      kind,
      name: config.name,
      description: config.description,
      sort: config.sort,
      logo: config.logo,
    });
    setPlugin("");
    setSettings(kind === "agent" ? gatewaySettings() : {});
    setQuery("");
    setNotice("");
  };
  const save = async (forTrial = false) => {
    if (!config.name.trim() || !upstreamModel.trim() || !plugin || !kindSelected) {
      setTab("basic");
      setNotice(
        !config.name.trim() || !upstreamModel.trim()
          ? "请填写展示名称和上游模型标识。"
          : settingsError(isAgent ? "AGENT_MODEL_INCOMPATIBLE" : "MODEL_PENDING"),
      );
      return;
    }
    if (
      !validModelCapabilities(
        config,
        plugin?.origin === "builtin" ? plugin.key : undefined,
        upstreamModel.trim(),
        settings,
      )
    ) {
      setTab("params");
      setNotice(settingsError("MODEL_CAPABILITIES_INVALID"));
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const input = {
        id: model?.id,
        expectedRevision: model?.revision ?? 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        upstreamModel,
        config,
        ...(!isAgent && { pluginHash }),
        settings,
        enabled,
      };
      let result = await window.desktop.settings.modelSave(input);
      if (!result.ok && result.code === "MODEL_ENDPOINT_APPROVAL_REQUIRED") {
        const tokenUrl = settings.tokenUrl || "https://oauth2.googleapis.com/token";
        const gcsBaseUrl = settings.gcsBaseUrl || "https://storage.googleapis.com";
        if (
          window.confirm(
            `Vertex AI 凭证请求地址发生变更。\n令牌地址：${tokenUrl}\nGCS 下载地址：${gcsBaseUrl}\n确认使用这些地址？`,
          )
        ) {
          result = await window.desktop.settings.modelSave({ ...input, approve: true });
        }
      }
      if (!result.ok) setNotice(settingsError(result.code));
      else {
        setModel(result.value);
        setConfig(result.value.config ?? config);
        setSettings(isAgent ? gatewaySettings(result.value.channel) : result.value.channel);
        setUpstream(result.value.model);
        await saved();
        if (forTrial) setTrial(result.value);
        else close();
      }
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (!busy && (!dirty || window.confirm("放弃尚未保存的模型修改？"))) close();
  };
  const number = (
    label: string,
    name: "sort" | "contextWindow" | "maxOutputTokens" | "promptLimit" | "timeoutSeconds",
    max: number,
    placeholder?: string,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={name === "sort" ? 0 : 1}
        max={max}
        placeholder={placeholder}
        value={config[name] ?? ""}
        onChange={(event) =>
          patch({
            [name]:
              event.target.value === ""
                ? name === "sort"
                  ? 100
                  : undefined
                : Number(event.target.value),
          })
        }
      />
    </label>
  );
  return (
    <>
      <ModelModal
        title={model ? "编辑模型" : "新增模型"}
        subtitle={`${channel.name}${model ? ` · ${model.model}` : ""}`}
        avatar={displayName}
        logo={config.logo}
        status={
          <>
            <span className="model-status" data-online={model?.enabled}>
              {model?.pending ? "待配置" : model?.enabled ? "已上线" : "未上线"}
            </span>
            {dirty && <span className="model-pending">有未保存修改</span>}
          </>
        }
        close={cancel}
        wide
      >
        <nav className="model-tabs" aria-label="模型编辑分区">
          {(
            [
              ["basic", "基本信息", Info],
              ["params", "能力与参数", SlidersHorizontal],
              ["price", "积分定价", Activity],
            ] as const
          ).map(([key, text, Icon]) => (
            <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
              <Icon size={15} /> {text}
            </button>
          ))}
        </nav>
        <div className="model-editor-grid">
          <div className="model-dialog-body model-editor-form" key={tab}>
            {tab === "basic" && (
              <>
                <section>
                  <h3>模型身份</h3>
                  <div className="model-fields model-identity-fields">
                    <label>
                      展示名称
                      <input
                        maxLength={120}
                        placeholder="用户在画布里看到的名字"
                        value={config.name}
                        onChange={(event) => patch({ name: event.target.value })}
                      />
                    </label>
                    <label>
                      上游模型标识
                      <input
                        maxLength={200}
                        placeholder="上游服务使用的模型 ID"
                        value={upstreamModel}
                        onChange={(event) => setUpstream(event.target.value)}
                      />
                    </label>
                    <ModelLogoPicker
                      name={displayName}
                      value={config.logo}
                      change={(logo) => patch({ logo })}
                    />
                  </div>
                </section>
                <section>
                  <h3>能力与协议</h3>
                  <fieldset className="model-kind-picker" aria-label="模型能力">
                    <legend>模型能力</legend>
                    {modelKinds.map((kind) => (
                      <button
                        type="button"
                        key={kind}
                        aria-pressed={kindSelected && kind === config.kind}
                        onClick={() => {
                          if (!kindSelected || kind !== config.kind) chooseKind(kind);
                        }}
                      >
                        <KindMark kind={kind} />
                      </button>
                    ))}
                  </fieldset>
                  {isAgent ? (
                    <div className="model-protocol-info model-agent-gateway">
                      <strong>宿主网关</strong>
                      <p>由 Link Studio 使用当前渠道连接 Agent。</p>
                      <div className="model-fields">
                        <label>
                          接口格式
                          <select
                            value={String(settings.api)}
                            onChange={(event) =>
                              setSettings({ ...settings, api: event.target.value })
                            }
                          >
                            <option value="chat_completions">OpenAI Chat Completions</option>
                            <option value="responses">OpenAI Responses</option>
                          </select>
                        </label>
                        <label>
                          接口路径前缀
                          <input
                            maxLength={256}
                            placeholder="/v1"
                            value={String(settings.pathPrefix)}
                            onChange={(event) =>
                              setSettings({ ...settings, pathPrefix: event.target.value })
                            }
                          />
                          <small>留空使用 /v1。接口不带版本段时填 /。</small>
                        </label>
                      </div>
                    </div>
                  ) : (
                    <div className="model-protocol-grid">
                      <div className="model-protocol-picker">
                        <label>
                          调用协议
                          <span className="model-protocol-search">
                            <Search size={15} aria-hidden="true" />
                            <input
                              type="search"
                              placeholder="名称、厂商或请求路径"
                              value={query}
                              onChange={(event) => setQuery(event.target.value)}
                            />
                          </span>
                        </label>
                        <div className="model-protocol-list">
                          {results.map((item) => {
                            const endpoint = item.endpoint
                              ? `${item.endpoint.method} ${item.endpoint.path}`
                              : "—";
                            const vendor = `${item.vendor || "—"}${item.disabled ? " · 已停用" : ""}`;
                            return (
                              <button
                                key={item.hash}
                                type="button"
                                aria-pressed={item.key === plugin?.key}
                                onClick={() => {
                                  if (item.key !== plugin?.key) {
                                    setKindSelected(true);
                                    selectPlugin(item);
                                  }
                                }}
                              >
                                <span className="model-protocol-summary">
                                  <strong title={item.name}>{item.name}</strong>
                                  <code title={endpoint}>{endpoint}</code>
                                  <small title={vendor}>{vendor}</small>
                                </span>
                                <small className="model-protocol-mode">
                                  {item.mode === "async" ? "异步" : "同步"}
                                </small>
                                <span className="model-protocol-dot" aria-hidden="true" />
                              </button>
                            );
                          })}
                          {!results.length && <p>没有匹配的协议。</p>}
                        </div>
                      </div>
                      <div className="model-protocol-detail">
                        <h4>当前选择</h4>
                        <div className="model-protocol-info">
                          {plugin ? (
                            <>
                              <strong>{plugin.name}</strong>
                              <p>{plugin.description}</p>
                              {plugin.disabled && (
                                <small className="model-protocol-warning">插件已停用</small>
                              )}
                              <small>
                                {plugin.authName ?? plugin.auth} ·{" "}
                                {plugin.mode === "async" ? "异步" : "同步"}
                              </small>
                              <code>
                                {plugin.endpoint?.method} {plugin.endpoint?.path}
                              </code>
                              <label>
                                版本
                                <select
                                  aria-label="协议版本"
                                  value={pluginHash}
                                  onChange={(event) =>
                                    selectPlugin(
                                      versions.find(({ hash }) => hash === event.target.value),
                                    )
                                  }
                                >
                                  {versions.map((entry, index) => (
                                    <option key={entry.hash} value={entry.hash}>
                                      v{entry.version}
                                      {index === 0 ? "（最新）" : ""}
                                    </option>
                                  ))}
                                </select>
                                <small>保存后固定</small>
                              </label>
                              {Object.keys(plugin.fields ?? {}).length > 0 && (
                                <>
                                  <h4>协议设置</h4>
                                  <ProtocolFields
                                    plugin={plugin}
                                    settings={settings}
                                    change={setSettings}
                                  />
                                </>
                              )}
                            </>
                          ) : (
                            <p>未选择协议</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </section>
                <section>
                  <h3>展示信息</h3>
                  <div className="model-fields model-display-fields">
                    <label>
                      模型描述
                      <textarea
                        maxLength={500}
                        rows={3}
                        placeholder="说明适用场景和注意事项"
                        aria-describedby={descriptionId}
                        value={config.description}
                        onChange={(event) => patch({ description: event.target.value })}
                      />
                      <small id={descriptionId}>{config.description.length} / 500</small>
                    </label>
                    {number("排序", "sort", 100000)}
                  </div>
                </section>
              </>
            )}
            {tab === "params" && (
              <>
                <section>
                  <h3>{config.kind === "agent" ? "调用设置" : "任务设置"}</h3>
                  {number(
                    config.kind === "agent" ? "上游响应超时（秒）" : "任务超时（秒）",
                    "timeoutSeconds",
                    config.kind === "agent" ? 600 : 3600,
                    config.kind === "agent" ? "默认 90" : "默认运行时设置",
                  )}
                  <div className="model-chips">
                    {(config.kind === "agent"
                      ? [30, 60, 90, 120, 180, 300]
                      : [300, 600, 1200, 1800, 3600]
                    ).map((seconds) => (
                      <button
                        type="button"
                        key={seconds}
                        aria-pressed={config.timeoutSeconds === seconds}
                        onClick={() => patch({ timeoutSeconds: seconds })}
                      >
                        {seconds < 60
                          ? `${seconds} 秒`
                          : seconds % 60
                            ? `${seconds} 秒`
                            : `${seconds / 60} 分钟`}
                      </button>
                    ))}
                  </div>
                </section>
                {isLanguage && (
                  <section>
                    <h3>上下文能力</h3>
                    <div className="model-fields">
                      {number("上下文窗口（Token）", "contextWindow", 2000000, "32768")}
                      {number("最大输出（Token）", "maxOutputTokens", 200000)}
                    </div>
                    {config.kind === "agent" && (
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={config.vision === true}
                          onChange={(event) => patch({ vision: event.target.checked })}
                        />
                        能看图
                      </label>
                    )}
                    {config.kind === "text" && (
                      <label>
                        固定系统提示
                        <textarea
                          rows={3}
                          maxLength={16000}
                          value={config.systemPrompt ?? ""}
                          onChange={(event) => patch({ systemPrompt: event.target.value })}
                        />
                      </label>
                    )}
                  </section>
                )}
                {!!modes.length && (
                  <section>
                    <h3>生成方式</h3>
                    <div className="model-chips">
                      {modes.map((mode) => {
                        const selected = config.modes ?? modes;
                        return (
                          <button
                            type="button"
                            key={mode}
                            aria-pressed={selected.includes(mode)}
                            disabled={selected.length === 1 && selected.includes(mode)}
                            onClick={() =>
                              patch({
                                modes: selected.includes(mode)
                                  ? selected.filter((item) => item !== mode)
                                  : [...selected, mode],
                              })
                            }
                          >
                            {modelModeLabels[mode]}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
                {Object.values(options.references).some(Boolean) && (
                  <section>
                    <h3>参考素材</h3>
                    <div className="model-fields">
                      {(["image", "video", "audio"] as const).flatMap((kind) => {
                        const count = options.references[kind] ?? 0;
                        if (!count) return [];
                        const value = config.refs?.[kind] ?? { max: count, mb: 10 };
                        return [
                          <fieldset key={kind}>
                            <legend>参考{modelKindLabels[kind]}</legend>
                            <label>
                              最多数量
                              <input
                                type="number"
                                min={0}
                                max={count}
                                value={value.max}
                                onChange={(event) =>
                                  patch({
                                    refs: {
                                      ...config.refs,
                                      [kind]: { ...value, max: Number(event.target.value) },
                                    },
                                  })
                                }
                              />
                            </label>
                            <label>
                              单个最大 MB
                              <input
                                type="number"
                                min={1}
                                max={10}
                                value={value.mb}
                                onChange={(event) =>
                                  patch({
                                    refs: {
                                      ...config.refs,
                                      [kind]: { ...value, mb: Number(event.target.value) },
                                    },
                                  })
                                }
                              />
                            </label>
                          </fieldset>,
                        ];
                      })}
                    </div>
                  </section>
                )}
                <section>
                  <h3>提示词</h3>
                  {number(
                    "字数上限",
                    "promptLimit",
                    options.promptLimit,
                    String(options.promptLimit),
                  )}
                  {config.kind === "video" && (
                    <label>
                      提示词格式
                      <select
                        value={config.promptFormat ?? ""}
                        onChange={(event) =>
                          patch({
                            promptFormat: (event.target.value ||
                              undefined) as ModelConfig["promptFormat"],
                          })
                        }
                      >
                        <option value="">通用</option>
                        <option value="seedance">Seedance</option>
                        <option value="h3">MiniMax H3</option>
                      </select>
                    </label>
                  )}
                </section>
                {!isLanguage && (
                  <section>
                    <h3>生成参数</h3>
                    {(config.params || config.refs || config.modes) && (
                      <button
                        type="button"
                        onClick={() =>
                          patch({ params: undefined, refs: undefined, modes: undefined })
                        }
                      >
                        恢复协议默认能力与参数
                      </button>
                    )}
                    {(Object.entries(params) as [ModelParameter, readonly (string | number)[]][])
                      .filter(([, values]) => values.length > 0)
                      .map(([key, raw]) => {
                        const all = raw.map(String);
                        const value = config.params?.[key] ?? {
                          values: all,
                          default: all[0] ?? "",
                        };
                        const update = (values: string[], preferred: string) => {
                          const params = {
                            ...config.params,
                            [key]: { values, default: preferred },
                          };
                          if (key === "size") {
                            delete params.aspectRatio;
                            delete params.resolution;
                          }
                          if (key === "aspectRatio" || key === "resolution") delete params.size;
                          patch({ params });
                        };
                        return (
                          <fieldset key={key}>
                            <legend>{modelParameterLabels[key]}</legend>
                            <div className="model-chips">
                              {all.map((item) => (
                                <button
                                  type="button"
                                  key={item}
                                  aria-pressed={value.values.includes(item)}
                                  disabled={
                                    value.values.length === 1 && value.values.includes(item)
                                  }
                                  onClick={() => {
                                    const values = value.values.includes(item)
                                      ? value.values.filter((entry) => entry !== item)
                                      : all.filter(
                                          (entry) => entry === item || value.values.includes(entry),
                                        );
                                    update(
                                      values,
                                      values.includes(value.default)
                                        ? value.default
                                        : (values[0] ?? ""),
                                    );
                                  }}
                                >
                                  {item}
                                </button>
                              ))}
                            </div>
                            <label>
                              默认{modelParameterLabels[key]}
                              <select
                                value={value.default}
                                onChange={(event) => update(value.values, event.target.value)}
                              >
                                {value.values.map((item) => (
                                  <option key={item}>{item}</option>
                                ))}
                              </select>
                            </label>
                          </fieldset>
                        );
                      })}
                  </section>
                )}
              </>
            )}
            {tab === "price" && (
              <section>
                <h3>积分定价</h3>
                <p className="muted">用于本地记录和模型预览。桌面版不扣减积分。</p>
                <label>
                  计价方式
                  <select
                    value={config.pricing?.unit ?? ""}
                    onChange={(event) => {
                      const unit = event.target.value as NonNullable<
                        ModelConfig["pricing"]
                      >["unit"];
                      patch({
                        pricing: unit ? { unit, input: config.pricing?.input ?? 0 } : undefined,
                      });
                    }}
                  >
                    <option value="">未设置</option>
                    <option value="request">按次</option>
                    {config.kind === "video" && <option value="second">按秒</option>}
                    {isLanguage && <option value="token">按百万 Token</option>}
                  </select>
                </label>
                {config.pricing && (
                  <div className="model-fields">
                    <label>
                      {config.pricing.unit === "token" ? "输入积分" : "积分"}
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={config.pricing.input}
                        onChange={(event) => {
                          if (config.pricing)
                            patch({
                              pricing: { ...config.pricing, input: Number(event.target.value) },
                            });
                        }}
                      />
                    </label>
                    {config.pricing.unit === "token" && (
                      <label>
                        输出积分
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={config.pricing.output ?? 0}
                          onChange={(event) => {
                            if (config.pricing)
                              patch({
                                pricing: { ...config.pricing, output: Number(event.target.value) },
                              });
                          }}
                        />
                      </label>
                    )}
                  </div>
                )}
              </section>
            )}
          </div>
          <aside className="model-preview" aria-label="创作端预览">
            <h3>
              <Eye size={16} />{" "}
              {tab === "params"
                ? "画布节点预览"
                : tab === "price"
                  ? "创作端预览 · 积分定价"
                  : "创作端预览 · 模型选择器"}
            </h3>
            <div className="model-preview-card">
              <div className="model-preview-identity">
                <ModelAvatar name={displayName} logo={config.logo} />
                <div>
                  <strong>{displayName}</strong>
                  {kindSelected && <KindMark kind={config.kind} />}
                  {config.description && <p>{config.description}</p>}
                </div>
              </div>
              {tab === "params" && (
                <>
                  <div className="model-chips">
                    {(config.modes ?? modes).map((mode) => (
                      <span key={mode}>{modelModeLabels[mode]}</span>
                    ))}
                  </div>
                  <div className="model-preview-prompt">
                    描述你想生成的内容…
                    <small>
                      0 / {Math.min(config.promptLimit ?? options.promptLimit, options.promptLimit)}
                    </small>
                  </div>
                  {Object.entries(params)
                    .filter(([, values]) => values.length > 0 && !isLanguage)
                    .map(([name, values]) => (
                      <div className="model-preview-parameter" key={name}>
                        <small>{modelParameterLabels[name as ModelParameter]}</small>
                        <div className="model-chips">
                          {(config.params?.[name as ModelParameter]?.values ?? values)
                            .slice(0, 10)
                            .map((value) => (
                              <span key={value}>{value}</span>
                            ))}
                        </div>
                      </div>
                    ))}
                </>
              )}
              {config.pricing && (
                <small>
                  {config.pricing.input} 积分 /{" "}
                  {config.pricing.unit === "request"
                    ? "次"
                    : config.pricing.unit === "second"
                      ? "秒"
                      : "百万输入 Token"}
                </small>
              )}
            </div>
          </aside>
        </div>
        {notice && (
          <p role="status" className="model-notice">
            {notice}
          </p>
        )}
        <footer className="model-dialog-footer">
          <SettingsSwitch
            label="模型上线"
            text={enabled ? "已上线" : "未上线"}
            checked={enabled}
            disabled={!plugin || !kindSelected || busy || (plugin.disabled && !enabled)}
            reason={
              !plugin || !kindSelected
                ? isAgent
                  ? "宿主网关不可用"
                  : "请先选择模型能力与调用协议"
                : plugin.disabled && !enabled
                  ? "插件已停用"
                  : undefined
            }
            onChange={setEnabled}
          />
          <div className="settings-actions">
            <button
              type="button"
              disabled={busy || !plugin || plugin.disabled || !channel.enabled || !kindSelected}
              title={dirty ? "开始前会先保存修改" : "测试模型"}
              onClick={() => {
                if (dirty || !model) void save(true);
                else setTrial(model);
              }}
            >
              <FlaskConical size={15} /> 测试模型
            </button>
            <button type="button" disabled={busy} onClick={cancel}>
              取消
            </button>
            <button
              type="button"
              className="settings-primary"
              disabled={busy}
              onClick={() => void save()}
            >
              <Save size={15} /> 保存模型
            </button>
          </div>
        </footer>
      </ModelModal>
      {trial && trialPlugin && (
        <ModelTrial model={trial} plugin={trialPlugin} close={() => setTrial(undefined)} />
      )}
    </>
  );
}
