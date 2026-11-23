import { Switch } from "@base-ui/react/switch";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  type ChannelView,
  EditableModelDocument,
  hasNumericDuration,
  type ModelConfig,
  type ModelKind,
  type ModelParameter,
  maxModelReferenceMB,
  mediaGenerationOptions,
  modelGenerationModes,
  modelGenerationOptions,
  modelKindLabels,
  modelKinds,
  modelModeLabels,
  modelParameterChoices,
  modelParameterLabels,
  modelPriceLabel,
  type PluginView,
  type ProviderFields,
  type ProviderView,
  priceDimensions,
  pricingIssues,
  type SettingsInput,
  validModelCapabilities,
} from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import {
  AudioLines,
  Bot,
  Braces,
  Check,
  CircleAlert,
  CircleHelp,
  Clapperboard,
  Coins,
  Eye,
  FlaskConical,
  Image,
  Info,
  Save,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  Type,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChoiceButton } from "../choice-button";
import { CatalogSelect } from "./adapter-catalog";
import { groupAdapters } from "./catalog-version-order";
import { CustomEnumEditor } from "./custom-enum-editor";
import { DurationRangeEditor } from "./duration-range-editor";
import { jsonPosition } from "./json-position";
import { locateJsonError } from "./json-syntax";
import { ModelContext } from "./model-context";
import {
  DocumentIssue,
  decodeModelBody,
  encodeModelBody,
  inspectOfflineBody,
  modelContextIssue,
  paramNames,
} from "./model-document";
import { readDuration } from "./model-duration";
import {
  editedModelText,
  isLegacyModelDraft,
  isModelObject,
  projectModelDraft,
} from "./model-json-draft";
import { applyKindTemplate, rebindTemplate } from "./model-kind-template";
import { ModelAvatar, ModelLogoPicker } from "./model-logo";
import { PricingPreview, PricingRules } from "./model-pricing";
import { ModelTags } from "./model-tags";
import { ModelTrial } from "./model-trial";
import { TrialInputCard, useTrialInputs } from "./model-trial-input";
import { ParameterHeading } from "./parameter-heading";
import { reportChannelAction } from "./plugin-notice";
import {
  type ProtocolLoadState,
  protocolAuth,
  protocolSwitchNotice,
  protocolValues,
  submittedSettings,
} from "./protocol-settings";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";
import { SettingsSwitch } from "./settings-switch";
import { useSettingsConfirm } from "./use-settings-confirm";

const icons = { text: Type, image: Image, video: Clapperboard, audio: AudioLines, agent: Bot };
const kindDescriptions = {
  text: "对话、写作",
  image: "文生图、图生图",
  video: "文生、图生视频",
  audio: "语音合成",
  agent: "画布 Agent 的对话大模型",
};
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
  variant,
  avatar,
  avatarSeed,
  logo,
  headerIcon,
  status,
}: {
  title: string;
  subtitle?: ReactNode;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  variant?:
    | "channel-delete"
    | "filing-remove"
    | "filing-detail"
    | "human-picker"
    | "human-enroll"
    | "channel-keys"
    | "channel-edit"
    | "trial"
    | "plugin-upgrade"
    | "destructive-confirm"
    | "batch-edit"
    | "batch-result"
    | "batch-protocol"
    | "batch-import";
  avatar?: string;
  avatarSeed?: string;
  logo?: string;
  headerIcon?: ReactNode;
  status?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const label = useId();
  const alert =
    variant === "destructive-confirm" ||
    variant === "filing-remove" ||
    variant === "plugin-upgrade";
  useLayoutEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    if (dialog?.querySelector(".model-json-entry") === document.activeElement)
      dialog
        ?.querySelector<HTMLButtonElement>(".model-dialog-head > button")
        ?.focus({ preventScroll: true });
    if (dialog?.dataset.variant === "batch-result")
      dialog.querySelector<HTMLElement>("footer button")?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`model-dialog${wide ? " model-dialog-wide" : ""}`}
      data-variant={variant}
      role={alert ? "alertdialog" : undefined}
      closedby={alert ? "closerequest" : "any"}
      aria-labelledby={label}
      aria-describedby={
        (alert || variant === "batch-result" || variant === "channel-delete") && subtitle
          ? `${label}-description`
          : undefined
      }
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <header className="model-dialog-head">
        <div className="model-dialog-identity">
          {headerIcon}
          {avatar && <ModelAvatar name={avatar} logo={logo} seed={avatarSeed} />}
          <div>
            <div className="model-dialog-title">
              <h2 id={label}>{title}</h2>
              {status}
            </div>
            {subtitle && <p id={`${label}-description`}>{subtitle}</p>}
          </div>
        </div>
        {variant !== "batch-result" && !alert && (
          <button type="button" aria-label="关闭弹窗" onClick={close}>
            <X size={17} />
          </button>
        )}
      </header>
      {children}
      {variant === "batch-result" && (
        <button className="batch-result-close" type="button" aria-label="关闭" onClick={close}>
          <X size={16} />
        </button>
      )}
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

export function protocolIssue(field: PluginView["fields"][string], value: unknown) {
  if (value === undefined || (typeof value === "string" && !value.trim()))
    return field.required ? `请填写${field.label}` : undefined;
  if (field.type === "enum") {
    if (typeof value !== "string" || !field.options?.includes(value))
      return `请选择有效的${field.label}`;
  } else if (typeof value !== field.type) return `${field.label}的值类型不正确`;
}

export function ProtocolFields({
  plugin,
  settings,
  change,
  container,
}: {
  plugin?: PluginView;
  settings: ProviderFields["channel"];
  change: (settings: ProviderFields["channel"]) => void;
  container: HTMLDialogElement | null;
}) {
  const prefix = useId();
  return (
    <div className="model-fields">
      {Object.entries(plugin?.fields ?? {}).map(([key, field]) => {
        const value = settings[key] ?? field.default;
        const error = protocolIssue(field, value);
        const attrs = {
          "data-field": `setting-${key}`,
          "aria-invalid": !!error,
          "aria-describedby": error ? `${prefix}-${key}-error` : undefined,
        };
        const update = (next: string | number | boolean) => change({ ...settings, [key]: next });
        return (
          <label key={key} htmlFor={`${prefix}-${key}`}>
            <span>
              {field.label}
              {field.required && field.type !== "boolean" && (
                <span className="protocol-required-mark" aria-hidden="true">
                  *
                </span>
              )}
            </span>
            {field.type === "enum" ? (
              <CatalogSelect
                id={`${prefix}-${key}`}
                label={field.label}
                field={attrs["data-field"]}
                description={attrs["aria-describedby"]}
                invalid={!!error}
                container={container}
                viewportPopup
                value={String(value ?? "")}
                options={[
                  ["", field.required ? "请选择" : "（不设置）"],
                  ...(field.options ?? []).map((option) => [option, option] as const),
                ]}
                change={update}
              />
            ) : field.type === "boolean" ? (
              <span className="protocol-switch-row">
                <Switch.Root
                  {...attrs}
                  id={`${prefix}-${key}`}
                  aria-label={field.label}
                  checked={value === true}
                  onCheckedChange={update}
                  className="protocol-setting-switch"
                >
                  <Switch.Thumb />
                </Switch.Root>
              </span>
            ) : (
              <input
                {...attrs}
                id={`${prefix}-${key}`}
                type={field.type === "number" ? "number" : "text"}
                required={field.required}
                value={String(value ?? "")}
                onChange={(event) =>
                  update(
                    field.type === "number"
                      ? event.target.value === ""
                        ? ""
                        : Number(event.target.value)
                      : event.target.value,
                  )
                }
              />
            )}
            {error ? (
              <small
                id={`${prefix}-${key}-error`}
                className="model-field-note"
                role="alert"
                data-error="true"
              >
                {error}
              </small>
            ) : (
              <small>{field.description || key}</small>
            )}
          </label>
        );
      })}
    </div>
  );
}

const defaults: ModelConfig = { kind: "text", name: "", description: "", sort: 100 };
type Tab = "basic" | "params" | "price";

function DisabledReason({ reason, children }: { reason?: string; children: ReactNode }) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  if (!reason) return children;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The disabled control cannot receive focus, so its wrapper handles tooltip dismissal.
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: This is the keyboard entry point for the disabled control’s explanation.
      tabIndex={0}
      aria-describedby={id}
      className="model-disabled-reason"
      data-dismissed={dismissed || undefined}
      onMouseEnter={() => setDismissed(false)}
      onFocus={() => setDismissed(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !dismissed) {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(true);
        }
      }}
    >
      {children}
      <span id={id} role="tooltip" className="batch-tool-tip model-disabled-tip">
        {reason}
      </span>
    </span>
  );
}

