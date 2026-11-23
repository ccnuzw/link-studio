import type {
  ChannelFields,
  ChannelView,
  ModelKind,
  ProviderView,
  SettingsValues,
} from "@link-studio/core";
import {
  channelEndpointIdentity,
  channelEndpointIssue,
  channelHeaderIssue,
  channelNameIssue,
  modelKindLabels,
  modelKinds,
} from "@link-studio/core";
import {
  Box,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FlaskConical,
  GripVertical,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Power,
  RadioTower,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CatalogSelect, catalogPageNumbers } from "./adapter-catalog";
import { ChannelCards } from "./channel-cards";
import { channelModelHealth, compareChannelModels, matchesModelQuery } from "./channel-model-list";
import { type BatchAction, ModelBatch } from "./model-batch";
import { ModelBatchToolbar } from "./model-batch-toolbar";
import { KindMark, kindOf, ModelEditor, ModelModal } from "./model-editor";
import { ModelAvatar } from "./model-logo";
import { ModelTrial } from "./model-trial";
import { PluginNotice, reportChannelAction } from "./plugin-notice";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";
import { SettingsSwitch } from "./settings-switch";
import "./channel-workspace.css";
import { FilingLibrary, type RenderFilingPicker } from "./filing-library";

type Dialog =
  | "create"
  | "edit"
  | "keys"
  | "filing"
  | "model"
  | "trial"
  | "pull"
  | "remove-channel"
  | "remove-model";
const emptyChannel: ChannelFields = {
  name: "",
  endpoint: "",
  allowLocal: false,
  enabled: true,
  sort: 100,
  headers: [],
};

