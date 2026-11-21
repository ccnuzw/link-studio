import type {
  ChannelFields,
  ChannelView,
  ModelKind,
  ProviderView,
  SettingsValues,
} from "@link-studio/core";
import { modelKindLabels, modelKinds } from "@link-studio/core";
import {
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  GripVertical,
  KeyRound,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ChannelCards } from "./channel-cards";
import { KindMark, kindOf, ModelEditor, ModelModal } from "./model-editor";
import { ModelAvatar } from "./model-logo";
import { ModelTrial } from "./model-trial";
import { settingsError } from "./settings-page";
import { SettingsSwitch } from "./settings-switch";
import "./channel-workspace.css";

type Dialog =
  | "create"
  | "edit"
  | "keys"
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
const modelSort = (model?: ProviderView) => model?.config?.sort ?? model?.pendingSort ?? 100;

export function ChannelWorkspace({
  data,
  refresh,
}: {
  data: SettingsValues["list"];
  refresh: () => Promise<unknown>;
}) {
  const api = window.desktop.settings;
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [selected, select] = useState("");
  const [dialog, setDialog] = useState<Dialog>();
  const [model, setModel] = useState<ProviderView>();
  const [search, setSearch] = useState("");
  const [channelStatus, setChannelStatus] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ModelKind | "pending" | "">("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const clearDrag = () => {
    setDragging(undefined);
    setDrop(undefined);
  };
  const reload = useCallback(async () => {
    const result = await api.channelList({});
    if (result.ok) setChannels(result.value);
    else setNotice(settingsError(result.code));
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const updated = async () => {
    await Promise.all([reload(), refresh()]);
  };
  const channel = channels.find(({ id }) => id === selected) ?? channels[0];
  const modelCounts = new Map<string, number>();
  for (const { channelId } of data.providers) {
    if (channelId) modelCounts.set(channelId, (modelCounts.get(channelId) ?? 0) + 1);
  }
  const selectChannel = (id: string) => {
    if (id === channel?.id) return;
    select(id);
    setQuery("");
    setKind("");
    setStatus("");
    setPage(0);
    setChecked([]);
  };
  const trialPlugin = data.plugins.find(({ hash }) => hash === model?.pluginHash);
  const models = data.providers
    .filter((entry) => entry.channelId && entry.channelId === channel?.id)
    .sort((left, right) => modelSort(left) - modelSort(right));
  const online = (entry: ProviderView) =>
    Boolean(
      channel?.enabled &&
        entry.enabled &&
        data.plugins.some(
          ({ hash, disabled, auth }) =>
            hash === entry.pluginHash && !disabled && (auth === "none" || channel?.hasSecret),
        ),
    );
  const matches = models.filter(
    (entry) =>
      (!kind || (entry.pending ? kind === "pending" : kindOf(entry, data.plugins) === kind)) &&
      (!status ||
        (entry.pending
          ? "pending"
          : online(entry)
            ? "enabled"
            : entry.enabled
              ? "unavailable"
              : "disabled") === status) &&
      `${entry.config?.name ?? ""} ${entry.model}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const visibleChannels = channels.filter(
    (entry) =>
      (!channelStatus || entry.enabled === (channelStatus === "enabled")) &&
      `${entry.name} ${entry.endpoint}`.toLowerCase().includes(search.trim().toLowerCase()),
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
      if (!result.ok) setNotice(settingsError(result.code));
      else {
        await updated();
        setNotice(message);
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  const toggle = (entry: ProviderView, enabled: boolean) =>
    api.modelToggle({ id: entry.id, expectedRevision: entry.revision, enabled });
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
  const toggleBatch = async (enabled: boolean) => {
    const targets = models.filter(({ id }) => checked.includes(id));
    setBusy(true);
    try {
      const results = await Promise.all(targets.map((entry) => toggle(entry, enabled)));
      const failures = results.filter(({ ok }) => !ok).length;
      setNotice(
        `已更新 ${results.length - failures} 个模型${failures ? `，${failures} 个失败` : ""}。`,
      );
      setChecked([]);
      await updated();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="channel-workspace">
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
          sortable={!busy && !search.trim() && !channelStatus}
          select={selectChannel}
          reorder={(source, target, after) => void reorderChannels(source, target, after)}
        />
        {!visibleChannels.length && (
          <p className="channel-list-empty">{channels.length ? "没有匹配的渠道" : "还没有渠道"}</p>
        )}
      </aside>
      <section className="channel-content" aria-label="渠道模型管理">
        {notice && (
          <p className="model-notice" role="status">
            {notice}
          </p>
        )}
        {channel ? (
          <>
            <header className="channel-heading">
              <div>
                <h2>
                  {channel.name}{" "}
                  <span className="model-status" data-online={channel.enabled}>
                    {channel.enabled ? "已启用" : "已停用"}
                  </span>
                </h2>
                <code>{channel.endpoint}</code>
              </div>
              <div className="settings-actions">
                <button type="button" onClick={() => setDialog("edit")}>
                  <Pencil size={15} /> 编辑渠道
                </button>
                <button type="button" onClick={() => setDialog("keys")}>
                  <KeyRound size={15} /> 设置 Key
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const enabled = !channel.enabled;
                    void act(
                      () =>
                        api.channelSave({
                          id: channel.id,
                          expectedRevision: channel.revision,
                          fields: channelFields(channel, { enabled }),
                          approve: false,
                        }),
                      enabled ? "渠道已启用" : "渠道已停用",
                    );
                  }}
                >
                  <Power size={15} /> {channel.enabled ? "停用渠道" : "启用渠道"}
                </button>
                <button
                  type="button"
                  className="model-danger"
                  disabled={models.length > 0}
                  title={models.length ? "请先删除渠道中的模型" : undefined}
                  onClick={() => setDialog("remove-channel")}
                >
                  <Trash2 size={15} /> 删除渠道
                </button>
              </div>
            </header>
            <div className="channel-metadata">
              <span>API Key {channel.hasSecret ? "已配置" : "未配置"}</span>
              <span>Secret Key {channel.hasSecretKey ? "已配置" : "未配置"}</span>
              <span>请求头 {channel.headers.length} 条</span>
              <span>
                限流 {channel.rps ? `${channel.rps} RPS` : "不限"} · 并发{" "}
                {channel.concurrent ?? "不限"} · 生成 {channel.running ?? "不限"}
              </span>
            </div>
            <div className="channel-heading channel-model-heading">
              <h2>
                模型管理 <small>{models.length}</small>
              </h2>
              <div className="settings-actions">
                <button type="button" disabled={!channel.enabled} onClick={() => setDialog("pull")}>
                  <RefreshCw size={15} /> 拉取模型
                </button>
                <button
                  type="button"
                  className="settings-primary"
                  onClick={() => {
                    setModel(undefined);
                    setDialog("model");
                  }}
                >
                  <Plus size={16} /> 新增模型
                </button>
              </div>
            </div>
            <div className="channel-table">
              <div className="channel-toolbar">
                <label className="channel-search">
                  <Search size={15} />
                  <input
                    type="search"
                    aria-label="搜索渠道模型"
                    placeholder="搜索模型标识或展示名称"
                    value={query}
                    onChange={(event) => {
                      setPage(0);
                      setQuery(event.target.value);
                    }}
                  />
                </label>
                <div className="channel-filter-selects">
                  <label className="channel-select">
                    <select
                      aria-label="按模型能力筛选"
                      value={kind}
                      onChange={(event) => {
                        setKind(event.target.value as typeof kind);
                        setPage(0);
                      }}
                    >
                      <option value="">全部能力</option>
                      <option value="pending">待配置</option>
                      {modelKinds.map((item) => (
                        <option value={item} key={item}>
                          {modelKindLabels[item]}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} aria-hidden="true" />
                  </label>
                  <label className="channel-select">
                    <select
                      aria-label="按模型状态筛选"
                      value={status}
                      onChange={(event) => {
                        setStatus(event.target.value);
                        setPage(0);
                      }}
                    >
                      <option value="">全部状态</option>
                      <option value="enabled">在线</option>
                      <option value="unavailable">不可用</option>
                      <option value="disabled">未上线</option>
                      <option value="pending">待配置</option>
                    </select>
                    <ChevronDown size={15} aria-hidden="true" />
                  </label>
                </div>
                <small
                  className="channel-filter-count"
                  title={`筛选结果 ${matches.length} 条，共 ${models.length} 条`}
                >
                  {matches.length} / {models.length}
                </small>
              </div>
              {!!checked.length && (
                <div className="channel-toolbar">
                  <strong>已选 {checked.length} 个</strong>
                  <button type="button" disabled={busy} onClick={() => void toggleBatch(true)}>
                    批量上线
                  </button>
                  <button type="button" disabled={busy} onClick={() => void toggleBatch(false)}>
                    批量下线
                  </button>
                  <button type="button" onClick={() => setChecked([])}>
                    取消选择
                  </button>
                </div>
              )}
              <div className="channel-table-scroll">
                <table aria-label="渠道模型">
                  <thead>
                    <tr>
                      <th className="channel-model-order" aria-label="排序" scope="col" />
                      <th>
                        <input
                          aria-label="选择本页模型"
                          type="checkbox"
                          checked={rows.length > 0 && rows.every(({ id }) => checked.includes(id))}
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
                    {rows.map((entry, index) => {
                      const plugin = data.plugins.find(({ hash }) => hash === entry.pluginHash);
                      const capability = kindOf(entry, data.plugins);
                      const name = entry.config?.name ?? entry.model;
                      return (
                        <tr
                          key={entry.id}
                          data-dragging={dragging === entry.id}
                          data-drop={
                            drop?.id === entry.id ? (drop.after ? "after" : "before") : undefined
                          }
                          onDragOver={(event) => {
                            if (busy || !dragging || dragging === entry.id) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            const rect = event.currentTarget.getBoundingClientRect();
                            setDrop({
                              id: entry.id,
                              after: event.clientY >= rect.top + rect.height / 2,
                            });
                          }}
                          onDragLeave={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                              setDrop((current) =>
                                current?.id === entry.id ? undefined : current,
                              );
                            }
                          }}
                          onDrop={(event) => {
                            if (busy || !dragging || dragging === entry.id) return;
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            void reorderModels(
                              dragging,
                              entry.id,
                              event.clientY >= rect.top + rect.height / 2,
                            );
                            clearDrag();
                          }}
                          onClick={(event) => {
                            if (
                              (event.target as Element).closest(
                                "button, input, label, .channel-model-order",
                              )
                            )
                              return;
                            setModel(entry);
                            setDialog("model");
                          }}
                        >
                          <td className="channel-model-order">
                            <button
                              type="button"
                              className="channel-model-grip"
                              aria-label={`排序 ${name}`}
                              aria-keyshortcuts="ArrowUp ArrowDown"
                              title="拖动排序，或聚焦后用 ↑ / ↓ 移动"
                              aria-disabled={busy || rows.length < 2}
                              draggable={!busy && rows.length > 1}
                              onKeyDown={(event) => {
                                if (busy || (event.key !== "ArrowUp" && event.key !== "ArrowDown"))
                                  return;
                                event.preventDefault();
                                const after = event.key === "ArrowDown";
                                const target = rows[index + (after ? 1 : -1)];
                                if (target && !event.repeat)
                                  void reorderModels(entry.id, target.id, after);
                              }}
                              onDragStart={(event) => {
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
                          </td>
                          <td>
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
                                name={entry.config?.name ?? entry.model}
                                logo={entry.config?.logo}
                              />
                              <span>
                                <strong>{entry.config?.name ?? entry.model}</strong>
                                {entry.config?.name && entry.config.name !== entry.model && (
                                  <small>{entry.model}</small>
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
                            {plugin && capability !== "agent" && <small>v{plugin.version}</small>}
                          </td>
                          <td>
                            <div className="channel-model-state">
                              <SettingsSwitch
                                label={`${entry.config?.name ?? entry.model} 上线`}
                                checked={entry.enabled}
                                disabled={busy || entry.pending}
                                reason={entry.pending ? "请先配置模型的能力与协议" : undefined}
                                onChange={(enabled) =>
                                  void act(
                                    () => toggle(entry, enabled),
                                    enabled ? "模型上线设置已保存。" : "模型已下线。",
                                  )
                                }
                              />
                              <span>
                                <span
                                  className={entry.pending ? "model-pending" : "model-status"}
                                  data-online={online(entry)}
                                >
                                  {entry.pending
                                    ? "待配置"
                                    : online(entry)
                                      ? "在线"
                                      : entry.enabled
                                        ? "不可用"
                                        : "未上线"}
                                </span>
                                {entry.pending && <small>还没有选择能力</small>}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="channel-row-actions">
                              <button
                                type="button"
                                aria-label={`测试 ${entry.config?.name ?? entry.model}`}
                                title={entry.pending ? "请先配置模型能力和协议" : "测试模型"}
                                disabled={
                                  busy ||
                                  entry.pending ||
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
                                disabled={busy || entry.enabled}
                                className="model-danger"
                                aria-label={`删除 ${entry.config?.name ?? entry.model}`}
                                title={entry.enabled ? "请先下线" : "删除模型"}
                                onClick={() => {
                                  setModel(entry);
                                  setDialog("remove-model");
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
                {!rows.length && (
                  <div className="channel-empty">
                    <Search size={24} />
                    <strong>{models.length ? "没有符合筛选条件的模型" : "此渠道还没有模型"}</strong>
                    <span>
                      {models.length
                        ? "调整搜索词或筛选条件。"
                        : "可拉取服务端目录，或手动新增模型。"}
                    </span>
                  </div>
                )}
              </div>
              <footer className="channel-pagination">
                <div className="channel-pagination-size">
                  <label>
                    <span className="channel-select">
                      <select
                        aria-label="模型每页条数"
                        value={pageSize}
                        onChange={(event) => {
                          setPageSize(Number(event.target.value));
                          setPage(0);
                        }}
                      >
                        <option>10</option>
                        <option>20</option>
                        <option>50</option>
                        <option>100</option>
                      </select>
                      <ChevronDown size={15} aria-hidden="true" />
                    </span>
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
                  <span className="channel-page-current" aria-current="page">
                    {currentPage + 1}
                  </span>
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
            </div>
          </>
        ) : (
          <div className="channel-empty channel-empty-large">
            <h2>模型渠道</h2>
            <p>先添加服务端点和凭证，再为各模型选择能力与调用协议。</p>
            <button type="button" className="settings-primary" onClick={() => setDialog("create")}>
              <Plus size={16} /> 创建首个渠道
            </button>
          </div>
        )}
      </section>
      {(dialog === "create" || (dialog === "edit" && channel)) && (
        <ChannelDialog
          key={dialog}
          channel={dialog === "edit" ? channel : undefined}
          close={close}
          saved={async (entry) => {
            selectChannel(entry.id);
            await updated();
            close();
          }}
        />
      )}
      {dialog === "keys" && channel && (
        <KeysDialog
          channel={channel}
          close={close}
          saved={async () => {
            await updated();
            close();
          }}
        />
      )}
      {dialog === "model" && channel && (
        <ModelEditor
          channel={channel}
          model={model}
          nextSort={Math.min(
            100000,
            models.length ? modelSort(models.at(-1) as ProviderView) + 1 : 100,
          )}
          plugins={data.plugins}
          close={close}
          saved={updated}
        />
      )}
      {dialog === "trial" && model && trialPlugin && (
        <ModelTrial model={model} plugin={trialPlugin} close={close} />
      )}
      {dialog === "pull" && channel && (
        <PullDialog
          channel={channel}
          manual={() => {
            setModel(undefined);
            setDialog("model");
          }}
          close={close}
          saved={async (added) => {
            await updated();
            setNotice(`已导入 ${added} 个模型，可检查能力后上线。`);
            close();
          }}
        />
      )}
      {(dialog === "remove-channel" || dialog === "remove-model") && channel && (
        <ModelModal title={dialog === "remove-channel" ? "删除渠道" : "删除模型"} close={close}>
          <div className="model-dialog-body">
            <p>
              确认删除「
              {dialog === "remove-channel" ? channel.name : (model?.config?.name ?? model?.model)}
              」？
            </p>
            {notice && <p role="alert">{notice}</p>}
          </div>
          <footer className="model-dialog-footer">
            <button type="button" onClick={close}>
              取消
            </button>
            <button
              type="button"
              className="model-danger"
              disabled={busy}
              onClick={() => {
                if (dialog === "remove-channel")
                  void act(
                    () => api.channelRemove({ id: channel.id, expectedRevision: channel.revision }),
                    "渠道已删除。",
                  );
                else if (model)
                  void act(
                    () => api.modelRemove({ id: model.id, expectedRevision: model.revision }),
                    "模型已删除。",
                  );
              }}
            >
              确认删除
            </button>
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
    rps,
    concurrent,
    running,
    ...patch,
  };
}

function ChannelDialog({
  channel,
  close,
  saved,
}: {
  channel?: ChannelView;
  close: () => void;
  saved: (channel: ChannelView) => Promise<void>;
}) {
  const [fields, setFields] = useState(channel ? channelFields(channel) : emptyChannel);
  const [headerKeys, setHeaderKeys] = useState(() => fields.headers.map(() => crypto.randomUUID()));
  const addHeader = (name: string, value: string) => {
    setHeaderKeys([...headerKeys, crypto.randomUUID()]);
    setFields({ ...fields, headers: [...fields.headers, { name, value }] });
  };
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (next: Partial<ChannelFields>) => setFields({ ...fields, ...next });
  const changed =
    !channel || channel.endpoint !== fields.endpoint || channel.allowLocal !== fields.allowLocal;
  const updateHeader = (index: number, key: "name" | "value", value: string) =>
    patch({
      headers: fields.headers.map((item, position) =>
        position === index ? { ...item, [key]: value } : item,
      ),
    });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await window.desktop.settings.channelSave({
        id: channel?.id,
        expectedRevision: channel?.revision ?? 0,
        fields,
        approve,
      });
      if (result.ok) await saved(result.value);
      else setError(settingsError(result.code));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModelModal title={channel ? "编辑渠道" : "新增渠道"} close={close}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="model-dialog-body model-editor-form">
          <label>
            渠道名称
            <input
              required
              maxLength={120}
              value={fields.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </label>
          <label>
            Base URL
            <input
              required
              type="url"
              maxLength={1024}
              placeholder="https://api.example.com"
              value={fields.endpoint}
              onChange={(event) => {
                patch({ endpoint: event.target.value });
                setApprove(false);
              }}
            />
            <small>填写服务端点，可包含路径。请省略查询参数。</small>
          </label>
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
          <fieldset>
            <legend>自定义请求头</legend>
            {fields.headers.map((header, index) => (
              <div className="channel-header-row" key={headerKeys[index]}>
                <input
                  aria-label={`请求头名称 ${index + 1}`}
                  required
                  value={header.name}
                  onChange={(event) => updateHeader(index, "name", event.target.value)}
                />
                <input
                  aria-label={`请求头值 ${index + 1}`}
                  type="password"
                  placeholder={
                    channel?.headers.some(({ name }) => name === header.name)
                      ? "留空保留已有值"
                      : "请求头值"
                  }
                  value={header.value}
                  onChange={(event) => updateHeader(index, "value", event.target.value)}
                />
                <button
                  type="button"
                  aria-label={`移除请求头 ${index + 1}`}
                  onClick={() => {
                    setHeaderKeys(headerKeys.filter((_, item) => item !== index));
                    patch({ headers: fields.headers.filter((_, item) => item !== index) });
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <div className="settings-actions">
              <button
                type="button"
                disabled={
                  fields.headers.length >= 32 ||
                  fields.headers.some(({ name }) => name.toLowerCase() === "user-agent")
                }
                onClick={() => addHeader("User-Agent", "Link Studio")}
              >
                添加 User-Agent
              </button>
              <button
                type="button"
                disabled={fields.headers.length >= 32}
                onClick={() => addHeader("", "")}
              >
                添加请求头
              </button>
              <small>{fields.headers.length} / 32</small>
            </div>
          </fieldset>
          <fieldset>
            <legend>限流 · 留空不限</legend>
            <div className="model-fields">
              {(
                [
                  ["rps", "每秒请求数", 1000],
                  ["concurrent", "最大同时请求数", 100],
                  ["running", "最大同时生成数", 100],
                ] as const
              ).map(([key, title, max]) => (
                <label key={key}>
                  {title}
                  <input
                    type="number"
                    min={1}
                    max={max}
                    value={fields[key] ?? ""}
                    onChange={(event) =>
                      patch({ [key]: event.target.value ? Number(event.target.value) : undefined })
                    }
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <div className="channel-enable-setting">
            <span className="model-status" data-online={fields.enabled}>
              {fields.enabled ? "已启用" : "已停用"}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => patch({ enabled: !fields.enabled })}
            >
              <Power size={15} /> {fields.enabled ? "停用渠道" : "启用渠道"}
            </button>
          </div>
          {changed && (
            <label className="settings-check">
              <input
                required
                type="checkbox"
                checked={approve}
                onChange={(event) => setApprove(event.target.checked)}
              />
              {channel ? "确认更换端点，保存后重新设置 Key" : "确认使用此服务端点"}
            </label>
          )}
          {error && (
            <p className="model-notice" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="model-dialog-footer">
          <button type="button" onClick={close}>
            取消
          </button>
          <button className="settings-primary" disabled={busy} type="submit">
            保存渠道
          </button>
        </footer>
      </form>
    </ModelModal>
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
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const secret = String(fields.get("secret") ?? "").trim();
    const secretKey = String(fields.get("secretKey") ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const result = await window.desktop.settings.channelKeys({
        id: channel.id,
        expectedRevision: channel.revision,
        secret: secret || undefined,
        secretKey: secretKey || undefined,
        clearSecret: fields.has("clearSecret"),
        clearSecretKey: fields.has("clearSecretKey"),
      });
      if (result.ok) await saved();
      else setError(settingsError(result.code));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModelModal title={`设置「${channel.name}」的 Key`} subtitle={channel.endpoint} close={close}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="model-dialog-body model-editor-form">
          <label>
            API Key
            <textarea
              name="secret"
              rows={2}
              maxLength={8192}
              autoComplete="off"
              className="channel-secret"
              placeholder={channel.hasSecret ? "已配置，留空保留" : "粘贴 API Key 或服务账号凭证"}
            />
          </label>
          {channel.hasSecret && (
            <label className="settings-check">
              <input name="clearSecret" type="checkbox" />
              移除 API Key
            </label>
          )}
          <label>
            Secret Key（可选）
            <input
              name="secretKey"
              type="password"
              maxLength={8192}
              autoComplete="new-password"
              placeholder={channel.hasSecretKey ? "已配置，留空保留" : "AK/SK 签名协议使用"}
            />
          </label>
          {channel.hasSecretKey && (
            <label className="settings-check">
              <input name="clearSecretKey" type="checkbox" />
              移除 Secret Key
            </label>
          )}
          {error && (
            <p className="model-notice" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="model-dialog-footer">
          <button type="button" onClick={close}>
            取消
          </button>
          <button className="settings-primary" disabled={busy} type="submit">
            保存 Key
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
  saved: (count: number) => Promise<void>;
}) {
  const api = window.desktop.settings;
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
            } else setNotice(settingsError(result.code));
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
    if (busy || !newIds.length || newIds.length > 500) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await api.modelImport({ id, expectedRevision: revision, models: newIds });
      if (result.ok) await saved(result.value.added);
      else setNotice(settingsError(result.code));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModelModal
      title="选择要导入的模型"
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="model-dialog-body channel-pull">
        {!models && !notice && <p role="status">正在拉取模型…</p>}
        {models && (
          <>
            <label className="channel-search">
              <Search size={16} />
              <input
                aria-label="搜索模型标识"
                type="search"
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
                  disabled={busy || !visible.length}
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
                  disabled={busy || !visible.length}
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
              {visible.map(({ id, exists }) => (
                <label className="settings-check" key={id}>
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    disabled={busy}
                    onChange={(event) => change([id], event.target.checked)}
                  />
                  <code>{id}</code>
                  {exists && <small>已存在</small>}
                </label>
              ))}
            </div>
            {!visible.length && (
              <p>{models.length ? "没有匹配的模型。" : "上游未返回模型，可以手动添加。"}</p>
            )}
            <small role="status">
              将导入 {newIds.length} 个新模型，另有 {selected.size - newIds.length}{" "}
              个已存在模型已勾选{newIds.length > 500 && "。单次最多导入 500 个，请分批选择。"}
            </small>
          </>
        )}
        {notice && (
          <p role="alert" className="model-notice">
            {notice}
          </p>
        )}
      </div>
      <footer className="model-dialog-footer">
        {!models && notice && (
          <>
            <button type="button" onClick={manual}>
              手动添加
            </button>
            <button
              type="button"
              onClick={() => {
                setNotice("");
                retry(attempt + 1);
              }}
            >
              重试
            </button>
          </>
        )}
        <button type="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="settings-primary"
          disabled={busy || !newIds.length || newIds.length > 500}
          onClick={() => void confirm()}
        >
          确认导入
        </button>
      </footer>
    </ModelModal>
  );
}