function gatewaySettings(settings?: ProviderFields["channel"]): ProviderFields["channel"] {
  if (settings?.api === "gemini") return { api: "gemini" };
  return {
    api: settings?.api === "responses" ? "responses" : "chat_completions",
    pathPrefix: typeof settings?.pathPrefix === "string" ? settings.pathPrefix : "",
  };
}

function ModelFieldLabel({
  text,
  required,
  tip,
}: {
  text: string;
  required?: boolean;
  tip?: string;
}) {
  const [trigger, setTrigger] = useState<HTMLSpanElement | null>(null);
  return (
    <span className="model-field-label">
      {required && (
        <span aria-hidden="true" className="model-required">
          *
        </span>
      )}
      {text}
      {tip && (
        <Tooltip.Provider delay={0}>
          <Tooltip.Root>
            <Tooltip.Trigger render={<span />} ref={setTrigger} tabIndex={0} aria-label={tip}>
              <CircleHelp size={14} />
            </Tooltip.Trigger>
            <Tooltip.Portal container={trigger?.closest("dialog")}>
              <Tooltip.Positioner side="top" sideOffset={4} className="batch-tool-tip-position">
                <Tooltip.Popup className="batch-tool-tip model-field-tooltip">
                  {tip}
                  <Tooltip.Arrow className="batch-tool-tip-arrow" />
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      )}
    </span>
  );
}

function AgentInterfaceFields({
  settings,
  setSettings,
}: {
  settings: ProviderFields["channel"];
  setSettings: (settings: ProviderFields["channel"]) => void;
}) {
  const field = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLDialogElement | null>(null);
  useLayoutEffect(() => setContainer(field.current?.closest("dialog") ?? null), []);
  const formats: [string, string][] = [
    ["chat_completions", "OpenAI 兼容"],
    ["gemini", "Gemini 原生"],
  ];
  if (settings.api === "responses") formats.push(["responses", "OpenAI Responses"]);
  return (
    <>
      <div className="model-agent-format" ref={field}>
        接口格式
        <CatalogSelect
          label="接口格式"
          value={String(settings.api)}
          options={formats}
          container={container}
          change={(api) => setSettings(gatewaySettings({ ...settings, api }))}
        />
      </div>
      {settings.api !== "gemini" && (
        <label>
          <ModelFieldLabel
            text="接口路径前缀"
            tip="请求路径是「渠道地址 + 前缀 + /chat/completions」。不填按 /v1；上游是 /v4、/api/v3 之类时填对应值；路径不带版本段填 /。"
          />
          <input
            aria-label="接口路径前缀"
            maxLength={256}
            placeholder="/v1"
            value={String(settings.pathPrefix)}
            onChange={(event) => setSettings({ ...settings, pathPrefix: event.target.value })}
          />
        </label>
      )}
    </>
  );
}

