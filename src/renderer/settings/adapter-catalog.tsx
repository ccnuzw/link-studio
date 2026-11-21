import { type PluginView, providerVendorLabel, type SettingsValues } from "@link-studio/core";
import {
  ArrowUpCircle,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Image,
  Layers3,
  Search,
  Type,
} from "lucide-react";
import { useRef, useState } from "react";

export const adapterOrigins = { builtin: "内置", manual: "手动导入", agent: "小灵草稿" };
export const adapterKinds = {
  text: { label: "文本", Icon: Type },
  image: { label: "图片", Icon: Image },
  video: { label: "视频", Icon: Clapperboard },
  audio: { label: "音频", Icon: AudioLines },
};
type AdapterKind = keyof typeof adapterKinds;
const kindKeys = Object.keys(adapterKinds) as AdapterKind[];
const collator = new Intl.Collator("en", { numeric: true });

function compareVersion(left: PluginView, right: PluginView) {
  const leftSplit = left.version.indexOf("-");
  const rightSplit = right.version.indexOf("-");
  const leftCore = leftSplit < 0 ? left.version : left.version.slice(0, leftSplit);
  const rightCore = rightSplit < 0 ? right.version : right.version.slice(0, rightSplit);
  const core = collator.compare(leftCore, rightCore);
  if (core) return core;
  if (leftSplit < 0 || rightSplit < 0) return Number(leftSplit < 0) - Number(rightSplit < 0);
  const leftParts = left.version.slice(leftSplit + 1).split(".");
  const rightParts = right.version.slice(rightSplit + 1).split(".");
  for (const [index, part] of leftParts.entries()) {
    const other = rightParts[index];
    if (other === undefined) return 1;
    const numeric = /^\d+$/.test(part);
    const otherNumeric = /^\d+$/.test(other);
    if (numeric !== otherNumeric) return numeric ? -1 : 1;
    const precedence = numeric
      ? collator.compare(part, other)
      : part < other
        ? -1
        : part > other
          ? 1
          : 0;
    if (precedence) return precedence;
  }
  return leftParts.length - rightParts.length;
}

export function groupAdapters(plugins: PluginView[]) {
  const groups = new Map<string, PluginView[]>();
  for (const plugin of plugins) {
    const group = groups.get(plugin.key);
    if (group) group.push(plugin);
    else groups.set(plugin.key, [plugin]);
  }
  return [...groups.values()]
    .map((versions) => versions.sort((left, right) => compareVersion(right, left)))
    .sort(([left], [right]) => collator.compare(left?.key ?? "", right?.key ?? ""));
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
  const { label, Icon } = adapterKinds[kind as AdapterKind] ?? { label: kind, Icon: Layers3 };
  return (
    <span className={`adapter-kind${iconOnly ? " adapter-kind-icon" : ""}`} data-kind={kind}>
      <Icon aria-hidden="true" size={iconOnly ? 20 : 14} />
      {!iconOnly && label}
    </span>
  );
}