export function ChannelWorkspace({
  data,
  listState,
  refresh,
  initialModel,
  initialChannel,
  onSelection,
  renderFilingPicker,
}: {
  data: SettingsValues["list"];
  listState: "loading" | "ready" | "error";
  refresh: () => Promise<unknown>;
  initialModel?: string;
  initialChannel?: string;
  renderFilingPicker?: RenderFilingPicker;
  onSelection?: (selection: { channel?: { id: string; label: string }; modelId?: string }) => void;
}) {
  const api = settingsRequests;
  const [disableTarget, setDisableTarget] = useState<ChannelView>();
  const [disableError, setDisableError] = useState("");
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [channelsState, setChannelsState] = useState<"loading" | "error" | "ready">("loading");
  const channelsRequest = useRef(0);
  const [loads, setLoads] = useState<SettingsValues["channelLoads"]>([]);
  const [loadsStale, setLoadsStale] = useState(false);
  useEffect(() => {
    let sequence = 0;
    const poll = async () => {
      if (document.hidden) return;
      const request = ++sequence;
      const result = await window.desktop.settings
        .channelLoads({})
        .catch(() => ({ ok: false as const }));
      if (request !== sequence) return;
      setLoadsStale(!result.ok);
      if (result.ok) setLoads(result.value);
    };
    void poll();
    const timer = window.setInterval(poll, 15000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      sequence++;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);
  const [migrationTarget, setMigrationTarget] = useState("");
  const [deleteContainer, setDeleteContainer] = useState<HTMLDivElement | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const [removalChannel, setRemovalChannel] = useState<ChannelView>();
  const [deleteCheck, setDeleteCheck] = useState<"loading" | "error" | "ready">("loading");
  const deleteCheckToken = useRef(0);
  const target = data.providers.find(({ id }) => id === initialModel);
  const [selected, select] = useState(target?.channelId ?? initialChannel ?? "");
  const [dialog, setDialog] = useState<Dialog | undefined>(target ? "model" : undefined);
  const [model, setModel] = useState<ProviderView | undefined>(target);
  const [search, setSearch] = useState("");
  const [channelStatus, setChannelStatus] = useState("");
  const [query, setQuery] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  useEffect(() => {
    if (query === searchDraft) return;
    const timer = setTimeout(() => {
      setQuery(searchDraft);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, query]);
  const [kind, setKind] = useState<ModelKind | "pending" | "">("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const selectionScope = JSON.stringify([selected, page, pageSize, query, kind, status]);
  const [checkedScope, setCheckedScope] = useState(selectionScope);
  if (checkedScope !== selectionScope) {
    setCheckedScope(selectionScope);
    setChecked([]);
  }
  const [batch, setBatch] = useState<BatchAction>();
  const [dragging, setDragging] = useState<string>();
  const dragSource = useRef<string | undefined>(undefined);
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const clearDrag = () => {
    dragSource.current = undefined;
    setDragging(undefined);
    setDrop(undefined);
  };
  const reload = useCallback(async () => {
    const sequence = ++channelsRequest.current;
    const result = await api
      .channelList({})
      .catch(() => ({ ok: false as const, code: "SETTINGS_ACTION_FAILED" }));
    if (sequence !== channelsRequest.current) return false;
    if (result.ok) {
      setChannels(result.value);
      setChannelsState("ready");
    } else setChannelsState("error");
    return result.ok;
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const updated = async () => {
    await Promise.all([reload(), refresh()]);
  };
  const checkDelete = async () => {
    const token = ++deleteCheckToken.current;
    setDeleteCheck("loading");
    try {
      const [loaded, catalog] = await Promise.all([reload(), refresh()]);
      if (token === deleteCheckToken.current) setDeleteCheck(loaded && catalog ? "ready" : "error");
    } catch {
      if (token === deleteCheckToken.current) setDeleteCheck("error");
    }
  };
  const channel =
    dialog === "remove-channel" && removalChannel
      ? (channels.find((entry) => entry.id === removalChannel.id) ?? removalChannel)
      : (channels.find(({ id }) => id === selected) ?? channels[0]);
  const load = loads.find((entry) => entry.channel === channel?.id);
  const channelId = channel?.id,
    channelName = channel?.name;
  const inspectedModel =
    (dialog === "model" || dialog === "trial") && channelId && model?.channelId === channelId
      ? model.id
      : undefined;
  useEffect(
    () =>
      onSelection?.({
        channel: channelId ? { id: channelId, label: channelName ?? channelId } : undefined,
        modelId: inspectedModel,
      }),
    [channelId, channelName, inspectedModel, onSelection],
  );
  const activeJobs = channel?.activeJobs ?? 0;
  const deleteModel = data.providers.find((entry) => entry.id === model?.id);
  const modelCounts = new Map<string, number>();
  for (const { channelId } of data.providers) {
    if (channelId) modelCounts.set(channelId, (modelCounts.get(channelId) ?? 0) + 1);
  }
  const selectChannel = (id: string) => {
    if (id === channel?.id) return;
    select(id);
    setQuery("");
    setSearchDraft("");
    setKind("");
    setStatus("");
    setPage(0);
    setChecked([]);
  };
  const trialPlugin = data.plugins.find(({ hash }) => hash === model?.pluginHash);
  const models = data.providers
    .filter((entry) => entry.channelId && entry.channelId === channel?.id)
    .sort(compareChannelModels);
  const pluginsByHash = new Map(data.plugins.map((plugin) => [plugin.hash, plugin]));
  const deleteReady = deleteCheck === "ready";
  const deleteBlocked =
    deleteReady &&
    (dialog === "remove-model" ? deleteModel?.enabled : Boolean(models.length || activeJobs));
  const deleteLabel =
    dialog === "remove-model" ? (deleteModel?.config?.name ?? deleteModel?.model) : channel?.name;
  const keyword = query.trim().toLowerCase();
  const emptyChannelModels =
    listState === "ready" && !models.length && !keyword && !kind && !status;
  const newModel = () => {
    setModel(undefined);
    setDialog("model");
  };
  const matches = models.filter(
    (entry) =>
      (!kind || (entry.pending ? kind === "pending" : kindOf(entry, data.plugins) === kind)) &&
      (kind === "pending" ||
        !status ||
        channelModelHealth(entry, channel, pluginsByHash.get(entry.pluginHash)).status ===
          status) &&
      matchesModelQuery(keyword, entry, channel, pluginsByHash.get(entry.pluginHash)),
  );
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const visibleModels = new Map(rows.map((entry) => [entry.id, entry]));
  const selectedModels = checked
    .map((id) => visibleModels.get(id))
    .filter((entry): entry is ProviderView => entry !== undefined);
  const visibleChannels = channels.filter(
    (entry) =>
      (!channelStatus || entry.enabled === (channelStatus === "enabled")) &&
      `${entry.name} ${entry.endpoint} ${entry.id}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const close = () => setDialog(undefined);
  const act = async (
    action: () => Promise<{ ok: true; value: unknown } | { ok: false; code: string }>,
    message: string,
  ) => {
    setBusy(true);
    setNotice("");
    try {
      const result = await action();
      if (!result.ok) {
        const message = settingsError(result.code);
        setNotice(message);
        if (dialog === "remove-channel" || dialog === "remove-model")
          reportChannelAction(message, "error");
      } else {
        await updated();
        if (dialog === "remove-channel" || dialog === "remove-model") reportChannelAction(message);
        else setNotice(message);
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  const toggle = (entry: ProviderView, enabled: boolean) =>
    api.modelToggle({ id: entry.id, expectedRevision: entry.revision, enabled });
  const disableChannel = async (target: ChannelView) => {
    if (busy) return;
    setBusy(true);
    setDisableError("");
    try {
      const result = await api.channelSave({
        id: target.id,
        expectedRevision: target.revision,
        fields: channelFields(target, { enabled: false }),
        approve: false,
      });
      if (!result.ok) {
        setDisableError(settingsError(result.code));
        if (result.code === "SETTINGS_REVISION_CONFLICT") {
          const latest = await api.channelList({});
          if (latest.ok) {
            setChannels(latest.value);
            const current = latest.value.find((entry) => entry.id === target.id);
            setDisableTarget(current?.enabled ? current : undefined);
          }
        }
        return;
      }
      setDisableTarget(undefined);
      await updated();
      setNotice(`渠道「${target.name}」已停用，画布里它的模型已不可见`);
    } catch {
      setDisableError(settingsError("SETTINGS_ACTION_FAILED"));
    } finally {
      setBusy(false);
    }
  };
  const reorderChannels = async (source: string, target: string, after: boolean) => {
    if (busy || source === target) return;
    const moving = channels.find(({ id }) => id === source);
    const reordered = channels.filter(({ id }) => id !== source);
    const position = reordered.findIndex(({ id }) => id === target);
    if (!moving || position < 0) return;
    reordered.splice(position + Number(after), 0, moving);
    if (reordered.every(({ id }, index) => channels[index]?.id === id)) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await api.channelReorder({
        order: reordered.map(({ id, revision }) => ({ id, expectedRevision: revision })),
      });
      if (result.ok) {
        if (channel) select(channel.id);
        setChannels(result.value);
        setNotice("渠道顺序已保存。");
      } else {
        await reload();
        setNotice(settingsError(result.code));
      }
    } catch {
      setNotice("渠道排序保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const reorderModels = async (source: string, target: string, after: boolean) => {
    if (busy || !channel || source === target) return;
    const moving = rows.find(({ id }) => id === source);
    const reordered = rows.filter(({ id }) => id !== source);
    const position = reordered.findIndex(({ id }) => id === target);
    if (!moving || position < 0) return;
    reordered.splice(position + Number(after), 0, moving);
    if (reordered.every(({ id }, index) => rows[index]?.id === id)) return;
    if (reordered.some((entry, index) => entry.enabled !== rows[index]?.enabled)) return;
    const visible = new Set(rows.map(({ id }) => id));
    const replacements = reordered.values();
    const order = models.map((entry) => {
      const { id, revision } = visible.has(entry.id) ? (replacements.next().value ?? entry) : entry;
      return { id, expectedRevision: revision };
    });
    setBusy(true);
    setNotice("");
    try {
      const result = await api.modelReorder({
        channelId: channel.id,
        channelRevision: channel.revision,
        order,
      });
      await updated();
      setNotice(result.ok ? "模型顺序已保存。" : settingsError(result.code));
    } catch {
      setNotice("模型排序保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="channel-workspace">
      <PluginNotice
        channel
        detailOpen={dialog === "model"}
        actionOpen={dialog === "remove-channel" || dialog === "remove-model"}
      />
      {disableTarget && (
        <ModelModal
          variant="destructive-confirm"
          title="停用渠道？"
          subtitle={`「${disableTarget.name}」的模型将在画布中不可见，进行中的任务不受影响。`}
          close={() => {
            if (!busy) setDisableTarget(undefined);
          }}
        >
          {disableError && (
            <p className="upload-error-heading" role="alert">
              {disableError}
            </p>
          )}
          <footer className="model-dialog-footer">
            <button type="button" disabled={busy} onClick={() => setDisableTarget(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="adapter-danger"
              disabled={busy}
              onClick={() => void disableChannel(disableTarget)}
            >
              {busy && <Loader2 size={16} />}停用
            </button>
          </footer>
        </ModelModal>
      )}
      <aside className="channel-sidebar" aria-label="模型渠道列表">
        <h2>
          渠道 <small>{channels.length}</small>
        </h2>
        <button
          type="button"
          className="settings-primary channel-add"
          onClick={() => setDialog("create")}
        >
          <Plus size={16} /> 新增渠道
        </button>
        <label className="channel-search">
          <Search size={15} />
          <input
            type="search"
            aria-label="搜索渠道"
            placeholder="搜索渠道名称或地址"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <fieldset className="channel-status-filter" aria-label="渠道状态筛选">
          {(
            [
              ["", "全部"],
              ["enabled", "已启用"],
              ["disabled", "已停用"],
            ] as const
          ).map(([key, title]) => (
            <button
              type="button"
              key={key}
              aria-pressed={key === channelStatus}
              onClick={() => setChannelStatus(key)}
            >
              {title}
            </button>
          ))}
        </fieldset>
        <ChannelCards
          channels={visibleChannels}
          selected={channel?.id}
          modelCounts={modelCounts}
          sortable={!busy && visibleChannels.length === channels.length}
          select={selectChannel}
          reorder={(source, target, after) => void reorderChannels(source, target, after)}
        />
        {channelsState === "loading" ? (
          <div className="channel-list-loading" aria-label="渠道列表加载中">
            {[0, 1, 2].map((index) => (
              <div className="channel-models-skeleton" key={index} />
            ))}
          </div>
        ) : channelsState === "error" && !channels.length ? (
          <div className="channel-list-error">
            渠道清单加载失败
            <button type="button" onClick={() => void reload()}>
              重试
            </button>
          </div>
        ) : (
          !visibleChannels.length && (
            <p className="channel-list-empty">
              {channels.length ? "没有匹配的渠道" : "还没有渠道"}
            </p>
          )
        )}
      </aside>
      <section className="channel-content" aria-label="渠道模型管理">
        {channelsState === "error" && !!channels.length && (
          <div className="channel-detail-error" role="alert">
            渠道清单刷新失败，显示的是旧数据
            <button type="button" onClick={() => void reload()}>
              重试
            </button>
          </div>
        )}
        {notice && (
          <p className="model-notice" role="status">
            {notice}
          </p>
        )}
        {channel ? (
          <>
            <section className="channel-overview" aria-label="渠道详情">
              <header className="channel-heading">
                <div>
                  <h2>
                    {channel.name}{" "}
                    <span className="model-status" data-online={channel.enabled}>
                      {channel.enabled ? "已启用" : "已停用"}
                    </span>
                  </h2>
                </div>
                <div className="settings-actions">
                  <button type="button" onClick={() => setDialog("edit")}>
                    <Pencil size={15} /> 编辑渠道
                  </button>
                  <button type="button" onClick={() => setDialog("keys")}>
                    <KeyRound size={15} /> 设置 Key
                  </button>
                  {(channel.filing?.enabled || channel.hasFilingRecords) && (
                    <button type="button" onClick={() => setDialog("filing")}>
                      虚拟人像库
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (channel.enabled) {
                        setDisableError("");
                        setDisableTarget(channel);
                        return;
                      }
                      void act(
                        () =>
                          api.channelSave({
                            id: channel.id,
                            expectedRevision: channel.revision,
                            fields: channelFields(channel, { enabled: true }),
                            approve: false,
                          }),
                        `渠道「${channel.name}」已启用`,
                      );
                    }}
                  >
                    <Power size={16} /> {channel.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="model-danger"
                    disabled={busy}
                    onClick={() => {
                      setRemovalChannel(channel);
                      setMigrationTarget(
                        channels.find((entry) => entry.id !== channel.id)?.id ?? "",
                      );
                      setDeleteName("");
                      setNotice("");
                      setDialog("remove-channel");
                      void checkDelete();
                    }}
                  >
                    <Trash2 size={16} /> 删除
                  </button>
                </div>
              </header>
              <code>{channel.endpoint}</code>
              <div className="channel-metadata">
                <span data-tone={channel.hasSecret ? "success" : "warning"}>
                  API Key {channel.hasSecret ? "已配置" : "未设置"}
                </span>
                <span data-tone={channel.hasSecretKey ? "success" : "neutral"}>
                  Secret Key {channel.hasSecretKey ? "已设置" : "未设置（可选）"}
                </span>
                <span>请求头 {channel.headers.length} 条</span>
                <span>
                  限流{" "}
                  {channel.rps || channel.concurrent || channel.running
                    ? `rps ${channel.rps || "不限"} · 并发 ${channel.concurrent || "不限"} · 同时生成 ${channel.running || "不限"}`
                    : "不限"}
                </span>
                <span
                  data-tone={loadsStale ? "warning" : "neutral"}
                  title={loadsStale ? "负载刷新失败，显示的是旧数据" : "每 15 秒刷新"}
                >
                  生成中 {load?.running ?? 0}/{channel.running || "不限"} · 排队{" "}
                  {load?.waiting ?? 0}
                  {loadsStale && "（旧数据）"}
                </span>
              </div>
              {!channel.enabled && (
                <p className="channel-disabled-notice">
                  <CircleAlert size={16} />
                  渠道已停用，模型在画布中不可见
                </p>
              )}
            </section>
            <div className="channel-heading channel-model-heading">
              <h2>
                模型管理 <small>{models.length}</small>
              </h2>
              <div className="settings-actions">
                <button type="button" disabled={!channel.enabled} onClick={() => setDialog("pull")}>
                  <RefreshCw size={15} /> 拉取模型
                </button>
                <button type="button" className="settings-primary" onClick={newModel}>
                  <Plus size={16} /> 新增模型
                </button>
              </div>
            </div>
            {emptyChannelModels ? (
              <section className="channel-models-empty" aria-label="渠道模型空状态">
                <Box aria-hidden="true" size={32} />
                <strong>这个渠道下还没有模型</strong>
                {!channel.hasSecret && <p>未设置 API Key，拉取前请先设置</p>}
                <div className="settings-actions">
                  <button
                    type="button"
                    className="settings-primary"
                    disabled={!channel.enabled}
                    onClick={() => setDialog("pull")}
                  >
                    <RefreshCw size={16} />
                    拉取模型
                  </button>
                  <button type="button" onClick={newModel}>
                    <Plus size={16} />
                    新增模型
                  </button>
                </div>
              </section>
            ) : (
              <div className="channel-table">
                <div className="channel-toolbar">
                  <label className="channel-search">
                    <Search size={15} />
                    <input
                      type="search"
                      aria-label="搜索渠道模型"
                      placeholder="搜索模型标识或显示名称"
                      autoComplete="off"
                      value={searchDraft}
                      onChange={(event) => setSearchDraft(event.target.value)}
                    />
                    {searchDraft && (
                      <button
                        type="button"
                        aria-label="清空搜索"
                        onClick={() => {
                          setSearchDraft("");
                          setQuery("");
                          setPage(0);
                        }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </label>
                  <div className="channel-filter-selects">
                    <CatalogSelect
                      label="按模型能力筛选"
                      value={kind}
                      change={(value) => {
                        setKind(value as typeof kind);
                        setPage(0);
                      }}
                      options={[
                        ["", "全部能力"],
                        ...modelKinds.map((item) => [item, modelKindLabels[item]] as const),
                        ["pending", "待配置"],
                      ]}
                    />
                    <CatalogSelect
                      label="按模型状态筛选"
                      value={status}
                      change={(value) => {
                        setStatus(value);
                        setPage(0);
                      }}
                      options={[
                        ["", "全部状态"],
                        ["online", "在线"],
                        ["broken", "不可用"],
                        ["offline", "未上线"],
                      ]}
                    />
                  </div>
                  <small
                    className="channel-filter-count"
                    title={`筛选结果 ${matches.length} 条，共 ${models.length} 条`}
                  >
                    {rows.length} / {matches.length}
                  </small>
                </div>
                <div className="channel-table-scroll">
                  <table aria-label="渠道模型">
                    <thead>
                      <tr>
                        <th className="channel-model-order" aria-label="排序" scope="col" />
                        <th>
                          <input
                            aria-label="选择本页模型"
                            type="checkbox"
                            checked={rows.length > 0 && selectedModels.length === rows.length}
                            ref={(input) => {
                              if (input)
                                input.indeterminate =
                                  selectedModels.length > 0 && selectedModels.length < rows.length;
                            }}
                            onChange={(event) =>
                              setChecked((before) =>
                                event.target.checked
                                  ? [...new Set([...before, ...rows.map(({ id }) => id)])]
                                  : before.filter((id) => !rows.some((entry) => entry.id === id)),
                              )
                            }
                          />
                        </th>
                        <th>模型</th>
                        <th>能力</th>
                        <th>请求协议</th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listState === "loading" &&
                        [0, 1, 2, 3].map((index) => (
                          <tr key={index}>
                            <td colSpan={7}>
                              <div className="channel-models-skeleton" aria-label="加载中" />
                            </td>
                          </tr>
                        ))}
                      {listState === "error" && (
                        <tr>
                          <td className="channel-models-no-match" colSpan={7}>
                            <span role="alert">加载失败</span>
                            <button
                              className="channel-models-retry"
                              type="button"
                              onClick={() => void refresh()}
                            >
                              重试
                            </button>
                          </td>
                        </tr>
                      )}
                      {listState === "ready" && !rows.length && (
                        <tr>
                          <td className="channel-models-no-match" colSpan={7}>
                            没有匹配的模型
                          </td>
                        </tr>
                      )}
                      {rows.map((entry, index) => {
                        const plugin = pluginsByHash.get(entry.pluginHash);
                        const health = channelModelHealth(entry, channel, plugin);
                        const capability = kindOf(entry, data.plugins);
                        const name = entry.config?.name ?? entry.model;
                        return (
                          <tr
                            key={entry.id}
                            data-state={checked.includes(entry.id) ? "selected" : undefined}
                            data-dragging={dragging === entry.id}
                            data-drop={
                              drop?.id === entry.id ? (drop.after ? "after" : "before") : undefined
                            }
                            onDragOver={(event) => {
                              if (busy || !dragSource.current || dragSource.current === entry.id)
                                return;
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              const rect = event.currentTarget.getBoundingClientRect();
                              setDrop({
                                id: entry.id,
                                after: event.clientY >= rect.top + rect.height / 2,
                              });
                            }}
                            onDragLeave={(event) => {
                              if (
                                !event.currentTarget.contains(event.relatedTarget as Node | null)
                              ) {
                                setDrop((current) =>
                                  current?.id === entry.id ? undefined : current,
                                );
                              }
                            }}
                            onDrop={(event) => {
                              const source = dragSource.current;
                              if (busy || !source || source === entry.id) return;
                              event.preventDefault();
                              const rect = event.currentTarget.getBoundingClientRect();
                              void reorderModels(
                                source,
                                entry.id,
                                event.clientY >= rect.top + rect.height / 2,
                              );
                              clearDrag();
                            }}
                            onClick={(event) => {
                              if (
                                (event.target as Element).closest(
                                  "button, input, label, .channel-model-order, .channel-model-state, .channel-select-cell, .channel-actions-cell",
                                )
                              )
                                return;
                              setModel(entry);
                              setDialog("model");
                            }}
                          >
                            <td className="channel-model-order">
                              {rows.length > 1 && (
                                <button
                                  type="button"
                                  className="channel-model-grip"
                                  aria-label={`排序 ${name}`}
                                  aria-keyshortcuts="ArrowUp ArrowDown"
                                  title="拖动排序，或聚焦后用 ↑ / ↓ 移动"
                                  aria-disabled={busy || rows.length < 2}
                                  draggable={!busy && rows.length > 1}
                                  onKeyDown={(event) => {
                                    if (
                                      busy ||
                                      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                                    )
                                      return;
                                    event.preventDefault();
                                    const after = event.key === "ArrowDown";
                                    const target = rows[index + (after ? 1 : -1)];
                                    if (target && !event.repeat)
                                      void reorderModels(entry.id, target.id, after);
                                  }}
                                  onDragStart={(event) => {
                                    dragSource.current = entry.id;
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData("text/plain", name);
                                    const row = event.currentTarget.closest("tr");
                                    if (row) event.dataTransfer.setDragImage(row, 18, 18);
                                    setDragging(entry.id);
                                  }}
                                  onDragEnd={clearDrag}
                                >
                                  <GripVertical size={16} aria-hidden="true" />
                                </button>
                              )}
                            </td>
                            <td className="channel-select-cell">
                              <input
                                type="checkbox"
                                aria-label={`选择 ${entry.config?.name ?? entry.model}`}
                                checked={checked.includes(entry.id)}
                                onChange={(event) =>
                                  setChecked((before) =>
                                    event.target.checked
                                      ? [...before, entry.id]
                                      : before.filter((id) => id !== entry.id),
                                  )
                                }
                              />
                            </td>
                            <th scope="row">
                              <button
                                className="channel-model-name"
                                type="button"
                                onClick={() => {
                                  setModel(entry);
                                  setDialog("model");
                                }}
                              >
                                <ModelAvatar
                                  seed={entry.modelKey ?? entry.id}
                                  name={entry.config?.name ?? entry.model}
                                  logo={entry.config?.logo}
                                />
                                <span>
                                  <strong>{entry.config?.name ?? entry.model}</strong>
                                  {!!entry.config?.tags?.length && (
                                    <span className="channel-model-tags">
                                      {entry.config.tags.map((tag) => (
                                        <span key={tag}>{tag}</span>
                                      ))}
                                    </span>
                                  )}
                                </span>
                              </button>
                            </th>
                            <td>
                              {entry.pending ? (
                                <span className="model-pending">待配置</span>
                              ) : (
                                <KindMark kind={capability} />
                              )}
                            </td>
                            <td>
                              {entry.pending ? (
                                <span className="model-pending">待配置</span>
                              ) : (
                                <span>
                                  {capability === "agent"
                                    ? "宿主网关"
                                    : (plugin?.name ?? "协议不可用")}
                                </span>
                              )}
                              {plugin && capability !== "agent" && (
                                <span className="channel-protocol-version">@{plugin.version}</span>
                              )}
                            </td>
                            <td>
                              <div className="channel-model-state">
                                <SettingsSwitch
                                  label={`${entry.config?.name ?? entry.model} 上线`}
                                  checked={entry.enabled}
                                  disabled={busy || entry.pending || !!entry.draftIssueCount}
                                  reason={
                                    entry.draftIssueCount
                                      ? health.reason
                                      : entry.pending
                                        ? "还没有选择能力或协议，先编辑模型"
                                        : undefined
                                  }
                                  onChange={(enabled) =>
                                    void act(
                                      () => toggle(entry, enabled),
                                      enabled ? "模型上线设置已保存。" : "模型已下线。",
                                    )
                                  }
                                />
                                <span>
                                  <span className="model-status" data-health={health.status}>
                                    {health.label}
                                  </span>
                                  {health.reason && (
                                    <small
                                      className="channel-model-reason"
                                      data-health={health.status}
                                    >
                                      {health.status === "offline" ? "上线前要处理：" : ""}
                                      {health.reason}
                                    </small>
                                  )}
                                </span>
                              </div>
                            </td>
                            <td className="channel-actions-cell">
                              <div className="channel-row-actions">
                                <button
                                  type="button"
                                  aria-label={`测试 ${entry.config?.name ?? entry.model}`}
                                  title={
                                    entry.draftIssueCount
                                      ? health.reason
                                      : entry.pending
                                        ? "还没有选择能力，先编辑模型"
                                        : capability === "agent"
                                          ? "Agent 模型暂不支持试跑"
                                          : "测试模型"
                                  }
                                  disabled={
                                    busy ||
                                    entry.pending ||
                                    !!entry.draftIssueCount ||
                                    capability === "agent" ||
                                    !channel.enabled ||
                                    !plugin ||
                                    plugin.disabled
                                  }
                                  onClick={() => {
                                    setModel(entry);
                                    setDialog("trial");
                                  }}
                                >
                                  <FlaskConical size={15} />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  className="model-danger"
                                  aria-label={`删除 ${entry.config?.name ?? entry.model}`}
                                  title="删除模型"
                                  onClick={() => {
                                    setModel(entry);
                                    setNotice("");
                                    setDialog("remove-model");
                                    void checkDelete();
                                  }}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {listState === "ready" && (
                  <footer className="channel-pagination">
                    <div className="channel-pagination-size">
                      <label>
                        <CatalogSelect
                          label="模型每页条数"
                          value={String(pageSize)}
                          options={["10", "20", "30", "40", "50"].map((size) => [size, size])}
                          side="top"
                          change={(value) => {
                            setPageSize(Number(value));
                            setPage(0);
                          }}
                        />
                        每页条数
                      </label>
                      <span>共 {matches.length} 条</span>
                    </div>
                    <nav className="channel-page-controls" aria-label="模型列表分页">
                      <span className="channel-page-summary">
                        第 {currentPage + 1} / {pageCount} 页
                      </span>
                      <button
                        type="button"
                        aria-label="第一页"
                        title="第一页"
                        disabled={!currentPage}
                        onClick={() => setPage(0)}
                      >
                        <ChevronFirst size={16} />
                      </button>
                      <button
                        type="button"
                        aria-label="上一页"
                        title="上一页"
                        disabled={!currentPage}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      {catalogPageNumbers(currentPage + 1, pageCount).map((number, index) =>
                        typeof number === "number" ? (
                          <button
                            type="button"
                            key={number}
                            aria-label={`第 ${number} 页`}
                            aria-current={number === currentPage + 1 ? "page" : undefined}
                            onClick={() => setPage(number - 1)}
                          >
                            {number}
                          </button>
                        ) : (
                          <span key={`gap-${index}`} aria-hidden="true">
                            …
                          </span>
                        ),
                      )}
                      <button
                        type="button"
                        aria-label="下一页"
                        title="下一页"
                        disabled={currentPage + 1 === pageCount}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        <ChevronRight size={16} />
                      </button>
                      <button
                        type="button"
                        aria-label="最后一页"
                        title="最后一页"
                        disabled={currentPage + 1 === pageCount}
                        onClick={() => setPage(pageCount - 1)}
                      >
                        <ChevronLast size={16} />
                      </button>
                    </nav>
                  </footer>
                )}
              </div>
            )}
            <ModelBatchToolbar
              count={selectedModels.length}
              disabled={busy || !!batch}
              select={setBatch}
              clear={() => setChecked([])}
            />
            {batch && (
              <ModelBatch
                action={batch}
                channel={channel}
                channels={channels}
                models={selectedModels}
                plugins={data.plugins}
                pluginsStatus={listState}
                refresh={() => updated().catch(() => setNotice("模型列表刷新失败，请重新载入。"))}
                close={() => setBatch(undefined)}
              />
            )}
          </>
        ) : channelsState === "loading" ? (
          <div className="channel-detail-loading" aria-label="渠道详情加载中">
            <div className="channel-models-skeleton" />
            <div className="channel-models-skeleton" />
          </div>
        ) : channelsState === "error" ? (
          <div className="channel-detail-error" role="alert">
            渠道清单加载失败
            <button type="button" onClick={() => void reload()}>
              重试
            </button>
          </div>
        ) : (
          <div className="channel-empty channel-empty-large">
            <RadioTower size={32} />
            <strong>还没有渠道</strong>
            <button type="button" className="settings-primary" onClick={() => setDialog("create")}>
              <Plus size={16} /> 新增渠道
            </button>
          </div>
        )}
      </section>
      {(dialog === "create" || (dialog === "edit" && channel)) && (
        <ChannelDialog
          key={`${dialog}:${dialog === "edit" ? channel?.id : ""}`}
          channel={dialog === "edit" ? channel : undefined}
          refreshChannels={reload}
          close={close}
          saved={async (entry, message) => {
            selectChannel(entry.id);
            close();
            setNotice(message);
            await updated();
          }}
        />
      )}
      {dialog === "keys" && channel && (
        <KeysDialog channel={channel} close={close} saved={updated} />
      )}
      {dialog === "model" && channel && (
        <ModelEditor
          key={model?.id ?? "new"}
          channel={channel}
          providers={data.providers}
          channels={channels}
          model={model}
          plugins={data.plugins}
          pluginsStatus={listState}
          close={close}
          saved={updated}
        />
      )}
      {dialog === "trial" && model && trialPlugin && (
        <ModelTrial model={model} plugin={trialPlugin} close={close} />
      )}
      {dialog === "filing" && channel && (
        <FilingLibrary channel={channel} close={close} renderFilingPicker={renderFilingPicker} />
      )}
      {dialog === "pull" && channel && (
        <PullDialog
          key={`${channel.id}:${channel.revision}`}
          channel={channel}
          manual={() => {
            setModel(undefined);
            setDialog("model");
          }}
          close={close}
          saved={async (added, prefixed) => {
            await updated();
            reportChannelAction(
              `已导入 ${added} 个待配置模型${prefixed ? `（${prefixed} 个 key 与其他模型冲突，已加渠道前缀）` : ""}`,
            );
            close();
          }}
        />
      )}
      {(dialog === "remove-channel" || (dialog === "remove-model" && deleteModel)) && channel && (
        <ModelModal
          variant="channel-delete"
          headerIcon={
            <span className="channel-delete-icon" data-blocked={deleteBlocked}>
              {deleteBlocked ? <Lock size={16} /> : <Trash2 size={16} />}
            </span>
          }
          subtitle={deleteBlocked ? undefined : !deleteReady ? "正在检查引用…" : "删除后不能撤销。"}
          title={`${deleteBlocked ? "暂时不能删除" : dialog === "remove-channel" ? "删除渠道？" : "删除模型？"}「${deleteLabel}」`}
          close={() => {
            if (!busy) close();
          }}
        >
          <div className="model-dialog-body reference-delete-body" ref={setDeleteContainer}>
            {deleteCheck === "loading" && (
              <div className="delete-check-skeleton" role="status" aria-label="正在检查引用" />
            )}
            {deleteCheck === "error" && (
              <div className="upload-error-heading" role="alert">
                <CircleAlert size={16} />
                <span>没能检查引用情况</span>
                <button type="button" onClick={() => void checkDelete()}>
                  重试
                </button>
              </div>
            )}
            {deleteReady && dialog === "remove-model" && deleteModel?.enabled && (
              <section className="channel-migration model-delete-blocker">
                <strong>
                  <CircleAlert size={16} />
                  模型还在上线，先下线再删除
                </strong>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const disabled = await toggle(deleteModel, false);
                      if (!disabled.ok) {
                        await updated();
                        return disabled;
                      }
                      const result = await api.modelRemove({
                        id: deleteModel.id,
                        expectedRevision: disabled.value.revision,
                      });
                      if (!result.ok) await updated();
                      return result;
                    }, `已删除模型「${deleteLabel}」`)
                  }
                >
                  下架并删除
                </button>
              </section>
            )}
            {deleteReady && dialog === "remove-model" && !deleteBlocked && (
              <div className="channel-delete-cascade">
                <div>
                  <span>一起删除：</span>草稿与全部历史版本
                </div>
                <div>
                  <span>不受影响：</span>历史生成任务
                </div>
              </div>
            )}
            {deleteReady && dialog === "remove-channel" && !models.length && !activeJobs && (
              <>
                <div className="channel-delete-cascade">
                  <div>
                    <span>一起删除：</span>渠道的 API Key 与 Secret Key
                  </div>
                  <div>
                    <span>不受影响：</span>历史生成任务
                  </div>
                </div>
                <label>
                  <span>
                    输入 <code>{channel.name}</code> 确认
                  </span>
                  <input
                    aria-label="输入名称确认删除"
                    autoComplete="off"
                    value={deleteName}
                    onChange={(event) => setDeleteName(event.target.value)}
                  />
                </label>
              </>
            )}
            {deleteReady && dialog === "remove-channel" && models.length > 0 && (
              <section className="channel-migration">
                <strong>
                  <CircleAlert size={16} />
                  {models.length} 个模型在用这个渠道
                </strong>
                <div className="channel-migration-refs">
                  {models.map((entry) => (
                    <a
                      href={`#model=${encodeURIComponent(entry.modelKey ?? entry.id)}`}
                      key={entry.id}
                      onClick={(event) => {
                        event.preventDefault();
                        setModel(entry);
                        setDialog("model");
                      }}
                    >
                      {entry.config?.name || entry.model}
                    </a>
                  ))}
                </div>
                {channels.length > 1 ? (
                  <>
                    <div className="channel-migration-row">
                      <span>全部迁到</span>
                      <CatalogSelect
                        label="迁移到的渠道"
                        container={deleteContainer?.closest("dialog")}
                        viewportPopup
                        value={migrationTarget}
                        change={setMigrationTarget}
                        options={channels
                          .filter((target) => target.id !== channel.id)
                          .map((target) => [
                            target.id,
                            `${target.name}（${!target.enabled ? "已停用" : target.hasSecret ? "可用" : "未设 Key"}）`,
                          ])}
                      />
                      <button
                        type="button"
                        disabled={busy || !migrationTarget}
                        onClick={async () => {
                          const target = channels.find((entry) => entry.id === migrationTarget);
                          if (!target || busy) return;
                          setBusy(true);
                          setNotice("");
                          const errors: string[] = [];
                          let moved = 0;
                          try {
                            for (const entry of models) {
                              try {
                                const result = await api.modelMove({
                                  id: entry.id,
                                  expectedRevision: entry.revision,
                                  sourceId: channel.id,
                                  sourceRevision: channel.revision,
                                  targetId: target.id,
                                  targetRevision: target.revision,
                                });
                                if (result.ok) moved++;
                                else errors.push(`${entry.model}：${settingsError(result.code)}`);
                              } catch {
                                errors.push(`${entry.model}：未收到迁移结果`);
                              }
                            }
                            if (moved)
                              reportChannelAction(`已把 ${moved} 个模型迁到「${target.name}」`);
                            setNotice(errors.join("；"));
                            await checkDelete();
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {busy && <Loader2 size={16} className="settings-spin" />}迁移
                      </button>
                    </div>
                    <small>新渠道需已启用并设置 Key</small>
                  </>
                ) : (
                  <small>没有其他可迁移的渠道</small>
                )}
              </section>
            )}
            {deleteReady && dialog === "remove-channel" && activeJobs > 0 && (
              <section className="channel-migration">
                <strong>
                  <CircleAlert size={16} />
                  {activeJobs} 个进行中的任务在用这个渠道
                </strong>
              </section>
            )}
            {notice && (
              <div className="upload-error-heading" role="alert">
                <CircleAlert size={16} />
                <span>{notice}</span>
              </div>
            )}
          </div>
          <footer className="model-dialog-footer">
            <button type="button" disabled={busy} onClick={close}>
              {deleteBlocked ? "关闭" : "取消"}
            </button>
            {!deleteBlocked && (
              <button
                type="button"
                className="model-danger"
                disabled={
                  !deleteReady ||
                  busy ||
                  (dialog === "remove-channel" && deleteName.trim() !== channel.name)
                }
                onClick={() => {
                  if (dialog === "remove-channel")
                    void act(async () => {
                      const result = await api
                        .channelRemove({
                          id: channel.id,
                          expectedRevision: channel.revision,
                        })
                        .catch(() => ({ ok: false as const, code: "SETTINGS_ACTION_FAILED" }));
                      if (!result.ok) void checkDelete();
                      return result;
                    }, `已删除渠道「${channel.name}」`);
                  else if (deleteModel)
                    void act(async () => {
                      const result = await api.modelRemove({
                        id: deleteModel.id,
                        expectedRevision: deleteModel.revision,
                      });
                      if (!result.ok) await updated();
                      return result;
                    }, "模型已删除。");
                }}
              >
                {busy ? <Loader2 size={16} className="settings-spin" /> : <Trash2 size={16} />} 删除
              </button>
            )}
          </footer>
        </ModelModal>
      )}
    </div>
  );
}

function channelFields(channel: ChannelView, patch?: Partial<ChannelFields>): ChannelFields {
  const { name, endpoint, allowLocal, enabled, sort, headers, rps, concurrent, running } = channel;
  return {
    name,
    endpoint,
    allowLocal,
    enabled,
    sort,
    headers: headers.map((header) => ({ ...header, value: "" })),
    filing: channel.filing,
    rps,
    concurrent,
    running,
    ...patch,
  };
}

function ChannelDialog({
  channel: openedChannel,
  refreshChannels,
  close,
  saved,
}: {
  channel?: ChannelView;
  refreshChannels: () => Promise<boolean>;
  close: () => void;
  saved: (channel: ChannelView, message: string) => Promise<void>;
}) {
  const [channel, setChannel] = useState(openedChannel);
  const [fields, setFields] = useState(channel ? channelFields(channel) : emptyChannel);
  const [initial, setInitial] = useState(fields);
  const [attempted, setAttempted] = useState(false);
  const [limits, setLimits] = useState(() => ({
    rps: String(fields.rps || ""),
    concurrent: String(fields.concurrent || ""),
    running: String(fields.running || ""),
  }));
  const [badNumbers, setBadNumbers] = useState<Partial<Record<keyof typeof limits, boolean>>>({});
  const [accessKey, setAccessKey] = useState("");
  const [filingSecret, setFilingSecret] = useState("");
  const filing = fields.filing ?? { enabled: false, groupId: "", projectName: "" };
  const officialFilingEndpoint =
    /^https:\/\/ark\.(cn-beijing\.volces|ap-southeast\.bytepluses)\.com(?::443)?(?:\/|$)/i.test(
      fields.endpoint.trim(),
    );
  const [discard, setDiscard] = useState(false);
  const [secret, setSecret] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [headerKeys, setHeaderKeys] = useState(() => fields.headers.map(() => crypto.randomUUID()));
  const addHeader = (name: string, value: string) => {
    setHeaderKeys([...headerKeys, crypto.randomUUID()]);
    setFields({ ...fields, headers: [...fields.headers, { name, value }] });
  };
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (next: Partial<ChannelFields>) => setFields({ ...fields, ...next });
  const dismiss = () => {
    if (busy) return;
    if (
      JSON.stringify(fields) !== JSON.stringify(initial) ||
      limitInputs.some(([key]) => limits[key] !== String(initial[key] || "") || badNumbers[key]) ||
      secret ||
      secretKey ||
      approve ||
      accessKey ||
      filingSecret
    ) {
      setDiscard(true);
      return;
    }
    close();
  };
  const endpointIssue = channelEndpointIssue(fields.endpoint);
  const endpoint = endpointIssue
    ? undefined
    : channelEndpointIdentity(new URL(fields.endpoint), channel?.endpoint);
  const changed =
    !channel || channel.endpoint !== endpoint || channel.allowLocal !== fields.allowLocal;
  const filingKeysSet = !!channel?.hasFilingKeys && !changed;
  const limitInputs = [
    ["rps", "每秒请求数 rps"],
    ["concurrent", "最大同时请求数"],
    ["running", "最大同时生成数"],
  ] as const;
  const issues: Record<string, string | undefined> = {
    name: channelNameIssue(fields.name),
    endpoint: endpointIssue,
  };
  const seen = new Set<string>();
  fields.headers.forEach(({ name, value }, index) => {
    if (name.trim() || value.trim())
      issues[`header-${index}`] = channelHeaderIssue(name, value, seen);
  });
  for (const [key, title] of limitInputs) {
    const value = Number(limits[key]);
    const label = key === "rps" ? key : title;
    if (badNumbers[key] || !Number.isFinite(value) || value < 0)
      issues[key] = `${label}必须是非负数字`;
    else if (key !== "rps" && !Number.isSafeInteger(value))
      issues[key] = `${label}必须是${Number.isInteger(value) ? "安全" : ""}整数`;
  }
  if (filing.enabled) {
    if (!officialFilingEndpoint && !issues.endpoint)
      issues.endpoint =
        "虚拟人像库只支持方舟 / BytePlus 官方地址（ark.cn-beijing.volces.com、ark.ap-southeast.bytepluses.com）";
    if (!filing.groupId.trim()) issues.group = "启用虚拟人像库时必须填写素材组 ID";
    if (!!accessKey.trim() !== !!filingSecret.trim())
      issues.filingKeys = "Access Key 和 Secret Key 要一起填写";
  }
  if (changed && !approve && !issues.endpoint) issues.approve = "请先确认使用此服务端点";
  const invalidProps = (key: string) => ({
    "aria-invalid": attempted && !!issues[key],
    "aria-describedby": attempted && issues[key] ? `channel-issue-${key}` : undefined,
  });
  const issueText = (key: string) =>
    attempted && issues[key] ? (
      <span className="channel-field-issue" id={`channel-issue-${key}`} role="alert">
        {issues[key]}
      </span>
    ) : null;
  const updateHeader = (index: number, key: "name" | "value", value: string) =>
    patch({
      headers: fields.headers.map((item, position) =>
        position === index ? { ...item, [key]: value } : item,
      ),
    });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    if (Object.values(issues).some(Boolean)) return;
    const payload: ChannelFields = {
      ...fields,
      name: fields.name.trim(),
      endpoint: fields.endpoint.trim(),
      headers: fields.headers
        .filter((row) => row.name.trim())
        .map((row) => ({ name: row.name.trim().toLowerCase(), value: row.value.trim() })),
    };
    if (payload.filing)
      payload.filing = {
        ...payload.filing,
        groupId: payload.filing.groupId.trim(),
        projectName: payload.filing.projectName.trim(),
      };
    for (const [key] of limitInputs) payload[key] = Number(limits[key]) || undefined;
    const comparable = (entry: ChannelFields) =>
      JSON.stringify({
        ...entry,
        headers: [...entry.headers].sort((left, right) => left.name.localeCompare(right.name)),
        rps: entry.rps || 0,
        concurrent: entry.concurrent || 0,
        running: entry.running || 0,
      });
    const configChanged =
      !channel ||
      comparable(initial) !== comparable({ ...payload, endpoint: endpoint ?? payload.endpoint });
    const filingKeys =
      filing.enabled && accessKey.trim() && filingSecret.trim()
        ? { accessKey: accessKey.trim(), secretKey: filingSecret.trim() }
        : undefined;
    if (channel && !configChanged && !filingKeys) {
      close();
      return;
    }
    setBusy(true);
    setError("");
    try {
      let entry = channel;
      if (!entry || configChanged) {
        const result = await settingsRequests.channelSave({
          id: entry?.id,
          expectedRevision: entry?.revision ?? 0,
          fields: payload,
          approve,
        });
        if (!result.ok) {
          setError(settingsError(result.code));
          return;
        }
        entry = result.value;
      }
      if (channel && filingKeys) {
        const persisted = channelFields(entry);
        if (configChanged) {
          setChannel(entry);
          setInitial(persisted);
          setFields(persisted);
          setApprove(false);
          setHeaderKeys(persisted.headers.map(() => crypto.randomUUID()));
          setLimits({
            rps: String(persisted.rps || ""),
            concurrent: String(persisted.concurrent || ""),
            running: String(persisted.running || ""),
          });
        }
        try {
          const result = await settingsRequests.channelSave({
            id: entry.id,
            expectedRevision: entry.revision,
            fields: persisted,
            approve: false,
            filingKeys,
          });
          if (!result.ok) {
            setError(
              `${configChanged ? "渠道配置已保存，但" : ""}备案凭证未保存。${settingsError(result.code)}请重试或取消。`,
            );
            if (configChanged) await refreshChannels();
            return;
          }
          entry = result.value;
        } catch {
          setError(`${configChanged ? "渠道配置已保存，但" : ""}备案凭证未保存。请重试或取消。`);
          if (configChanged) await refreshChannels();
          return;
        }
        setAccessKey("");
        setFilingSecret("");
      }
      const failed: string[] = [];
      if (!channel) {
        setSecret("");
        setSecretKey("");
        for (const [field, label, value] of [
          ["secret", "API Key", secret.trim()],
          ["secretKey", "Secret Key", secretKey.trim()],
        ] as const) {
          if (!value) continue;
          try {
            const applied = await settingsRequests.channelKeys({
              id: entry.id,
              expectedRevision: entry.revision,
              [field]: value,
            });
            if (applied.ok) entry = applied.value;
            else failed.push(label);
          } catch {
            failed.push(label);
          }
        }
      }
      await saved(
        entry,
        failed.length
          ? `渠道已创建，但 ${failed.join("、")} 没有设置成功，请重新设置 Key`
          : channel
            ? "渠道已更新"
            : "渠道已创建",
      );
    } catch {
      setError("无法保存渠道，请检查渠道列表后重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ModelModal title={channel ? "编辑渠道" : "新增渠道"} variant="channel-edit" close={dismiss}>
        <form noValidate onSubmit={(event) => void submit(event)}>
          <div className="model-dialog-body model-editor-form" aria-busy={busy}>
            <fieldset className="channel-fields" disabled={busy} aria-label="渠道配置">
              {error && (
                <p className="model-notice" role="alert">
                  {error}
                </p>
              )}
              <label>
                <span>
                  渠道名称 <b aria-hidden="true">*</b>
                </span>
                <input
                  required
                  {...invalidProps("name")}
                  placeholder="例如：OpenAI 官方渠道"
                  value={fields.name}
                  onChange={(event) => patch({ name: event.target.value })}
                />
                {issueText("name")}
              </label>
              <div className="channel-endpoint-field">
                <label>
                  <span>
                    Base URL <b aria-hidden="true">*</b>
                  </span>
                  <input
                    required
                    type="url"
                    {...invalidProps("endpoint")}
                    maxLength={1024}
                    placeholder="https://api.example.com"
                    value={fields.endpoint}
                    onChange={(event) => {
                      patch({ endpoint: event.target.value });
                      setApprove(false);
                    }}
                  />
                </label>
                <div className="channel-endpoint-hint">
                  {issueText("endpoint") || <small>不带查询参数</small>}
                  {!!fields.endpoint.trim() && (
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={fields.allowLocal}
                        onChange={(event) => {
                          patch({ allowLocal: event.target.checked });
                          setApprove(false);
                        }}
                      />
                      允许本机或内网端点
                    </label>
                  )}
                </div>
              </div>
              {!channel && (
                <>
                  <label>
                    API Key
                    <input
                      type="password"
                      autoComplete="new-password"
                      maxLength={8192}
                      value={secret}
                      placeholder="API Key"
                      onChange={(event) => setSecret(event.target.value)}
                    />
                  </label>
                  <label>
                    Secret Key（可选）
                    <input
                      type="password"
                      autoComplete="new-password"
                      maxLength={8192}
                      value={secretKey}
                      placeholder="Secret Key"
                      onChange={(event) => setSecretKey(event.target.value)}
                    />
                    <small>仅 AK/SK 签名协议需要</small>
                  </label>
                </>
              )}
              <div className="channel-headers-box" role="group" aria-label="自定义请求头">
                <strong>自定义请求头</strong>
                {fields.headers.map((header, index) => (
                  <div className="channel-header-row" key={headerKeys[index]}>
                    <input
                      aria-label={`请求头 ${index + 1} 名称`}
                      placeholder="名称"
                      autoComplete="off"
                      spellCheck={false}
                      {...invalidProps(`header-${index}`)}
                      value={header.name}
                      onChange={(event) => updateHeader(index, "name", event.target.value)}
                    />
                    <input
                      aria-label={`请求头 ${index + 1} 值`}
                      autoComplete="off"
                      spellCheck={false}
                      type="password"
                      {...invalidProps(`header-${index}`)}
                      placeholder={
                        channel?.headers.some(({ name }) => name === header.name)
                          ? "留空保留已有值"
                          : "值"
                      }
                      value={header.value}
                      onChange={(event) => updateHeader(index, "value", event.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={`删除请求头 ${index + 1}`}
                      onClick={() => {
                        setHeaderKeys(headerKeys.filter((_, item) => item !== index));
                        patch({ headers: fields.headers.filter((_, item) => item !== index) });
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                    {issueText(`header-${index}`)}
                  </div>
                ))}
                <div className="settings-actions">
                  <button
                    type="button"
                    disabled={
                      fields.headers.length >= 32 ||
                      fields.headers.some(({ name }) => name.trim().toLowerCase() === "user-agent")
                    }
                    onClick={() => addHeader("User-Agent", "MyApp/1.0")}
                  >
                    添加 User-Agent
                  </button>
                  <button
                    type="button"
                    disabled={fields.headers.length >= 32}
                    onClick={() => addHeader("", "")}
                  >
                    <Plus size={14} /> 添加请求头
                  </button>
                  <small>{fields.headers.length}/32</small>
                </div>
              </div>
              <div className="channel-limit-fields" role="group" aria-label="限流（留空不限）">
                <small>限流（留空不限）</small>
                <div className="model-fields">
                  {limitInputs.map(([key, title]) => (
                    <label key={key}>
                      {title}
                      <input
                        type="number"
                        min={0}
                        step={key === "rps" ? "any" : 1}
                        {...invalidProps(key)}
                        value={limits[key]}
                        onChange={(event) => {
                          setBadNumbers({ ...badNumbers, [key]: event.target.validity.badInput });
                          setLimits({ ...limits, [key]: event.target.value });
                        }}
                      />
                      {issueText(key)}
                    </label>
                  ))}
                </div>
              </div>
              {channel && (filing.enabled || officialFilingEndpoint) && (
                <div className="channel-filing-section">
                  <div className="channel-filing-heading">
                    <SettingsSwitch
                      label="虚拟人像库"
                      text="虚拟人像库"
                      disabled={busy}
                      checked={filing.enabled}
                      onChange={(enabled) => {
                        patch({ filing: { ...filing, enabled } });
                        if (!enabled) {
                          setAccessKey("");
                          setFilingSecret("");
                        }
                      }}
                    />
                    {filing.enabled && (
                      <span className="channel-filing-tag">
                        {fields.endpoint.toLowerCase().includes("byteplus")
                          ? "ap-southeast-1"
                          : "cn-beijing"}
                      </span>
                    )}
                  </div>
                  {filing.enabled && (
                    <>
                      <div className="model-fields">
                        <label>
                          <span>
                            素材组 ID <b aria-hidden="true">*</b>
                          </span>
                          <input
                            required
                            maxLength={128}
                            value={filing.groupId}
                            {...invalidProps("group")}
                            onChange={(event) =>
                              patch({ filing: { ...filing, groupId: event.target.value } })
                            }
                          />
                          {issueText("group")}
                        </label>
                        <label>
                          项目名
                          <input
                            maxLength={64}
                            placeholder="default"
                            value={filing.projectName}
                            onChange={(event) =>
                              patch({ filing: { ...filing, projectName: event.target.value } })
                            }
                          />
                        </label>
                      </div>
                      <div className="channel-filing-keys">
                        <label htmlFor="channel-filing-access">
                          Access Key / Secret Key{" "}
                          <span className="channel-filing-tag" data-configured={filingKeysSet}>
                            {filingKeysSet ? "已配置" : "未配置"}
                          </span>
                        </label>
                        <div className="model-fields">
                          <input
                            id="channel-filing-access"
                            aria-label="Access Key"
                            placeholder={filingKeysSet ? "留空不改" : "Access Key"}
                            maxLength={8192}
                            type="password"
                            autoComplete="new-password"
                            required={!!filingSecret}
                            {...invalidProps("filingKeys")}
                            value={accessKey}
                            onChange={(event) => setAccessKey(event.target.value)}
                          />
                          <input
                            aria-label="Secret Key"
                            placeholder={filingKeysSet ? "留空不改" : "Secret Key"}
                            maxLength={8192}
                            type="password"
                            autoComplete="new-password"
                            required={!!accessKey}
                            {...invalidProps("filingKeys")}
                            value={filingSecret}
                            onChange={(event) => setFilingSecret(event.target.value)}
                          />
                        </div>
                        {issueText("filingKeys")}
                      </div>
                    </>
                  )}
                </div>
              )}
              <div className="channel-access-row">
                <SettingsSwitch
                  label="启用"
                  text="启用"
                  checked={fields.enabled}
                  disabled={busy}
                  onChange={(enabled) => patch({ enabled })}
                />
                {changed && !!fields.endpoint.trim() && (
                  <div className="channel-approval-field">
                    <label className="settings-check">
                      <input
                        required
                        type="checkbox"
                        checked={approve}
                        {...invalidProps("approve")}
                        onChange={(event) => setApprove(event.target.checked)}
                      />
                      {channel
                        ? channel.endpoint !== endpoint
                          ? "确认更换端点，原有 Key 将清除"
                          : "确认更改本机或内网授权，原有 Key 将清除"
                        : "确认使用此服务端点"}
                    </label>
                    {issueText("approve")}
                  </div>
                )}
              </div>
            </fieldset>
          </div>
          <footer className="model-dialog-footer">
            <button type="button" disabled={busy} onClick={dismiss}>
              取消
            </button>
            <button className="settings-primary" disabled={busy} type="submit">
              {busy && <Loader2 className="settings-spin" size={16} />}保存
            </button>
          </footer>
        </form>
      </ModelModal>
      {discard && (
        <ModelModal
          variant="destructive-confirm"
          title="放弃未保存的修改？"
          close={() => setDiscard(false)}
        >
          <footer className="model-dialog-footer">
            <button type="button" onClick={() => setDiscard(false)}>
              取消
            </button>
            <button type="button" className="adapter-danger" onClick={close}>
              放弃修改
            </button>
          </footer>
        </ModelModal>
      )}
    </>
  );
}

function KeysDialog({
  channel,
  close,
  saved,
}: {
  channel: ChannelView;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasApi, setHasApi] = useState(false);
  const [hasSecondary, setHasSecondary] = useState(false);
  const [clearSecondary, setClearSecondary] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const secret = String(fields.get("secret") ?? "").trim();
    const secretKey = String(fields.get("secretKey") ?? "").trim();
    if (busy || !(secret || secretKey || clearSecondary)) return;
    event.currentTarget.reset();
    setHasApi(false);
    setHasSecondary(false);
    setBusy(true);
    setError("");
    let apiSaved = false;
    let expectedRevision = channel.revision;
    try {
      if (secret) {
        const result = await settingsRequests.channelKeys({
          id: channel.id,
          expectedRevision,
          secret,
        });
        if (!result.ok) throw new Error(settingsError(result.code));
        expectedRevision = result.value.revision;
        apiSaved = true;
      }
      if (secretKey || clearSecondary) {
        const result = await settingsRequests.channelKeys({
          id: channel.id,
          expectedRevision,
          secretKey: secretKey || undefined,
          clearSecretKey: !secretKey && clearSecondary,
        });
        if (!result.ok) throw new Error(settingsError(result.code));
      }
    } catch (error) {
      if (apiSaved) {
        if (mounted.current)
          setError("API Key 已保存，但 Secret Key 没有保存成功，请重新输入 Secret Key 再保存。");
        await saved();
      } else if (mounted.current)
        setError(error instanceof Error ? error.message : "保存失败，请重新输入。");
      return;
    } finally {
      if (mounted.current) setBusy(false);
    }
    await saved();
    if (mounted.current) close();
  };
  return (
    <ModelModal
      title={`设置「${channel.name}」的 Key`}
      subtitle={
        <>
          渠道 key：<code>{channel.id}</code>
        </>
      }
      variant="channel-keys"
      close={close}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="model-dialog-body model-editor-form">
          <label>
            API Key
            <input
              name="secret"
              type="password"
              autoFocus
              maxLength={8192}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setHasApi(!!event.target.value.trim())}
              placeholder={channel.hasSecret ? "已设置，留空表示不修改" : "粘贴 API Key"}
            />
          </label>
          <label>
            Secret Key（可选）
            <input
              name="secretKey"
              type="password"
              maxLength={8192}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setHasSecondary(!!event.target.value.trim())}
              placeholder={channel.hasSecretKey ? "已设置，留空表示不修改" : "粘贴 Secret Key"}
            />
          </label>
          {channel.hasSecretKey && (
            <label className="settings-check">
              <input
                name="clearSecretKey"
                type="checkbox"
                disabled={busy || hasSecondary}
                checked={clearSecondary}
                onChange={(event) => setClearSecondary(event.target.checked)}
              />
              清除已设置的 Secret Key
            </label>
          )}
          <small>仅 AK/SK 签名协议需要</small>
          {channel.hasSecret && hasApi && (
            <p className="key-notice" role="status">
              <TriangleAlert size={16} />
              <span>
                将<b>覆盖现有 API Key</b>，进行中的任务立即改用新 Key。
              </span>
            </p>
          )}
          {error && (
            <p className="key-notice" role="alert">
              <CircleAlert size={16} />
              <span>{error}</span>
            </p>
          )}
        </div>
        <footer className="model-dialog-footer">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className="settings-primary"
            disabled={busy || !(hasApi || hasSecondary || clearSecondary)}
            type="submit"
          >
            {busy && <Loader2 size={16} className="settings-spin" />}
            保存
          </button>
        </footer>
      </form>
    </ModelModal>
  );
}

function PullDialog({
  channel,
  close,
  manual,
  saved,
}: {
  channel: ChannelView;
  close: () => void;
  manual: () => void;
  saved: (count: number, prefixed?: number) => Promise<void>;
}) {
  const api = settingsRequests;
  const { id, revision } = channel;
  const [attempt, retry] = useState(0);
  const [models, setModels] = useState<SettingsValues["channelCatalog"]["models"]>();
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(
      () => {
        void api
          .channelCatalog({ id, expectedRevision: revision })
          .then((result) => {
            if (!current) return;
            if (result.ok) {
              setModels(result.value.models);
              setSelected(new Set(result.value.models.map(({ id }) => id)));
            } else
              setNotice(
                result.code === "PROVIDER_SECRET_MISSING"
                  ? "尚未设置 API Key"
                  : settingsError(result.code),
              );
          })
          .catch(() => {
            if (current) setNotice(settingsError("PROVIDER_CATALOG_NETWORK_FAILED"));
          });
      },
      attempt ? 0 : 30,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [api, id, revision, attempt]);
  const visible = (models ?? []).filter(({ id }) =>
    id.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const newIds = (models ?? [])
    .filter(({ id, exists }) => !exists && selected.has(id))
    .map(({ id }) => id);
  const change = (ids: string[], checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const confirm = async () => {
    if (busy || !newIds.length) return;
    if (selected.size > 500) {
      setNotice("单次最多导入 500 个模型，请分批导入");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const result = await api.modelImport({
        id,
        expectedRevision: revision,
        models: [...selected],
      });
      if (result.ok) await saved(result.value.added, result.value.prefixed);
      else setNotice(settingsError(result.code));
    } catch {
      setNotice(settingsError("SETTINGS_ACTION_FAILED"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModelModal
      title="选择要导入的模型"
      variant="batch-import"
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="model-dialog-body channel-pull">
        {!models && !notice && (
          <div className="pull-loading" role="status">
            <Loader2 size={16} className="settings-spin" />
            正在拉取模型…
          </div>
        )}
        {models?.length === 0 && (
          <div className="pull-message" role="status">
            <TriangleAlert size={16} />
            <span>上游没有返回模型</span>
          </div>
        )}
        {models && models.length > 0 && (
          <>
            <label className="channel-search">
              <Search size={16} />
              <input
                aria-label="搜索模型标识"
                type="search"
                autoComplete="off"
                placeholder="搜索模型标识，例如 gpt、sd2.5"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="channel-pull-toolbar">
              <strong>
                已选择 {selected.size} / {models.length} 个模型
              </strong>
              <div className="settings-actions">
                <button
                  type="button"
                  onClick={() =>
                    change(
                      visible.map(({ id }) => id),
                      true,
                    )
                  }
                >
                  全选
                </button>
                <button
                  type="button"
                  onClick={() =>
                    change(
                      visible.map(({ id }) => id),
                      false,
                    )
                  }
                >
                  取消全选
                </button>
              </div>
            </div>
            <div className="channel-pull-list">
              {!visible.length && <span>没有匹配的模型</span>}
              {visible.map(({ id, exists }) => (
                <label className="settings-check" key={id}>
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    onChange={(event) => change([id], event.target.checked)}
                  />
                  <code>{id}</code>
                  {exists && <small>已存在</small>}
                </label>
              ))}
            </div>
            <small role="status">
              将导入 {newIds.length} 个新模型，另有 {selected.size - newIds.length}{" "}
              个已存在模型已勾选
            </small>
          </>
        )}
        {notice &&
          (models ? (
            <p role="alert" className="model-notice">
              {notice}
            </p>
          ) : (
            <div role="alert" className="pull-message pull-error">
              <CircleAlert size={16} />
              <div>
                <strong>拉取失败</strong>
                <div>
                  <p>
                    {notice === "尚未设置 API Key"
                      ? settingsError("PROVIDER_SECRET_MISSING")
                      : notice}
                  </p>
                  <small>
                    {notice === "尚未设置 API Key"
                      ? notice
                      : "检查 Base URL 与 API Key；上游不支持拉取时可手动新增模型"}
                  </small>
                </div>
              </div>
            </div>
          ))}
      </div>
      <footer className="model-dialog-footer">
        <button type="button" disabled={busy} onClick={close}>
          {models?.length ? "取消" : "关闭"}
        </button>
        {!models && notice && (
          <button
            type="button"
            onClick={() => {
              setNotice("");
              retry(attempt + 1);
            }}
          >
            <RefreshCw size={16} />
            重试
          </button>
        )}
        {!models?.length && (models || notice) && (
          <button type="button" className="settings-primary" onClick={manual}>
            手动新增模型
          </button>
        )}
        {!!models?.length && (
          <button
            type="button"
            className="settings-primary"
            disabled={busy || !newIds.length}
            onClick={() => void confirm()}
          >
            {busy && <Loader2 size={16} className="settings-spin" />}确认导入
          </button>
        )}
      </footer>
    </ModelModal>
  );
}
