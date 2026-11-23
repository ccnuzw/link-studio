import type { ChannelView, ModelConfig, PluginView, ProviderView } from "@link-studio/core";
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { CatalogSelect } from "./adapter-catalog";
import { encodeModelBody } from "./model-document";
import { readDuration } from "./model-duration";
import { ModelModal, ModelProtocolPicker, protocolIssue } from "./model-editor";
import { editedModelText } from "./model-json-draft";
import { applyKindTemplate } from "./model-kind-template";
import {
  type ProtocolLoadState,
  protocolSwitchNotice,
  submittedSettings,
} from "./protocol-settings";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";

export type BatchAction = "批量上线" | "批量下线" | "批量修改" | "批量设置能力与协议" | "批量删除";

export function ModelBatch({
  action,
  channel,
  channels,
  models,
  plugins,
  pluginsStatus,
  close,
  refresh,
}: {
  action: BatchAction;
  channel: ChannelView;
  channels: ChannelView[];
  models: ProviderView[];
  plugins: PluginView[];
  pluginsStatus: ProtocolLoadState;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [targets] = useState(models);
  const [rows, setRows] = useState<
    { id: string; label: string; status: "成功" | "跳过" | "失败"; reason?: string }[]
  >([]);
  const started = useRef(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [price, setPrice] = useState("");
  const [timeout, setTimeoutValue] = useState("30m");
  const [applyPrice, setApplyPrice] = useState(false);
  const [applyTimeout, setApplyTimeout] = useState(false);
  const [applyChannel, setApplyChannel] = useState(false);
  const [hash, setHash] = useState("");
  const [switchNotice, setSwitchNotice] = useState("");
  useEffect(() => {
    if (!switchNotice) return;
    const timeout = window.setTimeout(() => setSwitchNotice(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [switchNotice]);
  const [selectedKind, setSelectedKind] = useState<ModelConfig["kind"]>();
  const [targetId, setTargetId] = useState("");
  const [dialogContainer, setDialogContainer] = useState<HTMLDialogElement | null>(null);
  const channelFieldId = useId();
  const target = (applyChannel && channels.find((entry) => entry.id === targetId)) || channel;
  const duration = readDuration(timeout, false);
  const priceError =
    applyPrice &&
    (!Number.isInteger(Number(price)) || Number(price) < 1 || Number(price) > 1000000);
  const invalid =
    (!applyPrice && !applyTimeout && !applyChannel) ||
    priceError ||
    (applyTimeout && !duration.seconds) ||
    (applyChannel && !targetId);
  const [settings, setSettings] = useState<ProviderView["channel"]>({});
  const plugin = plugins.find((entry) => entry.hash === hash);
  const protocol = action === "批量设置能力与协议";
  const protocolError = !selectedKind
    ? "请先选择模型能力"
    : selectedKind === "agent"
      ? undefined
      : !plugin
        ? "请选择调用协议"
        : Object.entries(plugin.fields)
            .map(([key, field]) => protocolIssue(field, settings[key] ?? field.default))
            .find(Boolean);
  const run = async (model: ProviderView) => {
    const api = settingsRequests;
    const input = { id: model.id, expectedRevision: model.revision };
    if (action === "批量删除")
      return model.enabled ? "还在上线，先下线再删除" : api.modelRemove(input);
    if (action === "批量上线" || action === "批量下线") {
      const enabled = action === "批量上线";
      return enabled === model.enabled
        ? enabled
          ? "已经在线"
          : "已经下线"
        : api.modelToggle({ ...input, enabled });
    }
    if (
      !protocol &&
      applyPrice &&
      (!model.config?.pricing || model.config.pricing.unit === "token")
    )
      return "按 Token 计费，没有统一价格，已跳过";
    if (!protocol && model.pending) {
      const saved = await api.modelPendingEdit({
        ...input,
        sourceId: channel.id,
        sourceRevision: channel.revision,
        ...(applyTimeout && { deadline: duration.seconds }),
        ...(applyChannel &&
          target.id !== channel.id && { moveTo: { id: target.id, revision: target.revision } }),
      });
      return saved.ok && saved.value.issues.length
        ? `已保存，但有 ${saved.value.issues.length} 个问题，上线前要处理`
        : saved;
    }
    if (!protocol && !model.config) return "请先设置能力与协议";
    const base = model.config ?? {
      name: model.model,
      sort: model.pendingSort ?? 100,
      description: "",
      kind: "text",
      timeoutSeconds: model.pendingDeadlineSeconds,
    };
    const kind =
      protocol && selectedKind === "agent"
        ? "agent"
        : protocol && plugin
          ? (plugin.kind as ModelConfig["kind"])
          : base.kind;
    const config: ModelConfig =
      model.config && kind === base.kind
        ? { ...base }
        : applyKindTemplate(base, kind, true, {
            adapter: plugin?.origin === "builtin" ? plugin.key : undefined,
            model: model.model,
            settings,
          });
    if (!protocol && applyPrice) {
      config.pricing = {
        ...config.pricing,
        unit: config.pricing?.unit ?? "request",
        input: Number(price),
        pending: undefined,
      };
    }
    if (!protocol && applyTimeout) {
      if (kind === "agent") config.agentDeadlineSeconds = duration.seconds;
      else config.timeoutSeconds = duration.seconds;
    }
    const request = {
      ...input,
      channelId: target.id,
      channelRevision: target.revision,
      moveFrom:
        target.id === channel.id ? undefined : { id: channel.id, revision: channel.revision },
      upstreamModel: model.model,
      config,
      pluginHash: kind === "agent" ? undefined : protocol ? hash : model.pluginHash,
      settings:
        protocol && !(kind === "agent" && model.config?.kind === "agent")
          ? submittedSettings(settings)
          : model.channel,
      enabled: model.enabled,
    };
    let documentText: string | undefined;
    if (model.hasDocumentDraft) {
      const draft = await api.modelDraftRead(input);
      if (!draft.ok) return draft;
      const document = encodeModelBody({
        key: model.modelKey ?? model.id,
        kindSelected: true,
        enabled: model.enabled,
        channel: target.id,
        config,
        upstream: model.model,
        plugin: plugins.find((entry) => entry.hash === request.pluginHash),
        settings: request.settings,
      });
      documentText = editedModelText(draft.value, JSON.stringify(document, null, 2));
    }
    const saved = await api.modelSave({
      ...request,
      ...(documentText !== undefined && { documentText }),
    });
    return saved.ok && saved.value.issues?.length
      ? `已保存，但有 ${saved.value.issues.length} 个问题，上线前要处理`
      : saved;
  };
  const submit = async () => {
    if (started.current) return;
    started.current = true;
    setRunning(true);
    try {
      for (const model of targets) {
        let status: (typeof rows)[number]["status"] = "成功";
        let reason: string | undefined;
        try {
          const result = await run(model);
          if (typeof result === "string") {
            status = "跳过";
            reason = result;
          } else if (!result.ok) {
            status = "失败";
            reason = settingsError(result.code);
          }
        } catch {
          status = "失败";
          reason = "操作未完成";
        }
        setRows((before) => [...before, { id: model.id, label: model.model, status, reason }]);
      }
    } finally {
      setFinished(true);
      setRunning(false);
    }
    await refresh();
  };
  const direct = action === "批量上线" || action === "批量下线";
  const startDirect = useEffectEvent(submit);
  useEffect(() => {
    if (direct) void startDirect();
  }, [direct]);
  if (finished) {
    const succeeded = rows.filter((row) => row.status === "成功");
    const skipped = rows.filter((row) => row.status === "跳过");
    const failed = rows.filter((row) => row.status === "失败");
    return (
      <ModelModal
        variant="batch-result"
        title={`${action}完成`}
        subtitle={`成功 ${succeeded.length} 项，跳过 ${skipped.length} 项，失败 ${failed.length} 项。`}
        close={close}
      >
        <div className="model-dialog-body batch-outcomes">
          {[failed, skipped, succeeded].map(
            (group) =>
              group[0] && (
                <section
                  key={group[0].status}
                  data-status={group[0].status}
                  role={group[0].status === "失败" ? "alert" : "status"}
                >
                  {group[0].status === "失败" ? (
                    <CircleAlert />
                  ) : group[0].status === "跳过" ? (
                    <TriangleAlert />
                  ) : (
                    <CircleCheck />
                  )}
                  <div>
                    <strong>{group[0].status}</strong>
                    <div className="batch-outcome-detail">
                      {group[0].status === "成功" ? (
                        <span className="batch-model-keys">
                          {group.map((row) => row.label).join("、")}
                        </span>
                      ) : (
                        <ul>
                          {group.map((row) => (
                            <li key={row.id}>
                              <code>{row.label}</code>：{row.reason}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </section>
              ),
          )}
        </div>
        <footer className="model-dialog-footer">
          <button type="button" className="settings-primary" onClick={close}>
            知道了
          </button>
        </footer>
      </ModelModal>
    );
  }
  if (running || direct)
    return (
      <div className="batch-progress" role="status">
        <Loader2 size={16} />
        {action}中… {rows.length} / {targets.length}
      </div>
    );
  if (action === "批量删除")
    return (
      <ModelModal
        variant="destructive-confirm"
        title={`删除 ${targets.length} 个模型？`}
        subtitle="删除后不可恢复，上线中的模型会跳过。"
        close={close}
      >
        <footer className="model-dialog-footer">
          <button type="button" onClick={close}>
            取消
          </button>
          <button type="button" className="adapter-danger" onClick={() => void submit()}>
            删除
          </button>
        </footer>
      </ModelModal>
    );
  return (
    <ModelModal
      variant={protocol ? "batch-protocol" : "batch-edit"}
      subtitle={protocol ? "覆盖所选模型的能力和协议，不改价格。" : undefined}
      title={
        protocol
          ? `${action} · 已选 ${targets.length} 个模型`
          : `${action} ${targets.length} 个模型`
      }
      close={() => {
        if (!running) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!(protocol && protocolError) && !(action === "批量修改" && invalid)) void submit();
        }}
      >
        <div className="model-dialog-body model-editor-form">
          {action === "批量修改" && (
            <>
              <div className="batch-field">
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={applyPrice}
                    disabled={running || finished}
                    onChange={(event) => setApplyPrice(event.target.checked)}
                  />
                  默认价格
                </label>
                {applyPrice && (
                  <label>
                    统一设置为（积分）
                    <input
                      aria-label="默认价格"
                      inputMode="numeric"
                      value={price}
                      disabled={running || finished}
                      aria-invalid={priceError}
                      onChange={(event) => setPrice(event.target.value)}
                    />
                    {priceError ? (
                      <small role="alert">
                        {Number.isInteger(Number(price)) && Number(price) > 1000000
                          ? "默认价格不可超过 100 万积分"
                          : "请填写大于 0 的整数"}
                      </small>
                    ) : (
                      <small>规格价不变，按 Token 计费的跳过</small>
                    )}
                  </label>
                )}
              </div>
              <div className="batch-field">
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={applyTimeout}
                    disabled={running || finished}
                    onChange={(event) => setApplyTimeout(event.target.checked)}
                  />
                  任务时限
                </label>
                {applyTimeout && (
                  <label>
                    统一设置为
                    <input
                      aria-label="任务时限"
                      value={timeout}
                      disabled={running || finished}
                      aria-invalid={!duration.seconds}
                      onChange={(event) => setTimeoutValue(event.target.value)}
                    />
                    {duration.seconds ? (
                      <small>如 90s、30m、1h</small>
                    ) : (
                      <small role="alert">{duration.error || "请填写时限，例如 30m"}</small>
                    )}
                  </label>
                )}
              </div>
              <div className="batch-field">
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={applyChannel}
                    disabled={running || finished}
                    onChange={(event) => {
                      setDialogContainer(event.currentTarget.closest("dialog"));
                      setApplyChannel(event.target.checked);
                    }}
                  />
                  所属渠道
                </label>
                {applyChannel && (
                  <div className="batch-channel-field">
                    <label htmlFor={channelFieldId}>统一切换到</label>
                    <CatalogSelect
                      label="所属渠道"
                      id={channelFieldId}
                      description={`${channelFieldId}-hint`}
                      container={dialogContainer}
                      viewportPopup
                      disabled={running || finished}
                      value={targetId}
                      options={[
                        ["", "选择渠道"],
                        ...channels.map((entry) => [entry.id, entry.name] as const),
                      ]}
                      change={setTargetId}
                    />
                    <small id={`${channelFieldId}-hint`} role={targetId ? undefined : "alert"}>
                      {targetId ? "新渠道需已启用并设置 Key" : "请选择渠道"}
                    </small>
                  </div>
                )}
              </div>
            </>
          )}
          {protocol && (
            <ModelProtocolPicker
              key={selectedKind}
              selectedKind={selectedKind}
              plugins={plugins}
              pluginsStatus={pluginsStatus}
              pluginHash={hash}
              settings={settings}
              chooseKind={(kind) => {
                setSwitchNotice(protocolSwitchNotice(hash, plugin, kind));
                setSelectedKind(kind);
                if (kind === "agent" || plugin?.kind !== kind) {
                  setHash("");
                  setSettings(kind === "agent" ? { api: "chat_completions" } : {});
                }
              }}
              selectPlugin={(entry, values) => {
                setHash(entry.hash);
                setSettings(values);
              }}
              setSettings={setSettings}
            />
          )}
        </div>
        {switchNotice && (
          <div className="protocol-switch-notice" role="status">
            <Info size={16} />
            {switchNotice}
          </div>
        )}
        <footer className="model-dialog-footer">
          <button type="button" disabled={running} onClick={close}>
            {finished ? "关闭" : "取消"}
          </button>
          {!finished && (
            <button
              type="submit"
              className="settings-primary"
              title={protocol ? protocolError : undefined}
              disabled={
                running || (action === "批量修改" && invalid) || (protocol && !!protocolError)
              }
            >
              {running ? `${rows.length} / ${targets.length}` : `应用到 ${targets.length} 个模型`}
            </button>
          )}
        </footer>
      </form>
    </ModelModal>
  );
}
