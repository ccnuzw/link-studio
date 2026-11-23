import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import type { PluginView, SettingsValues } from "@link-studio/core";
import {
  ArrowUpCircle,
  AudioLines,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  Clapperboard,
  Image,
  Layers3,
  MoreHorizontal,
  Search,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { olderCatalogVersions } from "./catalog-version-order";

export const adapterOrigins = { builtin: "内置", manual: "手动导入", agent: "小灵草稿" };
export const adapterKinds = {
  text: { label: "文本", Icon: Type },
  image: { label: "图片", Icon: Image },
  video: { label: "视频", Icon: Clapperboard },
  audio: { label: "音频", Icon: AudioLines },
};
type AdapterKind = keyof typeof adapterKinds;
export const capabilityKinds = { ...adapterKinds, agent: { label: "Agent", Icon: Bot } };
const kindKeys = Object.keys(adapterKinds) as AdapterKind[];
const sources = [
  ["", "全部来源"],
  ["builtin", "内置"],
  ["uploaded", "已上传"],
] as const;
const statuses = [
  ["", "全部状态"],
  ["enabled", "已启用"],
  ["disabled", "已停用"],
  ["outdated", "有旧版模型"],
] as const;
const sizes = ["10", "20", "30", "40", "50"].map((size) => [size, size] as const);

export function CatalogSelect({
  label,
  value,
  options,
  change,
  side = "bottom",
  container,
  description,
  id,
  disabled,
  viewportPopup,
  field,
  invalid,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  change: (value: string) => void;
  side?: "top" | "bottom";
  container?: HTMLElement | null;
  description?: string;
  id?: string;
  disabled?: boolean;
  viewportPopup?: boolean;
  field?: string;
  invalid?: boolean;
}) {
  let empty = "__all__";
  while (options.some(([key]) => key === empty)) empty += "_";
  const items = options.map(([key, text]) => ({ value: key || empty, label: text }));
  return (
    <Select.Root
      items={items}
      disabled={disabled}
      value={value || empty}
      onValueChange={(next) => {
        if (next != null) change(next === empty ? "" : next);
      }}
    >
      <Select.Trigger
        id={id}
        aria-label={label}
        aria-describedby={description}
        data-field={field}
        aria-invalid={invalid}
        data-filtered={side === "bottom" && !!value}
        className="adapter-select-trigger"
      >
        <Select.Value />
        <Select.Icon render={<ChevronDown size={16} />} />
      </Select.Trigger>
      <Select.Portal container={container ?? undefined}>
        <Select.Positioner
          className="adapter-select-position"
          side={side}
          sideOffset={4}
          positionMethod={viewportPopup ? "fixed" : undefined}
          collisionBoundary={viewportPopup ? [] : undefined}
          align={container && !viewportPopup ? "start" : "center"}
          alignItemWithTrigger={false}
          collisionAvoidance={
            container && !viewportPopup
              ? undefined
              : { side: "none", align: "shift", fallbackAxisSide: "none" }
          }
        >
          <Select.Popup className="adapter-select-popup">
            <Select.ScrollUpArrow className="adapter-select-scroll">
              <ChevronUp size={16} />
            </Select.ScrollUpArrow>
            <Select.List>
              {items.map((item) => (
                <Select.Item className="adapter-select-option" key={item.value} value={item.value}>
                  <Select.ItemText>{item.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={16} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
            <Select.ScrollDownArrow className="adapter-select-scroll">
              <ChevronDown size={16} />
            </Select.ScrollDownArrow>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export function adapterUpgradeTargets(plugin: PluginView, versions: PluginView[]) {
  return versions.filter(
    (entry) =>
      !entry.disabled &&
      entry.hash !== plugin.hash &&
      entry.key === plugin.key &&
      entry.kind === plugin.kind &&
      entry.auth === plugin.auth &&
      entry.authName === plugin.authName &&
      (entry.auth !== "custom" || (entry.origin === "builtin" && plugin.origin === "builtin")),
  );
}

export function Capability({ kind, iconOnly = false }: { kind: string; iconOnly?: boolean }) {
  if (iconOnly && !Object.hasOwn(adapterKinds, kind))
    return <span className="adapter-capability-empty">—</span>;
  const { label, Icon } = capabilityKinds[kind as keyof typeof capabilityKinds] ?? {
    label: kind,
    Icon: Layers3,
  };
  return (
    <span className={`adapter-kind${iconOnly ? " adapter-kind-icon" : ""}`} data-kind={kind}>
      <Icon aria-hidden="true" size={iconOnly ? 20 : 14} />
      {!iconOnly && label}
    </span>
  );
}

export function AdapterCatalog({
  state,
  reload,
  upload,
  groups,
  providers,
  initialHash,
  busy,
  toggling,
  open,
  toggle,
  remove,
}: {
  state: "loading" | "error" | "ready";
  reload: () => void;
  upload: () => void;
  groups: PluginView[][];
  providers: SettingsValues["list"]["providers"];
  initialHash: string;
  busy: boolean;
  toggling: ReadonlySet<string>;
  open: (plugin: PluginView, showUpgrade?: boolean) => void;
  toggle: (plugin: PluginView) => void;
  remove: (plugin: PluginView) => void;
}) {
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [kind, setKind] = useState("");
  const [origin, setOrigin] = useState("");
  const [status, setStatus] = useState("");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (query === committedQuery) return;
    const timer = window.setTimeout(() => {
      setCommittedQuery(query);
      setPage(1);
      if (scroll.current) scroll.current.scrollTop = 0;
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, committedQuery]);
  const search = committedQuery.trim().toLowerCase();
  const references = new Map<string, number>();
  for (const profile of providers)
    references.set(profile.pluginHash, (references.get(profile.pluginHash) ?? 0) + 1);
  const matching = groups
    .map((versions) => {
      const builtin = versions.some((version) => version.origin === "builtin");
      const count = versions.reduce(
        (total, version) => total + (references.get(version.hash) ?? 0),
        0,
      );
      const outdated = olderCatalogVersions(versions).reduce(
        (total, version) => total + (references.get(version.hash) ?? 0),
        0,
      );
      return { versions, builtin, count, outdated };
    })
    .filter(({ versions: [plugin], builtin, outdated }) => {
      if (!plugin) return false;
      return (
        (!kind || plugin.kind === kind) &&
        (!origin || builtin === (origin === "builtin")) &&
        (!status ||
          (status === "outdated" ? outdated > 0 : plugin.disabled === (status === "disabled"))) &&
        [plugin.name, plugin.key].some((value) => value?.toLowerCase().includes(search))
      );
    });
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const pageNumber = Math.min(page, pageCount);
  const offset = (pageNumber - 1) * pageSize;
  const visible = state === "ready" ? matching.slice(offset, offset + pageSize) : [];
  const goToPage = (value: number) => {
    setPage(value);
    if (scroll.current) scroll.current.scrollTop = 0;
  };
  if (state === "ready" && !groups.length && !search && !kind && !origin && !status)
    return (
      <section className="adapter-empty" aria-label="插件目录">
        <p>还没有插件</p>
        <button type="button" className="settings-primary" onClick={upload}>
          <Upload size={16} /> 上传插件
        </button>
      </section>
    );
  return (
    <section className="adapter-catalog" aria-label="插件目录">
      <div className="adapter-toolbar">
        <div className="adapter-search">
          <Search aria-hidden="true" size={17} />
          <input
            type="search"
            aria-label="搜索插件"
            placeholder="搜索名称或 key"
            value={query}
            autoComplete="off"
            onChange={({ target }) => setQuery(target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => {
                setQuery("");
                setCommittedQuery("");
                goToPage(1);
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <fieldset className="adapter-filter" aria-label="按能力筛选">
          {["", ...kindKeys].map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={kind === entry}
              onClick={() => {
                setKind(entry);
                goToPage(1);
              }}
            >
              {entry ? adapterKinds[entry as AdapterKind].label : "全部"}
            </button>
          ))}
        </fieldset>
        <CatalogSelect
          label="按来源筛选"
          value={origin}
          options={sources}
          change={(next) => {
            setOrigin(next);
            goToPage(1);
          }}
        />
        <CatalogSelect
          label="按状态筛选"
          value={status}
          options={statuses}
          change={(next) => {
            setStatus(next);
            goToPage(1);
          }}
        />
        {(committedQuery || kind || origin || status) && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCommittedQuery("");
              setKind("");
              setOrigin("");
              setStatus("");
              goToPage(1);
            }}
          >
            <X size={14} /> 重置
          </button>
        )}
        <span className="adapter-toolbar-count">
          {visible.length} / {matching.length}
        </span>
      </div>
      <div className="adapter-table-scroll" ref={scroll}>
        <table className="adapter-table" aria-label="Provider 插件">
          <thead>
            <tr>
              <th scope="col">插件</th>
              <th scope="col">能力</th>
              <th scope="col">最新版本</th>
              <th scope="col">模型</th>
              <th scope="col">启用</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {state === "loading" &&
              [0, 1, 2].map((index) => (
                <tr key={index} className="adapter-loading">
                  <td colSpan={6}>
                    <div aria-label="加载中" />
                  </td>
                </tr>
              ))}
            {state === "error" && (
              <tr>
                <td colSpan={6} className="adapter-load-error">
                  <span role="alert">加载失败</span>{" "}
                  <button type="button" onClick={reload}>
                    重试
                  </button>
                </td>
              </tr>
            )}
            {state === "ready" && !visible.length && (
              <tr>
                <td className="adapter-no-match" colSpan={6}>
                  没有匹配的插件
                </td>
              </tr>
            )}
            {visible.map(({ versions, builtin, count, outdated }) => {
              const latest = versions[0];
              if (!latest) return null;
              const selected = versions.find(({ hash }) => hash === initialHash);
              return (
                <tr
                  key={latest.key}
                  onClick={(event) => {
                    if (
                      !(event.target as HTMLElement).closest("button,input,label,summary,details")
                    )
                      open(selected ?? latest);
                  }}
                >
                  <th scope="row">
                    <div className="adapter-plugin-name">
                      <button
                        type="button"
                        className="adapter-row-name"
                        aria-label={`查看 ${latest.name}`}
                        onClick={() => open(selected ?? latest)}
                      >
                        {latest.name}
                      </button>
                      {builtin && <span className="adapter-badge">内置</span>}
                    </div>
                    <div className="adapter-plugin-key">
                      {latest.vendor && `${latest.vendor} · `}
                      <code>{latest.key}</code>
                    </div>
                  </th>
                  <td>
                    <div className="adapter-capability">
                      <Capability kind={latest.kind} />
                      <small>{latest.mode === "async" ? "异步" : "同步"}</small>
                    </div>
                  </td>
                  <td>
                    <code>v{latest.version}</code>
                  </td>
                  <td>
                    {count > 0 ? `${count} 个在用` : <span className="adapter-muted">未使用</span>}
                    {outdated > 0 && <small className="adapter-cell-note">{outdated} 个旧版</small>}
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <label className="adapter-switch" title={`${latest.name} · 所有版本`}>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-checked={!latest.disabled}
                        aria-label={`${latest.disabled ? "启用" : "停用"}插件 ${latest.name}`}
                        checked={!latest.disabled}
                        disabled={busy || toggling.has(latest.key)}
                        onChange={() => toggle(latest)}
                      />
                      <span aria-hidden="true" />
                    </label>
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <div className="adapter-row-actions">
                      <button
                        type="button"
                        className="adapter-upgrade-link"
                        disabled={busy || !outdated}
                        aria-label={`升级模型 ${latest.name}`}
                        title={outdated ? undefined : "没有固定在旧版本上的模型"}
                        onClick={() => open(latest, true)}
                      >
                        <ArrowUpCircle size={14} aria-hidden="true" />
                        升级模型{outdated > 0 && `（${outdated}）`}
                      </button>
                      <Menu.Root>
                        <Menu.Trigger
                          className="adapter-more-trigger"
                          aria-label={`${latest.name} 的更多操作`}
                          title="更多操作"
                        >
                          <MoreHorizontal size={16} />
                        </Menu.Trigger>
                        <Menu.Portal>
                          <Menu.Positioner
                            className="adapter-more-position"
                            align="end"
                            sideOffset={4}
                            collisionAvoidance={{
                              side: "none",
                              align: "shift",
                              fallbackAxisSide: "none",
                            }}
                          >
                            <Menu.Popup className="adapter-more-popup">
                              <Menu.Item disabled={busy} onClick={() => remove(latest)}>
                                <Trash2 size={16} />
                                删除插件
                              </Menu.Item>
                            </Menu.Popup>
                          </Menu.Positioner>
                        </Menu.Portal>
                      </Menu.Root>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {state === "ready" && (
        <footer className="adapter-pagination">
          <div>
            <CatalogSelect
              label="每页条数"
              value={String(pageSize)}
              options={sizes}
              side="top"
              change={(next) => {
                setPageSize(Number(next));
                goToPage(1);
              }}
            />
            每页条数 <span aria-live="polite">共 {matching.length} 条</span>
          </div>
          <div>
            <span>
              第 {pageNumber} / {pageCount} 页
            </span>
            <button
              type="button"
              aria-label="第一页"
              disabled={pageNumber === 1}
              onClick={() => goToPage(1)}
            >
              <ChevronsLeft size={16} />
            </button>
            <button
              type="button"
              aria-label="上一页"
              disabled={pageNumber === 1}
              onClick={() => goToPage(pageNumber - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            {catalogPageNumbers(pageNumber, pageCount).map((number, index) =>
              typeof number === "number" ? (
                <button
                  type="button"
                  key={number}
                  aria-label={`第 ${number} 页`}
                  aria-current={number === pageNumber ? "page" : undefined}
                  onClick={() => goToPage(number)}
                >
                  {number}
                </button>
              ) : (
                <span key={`gap-${index}`}>…</span>
              ),
            )}
            <button
              type="button"
              aria-label="下一页"
              disabled={pageNumber === pageCount}
              onClick={() => goToPage(pageNumber + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              aria-label="最后一页"
              disabled={pageNumber === pageCount}
              onClick={() => goToPage(pageCount)}
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

export function catalogPageNumbers(page: number, count: number): (number | string)[] {
  if (count <= 5) return Array.from({ length: count }, (_, index) => index + 1);
  if (page <= 3) return [1, 2, 3, 4, "…", count];
  if (page >= count - 2) return [1, "…", count - 3, count - 2, count - 1, count];
  return [1, "…", page - 1, page, page + 1, "…", count];
}