export function ModelProtocolPicker({
  selectedKind,
  plugins,
  pluginsStatus,
  pluginHash,
  settings,
  chooseKind,
  selectPlugin,
  setSettings,
  kindHint,
}: {
  selectedKind?: ModelKind;
  plugins: PluginView[];
  pluginsStatus: ProtocolLoadState;
  pluginHash: string;
  settings: ProviderFields["channel"];
  chooseKind: (kind: ModelKind) => void;
  selectPlugin: (plugin: PluginView, values: ProviderFields["channel"]) => void;
  setSettings: (settings: ProviderFields["channel"]) => void;
  kindHint?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [versionHint, setVersionHint] = useState("");
  const kindPicker = useRef<HTMLFieldSetElement>(null);
  const [container, setContainer] = useState<HTMLDialogElement | null>(null);
  useLayoutEffect(() => setContainer(kindPicker.current?.closest("dialog") ?? null), []);
  const plugin = plugins.find((entry) => entry.hash === pluginHash);
  const groups = groupAdapters(plugins);
  const pluginVersions = groups.find(([latest]) => latest?.key === plugin?.key) ?? [];
  const versions = pluginVersions.filter(
    (item) => item.kind === selectedKind || item.hash === pluginHash,
  );
  const options = groups.flatMap(([latest]) =>
    latest && latest.kind === selectedKind ? [latest] : [],
  );
  const results = options
    .filter((item) =>
      [
        item.name,
        item.key,
        item.vendor ?? "",
        item.endpoint?.path ?? "",
        `${item.endpoint?.method || "POST"} ${item.endpoint?.path ?? ""}`,
      ]
        .join("\n")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((left, right) => Number(left.disabled) - Number(right.disabled));
  return (
    <>
      <fieldset
        ref={kindPicker}
        className="model-kind-picker"
        aria-label="模型能力"
        data-field="kind"
        tabIndex={-1}
      >
        <legend>
          <ModelFieldLabel text="模型能力" required />
        </legend>
        <div className="model-kind-segments">
          {modelKinds.map((kind) => (
            <button
              type="button"
              key={kind}
              disabled={pluginsStatus !== "ready"}
              aria-pressed={kind === selectedKind}
              title={`${modelKindLabels[kind]}：${kindDescriptions[kind]}`}
              onClick={() => {
                if (kind !== selectedKind) void chooseKind(kind);
              }}
            >
              <KindMark kind={kind} />
            </button>
          ))}
        </div>
      </fieldset>
      {kindHint}
      {selectedKind && selectedKind !== "agent" && pluginsStatus === "error" && (
        <div role="alert" className="protocol-load-error">
          <CircleAlert size={16} />
          <div>
            <strong>协议列表加载失败</strong>
            <p>刷新页面后再试。</p>
          </div>
        </div>
      )}
      {selectedKind && selectedKind !== "agent" && pluginsStatus === "loading" && (
        <div
          className="protocol-loading"
          role="status"
          aria-busy="true"
          aria-label="协议列表加载中"
        >
          <span />
          <span />
        </div>
      )}
      {selectedKind && selectedKind !== "agent" && pluginsStatus === "ready" && (
        <div className="model-protocol-grid">
          <label className="model-protocol-picker">
            <span>
              <span aria-hidden="true" className="protocol-required">
                *
              </span>
              调用协议
            </span>
            <span className="model-protocol-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                data-field="protocol"
                aria-label="搜索协议"
                autoComplete="off"
                placeholder="搜索协议名称、厂商或请求路径"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </span>
          </label>
          <div className="model-protocol-list" role="radiogroup" aria-label="调用协议">
            {results.map((item) => {
              const endpoint = `${item.endpoint?.method || "POST"} ${item.endpoint?.path || "—"}`;
              const vendor = item.vendor || "—";
              return (
                <ChoiceButton
                  key={item.hash}
                  type="button"
                  role="radio"
                  aria-checked={item.key === plugin?.key}
                  aria-disabled={item.disabled}
                  title={item.disabled ? "插件已停用，不可选" : undefined}
                  onClick={() => {
                    if (!item.disabled && item.key !== plugin?.key) {
                      setVersionHint("");
                      selectPlugin(item, protocolValues(item.fields));
                    }
                  }}
                >
                  <span className="model-protocol-summary">
                    <strong title={item.name}>{item.name}</strong>
                    <code title={endpoint}>{endpoint}</code>
                    {item.disabled && (
                      <small className="model-protocol-warning">插件已停用，不可选</small>
                    )}
                  </span>
                  <small className="model-protocol-vendor" title={vendor}>
                    {vendor}
                  </small>
                  <small className="model-protocol-mode">
                    {item.mode === "async" ? "异步" : "同步"}
                  </small>
                  <span className="model-protocol-dot" aria-hidden="true" />
                </ChoiceButton>
              );
            })}
            {!results.length && (
              <p>
                {options.length
                  ? "没有匹配的协议"
                  : `没有支持“${modelKindLabels[selectedKind]}”的协议插件`}
              </p>
            )}
          </div>
          <div className="model-protocol-detail">
            <div className="model-protocol-info">
              {plugin ? (
                <>
                  <div className="protocol-heading">
                    <strong>{plugin.name}</strong>
                    <code>{plugin.key}</code>
                  </div>
                  <p>{plugin.description}</p>
                  {plugin.disabled && (
                    <small className="model-protocol-warning">插件已停用，模型无法启用</small>
                  )}
                  {plugin.kind !== selectedKind && (
                    <small className="model-protocol-warning">
                      该版本不支持{modelKindLabels[selectedKind]}
                    </small>
                  )}
                  <div className="protocol-badges">
                    <span>{protocolAuth(plugin)}</span>
                    <span>{plugin.mode === "async" ? "异步" : "同步"}</span>
                    <code>
                      {plugin.endpoint?.method || "POST"} {plugin.endpoint?.path || "—"}
                    </code>
                  </div>
                  <label>
                    版本
                    <CatalogSelect
                      label="协议版本"
                      value={pluginHash}
                      container={container}
                      viewportPopup
                      options={versions.map((entry) => [
                        entry.hash,
                        `v${entry.version}${entry.hash === pluginVersions[0]?.hash ? "（最新）" : ""}`,
                      ])}
                      change={(value) => {
                        const next = versions.find(({ hash }) => hash === value);
                        if (!next || next.hash === pluginHash) return;
                        const dropped = Object.keys(submittedSettings(settings)).filter(
                          (key) => !Object.hasOwn(next.fields, key),
                        );
                        setVersionHint(
                          dropped.length
                            ? `新版本不再声明协议设置项：${dropped.join("、")}，已丢弃`
                            : "",
                        );
                        selectPlugin(next, protocolValues(next.fields, settings));
                      }}
                    />
                    <small>保存后固定</small>
                  </label>
                  {versionHint && (
                    <p role="status" className="model-protocol-warning">
                      {versionHint}
                    </p>
                  )}
                  {Object.keys(plugin.fields ?? {}).length > 0 && (
                    <>
                      <h4>协议设置</h4>
                      <ProtocolFields
                        plugin={plugin}
                        settings={settings}
                        change={setSettings}
                        container={container}
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
    </>
  );
}

type EditorProps = {
  channel: ChannelView;
  providers: ProviderView[];
  channels: ChannelView[];
  model?: ProviderView;
  plugins: PluginView[];
  pluginsStatus: ProtocolLoadState;
  close: () => void;
  saved: () => Promise<void>;
};

type StoredDraft = { document: string; text: string };

export function ModelEditor(props: EditorProps) {
  const [draft, setDraft] = useState<StoredDraft>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { id, revision, hasDocumentDraft } = props.model ?? {};
  useEffect(() => {
    if (!hasDocumentDraft || !id || revision === undefined) return;
    let active = true;
    setError("");
    settingsRequests
      .modelDraftRead({ id, expectedRevision: revision })
      .then((result) => {
        if (active) {
          if (result.ok) setDraft(result.value);
          else setError(settingsError(result.code));
        }
      })
      .catch(() => {
        if (active) setError(settingsError("MODEL_DRAFT_UNAVAILABLE"));
      });
    return () => {
      active = false;
    };
  }, [id, revision, hasDocumentDraft, attempt]);
  if (hasDocumentDraft && !draft)
    return (
      <ModelModal title="编辑模型" close={props.close} wide>
        <p role="status">{error || "正在读取配置正文…"}</p>
        {error && (
          <button type="button" onClick={() => setAttempt(attempt + 1)}>
            重试
          </button>
        )}
      </ModelModal>
    );
  return <ModelEditorForm {...props} stored={draft} />;
}

function ModelEditorForm({
  channel: sourceChannel,
  providers,
  channels,
  model: initialModel,
  plugins,
  pluginsStatus,
  close,
  saved,
  stored,
}: EditorProps & { stored?: StoredDraft }) {
  const [model, setModel] = useState(initialModel);
  const [targetId, setTargetId] = useState(sourceChannel.id);
  const channel = channels.find((entry) => entry.id === targetId) ?? sourceChannel;
  const [trial, setTrial] = useState<ProviderView>();
  const [kindSelected, setKindSelected] = useState(Boolean(initialModel && !initialModel.pending));
  const [config, setConfig] = useState<ModelConfig>(
    model?.config ?? {
      ...defaults,
      sort: model?.pendingSort ?? defaults.sort,
      timeoutSeconds: model?.pendingDeadlineSeconds,
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
  const [durationDraft, setDurationDraft] = useState<string>();
  const previewInputs = useTrialInputs();
  const [tab, setTab] = useState<Tab>("basic");
  const [json, setJson] = useState<string>();
  const [jsonError, setJsonError] = useState<{
    message: string;
    position: number;
    syntax: boolean;
    notObject: boolean;
    legacy: boolean;
  }>();
  const [modeError, setModeError] = useState("");
  const beforeError = jsonError && json?.slice(0, jsonError.position).split("\n");
  const errorLocation =
    beforeError && `第 ${beforeError.length} 行 第 ${beforeError.at(-1)!.length + 1} 列`;
  const jsonProblem =
    jsonError &&
    `${jsonError.syntax ? "JSON 语法错误" : "模型配置错误"}${json?.trim() ? `（${errorLocation}）` : ""}：${jsonError.message}`;
  const jsonInput = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const jsonInitialConfig = useRef<{ document: string; config: ModelConfig } | undefined>(
    undefined,
  );
  const { confirm, confirmation } = useSettingsConfirm();
  const readDocument = (raw: unknown, inherited = jsonInitialConfig.current) => {
    if (!isModelObject(raw)) throw new DocumentIssue("", "正文必须是 JSON 对象，才能切回表单。");
    const canonical = !isLegacyModelDraft(raw) ? decodeModelBody(raw, plugins) : undefined;
    if (canonical && inherited) {
      const baseline = JSON.parse(inherited.document);
      if (
        baseline.kind === canonical.config.kind &&
        JSON.stringify(baseline.capabilities?.params) ===
          JSON.stringify((raw as typeof baseline).capabilities?.params)
      ) {
        const previous = inherited.config;
        canonical.config.params = previous.params;
        canonical.config.generateAudio = previous.generateAudio;
        const inheritedModes = previous.pricing?.tiers?.some((tier) =>
          Object.hasOwn(tier.when, "op"),
        );
        if (
          previous.parameterOrder ||
          !canonical.config.pricing?.tiers?.some((tier) => Object.hasOwn(tier.when, "op")) ||
          inheritedModes
        ) {
          canonical.config.parameterOrder = previous.parameterOrder;
        }
      }
    }
    if (canonical?.key && model && canonical.key !== (model.modelKey ?? model.id))
      throw new DocumentIssue("/key", "模型标识与当前编辑的模型不一致");
    if (canonical?.enabled !== undefined && canonical.enabled !== enabled)
      throw new DocumentIssue("/enabled", "请使用模型上线开关修改状态");
    const value: unknown = canonical
      ? {
          config: canonical.config,
          pluginHash: canonical.pluginHash,
          settings: canonical.settings,
          channels: canonical.channels,
        }
      : raw;
    if (!Value.Check(EditableModelDocument, value)) {
      const issue = Value.Errors(EditableModelDocument, value).First();
      throw new DocumentIssue(issue?.path ?? "", issue?.message || "字段无效");
    }
    const binding = value.channels?.[0];
    if (binding && !channels.some((entry) => entry.id === binding.channel)) {
      throw new DocumentIssue("/channels/0/channel", "未找到指定的渠道");
    }
    if (
      binding &&
      value.upstreamModel !== undefined &&
      binding.upstream_model !== value.upstreamModel
    ) {
      throw new DocumentIssue("/upstreamModel", "上游模型标识不一致");
    }
    return { value, kindSelected: canonical?.kindSelected };
  };
  const applyDocument = (value: typeof EditableModelDocument.static, selectedKind?: boolean) => {
    const binding = value.channels?.[0];
    setTargetId(binding?.channel ?? sourceChannel.id);
    setDurationDraft(undefined);
    setUpstream(binding?.upstream_model ?? value.upstreamModel ?? "");
    setPlugin(value.config.kind === "agent" ? "" : value.pluginHash);
    setSettings(value.config.kind === "agent" ? gatewaySettings(value.settings) : value.settings);
    if (selectedKind !== undefined) setKindSelected(selectedKind);
    else if (value.config.kind !== config.kind || value.pluginHash || value.config.kind === "agent")
      setKindSelected(true);
    setConfig(value.config);
  };
  const changeJson = (text: string) => {
    setJson(text);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
      const parsed = readDocument(raw);
      applyDocument(parsed.value, parsed.kindSelected);
      setJsonError(undefined);
    } catch (error) {
      if (isModelObject(raw) && !isLegacyModelDraft(raw)) {
        try {
          const parsed = readDocument(inspectOfflineBody(text).body);
          applyDocument(parsed.value, parsed.kindSelected);
          if (!enabled) {
            setJsonError(undefined);
            return;
          }
        } catch {
          const projected = projectModelDraft(raw, plugins);
          applyDocument(projected, projected.kindSelected);
        }
      }
      const message = error instanceof Error ? error.message : "JSON 格式无效";
      setJsonError({
        message: text.trim() ? message : "内容为空",
        syntax: error instanceof SyntaxError,
        notObject: !isModelObject(raw),
        legacy: isModelObject(raw) && isLegacyModelDraft(raw),
        position:
          error instanceof DocumentIssue
            ? jsonPosition(text, error.path)
            : (locateJsonError(text) ?? Number(/position (\d+)/.exec(message)?.[1] ?? text.length)),
      });
    }
  };
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [pendingAction, setPendingAction] = useState<ModelKind | "discard">();
  const descriptionId = useId();
  const isAgent = config.kind === "agent";
  const plugin = isAgent ? undefined : plugins.find(({ hash }) => hash === pluginHash);
  const options = mediaGenerationOptions(
    config.kind,
    plugin?.origin === "builtin" ? plugin.key : undefined,
    upstreamModel,
    settings,
  );
  const patch = (values: Partial<ModelConfig>) =>
    setConfig((current) => ({ ...current, ...values }));
  const isLanguage = isAgent || config.kind === "text";
  const formDocument = () =>
    JSON.stringify(
      encodeModelBody({
        config,
        key: model?.modelKey ?? model?.id,
        enabled,
        kindSelected,
        channel: targetId,
        upstream: upstreamModel,
        plugin,
        settings: isAgent ? settings : submittedSettings(settings),
      }),
      null,
      2,
    );
  const [formJson, setFormJson] = useState<StoredDraft | undefined>(
    () => stored && { text: editedModelText(stored, formDocument()), document: formDocument() },
  );
  const jsonBaseline = useRef(formJson?.text ?? "");
  const draftSnapshot = JSON.stringify({
    kindSelected,
    config,
    upstreamModel,
    enabled,
    settings,
    pluginHash,
  });
  const [initialDraft] = useState(draftSnapshot);
  const dirty =
    targetId !== sourceChannel.id ||
    !!(durationDraft && readDuration(durationDraft, isAgent).error) ||
    (json !== undefined
      ? json !== jsonBaseline.current
      : !!formJson && editedModelText(formJson, formDocument()) !== jsonBaseline.current) ||
    (!model?.config
      ? initialDraft !== draftSnapshot
      : upstreamModel !== model.model ||
        enabled !== model.enabled ||
        (!isAgent && pluginHash !== model.pluginHash) ||
        !Value.Equal(settings, isAgent ? gatewaySettings(model.channel) : model.channel) ||
        !Value.Equal(JSON.parse(JSON.stringify(config)), model.config));
  const params = modelParameterChoices(options);
  const supportedParameters: string[] = (Object.keys(params) as ModelParameter[]).filter(
    (key) => params[key].length > 0,
  );
  if (options.audio) supportedParameters.push("generateAudio");
  supportedParameters.push(...Object.keys(config.customParams ?? {}));
  const orderedParameters = (config.parameterOrder ?? supportedParameters).filter(
    (key) =>
      supportedParameters.includes(key) &&
      (!isLanguage || Object.hasOwn(config.customParams ?? {}, key)),
  );
  const modes = modelGenerationModes(config.kind, options);
  const dimensions = priceDimensions(
    config,
    plugin?.origin === "builtin" ? plugin.key : undefined,
    upstreamModel,
    settings,
  );
  const trialPlugin = plugins.find(({ hash }) => hash === trial?.pluginHash);
  const keyMissing = (isAgent || (plugin && plugin.auth !== "none")) && !channel.hasSecret;
  const checks: { tab: Tab; field: string; text: string; error: boolean }[] = [];
  const check = (tab: Tab, field: string, text: string, error = true) =>
    checks.push({ tab, field, text, error });
  if (channel.id !== targetId)
    check("basic", "channel", "目标渠道已不存在，请在配置 JSON 中重新选择渠道");
  if (!config.name.trim()) check("basic", "name", "填写展示名称");
  const durationParam = config.params?.duration;
  if (durationParam?.range) {
    const { min, max, step } = durationParam.range;
    if (
      ![min, max, step].every((value) => Number.isInteger(value) && value >= 1 && value <= 30) ||
      max < min
    )
      check("params", "durationRange", "时长范围须在 1 至 30 秒之间，最大值不能小于最小值");
    else if (!durationParam.values.includes(durationParam.default))
      check("params", "durationRange", "默认时长须符合范围和步长");
  }
  for (const issue of pricingIssues(config, dimensions)) check("price", issue.field, issue.text);
  if (!kindSelected) check("basic", "kind", "选择模型能力");
  else if (!isAgent && plugin?.kind !== config.kind)
    check("basic", "protocol", "选择与能力匹配的调用协议");
  else if (plugin?.disabled)
    check("basic", "protocol", `模型选择的协议插件 "${plugin.key}" 已停用`);
  if (!upstreamModel.trim()) check("basic", "upstream", "填写上游模型 ID");
  if (!isAgent && plugin) {
    for (const [key, field] of Object.entries(plugin.fields)) {
      const issue = protocolIssue(field, settings[key] ?? field.default);
      if (issue) check("basic", `setting-${key}`, issue);
    }
  }
  if (!channel.enabled) check("basic", "channel", `渠道「${channel.name}」已停用`, false);
  if (keyMissing) check("basic", "channel", `渠道「${channel.name}」还没有设置 Key`, false);
  const channelIssues = checks.filter((issue) => issue.field === "channel");
  const channelError = channelIssues.some((issue) => issue.error);
  const ChannelNoticeIcon = channelError ? CircleAlert : TriangleAlert;
  const timeoutPresets = isAgent
    ? [30, 60, undefined, 120, 180, 300]
    : [300, 600, 1200, 1800, 3600];
  const customDuration =
    durationDraft ??
    (config.timeoutSeconds && !timeoutPresets.includes(config.timeoutSeconds)
      ? `${config.timeoutSeconds}s`
      : "");
  const timeoutError = readDuration(customDuration, isAgent).error;
  if (timeoutError) check("params", "timeoutSeconds", timeoutError);
  else if (!isAgent && !config.timeoutSeconds)
    check("params", "timeoutSeconds", "没有设置任务超时，将使用系统默认值", false);
  if (
    config.timeoutSeconds !== undefined &&
    isAgent &&
    (config.timeoutSeconds < 10 || config.timeoutSeconds > 600)
  )
    check("params", "timeoutSeconds", "必须在 10s – 10m 之间");
  if (
    !config.pricing?.input &&
    !config.pricing?.output &&
    !config.pricing?.tiers?.some((tier) => tier.on && tier.unit)
  )
    check("price", "pricing", "还没有设置默认积分价格", false);
  const locate = (issue: (typeof checks)[number]) => {
    if (json !== undefined) {
      const legacy = isLegacyModelDraft(JSON.parse(json));
      const configRoot = legacy ? "/config" : "";
      const paths: Record<string, string> = {
        name: legacy ? "/config/name" : "/label",
        kind: `${configRoot}/kind`,
        upstream: "/channels/0/upstream_model",
        channel: "/channels/0/channel",
        protocol: legacy ? "/pluginHash" : "/channels/0/protocol",
        timeoutSeconds: legacy ? "/config/timeoutSeconds" : isAgent ? "/idle_timeout" : "/deadline",
        pricing: `${configRoot}/pricing`,
        durationRange: legacy ? "/config/params/duration/range" : "/capabilities/params/duration",
      };
      const pointer = issue.field.startsWith("setting-")
        ? `${legacy ? "/settings" : "/channels/0/protocol/settings"}/${issue.field.slice(8).replaceAll("~", "~0").replaceAll("/", "~1")}`
        : issue.field.startsWith("tier-")
          ? `${configRoot}/pricing/tiers/${issue.field.slice(5)}/when`
          : paths[issue.field];
      const field = jsonInput.current;
      if (pointer && field) {
        const start = jsonPosition(json, pointer);
        const key = /^"(?:\\[\s\S]|[^"\\])*"/.exec(json.slice(start));
        if (key) {
          field.focus();
          field.setSelectionRange(start, start + key[0].length);
          field.scrollTop = Math.max(0, (json.slice(0, start).split("\n").length - 3) * 20);
        }
      }
      return;
    }
    setTab(issue.tab);
    requestAnimationFrame(() => {
      const field = form.current?.querySelector<HTMLElement>(
        `[data-field="${CSS.escape(issue.field)}"]`,
      );
      field?.focus();
      field?.scrollIntoView({ block: "center" });
    });
  };
  const openJson = () => {
    if (timeoutError) {
      locate({ field: "timeoutSeconds", tab: "params", text: timeoutError, error: true });
      return;
    }
    const document = formDocument();
    jsonInitialConfig.current = { document, config };
    if (formJson) changeJson(editedModelText(formJson, document));
    else {
      jsonBaseline.current = document;
      setFormJson(undefined);
      setJson(document);
    }
    setModeError("");
    requestAnimationFrame(() => jsonInput.current?.focus({ preventScroll: true }));
  };
  const hint = (field: string) =>
    checks
      .filter((issue) => issue.field === field)
      .map((issue, index) => (
        <small
          key={issue.text}
          id={`${descriptionId}-${issue.field}-${index}`}
          className="model-field-note"
          data-error={issue.error}
        >
          {issue.text}
        </small>
      ));
  const selectPlugin = (next: PluginView, nextSettings: ProviderFields["channel"]) => {
    setConfig((current) =>
      rebindTemplate(
        current,
        {
          adapter: plugin?.origin === "builtin" ? plugin.key : undefined,
          model: upstreamModel,
          settings,
        },
        {
          adapter: next?.origin === "builtin" ? next.key : undefined,
          model: upstreamModel,
          settings: nextSettings,
        },
      ),
    );
    setPlugin(next?.hash ?? "");
    setSettings(nextSettings);
  };
  const chooseKind = (kind: ModelKind) => {
    setDurationDraft(undefined);
    setKindSelected(true);
    setConfig(applyKindTemplate(config, kind));
    if (kind === "agent" || plugin?.kind !== kind) {
      setPlugin("");
      setSettings(kind === "agent" ? gatewaySettings() : {});
    }
    setNotice(protocolSwitchNotice(pluginHash, plugin, kind));
  };
  const save = async () => {
    const source =
      json ??
      (formJson && editedModelText(formJson, formDocument())) ??
      (modelContextIssue(config) ? formDocument() : undefined);
    let documentText: string | undefined;
    if (source !== undefined) {
      try {
        const raw: unknown = JSON.parse(source);
        if (isModelObject(raw) && !isLegacyModelDraft(raw)) {
          const { body, issues } = inspectOfflineBody(source);
          if (issues.length && enabled) throw new Error(settingsError("MODEL_DOCUMENT_INVALID"));
          readDocument(body, { document: formDocument(), config });
          if (
            issues.length ||
            Object.hasOwn(raw, "params") ||
            model?.hasDocumentDraft ||
            (!model && body.key)
          )
            documentText = source;
        } else {
          readDocument(raw, { document: formDocument(), config });
          if (model?.hasDocumentDraft) throw new Error(settingsError("MODEL_DOCUMENT_REQUIRED"));
        }
      } catch (error) {
        reportChannelAction(
          jsonError?.syntax ? "JSON 格式错误，无法保存" : "模型配置错误，无法保存",
          "error",
          error instanceof Error ? error.message : undefined,
        );
        if (json === undefined) openJson();
        return;
      }
    }
    if (model && source) {
      const body = JSON.parse(source);
      if (!isLegacyModelDraft(body) && !body.key?.trim()) {
        reportChannelAction("正文里缺少 key", "error", "key 是配置的唯一标识，必须填写。");
        return;
      }
    }
    const first = checks.find((issue) => issue.error);
    if (first || (!isAgent && !plugin)) {
      if (first) {
        reportChannelAction(first.text, "error");
        locate(first);
        setNotice("");
      }
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
      const input: SettingsInput<"modelSave"> = {
        id: model?.id,
        expectedRevision: model?.revision ?? 0,
        ...(documentText !== undefined && { documentText }),
        channelId: channel.id,
        channelRevision: channel.revision,
        ...(model &&
          targetId !== sourceChannel.id && {
            moveFrom: { id: sourceChannel.id, revision: sourceChannel.revision },
          }),
        upstreamModel,
        config,
        ...(!isAgent && { pluginHash }),
        settings: isAgent ? settings : submittedSettings(settings),
        enabled,
      };
      let result = await settingsRequests.modelSave(input);
      if (!result.ok && result.code === "MODEL_AUTH_APPROVAL_REQUIRED" && plugin) {
        if (
          !(await confirm(
            `渠道「${channel.name}」的模型将改用 ${plugin.key}@${plugin.version}。\n新版本的鉴权方式、凭证位置或签名代码已改变。\n目标鉴权：${protocolAuth(plugin)}。确认授权此版本？`,
          ))
        )
          return;
        input.approvedAuthHash = plugin.hash;
        result = await settingsRequests.modelSave(input);
      }
      if (!result.ok && result.code === "MODEL_ENDPOINT_APPROVAL_REQUIRED") {
        const tokenUrl = settings.tokenUrl || "https://oauth2.googleapis.com/token";
        const gcsBaseUrl = settings.gcsBaseUrl || "https://storage.googleapis.com";
        if (
          await confirm(
            `Vertex AI 凭证请求地址发生变更。\n令牌地址：${tokenUrl}\nGCS 下载地址：${gcsBaseUrl}\n确认使用这些地址？`,
          )
        ) {
          result = await settingsRequests.modelSave({ ...input, approve: true });
        }
      }
      if (!result.ok) setNotice(settingsError(result.code));
      else {
        reportChannelAction(
          "已保存",
          result.value.issues?.length ? "info" : "success",
          result.value.issues?.length
            ? `有 ${result.value.issues.length} 个问题，修复后才能上线。`
            : undefined,
        );
        setModel(result.value);
        setConfig(result.value.config ?? config);
        setSettings(isAgent ? gatewaySettings(result.value.channel) : result.value.channel);
        setUpstream(result.value.model);
        await saved();
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (busy) return;
    if (dirty) setPendingAction("discard");
    else close();
  };
  const saveFirst = !model
    ? "先保存模型"
    : dirty || jsonError
      ? "有未保存的修改，先保存"
      : undefined;
  const publishReason = () => {
    if (enabled) return;
    if (saveFirst) return saveFirst;
    if (model?.draftIssueCount) return settingsError("MODEL_DOCUMENT_INVALID");
    if (!kindSelected) return "还没有选择模型能力";
    if (targetId !== channel.id) return `渠道 ${targetId} 不存在`;
    if (!channel.enabled) return `渠道 ${channel.name} 已停用`;
    if (!isAgent && !plugin) return "该模型还没有选择调用协议";
    const protocolError = checks.find(
      (issue) => issue.field === "protocol" || issue.field.startsWith("setting-"),
    );
    if (protocolError) return protocolError.text;
    if (keyMissing) return `渠道 ${channel.name} 的 Key 尚未设置，请在渠道设置中填写后再试`;
    if (config.pricing?.pending) return settingsError("MODEL_PRICING_PENDING");
  };
  const enableDeny = publishReason();
  const testDeny =
    saveFirst ??
    (model?.draftIssueCount
      ? settingsError("MODEL_DOCUMENT_INVALID")
      : !kindSelected
        ? "还没有选择模型能力，先选择能力和协议并保存"
        : isAgent
          ? "Agent 模型暂不支持试跑"
          : !plugin
            ? "还没有选择调用协议，先选择协议并保存"
            : undefined);
  async function toggleOnline(next: boolean) {
    if (!model || busy || (next && enableDeny)) return;
    setBusy(true);
    try {
      const result = await settingsRequests.modelToggle({
        id: model.id,
        expectedRevision: model.revision,
        enabled: next,
      });
      if (!result.ok) {
        setNotice(settingsError(result.code));
        return;
      }
      setModel(result.value);
      setEnabled(result.value.enabled);
      await saved();
    } catch {
      setNotice(settingsError("SETTINGS_ACTION_FAILED"));
    } finally {
      setBusy(false);
    }
  }
  const number = (
    label: string,
    name: "sort" | "promptLimit" | "timeoutSeconds",
    max: number,
    placeholder?: string,
  ) => (
    <label>
      {name === "sort" && model ? (
        <ModelFieldLabel text={label} tip="在渠道的“自定义排序”里调整" />
      ) : (
        label
      )}
      <input
        data-field={name}
        aria-label={label}
        type="number"
        disabled={name === "sort" && !!model}
        title={name === "sort" && model ? "在渠道的“自定义排序”里调整" : undefined}
        min={name === "sort" ? 0 : name === "timeoutSeconds" ? 10 : 1}
        max={max}
        placeholder={placeholder}
        value={config[name] ?? ""}
        onChange={(event) =>
          patch({
            [name]:
              event.target.value === ""
                ? name === "sort"
                  ? 0
                  : undefined
                : Number(event.target.value),
          })
        }
      />
      {hint(name)}
    </label>
  );
  const missingBody = json !== undefined && jsonError?.notObject;
  const headerChannel = missingBody
    ? model
      ? sourceChannel.name
      : "未选渠道"
    : channel.id === targetId
      ? channel.name
      : "未选渠道";
  const modelKey = model?.modelKey ?? model?.id;
  const headerModel = (!missingBody && upstreamModel) || modelKey || "未填写";
  return (
    <>
      <ModelModal
        title={model ? "编辑模型" : "新建模型"}
        subtitle={
          <>
            {headerChannel} ·{" "}
            {json === undefined ? (
              <button
                type="button"
                className="model-json-entry"
                disabled={busy}
                aria-label="配置 JSON"
                title="编辑配置 JSON"
                onClick={openJson}
              >
                <code>{headerModel}</code>
              </button>
            ) : (
              <code>{headerModel}</code>
            )}
          </>
        }
        avatar={(missingBody ? model?.config?.name : config.name) || "?"}
        avatarSeed={modelKey}
        logo={missingBody ? model?.config?.logo : config.logo}
        status={
          <>
            {model && (
              <span className="model-status" data-online={model.enabled}>
                {model?.enabled ? "已上线" : "未上线"}
              </span>
            )}
            {dirty && <span className="model-pending">有未保存修改</span>}
          </>
        }
        close={cancel}
        wide
      >
        {confirmation}
        {json === undefined ? (
          <div className="model-tabs" role="tablist" aria-label="模型编辑分区">
            {(
              [
                ["basic", "基本信息", Info],
                ["params", "能力与参数", SlidersHorizontal],
                ["price", "积分定价", Coins],
              ] as const
            ).map(([key, text, Icon]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-label={text}
                title={checks
                  .filter((issue) => issue.tab === key)
                  .map((issue) => issue.text)
                  .join("\n")}
                aria-selected={tab === key}
                onClick={() => {
                  setJson(undefined);
                  setTab(key);
                }}
              >
                <Icon size={16} /> {text}
                {checks.some((issue) => issue.tab === key) && (
                  <i
                    className="model-tab-dot"
                    role="img"
                    aria-label={
                      checks.some((issue) => issue.tab === key && issue.error)
                        ? `${checks.filter((issue) => issue.tab === key && issue.error).length} 个问题需要修复`
                        : "有建议项"
                    }
                    data-error={checks.some((issue) => issue.tab === key && issue.error)}
                  />
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="model-tabs model-json-tools">
            <Braces size={16} aria-hidden="true" />
            <strong>JSON 编辑</strong>
            <button
              type="button"
              onClick={() =>
                jsonError?.syntax
                  ? reportChannelAction("无法格式化", "error", jsonError.message)
                  : changeJson(JSON.stringify(JSON.parse(json), null, 2))
              }
            >
              格式化
            </button>
            <button
              type="button"
              className="model-json-return"
              onClick={() => {
                if (jsonError?.syntax)
                  setModeError(
                    `${jsonProblem?.replace(/^JSON 语法错误/, "JSON 有语法错误")}。修复后才能切回表单。`,
                  );
                else if (jsonError?.notObject) setModeError("正文必须是 JSON 对象，才能切回表单。");
                else if (jsonError?.legacy) setModeError(jsonError.message);
                else {
                  setModeError("");
                  setFormJson({ document: formDocument(), text: json });
                  setJson(undefined);
                }
              }}
            >
              回到表单
            </button>
          </div>
        )}
        {json !== undefined && modeError && (
          <div className="model-json-alert">
            <div role="alert" className="model-channel-note">
              <CircleAlert size={16} aria-hidden="true" />
              <div>
                <strong>无法切回表单</strong>
                <span>{modeError}</span>
              </div>
            </div>
          </div>
        )}
        <div
          className="model-editor-grid"
          data-json={json !== undefined}
          data-tab={json === undefined ? tab : undefined}
        >
          <div className="model-dialog-body model-editor-form" key={tab} ref={form}>
            {json !== undefined && (
              <>
                <textarea
                  ref={jsonInput}
                  aria-label="配置 JSON"
                  spellCheck={false}
                  wrap="off"
                  aria-invalid={!!jsonError?.syntax}
                  onKeyDown={(event) => {
                    if (event.key !== "Tab" || event.shiftKey) return;
                    event.preventDefault();
                    const field = event.currentTarget;
                    const position = field.selectionStart;
                    changeJson(`${json.slice(0, position)}  ${json.slice(field.selectionEnd)}`);
                    requestAnimationFrame(() =>
                      field.setSelectionRange(position + 2, position + 2),
                    );
                  }}
                  rows={22}
                  value={json}
                  onChange={(event) => changeJson(event.target.value)}
                />
                {!jsonError?.syntax && <small>JSON 语法正确</small>}
                {jsonError && (jsonError.syntax || !jsonError.notObject) && (
                  <div role="alert" className="model-json-problem">
                    <button
                      type="button"
                      onClick={() => {
                        jsonInput.current?.focus();
                        jsonInput.current?.setSelectionRange(
                          jsonError.position,
                          jsonError.position + 1,
                        );
                        if (jsonInput.current)
                          jsonInput.current.scrollTop = Math.max(
                            0,
                            (json.slice(0, jsonError.position).split("\n").length - 3) * 20,
                          );
                      }}
                    >
                      {jsonProblem}
                    </button>
                  </div>
                )}
              </>
            )}
            {json === undefined && tab === "basic" && (
              <>
                <section>
                  <h3>模型身份</h3>
                  {channelIssues.length > 0 && (
                    <div
                      tabIndex={-1}
                      data-field="channel"
                      data-slot="notice"
                      role={channelError ? "alert" : "status"}
                      className="model-channel-note"
                    >
                      <ChannelNoticeIcon size={16} aria-hidden="true" />
                      <div>
                        <strong>所属渠道</strong>
                        <span>{channelIssues.map((issue) => issue.text).join("；")}</span>
                      </div>
                    </div>
                  )}
                  <div className="model-fields model-identity-fields">
                    <label>
                      <ModelFieldLabel text="展示名称" required />
                      <input
                        data-field="name"
                        aria-label="展示名称"
                        aria-required="true"
                        aria-invalid={!config.name.trim()}
                        aria-describedby={
                          !config.name.trim() ? `${descriptionId}-name-0` : undefined
                        }
                        maxLength={120}
                        placeholder="用户在画布里看到的名字"
                        value={config.name}
                        onChange={(event) => patch({ name: event.target.value })}
                      />
                      {hint("name")}
                    </label>
                    <label>
                      <ModelFieldLabel
                        text="上游模型标识"
                        required
                        tip="插件把这个值作为 model 参数发给上游网关。"
                      />
                      <input
                        data-field="upstream"
                        aria-label="上游模型标识"
                        aria-required="true"
                        aria-invalid={!upstreamModel.trim()}
                        aria-describedby={
                          !upstreamModel.trim() ? `${descriptionId}-upstream-0` : undefined
                        }
                        maxLength={200}
                        placeholder="实际发给上游的模型名"
                        value={upstreamModel}
                        onChange={(event) => {
                          const model = event.target.value;
                          const adapter = plugin?.origin === "builtin" ? plugin.key : undefined;
                          setConfig((current) =>
                            rebindTemplate(
                              current,
                              { adapter, model: upstreamModel, settings },
                              { adapter, model, settings },
                            ),
                          );
                          setUpstream(model);
                        }}
                      />
                      {hint("upstream")}
                    </label>
                    <ModelLogoPicker
                      name={config.name}
                      seed={modelKey}
                      value={config.logo}
                      change={(logo) => patch({ logo })}
                    />
                    {isAgent && (
                      <AgentInterfaceFields
                        settings={settings}
                        setSettings={(next) => {
                          if (settings.api === "gemini" && next.api !== "gemini" && config.video) {
                            patch({ video: false });
                            setNotice("接口格式改成 OpenAI 兼容后，「看视频」已关闭");
                          }
                          setSettings(next);
                        }}
                      />
                    )}
                  </div>
                </section>
                <section>
                  <h3>能力与协议</h3>
                  <ModelProtocolPicker
                    key={config.kind}
                    selectedKind={kindSelected ? config.kind : undefined}
                    plugins={plugins}
                    pluginsStatus={pluginsStatus}
                    pluginHash={pluginHash}
                    settings={settings}
                    kindHint={hint("kind")}
                    selectPlugin={selectPlugin}
                    setSettings={setSettings}
                    chooseKind={(kind) => {
                      if (kindSelected && kind === config.kind) return;
                      if (kindSelected && model) setPendingAction(kind);
                      else chooseKind(kind);
                    }}
                  />
                  {hint("protocol")}
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
                      <small
                        id={descriptionId}
                        className="model-description-count"
                        data-limit={config.description.length >= 500}
                      >
                        {config.description.length} / 500
                      </small>
                    </label>
                    {number("排序", "sort", 2147483647)}
                    <ModelTags tags={config.tags} change={(tags) => patch({ tags })} />
                  </div>
                </section>
              </>
            )}
            {json === undefined && tab === "params" && (
              <>
                <section>
                  <h3>{config.kind === "agent" ? "调用设置" : "任务设置"}</h3>
                  <span>{isAgent ? "上游响应超时" : "任务超时"}</span>
                  <div className="model-chips model-timeout-choices">
                    {timeoutPresets.map((seconds) => (
                      <button
                        type="button"
                        key={seconds ?? "default"}
                        aria-pressed={!customDuration && config.timeoutSeconds === seconds}
                        onClick={() => {
                          setDurationDraft(undefined);
                          patch({ timeoutSeconds: seconds });
                        }}
                      >
                        {!customDuration && config.timeoutSeconds === seconds && (
                          <Check size={14} aria-hidden="true" />
                        )}
                        {seconds === undefined
                          ? "默认（90 秒）"
                          : isAgent && seconds <= 60
                            ? `${seconds} 秒`
                            : seconds < 60
                              ? `${seconds} 秒`
                              : seconds % 60
                                ? `${seconds} 秒`
                                : `${seconds / 60} 分钟`}
                      </button>
                    ))}
                    <input
                      data-field="timeoutSeconds"
                      aria-label={isAgent ? "自定义上游响应超时" : "自定义超时"}
                      placeholder={isAgent ? "自定义，如 150s" : "自定义，如 90s"}
                      aria-invalid={!!timeoutError}
                      value={customDuration}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDurationDraft(value);
                        const parsed = readDuration(value, isAgent);
                        if (!parsed.error) patch({ timeoutSeconds: parsed.seconds });
                      }}
                    />
                  </div>
                  {hint("timeoutSeconds")}
                  {isAgent && !checks.some((issue) => issue.field === "timeoutSeconds") && (
                    <small className="model-timeout-hint">10 秒 – 10 分钟，超时自动重试一次</small>
                  )}
                </section>
                {kindSelected && isLanguage && (
                  <ModelContext
                    config={config}
                    patch={patch}
                    id={channel.id}
                    revision={channel.revision}
                    name={upstreamModel.trim()}
                    gemini={settings.api === "gemini"}
                  />
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
                                max={maxModelReferenceMB}
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
                    isAgent ? "单条消息字数上限" : "字数上限",
                    "promptLimit",
                    options.promptLimit,
                    kindSelected ? String(options.promptLimit) : undefined,
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
                {!isAgent && (
                  <section>
                    <h3>生成参数</h3>
                    {!orderedParameters.length && (
                      <p className="model-empty-capabilities">暂无生成参数</p>
                    )}
                    {(config.params ||
                      config.customParams ||
                      config.refs ||
                      config.modes ||
                      config.generateAudio ||
                      config.parameterOrder) && (
                      <button
                        type="button"
                        onClick={() =>
                          patch({
                            params: undefined,
                            customParams: undefined,
                            refs: undefined,
                            modes: undefined,
                            generateAudio: undefined,
                            parameterOrder: undefined,
                          })
                        }
                      >
                        恢复协议默认能力与参数
                      </button>
                    )}
                    {orderedParameters.map((key, index) => {
                      const orderControls = {
                        first: index === 0,
                        last: index === orderedParameters.length - 1,
                        remove: () => {
                          const parameterOrder = orderedParameters.filter((name) => name !== key);
                          if (key === "generateAudio")
                            return patch({ generateAudio: undefined, parameterOrder });
                          if (Object.hasOwn(config.customParams ?? {}, key)) {
                            const customParams = { ...config.customParams };
                            delete customParams[key];
                            return patch({ customParams, parameterOrder });
                          }
                          const fixedKey = key as ModelParameter;
                          const params = { ...config.params };
                          delete params[fixedKey];
                          patch({ params, parameterOrder });
                        },
                        move: (offset: number) => {
                          const order = [...orderedParameters];
                          order.splice(index, 1);
                          order.splice(index + offset, 0, key);
                          patch({ parameterOrder: order });
                        },
                      };
                      if (key === "generateAudio") {
                        const field = config.generateAudio ?? {
                          label: "生成音频",
                          open: true,
                          default: true,
                          spec: true,
                        };
                        return (
                          <fieldset key={key}>
                            <legend>生成音频</legend>
                            <ParameterHeading
                              name="generate_audio"
                              kind="开关"
                              order={orderControls}
                              controls={{ ...field, label: field.label ?? "生成音频" }}
                              change={(changes) =>
                                patch({ generateAudio: { ...field, ...changes } })
                              }
                            />
                            <SettingsSwitch
                              label={`${field.label || "生成音频"} 默认开启`}
                              text="默认开启"
                              checked={field.default}
                              onChange={(preferred) =>
                                patch({ generateAudio: { ...field, default: preferred } })
                              }
                            />
                          </fieldset>
                        );
                      }
                      const custom = config.customParams?.[key];
                      if (custom) {
                        const updateCustom = (next: typeof custom) =>
                          patch({ customParams: { ...config.customParams, [key]: next } });
                        const name = custom.label ?? key;
                        return (
                          <fieldset key={key}>
                            <legend>{name}</legend>
                            <ParameterHeading
                              name={key}
                              kind={
                                custom.type === "boolean"
                                  ? "开关"
                                  : custom.type === "number"
                                    ? "数字"
                                    : "枚举"
                              }
                              order={orderControls}
                              controls={{
                                label: name,
                                open: custom.open ?? true,
                                ...(custom.type !== "number" && { spec: custom.spec ?? false }),
                              }}
                              change={(fields) => updateCustom({ ...custom, ...fields })}
                            />
                            {custom.type === "boolean" ? (
                              <SettingsSwitch
                                label={`${name} 默认值`}
                                text="默认开启"
                                checked={custom.default}
                                onChange={(value) => updateCustom({ ...custom, default: value })}
                              />
                            ) : custom.type === "number" ? (
                              <div className="model-fields">
                                {(["min", "max", "step", "default"] as const).map((field) => (
                                  <label key={field}>
                                    {field === "min"
                                      ? "最小"
                                      : field === "max"
                                        ? "最大"
                                        : field === "step"
                                          ? "步长"
                                          : "默认"}
                                    <input
                                      type="number"
                                      value={custom[field] ?? ""}
                                      onChange={(event) =>
                                        updateCustom({
                                          ...custom,
                                          [field]: Number(event.target.value),
                                        })
                                      }
                                    />
                                  </label>
                                ))}
                                <label>
                                  单位
                                  <input
                                    value={custom.unit ?? ""}
                                    onChange={(event) =>
                                      updateCustom({
                                        ...custom,
                                        unit: event.target.value || undefined,
                                      })
                                    }
                                  />
                                </label>
                              </div>
                            ) : (
                              <CustomEnumEditor field={custom} change={updateCustom} />
                            )}
                          </fieldset>
                        );
                      }
                      const fixedKey = key as ModelParameter;
                      const raw = params[fixedKey] ?? [];
                      const all = raw.map(String);
                      const range =
                        fixedKey === "duration" ? config.params?.duration?.range : undefined;
                      const value = config.params?.[fixedKey] ?? {
                        values: all,
                        default: all[0] ?? "",
                      };
                      const update = (
                        values: string[],
                        preferred: string,
                        fields: Partial<
                          NonNullable<NonNullable<ModelConfig["params"]>["duration"]>
                        > = {},
                      ) => {
                        const params = {
                          ...config.params,
                          [key]: {
                            ...config.params?.[fixedKey],
                            values,
                            default: preferred,
                            ...(fixedKey === "duration" &&
                              !Value.Equal(values, value.values) && { range: undefined }),
                            ...fields,
                          },
                        };
                        if (fixedKey === "size") {
                          delete params.aspectRatio;
                          delete params.resolution;
                        }
                        if (fixedKey === "aspectRatio" || fixedKey === "resolution")
                          delete params.size;
                        patch({ params });
                      };
                      return (
                        <fieldset key={key}>
                          <legend>{modelParameterLabels[fixedKey]}</legend>
                          <ParameterHeading
                            name={paramNames[fixedKey]}
                            kind={range ? "数字" : "枚举"}
                            order={orderControls}
                            controls={{
                              label: range?.label ?? value.label ?? modelParameterLabels[fixedKey],
                              open: range?.open ?? value.open ?? true,
                              spec:
                                range || fixedKey === "count" ? undefined : (value.spec ?? true),
                            }}
                            change={(fields) =>
                              update(
                                value.values,
                                value.default,
                                range ? { range: { ...range, ...fields } } : fields,
                              )
                            }
                          />
                          {range ? (
                            <>
                              <DurationRangeEditor
                                range={range}
                                preferred={value.default}
                                change={update}
                              />
                              {hint("durationRange")}
                            </>
                          ) : (
                            <CustomEnumEditor
                              field={{ ...value, type: "enum" }}
                              presets={all}
                              change={(field) =>
                                update(field.values.map(String), String(field.default))
                              }
                            />
                          )}
                        </fieldset>
                      );
                    })}
                  </section>
                )}
                {kindSelected && config.kind === "text" && (
                  <section>
                    <h3>固定系统提示</h3>
                    <textarea
                      aria-label="固定系统提示"
                      rows={4}
                      maxLength={16000}
                      placeholder="例如：你是一名资深分镜师，回答使用中文。"
                      value={config.systemPrompt ?? ""}
                      onChange={(event) => patch({ systemPrompt: event.target.value })}
                    />
                  </section>
                )}
              </>
            )}
            {json === undefined && tab === "price" && (
              <section>
                <h3>用户积分价格</h3>
                <PricingRules
                  pricing={
                    config.pricing ??
                    (kindSelected
                      ? applyKindTemplate(config, config.kind, false, {
                          model: upstreamModel,
                          adapter: plugin?.origin === "builtin" ? plugin.key : undefined,
                          settings,
                        }).pricing!
                      : { unit: "request", input: 2 })
                  }
                  hint={hint("pricing")}
                  tierError={(index) =>
                    checks.find((issue) => issue.field === `tier-${index}`)?.text
                  }
                  kind={kindSelected ? config.kind : undefined}
                  timed={hasNumericDuration(config)}
                  dimensions={kindSelected ? dimensions : []}
                  change={(pricing) => patch({ pricing })}
                />
              </section>
            )}
          </div>
          <aside className="model-preview" aria-label="创作端预览">
            <h3>
              <Eye size={14} />{" "}
              {tab === "params"
                ? "画布节点预览"
                : tab === "price"
                  ? "用户看到的价格"
                  : "创作端预览 · 模型选择器"}
            </h3>
            {tab === "price" ? (
              <PricingPreview config={config} dimensions={dimensions} />
            ) : tab === "params" && kindSelected ? (
              <TrialInputCard
                name={config.name.trim() || "未命名模型"}
                logo={config.logo}
                kind={config.kind}
                options={modelGenerationOptions(
                  config.kind,
                  plugin?.origin === "builtin" ? plugin.key : undefined,
                  upstreamModel,
                  settings,
                  config,
                )}
                inputs={previewInputs}
                preview
              />
            ) : (
              <div className="model-preview-card">
                {tab === "basic" && (
                  <small>{kindSelected ? modelKindLabels[config.kind] : ""}模型</small>
                )}
                <div className="model-preview-identity">
                  <ModelAvatar name={config.name.trim()} logo={config.logo} seed={modelKey} />
                  <div>
                    <div className="model-preview-line">
                      <strong>{config.name.trim() || "未命名模型"}</strong>
                      {!!config.tags?.length && (
                        <div className="model-chips">
                          {config.tags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                      )}
                      {tab === "basic" && config.pricing && (
                        <small>{modelPriceLabel(config.pricing)}</small>
                      )}
                    </div>
                    {kindSelected && tab !== "basic" && <KindMark kind={config.kind} />}
                    {config.description && <p>{config.description}</p>}
                  </div>
                </div>
                {tab === "basic" &&
                  kindSelected &&
                  providers
                    .filter(
                      (entry) =>
                        entry.enabled &&
                        !entry.pending &&
                        entry.id !== model?.id &&
                        kindOf(entry, plugins) === config.kind,
                    )
                    .slice(0, 2)
                    .map((entry) => (
                      <div key={entry.id} className="model-preview-identity model-preview-peer">
                        <ModelAvatar
                          name={entry.config?.name || entry.model}
                          logo={entry.config?.logo}
                          seed={entry.modelKey ?? entry.id}
                        />
                        <div>
                          <div className="model-preview-line">
                            <strong>{entry.config?.name || entry.model}</strong>
                            {!!entry.config?.tags?.length && (
                              <div className="model-chips">
                                {entry.config.tags.map((tag) => (
                                  <span key={tag}>{tag}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                {tab === "params" && !kindSelected && (
                  <p className="model-empty-capabilities">未配置 capabilities</p>
                )}
                {tab !== "basic" && config.pricing && !config.pricing.pending && (
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
            )}
          </aside>
        </div>
        {notice && (
          <p role="status" className="model-notice">
            {notice}
          </p>
        )}
        <footer className="model-dialog-footer">
          <DisabledReason reason={enableDeny}>
            <SettingsSwitch
              label="模型上线"
              text={enabled ? "已上线" : "未上线"}
              checked={enabled}
              disabled={busy || !!enableDeny}
              reason={enableDeny}
              onChange={(next) => void toggleOnline(next)}
            />
          </DisabledReason>
          <div className="settings-actions">
            <DisabledReason reason={testDeny}>
              <button
                type="button"
                disabled={busy || !!testDeny}
                title={testDeny ?? "测试模型"}
                onClick={() => setTrial(model)}
              >
                <FlaskConical size={15} /> 测试模型
              </button>
            </DisabledReason>
            <button type="button" disabled={busy} onClick={cancel}>
              取消
            </button>
            <button
              type="button"
              className="settings-primary"
              aria-label="保存模型"
              disabled={busy}
              onClick={() => void save()}
            >
              <Save size={16} /> 保存
            </button>
          </div>
        </footer>
      </ModelModal>
      {pendingAction && (
        <ModelModal
          variant="destructive-confirm"
          title={
            pendingAction === "discard"
              ? "放弃未保存的修改？"
              : `改成${modelKindLabels[pendingAction]}模型？`
          }
          subtitle={
            pendingAction === "discard"
              ? "未保存的修改会丢失。"
              : "能力、参数和定价将重置为默认值，不兼容的协议会被清空。"
          }
          close={() => setPendingAction(undefined)}
        >
          <footer className="model-dialog-footer">
            <button type="button" onClick={() => setPendingAction(undefined)}>
              取消
            </button>
            <button
              type="button"
              className={pendingAction === "discard" ? "adapter-danger" : "settings-primary"}
              onClick={() => {
                if (pendingAction === "discard") close();
                else chooseKind(pendingAction);
                setPendingAction(undefined);
              }}
            >
              {pendingAction === "discard" ? "放弃修改" : "确认修改"}
            </button>
          </footer>
        </ModelModal>
      )}
      {trial && trialPlugin && (
        <ModelTrial
          model={trial}
          plugin={trialPlugin}
          inputs={previewInputs}
          close={() => setTrial(undefined)}
        />
      )}
    </>
  );
}
