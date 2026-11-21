import { type SkillItem, skillScopes } from "@link-studio/core";
import {
  ArrowLeft,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Layers3,
  Search,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SkillDetail } from "./skill-detail";
import { SkillImport } from "./skill-import";
import "./skills.css";

const filters = [
  ["all", "全部"],
  ["agent", "画布 Agent"],
  ["drama", "短剧"],
  ["unused", "未使用"],
  ["builtin", "内置"],
] as const;
type Filter = (typeof filters)[number][0];

function activeDescription(item: SkillItem) {
  return item.versions.find(({ version }) => version === item.activeVersion)?.description ?? "";
}

function matches(item: SkillItem, filter: Filter) {
  switch (filter) {
    case "all":
      return true;
    case "agent":
      return item.enabled && item.scopes.includes("agent");
    case "drama":
      return item.enabled && item.scopes.some((scope) => scope !== "agent");
    case "unused":
      return !item.enabled || item.scopes.length === 0;
    case "builtin":
      return item.origin === "builtin";
  }
}

export function SkillsPage({ close }: { close: () => void }) {
  const [items, setItems] = useState<SkillItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [importing, setImporting] = useState<{ files: File[] | null }>();
  const [selected, setSelected] = useState<string>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const active = items?.find((item) => item.name === selected);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setError("");
    const result = await window.desktop.skills.list({});
    if (sequence !== loadSequence.current) return;
    if (result.ok) setItems(result.value);
    else setError(result.message);
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current++;
    };
  }, [load]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        importing ||
        active ||
        (event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      event.preventDefault();
      search.current?.focus();
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [importing, active]);

  const needle = query.trim().toLowerCase();
  const results = (items ?? []).filter(
    (item) =>
      matches(item, filter) &&
      [item.name, item.title, activeDescription(item)].some((value) =>
        value.toLowerCase().includes(needle),
      ),
  );
  const pages = Math.max(1, Math.ceil(results.length / pageSize));
  const current = Math.min(page, pages);
  const visible = results.slice((current - 1) * pageSize, current * pageSize);

  function saveItem(item: SkillItem) {
    setItems((previous) =>
      [...(previous ?? []).filter(({ name }) => name !== item.name), item].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    );
    void load();
  }

  return (
    <main
      className="skills-page"
      aria-label="技能管理"
      data-dragging={dragging}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          if (!importing && !active) setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!importing && !active && event.dataTransfer.files.length)
          setImporting({ files: Array.from(event.dataTransfer.files) });
      }}
    >
      <nav className="skills-nav" aria-label="当前位置">
        <button type="button" onClick={close}>
          <ArrowLeft size={16} />
          模型设置
        </button>
        <ChevronRight size={14} />
        <span aria-current="page">技能</span>
      </nav>
      <div className="skills-heading">
        <h1>技能</h1>
        <button
          type="button"
          className="skill-primary"
          onClick={() => setImporting({ files: null })}
        >
          <Upload size={17} />
          导入技能
        </button>
      </div>
      <section className="skills-panel" aria-label="技能列表">
        <div className="skills-toolbar">
          <label className="skills-search">
            <Search size={17} />
            <input
              ref={search}
              type="search"
              aria-label="搜索名称或说明"
              placeholder="搜索名称或说明"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
            <kbd>/</kbd>
          </label>
          <fieldset className="skills-filters" aria-label="筛选技能">
            {filters.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => {
                  setFilter(key);
                  setPage(1);
                }}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <span className="skill-note">共 {results.length} 个</span>
        </div>
        {notice && (
          <p className="skills-list-notice" role="status">
            {notice}
          </p>
        )}
        <div className="skills-list-body">
          {error ? (
            <div className="skills-empty">
              <p role="alert">{error}</p>
              <button type="button" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : items === null ? (
            <div className="skills-empty" role="status">
              正在读取技能库…
            </div>
          ) : visible.length === 0 ? (
            <div className="skills-empty">
              <Layers3 size={26} />
              <strong>
                {items.length === 0 && filter === "all" && !needle
                  ? "技能库为空"
                  : "没有符合条件的技能"}
              </strong>
              {items.length === 0 && filter === "all" && !needle && (
                <span>导入 ZIP、文件夹或 SKILL.md 开始管理技能。</span>
              )}
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">适用场景</th>
                  <th scope="col">状态</th>
                  <th scope="col">生效版本</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.name}>
                    <td>
                      <button
                        className="skill-name"
                        type="button"
                        onClick={() => setSelected(item.name)}
                      >
                        {item.title}
                        <ChevronRight size={15} />
                      </button>
                      <div className="skill-description" title={activeDescription(item)}>
                        {activeDescription(item)}
                      </div>
                    </td>
                    <td>
                      <div className="skill-tags">
                        {item.scopes.length ? (
                          item.scopes.map((scope) => (
                            <span className="skill-tag" key={scope}>
                              {skillScopes[scope]}
                            </span>
                          ))
                        ) : (
                          <span className="skill-note">未配置</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="skill-status" data-enabled={item.enabled}>
                        {item.enabled ? "已启用" : "未启用"}
                      </span>
                    </td>
                    <td>v{item.activeVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <footer className="skills-pagination">
          <label>
            <select
              aria-label="每页条数"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {[10, 20, 50].map((count) => (
                <option key={count}>{count}</option>
              ))}
            </select>
            每页条数
          </label>
          <span className="skill-note">共 {results.length} 条</span>
          <span className="skills-page-number">
            第 {current} / {pages} 页
          </span>
          <fieldset className="skill-actions" aria-label="分页">
            <button
              type="button"
              className="skill-icon-button"
              aria-label="第一页"
              disabled={current === 1}
              onClick={() => setPage(1)}
            >
              <ChevronFirst size={17} />
            </button>
            <button
              type="button"
              className="skill-icon-button"
              aria-label="上一页"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft size={17} />
            </button>
            <span aria-current="page">{current}</span>
            <button
              type="button"
              className="skill-icon-button"
              aria-label="下一页"
              disabled={current === pages}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight size={17} />
            </button>
            <button
              type="button"
              className="skill-icon-button"
              aria-label="最后一页"
              disabled={current === pages}
              onClick={() => setPage(pages)}
            >
              <ChevronLast size={17} />
            </button>
          </fieldset>
        </footer>
      </section>
      {dragging && (
        <div className="skill-drop-overlay">
          <Upload size={24} />
          松开以预检技能包
        </div>
      )}
      {importing && (
        <SkillImport
          dropped={importing.files}
          close={() => setImporting(undefined)}
          imported={(item, version) => {
            saveItem(item);
            setImporting(undefined);
            setQuery("");
            setFilter("all");
            setPage(1);
            setNotice(`已导入「${item.title}」v${version}。`);
          }}
        />
      )}
      {active && (
        <SkillDetail
          key={active.name}
          item={active}
          close={() => setSelected(undefined)}
          changed={(item) => {
            if (item) saveItem(item);
            else {
              setItems((previous) => previous?.filter(({ name }) => name !== active.name) ?? []);
              setSelected(undefined);
              setPage(current);
              setNotice(`已删除「${active.title}」。`);
            }
          }}
        />
      )}
    </main>
  );
}
