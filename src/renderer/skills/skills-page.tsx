import type { SkillItem } from "@link-studio/core";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  Upload,
  X,
} from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SkillDetail } from "./skill-detail";
import { SkillImport } from "./skill-import";
import { activeDescription, SkillList } from "./skill-list";
import "./skills.css";
import { MethodWorkbench } from "./method-workbench";

const filters = [
  ["all", "全部"],
  ["agent", "画布 Agent"],
  ["drama", "短剧"],
  ["unused", "未使用"],
  ["builtin", "内置"],
] as const;
type Filter = (typeof filters)[number][0];

function pageNumbers(page: number, pages: number): (number | "…")[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, index) => index + 1);
  if (page <= 3) return [1, 2, 3, 4, "…", pages];
  if (page >= pages - 2) return [1, "…", pages - 3, pages - 2, pages - 1, pages];
  return [1, "…", page - 1, page, page + 1, "…", pages];
}

function matches(item: SkillItem, filter: Filter) {
  switch (filter) {
    case "all":
      return true;
    case "agent":
      return item.scopes.includes("agent");
    case "drama":
      return item.scopes.some((scope) => scope !== "agent");
    case "unused":
      return item.scopes.length === 0;
    case "builtin":
      return item.origin === "builtin";
  }
}

export function SkillsPage({ visit = 0 }: { visit?: number }) {
  const [pageSize, setPageSize] = useState(20);
  return <SkillBrowser key={visit} pageSize={pageSize} setPageSize={setPageSize} />;
}

function SkillBrowser({
  pageSize,
  setPageSize,
}: {
  pageSize: number;
  setPageSize: (size: number) => void;
}) {
  const [methods, setMethods] = useState(false);
  const [items, setItems] = useState<SkillItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [importing, setImporting] = useState<{ files: File[] | null }>();
  const [selected, setSelected] = useState<string>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const active = items?.find((item) => item.name === selected);

  useEffect(() => {
    if (input === query) return;
    const timer = window.setTimeout(() => {
      setQuery(input);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [input, query]);

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
        methods ||
        active ||
        document.querySelector("dialog[open]") ||
        (event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      event.preventDefault();
      search.current?.focus();
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [importing, active, methods]);

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
    <section
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
      <div className="skills-heading">
        <h2>技能</h2>
        <button type="button" disabled={!items} onClick={() => setMethods(true)}>
          环节技能
        </button>
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
          <div className="skills-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              aria-label="搜索名称或说明（/）"
              placeholder="搜索名称或说明（/）"
              autoComplete="off"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            {input && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => {
                  setInput("");
                  setQuery("");
                  setPage(1);
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <MotionConfig reducedMotion="user">
            <fieldset data-ui-group className="skills-filters" aria-label="状态筛选">
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
                  {filter === key && (
                    <motion.span
                      aria-hidden="true"
                      className="skill-filter-slider"
                      layoutId="skill-filter"
                      transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
                    />
                  )}
                  <span>{label}</span>
                </button>
              ))}
            </fieldset>
          </MotionConfig>
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
            <div className="skills-empty skills-no-results">
              <p>没有符合条件的技能</p>
            </div>
          ) : (
            <SkillList items={visible} open={setSelected} />
          )}
        </div>
        <footer className="skills-pagination">
          <div className="skills-page-summary">
            <label>
              <select
                aria-label="每页条数"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {[10, 20, 30, 40, 50].map((count) => (
                  <option key={count}>{count}</option>
                ))}
              </select>
              <span>每页条数</span>
            </label>
            <span className="skill-note">共 {results.length} 条</span>
          </div>
          <div className="skills-page-controls">
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
                <ChevronsLeft size={16} />
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
              {pageNumbers(current, pages).map((number, index, entries) =>
                number === "…" ? (
                  <span key={`gap-${entries[index - 1]}`} className="skill-page-gap">
                    …
                  </span>
                ) : (
                  <button
                    key={number}
                    className="skill-page-link"
                    type="button"
                    aria-label={`第 ${number} 页`}
                    aria-current={number === current ? "page" : undefined}
                    onClick={() => setPage(number)}
                  >
                    {number}
                  </button>
                ),
              )}
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
                <ChevronsRight size={16} />
              </button>
            </fieldset>
          </div>
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
            setNotice(`已导入「${item.title}」v${version}。`);
          }}
        />
      )}
      {methods && <MethodWorkbench items={items ?? []} close={() => setMethods(false)} />}
      {active && (
        <SkillDetail
          key={active.name}
          item={active}
          close={() => {
            setSelected(undefined);
            void load();
          }}
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
    </section>
  );
}