export function AdapterCatalog({
  groups,
  providers,
  initialHash,
  busy,
  open,
  toggle,
}: {
  groups: PluginView[][];
  providers: SettingsValues["list"]["providers"];
  initialHash: string;
  busy: boolean;
  open: (plugin: PluginView, showUpgrade?: boolean) => void;
  toggle: (plugin: PluginView) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [origin, setOrigin] = useState("");
  const [status, setStatus] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const scroll = useRef<HTMLDivElement>(null);
  const search = query.trim().toLowerCase();
  const matching = groups.filter(([plugin]) => {
    if (!plugin) return false;
    return (
      (!kind || plugin.kind === kind) &&
      (!origin || plugin.origin === origin) &&
      (!status || plugin.disabled === (status === "disabled")) &&
      [plugin.name, plugin.key, plugin.vendor, providerVendorLabel(plugin.vendor)].some((value) =>
        value?.toLowerCase().includes(search),
      )
    );
  });
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const pageNumber = Math.min(page, pageCount);
  const offset = (pageNumber - 1) * pageSize;
  const visible = matching.slice(offset, offset + pageSize);
  const goToPage = (value: number) => {
    setPage(value);
    if (scroll.current) scroll.current.scrollTop = 0;
  };
  return (
    <section className="adapter-catalog" aria-label="插件目录">
      <div className="adapter-toolbar">
        <label className="adapter-search">
          <Search aria-hidden="true" size={17} />
          <input
            type="search"
            aria-label="搜索插件"
            placeholder="搜索名称、厂商或插件标识"
            value={query}
            onChange={({ target }) => {
              setQuery(target.value);
              goToPage(1);
            }}
          />
        </label>
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
        <select
          aria-label="最新版本来源"
          value={origin}
          onChange={({ target }) => {
            setOrigin(target.value);
            goToPage(1);
          }}
        >
          <option value="">全部来源</option>
          {Object.entries(adapterOrigins).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="最新版本状态"
          value={status}
          onChange={({ target }) => {
            setStatus(target.value);
            goToPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已停用</option>
        </select>
      </div>
      <div className="adapter-table-scroll" ref={scroll}>
        <table className="adapter-table" aria-label="Provider 插件">
          <thead>
            <tr>
              <th scope="col">插件</th>
              <th scope="col">能力</th>
              <th scope="col">最新版本</th>
              <th scope="col">引用模型</th>
              <th scope="col">启用最新版本</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((versions) => {
              const latest = versions[0];
              if (!latest) return null;
              const hashes = new Set(versions.map(({ hash }) => hash));
              const references = providers.filter(({ pluginHash }) => hashes.has(pluginHash));
              const locked =
                !latest.disabled &&
                references.some(({ enabled, pluginHash }) => enabled && pluginHash === latest.hash);
              const older = versions.find(
                (entry) =>
                  references.some(({ pluginHash }) => pluginHash === entry.hash) &&
                  entry.hash !== latest.hash &&
                  adapterUpgradeTargets(entry, [latest]).length,
              );
              const selected = versions.find(({ hash }) => hash === initialHash);
              return (
                <tr key={latest.key}>
                  <th scope="row">
                    <button
                      type="button"
                      className="adapter-row-name"
                      aria-label={`查看 ${latest.name}`}
                      onClick={() => open(selected ?? latest)}
                    >
                      <Capability kind={latest.kind} iconOnly />
                      <span className="adapter-row-label">
                        <span>
                          <strong>{latest.name}</strong>{" "}
                          <span className="adapter-badge">{adapterOrigins[latest.origin]}</span>
                        </span>
                        <small>
                          {providerVendorLabel(latest.vendor)} <span aria-hidden="true">·</span>{" "}
                          <code>{latest.key}</code>
                        </small>
                      </span>
                    </button>
                  </th>
                  <td>
                    <div className="adapter-capability">
                      <Capability kind={latest.kind} />
                      <small>{latest.mode === "async" ? "异步" : "同步"}</small>
                    </div>
                  </td>
                  <td>
                    <code>v{latest.version}</code>
                    {versions.length > 1 && (
                      <small className="adapter-cell-note">{versions.length} 个版本</small>
                    )}
                  </td>
                  <td>
                    {references.length > 0 ? (
                      `${references.length} 个`
                    ) : (
                      <span className="adapter-muted">未使用</span>
                    )}
                    {references.some(({ enabled }) => enabled) && (
                      <small className="adapter-cell-note">
                        {references.filter(({ enabled }) => enabled).length} 个启用
                      </small>
                    )}
                  </td>
                  <td>
                    <label
                      className="adapter-switch"
                      title={
                        locked ? "先停用引用此版本的模型" : `${latest.name} v${latest.version}`
                      }
                    >
                      <input
                        type="checkbox"
                        role="switch"
                        aria-checked={!latest.disabled}
                        aria-label={`启用 ${latest.name} v${latest.version}`}
                        checked={!latest.disabled}
                        disabled={busy || locked}
                        onChange={() => toggle(latest)}
                      />
                      <span aria-hidden="true" />
                    </label>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={older ? "adapter-upgrade-link" : "adapter-detail-link"}
                      onClick={() => open(older ?? selected ?? latest, Boolean(older))}
                    >
                      {older ? (
                        <>
                          <ArrowUpCircle size={15} aria-hidden="true" /> 升级模型
                        </>
                      ) : (
                        <>
                          详情 <ChevronRight size={15} aria-hidden="true" />
                        </>
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visible.length && (
          <div className="adapter-empty">
            <Search size={25} aria-hidden="true" />
            <strong>没有符合条件的插件</strong>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setKind("");
                setOrigin("");
                setStatus("");
                goToPage(1);
              }}
            >
              清除筛选
            </button>
          </div>
        )}
      </div>
      <footer className="adapter-pagination">
        <span aria-live="polite">
          {matching.length
            ? `${offset + 1}–${offset + visible.length} 项，共 ${matching.length} 项`
            : "共 0 项"}
        </span>
        <div>
          <select
            aria-label="每页条数"
            value={pageSize}
            onChange={({ target }) => {
              setPageSize(Number(target.value));
              goToPage(1);
            }}
          >
            {[10, 20, 50].map((size) => (
              <option key={size} value={size}>
                {size} 项 / 页
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="上一页"
            disabled={pageNumber === 1}
            onClick={() => goToPage(pageNumber - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="adapter-page-number" title={`第 ${pageNumber} 页，共 ${pageCount} 页`}>
            {pageNumber} / {pageCount}
          </span>
          <button
            type="button"
            aria-label="下一页"
            disabled={pageNumber === pageCount}
            onClick={() => goToPage(pageNumber + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </footer>
    </section>
  );
}
